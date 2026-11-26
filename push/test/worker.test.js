// 通知のサーバーの試験（Node 20 以降。KV と配達サービスは偽物）
import { test } from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import worker, { BATCH, expire, subKey, CRON_WATCH, CRON_FULL, dispatchWatch, DISPATCH_LOG } from "../src/index.js";
import { encryptPayload, vapidAuth, b64u, unb64u } from "../src/webpush.js";

// ---------- 偽物 ----------
class FakeKV {
  constructor() { this.m = new Map(); this.writes = 0; }
  async get(k, type) { const x = this.m.get(k); return x ? (type === "json" ? JSON.parse(x.v) : x.v) : null; }
  async getWithMetadata(k, type) { const x = this.m.get(k); return { value: x ? (type === "json" ? JSON.parse(x.v) : x.v) : null, metadata: x ? x.meta : null }; }
  async put(k, v, o = {}) { this.writes++; this.m.set(k, { v, meta: o.metadata || null }); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix }) { return { keys: [...this.m].filter(([k]) => k.startsWith(prefix)).map(([name, x]) => ({ name, metadata: x.meta })), list_complete: true }; }
}
const CATALOG = { feeds: [
  { feed: "yonezawacity/Yonezawa", usable: true, revisions: [{ change_date: "2026-12-01" }] },
  { feed: "omachicity/omachiraicholiner", usable: true, revisions: [] },
] };
const pushed = [];
let pushStatus = () => 201;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.endsWith("/data/catalog.json")) return new Response(JSON.stringify(CATALOG));
  pushed.push({ url: u, init });
  return new Response(null, { status: pushStatus(u) });
};
const vapid = nodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
const ORIGIN = "https://h-kazuki-pixel.github.io";
const env = () => ({ SUBS: new FakeKV(), ALLOWED_ORIGIN: ORIGIN, PAGES_BASE: "https://example.test/app", NOTIFY_TOKEN: "secret-token",
                     VAPID_PRIVATE_JWK: JSON.stringify(vapid), VAPID_SUBJECT: "https://github.com/example" });
function uaKeys() {
  const ecdh = nodeCrypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { ecdh, p256dh: b64u(ecdh.getPublicKey()), auth: b64u(nodeCrypto.randomBytes(16)) };
}
const call = (e, path, body, headers = {}) => worker.fetch(new Request(`https://push.test${path}`, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }), e);
const app = { Origin: ORIGIN };
const subBody = (n, feeds = ["yonezawacity/Yonezawa"], k = uaKeys()) => ({
  subscription: { endpoint: `https://web.push.apple.com/QK${String(n).padStart(4, "0")}`, keys: { p256dh: k.p256dh, auth: k.auth } }, feeds });
const withDate = async (iso, fn) => { const real = Date.now; Date.now = () => Date.parse(iso); try { return await fn(); } finally { Date.now = real; } };

// ---------- 暗号 ----------
test("RFC 8291：暗号化した中身を、受け手の鍵で読める", async () => {
  const k = uaKeys();
  const body = await encryptPayload('{"feed":"a/b","change_date":"2026-12-01"}', k.p256dh, k.auth);
  // 受け手の側の計算（node:crypto で別に書く）
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  assert.equal(new DataView(body.buffer, body.byteOffset).getUint32(16), 4096);
  const secret = k.ecdh.computeSecret(asPub);
  const h = (key, data) => nodeCrypto.createHmac("sha256", key).update(data).digest();
  const ikm = h(h(unb64u(k.auth), secret), Buffer.concat([Buffer.from("WebPush: info\0"), unb64u(k.p256dh), asPub, Buffer.from([1])]));
  const prk = h(salt, ikm);
  const cek = h(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = h(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const d = nodeCrypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain.at(-1), 2); // 最後の記録の印
  assert.equal(plain.subarray(0, -1).toString(), '{"feed":"a/b","change_date":"2026-12-01"}');
});

test("RFC 8292：VAPID の名乗りは、公開の鍵で確かめられる ES256 の JWT", async () => {
  const h = await vapidAuth("https://web.push.apple.com/abc", vapid, "https://github.com/example", 3600, Date.parse("2026-11-24T00:00:00Z"));
  const [, t, k] = h.match(/^vapid t=([^,]+), k=(.+)$/);
  const [hd, cl, sig] = t.split(".");
  const claims = JSON.parse(Buffer.from(unb64u(cl)).toString());
  assert.equal(claims.aud, "https://web.push.apple.com");
  assert.equal(claims.sub, "https://github.com/example");
  const pub = nodeCrypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(unb64u(k).subarray(1, 33)), y: b64u(unb64u(k).subarray(33)) }, format: "jwk" });
  assert.ok(nodeCrypto.verify("sha256", Buffer.from(`${hd}.${cl}`), { key: pub, dsaEncoding: "ieee-p1363" }, unb64u(sig)));
});

