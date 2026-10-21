// 내 컴퓨터에서 미리 볼 때만 쓰는 간단한 서버예요. (Vercel에 올릴 때는 필요 없어요)
// 실행: node dev-server.js  →  http://localhost:3000
import http from "node:http";
import { readFile } from "node:fs/promises";
import handler from "./api/trades.js";

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/trades") {
    req.query = Object.fromEntries(url.searchParams);
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
    return handler(req, res);
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(await readFile("./index.html"));
}).listen(3000, () => console.log("http://localhost:3000"));
