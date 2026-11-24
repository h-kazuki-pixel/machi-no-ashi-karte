// 画面が出るまでの時間を、実際の時間で測る（Chrome の DevTools の仕組みで動かす。仮想の時間は使わない）
//   node app/tools/measure.mjs <サイトのフォルダ> <ラベル> <URL の ? から後> [回数=3]
// 「読みこんでいます」が消えて、画面の中身が出るまでの時間と、読んだファイル（時刻表など）の時間を出す。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import zlib from "node:zlib";

const [siteDir, label, query, nArg] = process.argv.slice(2);
const N = Number(nArg || 3);
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\//, "") || "index.html";
  const f = path.join(siteDir, p);
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end(); }
  // GitHub Pages と同じく、gzip で送る
  const gz = /gzip/.test(req.headers["accept-encoding"] || "") && [".json", ".js", ".css", ".html"].includes(path.extname(p));
  res.writeHead(200, { "Content-Type": types[path.extname(p)] || "application/octet-stream", ...(gz ? { "Content-Encoding": "gzip" } : {}) });
  gz ? fs.createReadStream(f).pipe(zlib.createGzip({ level: 6 })).pipe(res) : fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "measure-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((resolve) => {
  let buf = "";
  chrome.stderr.on("data", (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolve(m[1]);
  });
});
const browser = new WebSocket(wsUrl);
await new Promise((r) => (browser.onopen = r));
let id = 0;
const pending = new Map();
browser.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}, sessionId) => new Promise((r) => {
  const i = ++id;
  pending.set(i, r);
  browser.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" });
const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, sessionId);
// 時刻表を端末に残せない状態（NOCACHE=hang：Cache Storage が返事をしない。NOCACHE=reject：開けないと返す）
if (process.env.NOCACHE) {
  const body = process.env.NOCACHE === "hang" ? "() => new Promise(() => {})" : "() => Promise.reject(new DOMException('no', 'SecurityError'))";
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `try { Object.defineProperty(CacheStorage.prototype, "open", { value: ${body} }); } catch (e) {}` }, sessionId);
}
// 端末の速さ（THROTTLE=phone：CPU を 1/4、回線を 4G ほど：下り 9Mbps・上り 1.5Mbps・往復 70ms）
if (process.env.THROTTLE === "phone") {
  await send("Emulation.setCPUThrottlingRate", { rate: 4 }, sessionId);
  await send("Network.enable", {}, sessionId);
  await send("Network.emulateNetworkConditions", { offline: false, latency: 70, downloadThroughput: 9e6 / 8, uploadThroughput: 1.5e6 / 8 }, sessionId);
}
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId)).result.result.value;

for (let k = 1; k <= N; k++) {
  const url = `http://127.0.0.1:${port}/?${query}`;
  await send("Page.navigate", { url: "about:blank" }, sessionId);
  await send("Page.navigate", { url }, sessionId);
  const t0 = Date.now();
  let done = null;
  while (Date.now() - t0 < 60000) {
    const st = await evalJs(`(() => { const v = document.getElementById("view"); if (!v) return null;
      const t = v.innerText; return t && !t.includes("読みこんでいます") ? performance.now() : null; })()`);
    if (st) { done = st; break; }
    await new Promise((r) => setTimeout(r, 20));
  }
  const res = await evalJs(`performance.getEntriesByType("resource").filter((e) => e.name.includes("/data/"))
    .map((e) => ({ f: e.name.replace(/^.*\\/data\\//, "").slice(0, 60), start: Math.round(e.startTime), end: Math.round(e.responseEnd), kb: Math.round(e.encodedBodySize / 1024) }))`);
  console.log(`${label} ${k}回目：画面が出るまで ${done ? Math.round(done) + " ms" : "60秒で出ない"}`);
  for (const r of res || []) console.log(`    ${String(r.start).padStart(5)}〜${String(r.end).padStart(5)} ms ${String(r.kb).padStart(6)} KB ${r.f}`);
}
browser.close();
chrome.kill();
server.close();
await new Promise((r) => chrome.on("exit", r));
try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch { /* 一時フォルダは OS が消す */ }
