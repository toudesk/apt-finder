// 보고서 신청·저장·조회 서버 함수예요. 저장소는 Upstash Redis(무료)를 써요.
// Vercel → Storage에서 Upstash Redis를 프로젝트에 연결하면 KV_REST_API_URL / KV_REST_API_TOKEN 이 자동으로 들어와요.
// 관리자 비밀번호는 Vercel 환경변수 ADMIN_PASSWORD 에 직접 넣어 주세요.
//
//  공개
//   POST /api/report?a=apply   {code, gus, months, min, max, area, hh, work}  → {id}
//   GET  /api/report?a=status&id=        → 신청 상태 (+ 완성되면 보고서 주소)
//   GET  /api/report?a=find&code=        → 그 코드로 한 신청 목록
//   GET  /api/report?a=get&rid=          → 저장된 보고서 (30일 뒤 자동 삭제)
//  관리자 (헤더 x-admin: 비밀번호)
//   GET  /api/report?a=list              → 신청·코드 목록
//   GET  /api/report?a=req&id=           → 신청 하나
//   POST /api/report?a=code   {code, name, limit, perDay}  → 코드 만들기/수정
//   POST /api/report?a=delcode {code}
//   POST /api/report?a=status {id, status}  → 진행 중·거절 표시
//   POST /api/report?a=save   {id, snap}    → 보고서 저장 + 신청 완료 처리

import { randomBytes, timingSafeEqual } from "node:crypto";

const DAYS = 30;
const TTL = DAYS * 86400;