// ---------- 登録 ----------
test("登録：アプリのページ以外・配達サービスでない宛先・一覧に無いバス・多すぎるバスは断る", async () => {
  const e = env();
  assert.equal((await call(e, "/subscribe", subBody(1))).status, 403); // Origin が無い
  assert.equal((await call(e, "/subscribe", subBody(1), { Origin: "https://evil.example" })).status, 403);
  const bad = subBody(1); bad.subscription.endpoint = "https://evil.example/push";
  assert.equal((await call(e, "/subscribe", bad, app)).status, 400);
  assert.equal((await call(e, "/subscribe", subBody(1, ["nope/nope"]), app)).status, 400);
  assert.equal((await call(e, "/subscribe", subBody(1, Array.from({ length: 21 }, (_, i) => `x/${i}`)), app)).status, 400);
  const badKey = subBody(1); badKey.subscription.keys.auth = "AAAA";
  assert.equal((await call(e, "/subscribe", badKey, app)).status, 400);
  assert.equal(e.SUBS.m.size, 0);
});

test("登録：残すのは宛先・鍵・バスの番号と、日付だけ。同じ宛先は上書き。30日たつまでは書き直さない", async () => {
  const e = env();
  const k = uaKeys();
  await withDate("2026-11-24T03:00:00Z", async () => assert.equal((await call(e, "/subscribe", subBody(1, ["yonezawacity/Yonezawa"], k), app)).status, 200));
  const [[key, x]] = [...e.SUBS.m];
  assert.deepEqual(Object.keys(JSON.parse(x.v)).sort(), ["a", "e", "f", "p"]);
  assert.deepEqual(Object.keys(x.meta).sort(), ["c", "h", "u"]);
  assert.equal(x.meta.u, "2026-11-24");
  assert.ok(!JSON.stringify(x).match(/\d{2}:\d{2}/)); // 時刻は残さない
  await withDate("2026-12-20T03:00:00Z", () => call(e, "/subscribe", subBody(1, ["yonezawacity/Yonezawa"], k), app));
  assert.equal(e.SUBS.writes, 1); // 26日目：書かない
  await withDate("2026-12-24T03:00:00Z", () => call(e, "/subscribe", subBody(1, ["yonezawacity/Yonezawa"], k), app));
  assert.equal(e.SUBS.writes, 2); // 30日目：更新の日を新しくする
  assert.equal(e.SUBS.m.get(key).meta.u, "2026-12-24");
  assert.equal(e.SUBS.m.get(key).meta.c, "2026-11-24");
  await withDate("2026-12-25T03:00:00Z", () => call(e, "/subscribe", subBody(1, ["yonezawacity/Yonezawa", "omachicity/omachiraicholiner"], k), app));
  assert.equal(e.SUBS.writes, 3); // バスが変わったら、すぐ書く
  assert.equal(e.SUBS.m.size, 1);
});

test("止める：/unsubscribe で、その場で宛先が消える", async () => {
  const e = env();
  const b = subBody(1);
  await call(e, "/subscribe", b, app);
  assert.equal(e.SUBS.m.size, 1);
  assert.equal((await call(e, "/unsubscribe", { endpoint: b.subscription.endpoint }, app)).status, 200);
  assert.equal(e.SUBS.m.size, 0);
});

