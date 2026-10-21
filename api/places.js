// 단지 주소를 받아서 카카오맵으로 주변 정보를 찾아주는 서버 함수예요.
// /api/places?addr=서울 노원구 중계동 393&name=중계무지개
// 돌려주는 것: 가까운 지하철역, 도보 예상 시간, 3km 안 대형마트·백화점 수
// 카카오 REST API 키는 Vercel 환경변수 KAKAO_REST_KEY 에 넣어요.

const KAKAO = "https://dapi.kakao.com/v2/local";

export default async function handler(req, res) {
  const key = process.env.KAKAO_REST_KEY || "";
  if (!key) return res.status(200).json({ none: true });

  const addr = String(req.query.addr || "").slice(0, 100);
  const name = String(req.query.name || "").slice(0, 60);
  const call = async (path, params) => {
    const r = await fetch(`${KAKAO}/${path}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `KakaoAK ${key}` },
    });
    if (!r.ok) throw new Error(`카카오 API 오류 (${r.status})`);
    return r.json();
  };

  try {
    // 1) 단지 위치 찾기: 지번 주소 → 안 되면 "동 + 단지명" 검색
    let pos = null;
    if (addr) {
      const a = await call("search/address.json", { query: addr, size: "1" });
      if (a.documents?.[0]) pos = { x: a.documents[0].x, y: a.documents[0].y };
    }
    if (!pos && name) {
      const dongPart = addr.split(" ").slice(0, 3).join(" ");
      const k = await call("search/keyword.json", { query: `${dongPart} ${name}`, size: "1" });
      if (k.documents?.[0]) pos = { x: k.documents[0].x, y: k.documents[0].y };
    }
    if (!pos) return res.status(200).json({ found: false });

    const near = { x: pos.x, y: pos.y, radius: "3000" };
    // 최대 3쪽(45곳)까지 모아요
    const all = async (path, params) => {
      const out = [];
      for (let page = 1; page <= 3; page++) {
        const r = await call(path, { ...params, size: "15", page: String(page) });
        out.push(...(r.documents || []));
        if (r.meta?.is_end) break;
      }
      return out;
    };
    const [sub, martDocs, deptDocs] = await Promise.all([
      call("search/category.json", { ...near, sort: "distance", category_group_code: "SW8", size: "1" }),
      all("search/category.json", { ...near, sort: "distance", category_group_code: "MT1" }),
      all("search/keyword.json", { ...near, sort: "accuracy", query: "백화점" }),
    ]);

    const st = sub.documents?.[0];
    // 카카오 '대형마트' 분류에는 동네 슈퍼도 섞여 있어서, 큰 마트 브랜드만 세요
    const BIG = /(이마트|홈플러스|롯데마트|코스트코|트레이더스|하나로마트|메가마트|빅마켓|농협하나로)/;
    const SMALL = /(에브리데이|익스프레스|365|24)/;
    const marts = new Set(
      martDocs.filter((d) => BIG.test(d.place_name) && !SMALL.test(d.place_name)).map((d) => d.id)
    );
    // 백화점 안의 매장들은 빼고, 분류가 '백화점'인 본점·지점만 세요
    const depts = new Set(deptDocs.filter((d) => /백화점$/.test(d.category_name)).map((d) => d.id));

    // 결과는 오래 저장해 둬요 (역·마트 위치는 거의 안 바뀌니까요)
    res.setHeader("Cache-Control", "s-maxage=2592000, stale-while-revalidate=2592000");
    return res.status(200).json({
      found: true,
      station: st
        ? {
            name: st.place_name,
            meters: Number(st.distance),
            // 직선거리에 실제 길 우회(약 1.3배)를 감안, 분당 67m 걸음으로 계산한 추정치
            walkMin: Math.max(1, Math.round((Number(st.distance) * 1.3) / 67)),
          }
        : null,
      marts: marts.size,
      depts: depts.size,
    });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
