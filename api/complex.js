// 단지 이름으로 공동주택관리정보시스템(K-apt)의 단지를 찾아서 세대수를 알려주는 서버 함수예요.
// /api/complex?gu=11350&dong=중계동&name=중계무지개
// 필요한 공공데이터 (같은 MOLIT_API_KEY 사용, 활용신청 필요):
//  - 국토교통부_공동주택 단지 목록제공 서비스 (AptListService4)
//  - 국토교통부_공동주택 기본 정보제공 서비스 (AptBasisInfoServiceV5)

const LIST = "https://apis.data.go.kr/1613000/AptListService4/getSigunguAptList4";
const BASIS = "https://apis.data.go.kr/1613000/AptBasisInfoServiceV5/getAphusBassInfoV5";
const listCache = new Map(); // 구별 단지 목록 (서버가 켜져 있는 동안 기억)

export default async function handler(req, res) {
  let key = process.env.MOLIT_API_KEY || "";
  if (!key) return res.status(200).json({ none: true });
  if (key.includes("%")) key = decodeURIComponent(key);
  const gu = String(req.query.gu || "");
  const dong = String(req.query.dong || "").slice(0, 20);
  const name = String(req.query.name || "").slice(0, 60);
  if (!/^\d{5}$/.test(gu) || !name) return res.status(400).json({ error: "구 코드와 단지 이름이 필요해요." });

  try {
    const list = await getList(key, gu);
    const hit = match(list, dong, name);
    if (!hit) return res.status(200).json({ found: false });

    const body = await get(`${BASIS}?${new URLSearchParams({ serviceKey: key, kaptCode: hit.kaptCode })}`);
    const item = Array.isArray(body.item) ? body.item[0] : body.item || (body.items && [].concat(body.items.item || body.items)[0]) || {};
    const n = (k) => parseInt(item[k], 10) || null;
    res.setHeader("Cache-Control", "s-maxage=2592000, stale-while-revalidate=2592000");
    return res.status(200).json({
      found: true,
      kaptCode: hit.kaptCode,
      kaptName: hit.kaptName,
      households: n("kaptdaCnt"),
      buildings: n("kaptDongCnt"),
    });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}

async function getList(key, gu) {
  if (listCache.has(gu)) return listCache.get(gu);
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const body = await get(`${LIST}?${new URLSearchParams({ serviceKey: key, sigunguCode: gu, numOfRows: "1000", pageNo: String(page) })}`);
    const items = [].concat(body.items?.item || body.items || []);
    for (const it of items) out.push({ kaptCode: it.kaptCode, kaptName: String(it.kaptName || "").trim(), dong: it.as3 });
    const total = parseInt(body.totalCount || "0", 10);
    if (!items.length || page * 1000 >= total) break;
  }
  listCache.set(gu, out);
  return out;
}

// 이 API는 JSON으로 답해요: { response: { header: {resultCode}, body: {...} } }
async function get(url) {
  let r, text;
  // 공공데이터포털은 너무 빨리 여러 번 부르면 429(요청 과다)로 거절해요 → 잠깐 쉬었다가 다시 시도
  for (let i = 0; i < 4; i++) {
    r = await fetch(url);
    text = await r.text();
    if (r.status !== 429) break;
    await new Promise((ok) => setTimeout(ok, 700 * (i + 1)));
  }
  let data = null;
  try { data = JSON.parse(text); } catch {}
  const resp = data?.response || data || {};
  const code = resp.header?.resultCode;
  if (!r.ok || !data || (code && code !== "00" && code !== "000")) {
    throw new Error(`공동주택 정보 API 오류: ${resp.header?.resultMsg || r.status}`);
  }
  return resp.body || {};
}

// ---- 이름 맞추기: 실거래가의 단지명과 K-apt 단지명은 표기가 조금씩 달라요 ----
// 예) "상계주공7(고층)" ↔ "상계주공7단지", "한신4차" ↔ "한신(4차)", "성원(사슴4)" ↔ "사슴4단지"
const clean = (s) => s.replace(/아파트|APT|apt/g, "").replace(/단지/g, "").replace(/[^0-9a-zA-Z가-힣]/g, "");
// 괄호 안 글자를 뺀 것 / 괄호 안 글자만 / 괄호만 지운 것, 세 가지 모양을 만들어 비교해요
function forms(s) {
  const inner = (s.match(/\((.*?)\)/g) || []).map((x) => x.slice(1, -1)).join("");
  return [...new Set([clean(s.replace(/\(.*?\)/g, "")), clean(inner), clean(s)].filter((x) => x.length >= 2))];
}
const digits = (s) => (s.match(/\d+/g) || []).join(",");
function bigrams(s) { const a = []; for (let i = 0; i < s.length - 1; i++) a.push(s.slice(i, i + 2)); return a; }
function dice(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.length || !B.length) return 0;
  let hit = 0; const pool = [...B];
  for (const x of A) { const i = pool.indexOf(x); if (i >= 0) { hit++; pool.splice(i, 1); } }
  return (2 * hit) / (A.length + B.length);
}
function pairScore(a, b) {
  const da = digits(a), db = digits(b);
  let pen = 1;
  if (da !== db) {
    if (da && db) return 0;   // 둘 다 번호가 있는데 다르면 다른 단지 (예: 7단지 ↔ 17단지)
    pen = 0.8;                // 한쪽만 번호가 있으면 조금 감점
  }
  if (a === b) return 1 * pen;
  if (a.includes(b) || b.includes(a)) return 0.9 * pen;
  return dice(a, b) * pen;
}
function match(list, dong, name) {
  const T = forms(name);
  const score = (c) => {
    let best = 0;
    for (const a of T) for (const b of forms(c.kaptName)) best = Math.max(best, pairScore(a, b));
    return best;
  };
  const pick = (cands) => {
    let best = null, bestS = 0;
    for (const c of cands) { const s = score(c); if (s > bestS) { best = c; bestS = s; } }
    return bestS >= 0.6 ? best : null;
  };
  return pick(list.filter((c) => c.dong === dong)) || pick(list);
}