// ---------- 送る ----------
test("送る：合言葉が無い・違うときは断る。公開中の改正でなければ断る", async () => {
  const e = env();
  assert.equal((await call(e, "/notify", { feed: "yonezawacity/Yonezawa", change_date: "2026-12-01" })).status, 401);
  assert.equal((await call(e, "/notify", { feed: "yonezawacity/Yonezawa", change_date: "2026-12-01" }, { Authorization: "Bearer wrong" })).status, 401);
  const auth = { Authorization: "Bearer secret-token" };
  await withDate("2026-11-24T03:00:00Z", async () => {
    assert.equal((await call(e, "/notify", { feed: "yonezawacity/Yonezawa", change_date: "2026-12-08" }, auth)).status, 409);
    assert.equal((await call(e, "/notify", { feed: "omachicity/omachiraicholiner", change_date: "2026-12-01" }, auth)).status, 409);
  });
  await withDate("2027-01-05T03:00:00Z", async () => { // 変わる日から30日より後
    assert.equal((await call(e, "/notify", { feed: "yonezawacity/Yonezawa", change_date: "2026-12-01" }, auth)).status, 409);
  });
});

test("送る：そのバスを登録した宛先にだけ、10ずつ分けて送る。404・410 の宛先は消す。同じ改正は二度送らない", async () => {
  const e = env();
  for (let i = 0; i < 23; i++) await call(e, "/subscribe", subBody(i), app);
  await call(e, "/subscribe", subBody(99, ["omachicity/omachiraicholiner"]), app); // 別のバス
  const gone = new Set([(await subBody(3)).subscription.endpoint]);
  pushStatus = (u) => (gone.has(u) ? 410 : 201);
  pushed.length = 0;
  const auth = { Authorization: "Bearer secret-token" };
  let after = null, sent = 0, removed = 0, calls = 0;
  await withDate("2026-11-24T03:00:00Z", async () => {
    do {
      const r = await (await call(e, "/notify", { feed: "yonezawacity/Yonezawa", change_date: "2026-12-01", after }, auth)).json();
      sent += r.sent; removed += r.removed; after = r.next; calls++;
    } while (after);
    const again = await (await call(e, "/notify", { feed: "yonezawacity/Yonezawa", change_date: "2026-12-01" }, auth)).json();
    assert.equal(again.already, true);
  });
  assert.equal(calls, Math.ceil(23 / BATCH));
  assert.equal(sent, 22);
  assert.equal(removed, 1);
  assert.equal(pushed.length, 23);
  assert.ok(pushed.every((p) => !p.url.includes("QK0099")));
  assert.ok(pushed.every((p) => p.init.headers["Content-Encoding"] === "aes128gcm" && p.init.headers.Authorization.startsWith("vapid t=")));
  assert.equal(e.SUBS.m.has(await subKey((await subBody(3)).subscription.endpoint)), false);
  pushStatus = () => 201;
});

test("定時の処理：1年間更新の無い宛先を消す", async () => {
  const e = env();
  await withDate("2025-11-20T03:00:00Z", () => call(e, "/subscribe", subBody(1), app));
  await withDate("2026-11-20T03:00:00Z", () => call(e, "/subscribe", subBody(2), app));
  assert.equal(await expire(e, "2026-11-24"), 1);
  assert.equal(e.SUBS.m.size, 1);
});

