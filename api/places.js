// 단지 주소를 받아서 카카오맵으로 주변 정보를 찾아주는 서버 함수예요.
// /api/places?addr=서울 노원구 중계동 393&name=중계무지개
// 돌려주는 것: 가까운 지하철역, 도보 예상 시간, 3km 안 대형마트·백화점 수, 가장 가까운 중학교,
//            건축물대장의 세대수·용적률·건폐율
// 카카오 REST API 키는 KAKAO_REST_KEY, 건축물대장은 공공데이터포털 키 MOLIT_API_KEY 를 써요.

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
    let pos = null, lot = null; // lot: 건축물대장 조회용 지번 정보
    if (addr) {
      const a = await call("search/address.json", { query: addr, size: "1" });
      if (a.documents?.[0]) { pos = { x: a.documents[0].x, y: a.documents[0].y }; lot = a.documents[0].address; }
    }
    if (!pos && name) {
      const dongPart = addr.split(" ").slice(0, 3).join(" ");
      const k = await call("search/keyword.json", { query: `${dongPart} ${name}`, size: "1" });
      const d = k.documents?.[0];
      if (d) {
        pos = { x: d.x, y: d.y };
        const a2 = await call("search/address.json", { query: d.address_name, size: "1" }).catch(() => null);
        lot = a2?.documents?.[0]?.address || null;
      }
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
    const [sub, martDocs, deptDocs, schoolDocs, building] = await Promise.all([
      call("search/category.json", { ...near, sort: "distance", category_group_code: "SW8", size: "1" }),
      all("search/category.json", { ...near, sort: "distance", category_group_code: "MT1" }),
      all("search/keyword.json", { ...near, sort: "accuracy", query: "백화점" }),
      call("search/keyword.json", { x: pos.x, y: pos.y, radius: "3000", sort: "distance", category_group_code: "SC4", query: "중학교", size: "15" })
        .then((r) => r.documents || []),
      getBuilding(lot).catch((e) => ({ error: e.message })),
    ]);
    // 가장 가까운 중학교 (분류가 '중학교'인 곳만)
    const sc = schoolDocs.find((d) => /중학교$/.test(d.category_name));

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
      school: sc ? { name: sc.place_name, meters: Number(sc.distance) } : null,
      building,
    });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}

// ---- 건축물대장 (국토교통부_건축HUB_건축물대장정보 서비스) ----
// 아파트 단지는 보통 '총괄표제부'에 단지 전체 세대수·용적률·건폐율이 있고,
// 동이 하나뿐인 아파트는 '표제부'에만 있어서 그쪽도 찾아봐요.
const BLD = "https://apis.data.go.kr/1613000/BldRgstHubService";
async function getBuilding(lot) {
  let key = process.env.MOLIT_API_KEY || "";
  if (!key || !lot?.b_code) return null;
  if (key.includes("%")) key = decodeURIComponent(key);
  const pad = (v) => String(v || "0").padStart(4, "0");
  const q = {
    serviceKey: key, sigunguCd: lot.b_code.slice(0, 5), bjdongCd: lot.b_code.slice(5, 10),
    platGbCd: lot.mountain_yn === "Y" ? "1" : "0", bun: pad(lot.main_address_no), ji: pad(lot.sub_address_no),
    numOfRows: "100", pageNo: "1",
  };
  const items = async (op) => {
    const r = await fetch(`${BLD}/${op}?${new URLSearchParams(q)}`);
    const xml = await r.text();
    const code = tag(xml, "resultCode");
    if (!r.ok || (code && code !== "00" && code !== "000")) {
      throw new Error(`건축물대장 API 오류: ${tag(xml, "resultMsg") || r.status}`);
    }
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  };
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

  const recap = await items("getBrRecapTitleInfo");
  const titlesAll = await items("getBrTitleInfo");
  const dbg = {
    lot: `${q.sigunguCd}-${q.bjdongCd} ${q.bun}-${q.ji}`,
    recap: recap.map((it) => ["bldNm", "hhldCnt", "vlRat", "bcRat", "platPlc", "mainBldCnt"].map((k) => tag(it, k)).join("|")),
    titles: titlesAll.length,
    titleSum: titlesAll.reduce((s, it) => s + num(tag(it, "hhldCnt")), 0),
    titleSample: titlesAll.slice(0, 3).map((it) => ["bldNm", "dongNm", "hhldCnt", "vlRat", "mainPurpsCdNm"].map((k) => tag(it, k)).join("|")),
  };
  if (recap.length) {
    const best = recap.sort((a, b) => num(tag(b, "hhldCnt")) - num(tag(a, "hhldCnt")))[0];
    if (num(tag(best, "hhldCnt")) > 0) {
      return {
        households: num(tag(best, "hhldCnt")),
        far: Math.round(num(tag(best, "vlRat"))) || null,
        bcr: Math.round(num(tag(best, "bcRat"))) || null,
        approved: tag(best, "useAprDay") || null,
        dbg,
      };
    }
  }
  const titles = titlesAll.filter((it) => num(tag(it, "hhldCnt")) > 0);
  if (!titles.length) return { dbg };
  return {
    households: titles.reduce((s, it) => s + num(tag(it, "hhldCnt")), 0),
    far: Math.round(num(tag(titles[0], "vlRat"))) || null,
    bcr: Math.round(num(tag(titles[0], "bcRat"))) || null,
    approved: tag(titles[0], "useAprDay") || null,
    dbg,
  };
}
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : "";
}
