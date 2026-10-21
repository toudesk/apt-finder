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

  if (req.query.debug) {
    // 점검용: 단지 목록 API가 어떻게 응답하는지 그대로 보여줘요 (키는 보여주지 않아요)
    const out = {};
    for (const [op, params] of [
      ["getSigunguAptList4", { sigunguCode: gu }],
      ["getLegaldongAptList4", { bjdCode: `${gu}10600` }],
    ]) {
      const r = await fetch(`https://apis.data.go.kr/1613000/AptListService4/${op}?${new URLSearchParams({ serviceKey: key, numOfRows: "3", pageNo: "1", ...params })}`);
      out[op] = { status: r.status, body: (await r.text()).slice(0, 700) };
    }
    return res.status(200).json(out);
  }
  try {
    const list = await getList(key, gu);
    const hit = match(list, dong, name);
    if (!hit) return res.status(200).json({ found: false });

    const xml = await get(`${BASIS}?${new URLSearchParams({ serviceKey: key, kaptCode: hit.kaptCode })}`);
    const n = (k) => parseInt(tag(xml, k), 10) || null;
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
    const xml = await get(`${LIST}?${new URLSearchParams({ serviceKey: key, sigunguCode: gu, numOfRows: "1000", pageNo: String(page) })}`);
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
    for (const it of items) out.push({ kaptCode: tag(it, "kaptCode"), kaptName: tag(it, "kaptName"), dong: tag(it, "as3") });
    const total = parseInt(tag(xml, "totalCount") || "0", 10);
    if (!items.length || page * 1000 >= total) break;
  }
  listCache.set(gu, out);
  return out;
}

async function get(url) {
  const r = await fetch(url);
  const xml = await r.text();
  const code = tag(xml, "resultCode");
  if (!r.ok || (code && code !== "00" && code !== "000")) {
    throw new Error(`공동주택 정보 API 오류: ${tag(xml, "resultMsg") || r.status}`);
  }
  return xml;
}

// ---- 이름 맞추기: 실거래가의 단지명과 K-apt 단지명은 표기가 조금씩 달라요 ----
// 예) "상계주공7(고층)" ↔ "상계주공7단지", "중계무지개" ↔ "중계무지개아파트"
function norm(s) {
  return s.replace(/\(.*?\)/g, "").replace(/아파트|단지|APT|apt/g, "").replace(/[^0-9a-zA-Z가-힣]/g, "");
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
function match(list, dong, name) {
  const target = norm(name);
  const score = (c) => {
    const n = norm(c.kaptName);
    if (!n || digits(n) !== digits(target)) return 0; // 숫자(단지 번호)가 다르면 다른 단지
    if (n === target) return 1;
    if (n.includes(target) || target.includes(n)) return 0.9;
    return dice(n, target);
  };
  const pick = (cands) => {
    let best = null, bestS = 0;
    for (const c of cands) { const s = score(c); if (s > bestS) { best = c; bestS = s; } }
    return bestS >= 0.6 ? best : null;
  };
  return pick(list.filter((c) => c.dong === dong)) || pick(list);
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : "";
}
