// 단지에서 출근지까지 대중교통으로 몇 분 걸리는지 카카오맵으로 계산해주는 서버 함수예요.
// /api/commute?addr=서울 노원구 중계동 393&name=중계무지개&to=강남역
// 카카오 대중교통 경로 API는 하루 1,000번까지 무료라서, 결과를 오래 저장해 두고 재사용해요.
// 키는 2단계와 같은 KAKAO_REST_KEY 를 써요.

const KAKAO = "https://dapi.kakao.com";

export default async function handler(req, res) {
  const key = process.env.KAKAO_REST_KEY || "";
  if (!key) return res.status(200).json({ none: true });

  const addr = String(req.query.addr || "").slice(0, 100);
  const name = String(req.query.name || "").slice(0, 60);
  const to = String(req.query.to || "").trim().slice(0, 40);
  if (!to) return res.status(400).json({ error: "출근지를 적어주세요." });

  const call = async (path, params) => {
    const r = await fetch(`${KAKAO}${path}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `KakaoAK ${key}` },
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(body.msg || `카카오 API 오류 (${r.status})`);
      err.quota = body.code === -10; // 오늘 무료 사용량을 다 쓴 경우
      throw err;
    }
    return body;
  };

  try {
    // 1) 단지 위치
    let from = null;
    if (addr) {
      const a = await call("/v2/local/search/address.json", { query: addr, size: "1" });
      if (a.documents?.[0]) from = a.documents[0];
    }
    if (!from && name) {
      const dongPart = addr.split(" ").slice(0, 3).join(" ");
      const k = await call("/v2/local/search/keyword.json", { query: `${dongPart} ${name}`, size: "1" });
      if (k.documents?.[0]) from = k.documents[0];
    }
    // 2) 출근지 위치 (예: "강남역", 회사 이름)
    const t = await call("/v2/local/search/keyword.json", { query: to, size: "1" });
    const dest = t.documents?.[0];
    if (!from || !dest) return res.status(200).json({ found: false });

    // 3) 대중교통 경로
    const r = await call("/v2/routing/publictraffic", {
      start_x: from.x, start_y: from.y, end_x: dest.x, end_y: dest.y,
      s_name: name || "출발", e_name: dest.place_name || to,
    });
    if (r.status !== "OK" || !r.routes?.length) {
      return res.status(200).json({ found: false, reason: r.status });
    }
    // 여러 경로 중 가장 빠른 것
    const best = r.routes
      .map((x) => x.properties || {})
      .sort((a, b) => (a.totalTime ?? 1e9) - (b.totalTime ?? 1e9))[0];

    res.setHeader("Cache-Control", "s-maxage=2592000, stale-while-revalidate=2592000");
    return res.status(200).json({
      found: true,
      dest: dest.place_name,
      minutes: Math.round((best.totalTime || 0) / 60),
      transfers: best.transfers ?? null,
      fare: best.fare?.value ?? null,
    });
  } catch (e) {
    return res.status(e.quota ? 429 : 502).json({ error: e.message, quota: !!e.quota });
  }
}