test("送る：変わる日が分からない改正（一覧に change_date_known: false）は、中身に known: false を入れる", async () => {
  const e = env();
  const k = uaKeys();
  await call(e, "/subscribe", subBody(1, ["yonezawacity/Yonezawa"], k), app);
  CATALOG.feeds[0].revisions.push({ change_date: "2026-11-24", change_date_known: false });
  pushed.length = 0;
  await withDate("2026-11-24T03:00:00Z", () => call(e, "/notify", { feed: "yonezawacity/Yonezawa", change_date: "2026-11-24" }, { Authorization: "Bearer secret-token" }));
  CATALOG.feeds[0].revisions.pop();
  assert.equal(pushed.length, 1);
  // 受け手の鍵で読み戻す
  const body = new Uint8Array(await new Response(pushed[0].init.body).arrayBuffer());
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const h = (key, data) => nodeCrypto.createHmac("sha256", key).update(data).digest();
  const ikm = h(h(unb64u(k.auth), k.ecdh.computeSecret(asPub)), Buffer.concat([Buffer.from("WebPush: info\0"), unb64u(k.p256dh), asPub, Buffer.from([1])]));
  const prk = h(salt, ikm);
  const d = nodeCrypto.createDecipheriv("aes-128-gcm", h(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16), h(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).subarray(0, -1).toString();
  assert.deepEqual(JSON.parse(plain), { feed: "yonezawacity/Yonezawa", change_date: "2026-11-24", known: false });
});

test("試し：端末の番号の1つの宛先だけに送り、送った印は付けない（あとで本物を送れる）", async () => {
  const e = env();
  for (let i = 0; i < 3; i++) await call(e, "/subscribe", subBody(i), app);
  const target = (await subBody(1)).subscription.endpoint;
  const no = (await subKey(target)).slice(2, 10);
  const auth = { Authorization: "Bearer secret-token" };
  pushed.length = 0;
  await withDate("2026-11-24T03:00:00Z", async () => {
    const r = await (await call(e, "/notify", { feed: "yonezawacity/Yonezawa", change_date: "2026-12-01", test: true, to: no }, auth)).json();
    assert.equal(r.sent, 1);
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].url, target);
    assert.ok(![...e.SUBS.m.keys()].some((k) => k.startsWith("n:")));
    assert.equal((await call(e, "/notify", { feed: "yonezawacity/Yonezawa", change_date: "2026-12-01", test: true, to: "zzzz" }, auth)).status, 400);
    assert.equal((await call(e, "/notify", { feed: "yonezawacity/Yonezawa", change_date: "2026-12-01", test: true, to: "00000000" }, auth)).status, 404);
    assert.equal((await call(e, "/notify", { feed: "yonezawacity/Yonezawa", change_date: "2026-12-01", test: true, to: no })).status, 401);
    const real = await (await call(e, "/notify", { feed: "yonezawacity/Yonezawa", change_date: "2026-12-01" }, auth)).json();
    assert.equal(real.already, undefined);
    assert.equal(real.sent, 3);
  });
});

test("定時の処理：見る仕組みを workflow_dispatch で呼ぶ（点検の時刻は full）。鍵が無ければ呼ばない", async () => {
  const runs = async (e, cron) => {
    pushed.length = 0;
    const waits = [];
    await worker.scheduled({ cron }, e, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    return pushed.filter((x) => x.url.includes("api.github.com"));
  };
  const e = { ...env(), GH_REPO: "owner/repo", GH_DISPATCH_TOKEN: "gh-token" };
  pushStatus = () => 204;
  let calls = await runs(e, CRON_WATCH);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/owner/repo/actions/workflows/daily-watch.yml/dispatches");
  assert.equal(calls[0].init.headers.Authorization, "Bearer gh-token");
  assert.deepEqual(JSON.parse(calls[0].init.body), { ref: "main", inputs: { full: "false", by: "cloudflare" } });
  calls = await runs(e, CRON_FULL);
  assert.equal(JSON.parse(calls[0].init.body).inputs.full, "true");
  calls = await runs(env(), CRON_WATCH);
  assert.equal(calls.length, 0);
  calls = await runs(e, "23 18 * * *"); // 宛先を消す時刻には呼ばない
  assert.equal(calls.length, 0);
  pushStatus = () => 201;
});

test("定時の処理：GitHub が受け付けなかったら1回だけやり直し、それでもだめなら時刻と番号を記録する", async () => {
  const e = { ...env(), GH_REPO: "owner/repo", GH_DISPATCH_TOKEN: "gh-token" };
  const gh = () => pushed.filter((x) => x.url.includes("api.github.com")).length;
  // 1回目 503、2回目 204：記録しない
  pushed.length = 0;
  let n = 0;
  pushStatus = () => (n++ === 0 ? 503 : 204);
  let r = await dispatchWatch(e, false, 0);
  assert.equal(r.ok, true);
  assert.equal(gh(), 2);
  assert.equal(await e.SUBS.get(DISPATCH_LOG, "json"), null);
  // 2回とも 401：2回だけ呼び、記録する
  pushed.length = 0;
  pushStatus = () => 401;
  r = await dispatchWatch(e, true, 0);
  assert.equal(r.ok, false);
  assert.equal(gh(), 2);
  const log = await e.SUBS.get(DISPATCH_LOG, "json");
  assert.equal(log.length, 1);
  assert.deepEqual(log[0].status, [401, 401]);
  assert.equal(log[0].full, true);
  assert.match(log[0].at, /^\d{4}-\d{2}-\d{2}T/);
  pushStatus = () => 201;
});
