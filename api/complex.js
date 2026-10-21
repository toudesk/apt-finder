// 공동주택관리정보시스템(K-apt) 단지 정보를 가져오는 서버 함수예요. 두 가지로 써요.
//  1) /api/complex?gu=11350          → 그 구의 단지 목록 [{c: 단지코드, n: 단지명, d: 동}] (하루 저장)
//  2) /api/complex?code=A13986504    → 그 단지의 세대수·동수 (30일 저장)
// 이름 맞추기는 화면(index.html)에서 해요. 목록을 구마다 한 번만 받으면 돼서 요청이 확 줄어요.
// 필요한 공공데이터 (같은 MOLIT_API_KEY 사용, 활용신청 필요):
//  - 국토교통부_공동주택 단지 목록제공 서비스 (AptListService4)  ※ JSON으로 응답
//  - 국토교통부_공동주택 기본 정보제공 서비스 (AptBasisInfoServiceV5)  ※ JSON으로 응답

const LIST = "https://apis.data.go.kr/1613000/AptListService4/getSigunguAptList4";
const BASIS = "https://apis.data.go.kr/1613000/AptBasisInfoServiceV5/getAphusBassInfoV5";

export default async function handler(req, res) {
  let key = process.env.MOLIT_API_KEY || "";
  if (!key) return res.status(200).json({ none: true });
  if (key.includes("%")) key = decodeURIComponent(key);

  try {
    const gu = String(req.query.gu || "");
    const code = String(req.query.code || "");
    if (/^\d{5}$/.test(gu)) {
      const out = [];
      for (let page = 1; page <= 5; page++) {
        const body = await get(`${LIST}?${new URLSearchParams({ serviceKey: key, sigunguCode: gu, numOfRows: "1000", pageNo: String(page) })}`);
        const items = [].concat(body.items?.item || body.items || []);
        for (const it of items) out.push({ c: it.kaptCode, n: String(it.kaptName || "").trim(), d: it.as3 });
        if (!items.length || page * 1000 >= parseInt(body.totalCount || "0", 10)) break;
      }
      res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
      return res.status(200).json({ list: out });
    }
    if (/^A\d+$/.test(code)) {
      const body = await get(`${BASIS}?${new URLSearchParams({ serviceKey: key, kaptCode: code })}`);
      const item = Array.isArray(body.item) ? body.item[0] : body.item || [].concat(body.items?.item || body.items || [])[0] || {};
      const n = (k) => parseInt(item[k], 10) || null;
      res.setHeader("Cache-Control", "s-maxage=2592000, stale-while-revalidate=2592000");
      return res.status(200).json({ households: n("kaptdaCnt"), buildings: n("kaptDongCnt") });
    }
    return res.status(400).json({ error: "gu(구 코드) 또는 code(단지 코드)가 필요해요." });
  } catch (e) {
    return res.status(e.status === 429 ? 429 : 502).json({ error: e.message, busy: e.status === 429 });
  }
}

// 공공데이터포털은 너무 빨리 여러 번 부르면 429(요청 과다)로 거절해요 → 잠깐 쉬었다가 다시 시도
async function get(url) {
  let r, text;
  for (let i = 0; i < 4; i++) {
    r = await fetch(url);
    text = await r.text();
    if (r.status !== 429) break;
    await new Promise((ok) => setTimeout(ok, 800 * (i + 1)));
  }
  let data = null;
  try { data = JSON.parse(text); } catch {}
  const resp = data?.response || data || {};
  const code = resp.header?.resultCode;
  if (!r.ok || !data || (code && code !== "00" && code !== "000")) {
    const err = new Error(`공동주택 정보 API 오류: ${resp.header?.resultMsg || r.status}`);
    err.status = r.status;
    throw err;
  }
  return resp.body || {};
}
