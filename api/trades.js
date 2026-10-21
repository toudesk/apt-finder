// 국토교통부 아파트 매매 실거래가 API를 불러와서 화면이 쓰기 쉬운 JSON으로 바꿔주는 서버 함수예요.
// Vercel에 올리면 /api/trades?gu=11350&months=3 주소로 동작해요.
// API 키는 코드에 적지 않고, Vercel 설정의 환경변수 MOLIT_API_KEY 에 넣어요.

const ENDPOINT =
  "https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade";

export default async function handler(req, res) {
  const gu = String(req.query.gu || "");
  const months = Math.min(Math.max(parseInt(req.query.months || "3", 10) || 3, 1), 12);

  if (!/^11\d{3}$/.test(gu)) {
    return res.status(400).json({ error: "구 코드가 올바르지 않아요." });
  }

  let key = process.env.MOLIT_API_KEY || "";
  if (!key) {
    // 키가 아직 없으면 화면을 확인할 수 있도록 예시 데이터를 보내요.
    return res.status(200).json({ demo: true, trades: sampleTrades(gu, months) });
  }
  if (key.includes("%")) key = decodeURIComponent(key); // 인코딩 키를 넣어도 동작하게

  try {
    const yms = recentMonths(months);
    const lists = await Promise.all(yms.map((ym) => fetchMonth(key, gu, ym)));
    const trades = lists.flat();
    // 같은 결과는 하루 동안 저장해 두고 재사용해요 (API 호출 횟수 절약).
    res.setHeader("Cache-Control", "s-maxage=43200, stale-while-revalidate=86400");
    return res.status(200).json({ demo: false, trades });
  } catch (e) {
    return res.status(502).json({ error: e.message || "실거래가를 불러오지 못했어요." });
  }
}

function recentMonths(n) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    const t = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

async function fetchMonth(key, gu, ym) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const qs = new URLSearchParams({
      serviceKey: key,
      LAWD_CD: gu,
      DEAL_YMD: ym,
      pageNo: String(page),
      numOfRows: "1000",
    });
    const r = await fetch(`${ENDPOINT}?${qs}`);
    const xml = await r.text();

    const code = tag(xml, "resultCode");
    if (code && code !== "00" && code !== "000") {
      throw new Error(`공공데이터 API 오류: ${tag(xml, "resultMsg") || code}`);
    }
    if (!r.ok) throw new Error(`공공데이터 API 응답 오류 (${r.status})`);

    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
    for (const it of items) {
      if (tag(it, "cdealType") === "O") continue; // 취소된 거래는 빼요
      all.push({
        apt: tag(it, "aptNm"),
        dong: tag(it, "umdNm"),
        jibun: tag(it, "jibun"),
        price: parseInt(tag(it, "dealAmount").replace(/,/g, ""), 10), // 만원
        area: parseFloat(tag(it, "excluUseAr")), // 전용면적 ㎡
        floor: parseInt(tag(it, "floor"), 10),
        built: parseInt(tag(it, "buildYear"), 10),
        date: `${tag(it, "dealYear")}-${tag(it, "dealMonth").padStart(2, "0")}-${tag(it, "dealDay").padStart(2, "0")}`,
      });
    }
    const total = parseInt(tag(xml, "totalCount") || "0", 10);
    if (page * 1000 >= total) break;
  }
  return all;
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : "";
}

// ---- 예시 데이터 (API 키를 넣기 전까지만 사용) ----
function sampleTrades(gu, months) {
  let seed = parseInt(gu, 10);
  const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const dongs = ["가동", "나동", "다동", "라동"];
  const out = [];
  for (let a = 1; a <= 18; a++) {
    const built = 1985 + Math.floor(rand() * 38);
    const base = 35000 + Math.floor(rand() * 60000);
    const dong = dongs[a % dongs.length];
    const n = 1 + Math.floor(rand() * 8 * months / 3);
    for (let k = 0; k < n; k++) {
      const area = [39.6, 44.9, 49.5, 59.9, 84.9][Math.floor(rand() * 5)];
      const day = new Date();
      day.setDate(day.getDate() - Math.floor(rand() * months * 30));
      out.push({
        apt: `예시아파트${a}단지`,
        dong,
        jibun: String(100 + a),
        price: Math.round((base * (area / 50) * (0.9 + rand() * 0.2)) / 100) * 100,
        area,
        floor: 1 + Math.floor(rand() * 15),
        built,
        date: day.toISOString().slice(0, 10),
      });
    }
  }
  return out;
}