export default async function handler(req, res) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if (!url || !token) return res.status(503).json({ error: "저장소(Upstash Redis)가 아직 연결되지 않았어요.", nostore: true });
  const redis = async (...cmd) => {
    const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(cmd) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error(`저장소 오류: ${d.error || r.status}`);
    return d.result;
  };
  const getJ = async (k) => { const v = await redis("GET", k); return v ? JSON.parse(v) : null; };
  const setJ = (k, v, ex) => ex ? redis("SET", k, JSON.stringify(v), "EX", String(ex)) : redis("SET", k, JSON.stringify(v));

  const a = String(req.query.a || "");
  const body = req.method === "POST" ? await readBody(req) : {};
  res.setHeader("Cache-Control", "no-store");

  try {
    // ---------- 공개 ----------
    if (a === "apply" && req.method === "POST") {
      const code = cleanCode(body.code);
      const c = code && await getJ(`code:${code}`);
      if (!c) return res.status(400).json({ error: "신청 코드를 확인해 주세요." });
      const mine = await listReqs(redis, getJ, `code:${code}:reqs`);
      const today = kstDay();
      if (c.limit && mine.length >= c.limit) return res.status(400).json({ error: `이 코드는 ${c.limit}번까지 신청할 수 있어요. 이미 다 쓰셨어요.` });
      if (c.perDay && mine.filter((r) => kstDay(r.createdAt) === today).length >= c.perDay)
        return res.status(400).json({ error: `하루 ${c.perDay}번까지 신청할 수 있어요. 내일 다시 신청해 주세요.` });
      const gus = [].concat(body.gus || []).map(String).filter((g) => /^11\d{3}$/.test(g)).slice(0, 3);
      if (!gus.length) return res.status(400).json({ error: "지역(구)을 1곳 이상 골라 주세요." });
      const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : d; };
      const min = num(body.min, 0), max = num(body.max, 0);
      if (!max || max < min) return res.status(400).json({ error: "예산을 확인해 주세요." });
      const id = rid(8);
      const r = {
        id, code, name: c.name || code, gus, months: [3, 6, 12].includes(+body.months) ? +body.months : 6,
        min, max, area: num(body.area, 0), hh: num(body.hh, 0),
        work: String(body.work || "").slice(0, 80), status: "pending", createdAt: Date.now(),
      };
      await setJ(`req:${id}`, r);
      await redis("LPUSH", "reqs", id);
      await redis("LPUSH", `code:${code}:reqs`, id);
      return res.status(200).json({ id });
    }
    if (a === "status") {
      if (req.method === "POST") {
        if (!admin(req)) return res.status(401).json({ error: "관리자 비밀번호가 맞지 않아요." });
        const r = await getJ(`req:${body.id}`); if (!r) return res.status(404).json({ error: "신청을 찾지 못했어요." });
        if (["pending", "making", "rejected"].includes(body.status)) r.status = body.status;
        await setJ(`req:${r.id}`, r);
        return res.status(200).json({ ok: true });
      }
      const r = await getJ(`req:${String(req.query.id || "")}`);
      if (!r) return res.status(404).json({ error: "신청을 찾지 못했어요." });
      return res.status(200).json(publicReq(r, await queuePos(redis, getJ, r)));
    }
    if (a === "find") {
      const code = cleanCode(req.query.code);
      const c = code && await getJ(`code:${code}`);
      if (!c) return res.status(404).json({ error: "신청 코드를 확인해 주세요." });
      const mine = await listReqs(redis, getJ, `code:${code}:reqs`);
      return res.status(200).json({ name: c.name, limit: c.limit, perDay: c.perDay, list: mine.map((r) => publicReq(r)) });
    }
    if (a === "get") {
      const snap = await getJ(`report:${String(req.query.rid || "")}`);
      if (!snap) return res.status(404).json({ error: "보고서를 찾지 못했어요. 공유 기간(30일)이 지났을 수 있어요." });
      return res.status(200).json(snap);
    }

    // ---------- 관리자 ----------
    if (!admin(req)) return res.status(401).json({ error: "관리자 비밀번호가 맞지 않아요." });
    if (a === "list") {
      const reqs = await listReqs(redis, getJ, "reqs", 200);
      const keys = (await redis("KEYS", "code:*")) || [];
      const codes = [];
      for (const k of keys.filter((k) => !k.endsWith(":reqs"))) {
        const c = await getJ(k); if (!c) continue;
        const n = (await redis("LLEN", `${k}:reqs`)) || 0;
        codes.push({ code: k.slice(5), ...c, used: n });
      }
      return res.status(200).json({ reqs, codes });
    }
    if (a === "req") {
      const r = await getJ(`req:${String(req.query.id || "")}`);
      return r ? res.status(200).json(r) : res.status(404).json({ error: "신청을 찾지 못했어요." });
    }
    if (a === "code" && req.method === "POST") {
      const code = cleanCode(body.code);
      if (!code) return res.status(400).json({ error: "코드를 적어 주세요." });
      await setJ(`code:${code}`, { name: String(body.name || code).slice(0, 20), limit: parseInt(body.limit, 10) || 0, perDay: parseInt(body.perDay, 10) || 0 });
      return res.status(200).json({ ok: true });
    }
    if (a === "delcode" && req.method === "POST") {
      await redis("DEL", `code:${cleanCode(body.code)}`);
      return res.status(200).json({ ok: true });
    }
    if (a === "save" && req.method === "POST") {
      const r = await getJ(`req:${body.id}`);
      if (!r) return res.status(404).json({ error: "신청을 찾지 못했어요." });
      if (!body.snap || !Array.isArray(body.snap.groups)) return res.status(400).json({ error: "보고서 내용이 비어 있어요." });
      const reportId = rid(9);
      const now = Date.now();
      const snap = { ...body.snap, reportId, name: r.name, createdAt: now, expiresAt: now + TTL * 1000,
        cond: { gus: r.gus, months: r.months, min: r.min, max: r.max, area: r.area, hh: r.hh, work: r.work } };
      await setJ(`report:${reportId}`, snap, TTL);
      Object.assign(r, { status: "done", reportId, doneAt: now, expiresAt: snap.expiresAt });
      await setJ(`req:${r.id}`, r);
      return res.status(200).json({ reportId });
    }
    return res.status(400).json({ error: "알 수 없는 요청이에요." });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function admin(req) {
  // 화면에서 encodeURIComponent로 보내요 (한글 비밀번호도 되게)
  const pw = encodeURIComponent(process.env.ADMIN_PASSWORD || "");
  const got = String(req.headers["x-admin"] || "");
  if (!pw || !got) return false;
  const A = Buffer.from(pw), B = Buffer.from(got);
  return A.length === B.length && timingSafeEqual(A, B);
}
const cleanCode = (v) => String(v || "").replace(/\s/g, "").slice(0, 20);
const rid = (n) => randomBytes(n).toString("base64url").slice(0, Math.ceil(n * 4 / 3));
const kstDay = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
function publicReq(r, pos) {
  return { id: r.id, name: r.name, gus: r.gus, months: r.months, min: r.min, max: r.max, area: r.area, hh: r.hh, work: r.work,
    status: r.status, createdAt: r.createdAt, doneAt: r.doneAt, reportId: r.reportId, expiresAt: r.expiresAt, queue: pos };
}
async function listReqs(redis, getJ, key, n = 50) {
  const ids = (await redis("LRANGE", key, "0", String(n - 1))) || [];
  const out = [];
  for (const id of ids) { const r = await getJ(`req:${id}`); if (r) out.push(r); }
  return out;
}
// 대기 순서: 나보다 먼저 들어온 대기 중 신청 수 + 1
async function queuePos(redis, getJ, r) {
  if (r.status !== "pending") return null;
  const all = await listReqs(redis, getJ, "reqs", 200);
  return all.filter((x) => x.status === "pending" && x.createdAt < r.createdAt).length + 1;
}
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
}
