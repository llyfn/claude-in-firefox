import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PAGES = fileURLToPath(new URL("./pages/", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".txt": "text/plain" };

function handler(req, res) {
  const url = new URL(req.url, "http://fixture");
  if (url.pathname === "/api/ping") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"pong":true}');
    return;
  }
  const file = path.join(PAGES, path.normalize(url.pathname).replace(/^\/+/, ""));
  if (!file.startsWith(PAGES) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const headers = { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" };
  if (path.basename(file).startsWith("csp-")) headers["content-security-policy"] = "script-src 'self'";
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

export async function startFixtures() {
  const a = http.createServer(handler);
  const b = http.createServer(handler);
  await new Promise((resolve) => a.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => b.listen(0, "localhost", resolve));
  const stop = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  return {
    a: `http://127.0.0.1:${a.address().port}`,
    b: `http://localhost:${b.address().port}`,
    close: () => Promise.all([stop(a), stop(b)]),
  };
}
