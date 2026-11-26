// まちの足カルテ：通知のサーバー（Cloudflare Workers ＋ Workers KV）
//
// 持つもの（KV）：  キー "s:{宛先のハッシュ}"
//   値          { e: 宛先 URL, p: p256dh, a: auth, f: [バスの番号] }
//   メタデータ   { h: [バスの番号のハッシュ（8文字）], c: 登録した日, u: 更新した日 }   日付は「YYYY-MM-DD」だけ（時刻は残さない）
//   ほかに、同じ改正を二度送らないための印 "n:{バスの番号}:{変わる日}"（60日で自動で消える）
// 持たないもの：IP アドレス・端末の情報・停留所・時刻・移動の名前。console.log もしない。
//
//   POST /subscribe     { subscription: {endpoint, keys: {p256dh, auth}}, feeds: [...], old_endpoint? }   アプリから
//   POST /unsubscribe   { endpoint }                                                                 アプリから
//   POST /notify        { feed, change_date, after? }  合言葉（Authorization: Bearer）つき                見る仕組みから
//                       { feed, change_date, test: true, to: "端末の番号（8文字）" }  試し：その1つの宛先だけに送る。送った印は付けない
//   毎日の定時の処理     1年間更新の無い宛先を消す
import { sendPush, b64u, unb64u } from "./webpush.js";

export const MAX_FEEDS = 20;       // 1つの宛先に登録できるバスの数
export const BATCH = 10;           // 1回の /notify で送る宛先の数（無料プランの CPU の時間に収める。続きは after で）
export const REFRESH_DAYS = 30;    // 更新の日時は、前の更新から30日以上たっているときだけ新しくする
export const EXPIRE_DAYS = 365;    // 1年間更新の無い宛先は消す
export const RECENT_DAYS = 30;     // 変わる日からこの日数より前の改正は送らない（アプリの知らせと同じ）
const MAX_BODY = 4096;
// 宛先として受け付ける配達サービス（Apple・Google・Mozilla・Microsoft）
const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/,
                    /^[a-z0-9-]+\.notify\.windows\.com$/];

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } });

export function todayJst(now = Date.now()) {
  return new Date(now + 9 * 3600000).toISOString().slice(0, 10);
}
export function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}
async function sha256hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export const subKey = async (endpoint) => `s:${(await sha256hex(endpoint)).slice(0, 32)}`;
export const feedHash = async (feed) => (await sha256hex(`feed:${feed}`)).slice(0, 8);

function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

export function validEndpoint(e) {
  if (typeof e !== "string" || e.length > 1024) return false;
  try {
    const u = new URL(e);
    return u.protocol === "https:" && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}
function validKeys(k) {
  try {
    const p = unb64u(k.p256dh), a = unb64u(k.auth);
    return p.length === 65 && p[0] === 4 && a.length === 16;
  } catch {
    return false;
  }
}

// 公開中のバスの一覧（GitHub Pages の catalog.json）。fresh=true のときは手元の写しを使わない
async function catalog(env, fresh = false) {
  const r = await fetch(`${env.PAGES_BASE}/data/catalog.json`, fresh ? { cache: "no-store" } : { cf: { cacheTtl: 3600 } });
  if (!r.ok) throw new Error("catalog");
  return r.json();
}

async function readBody(req) {
  const len = Number(req.headers.get("Content-Length") || 0);
  if (len > MAX_BODY) return null;
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function cors(env) {
  return { "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN, "Access-Control-Allow-Methods": "POST",
           "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400", Vary: "Origin" };
}

// ---------- アプリから ----------
async function subscribe(req, env) {
  const body = await readBody(req);
  const sub = body && body.subscription;
  if (!sub || !validEndpoint(sub.endpoint) || !sub.keys || !validKeys(sub.keys)) return json({ error: "bad_subscription" }, 400, cors(env));
  const feeds = Array.isArray(body.feeds) ? [...new Set(body.feeds)] : [];
  if (!feeds.length || feeds.length > MAX_FEEDS || !feeds.every((f) => typeof f === "string" && f.length <= 100)) {
    return json({ error: "bad_feeds" }, 400, cors(env));
  }
  const cat = await catalog(env);
  const usable = new Set(cat.feeds.filter((f) => f.usable).map((f) => f.feed));
  if (!feeds.every((f) => usable.has(f))) return json({ error: "unknown_feed" }, 400, cors(env));
  feeds.sort();
  const today = todayJst();
  const key = await subKey(sub.endpoint);
  const old = await env.SUBS.getWithMetadata(key, "json");
  const same = old.value && old.value.p === sub.keys.p256dh && old.value.a === sub.keys.auth
    && JSON.stringify(old.value.f) === JSON.stringify(feeds);
  // 中身が同じで、前の更新から30日たっていなければ書かない（KV の書き込みを減らす）
  if (same && old.metadata && daysBetween(old.metadata.u, today) < REFRESH_DAYS) return json({ ok: true, wrote: false }, 200, cors(env));
  const meta = { h: await Promise.all(feeds.map(feedHash)), c: (old.metadata && old.metadata.c) || today, u: today };
  await env.SUBS.put(key, JSON.stringify({ e: sub.endpoint, p: sub.keys.p256dh, a: sub.keys.auth, f: feeds }), { metadata: meta });
  if (body.old_endpoint && body.old_endpoint !== sub.endpoint && validEndpoint(body.old_endpoint)) {
    await env.SUBS.delete(await subKey(body.old_endpoint)); // 宛先が変わった（ブラウザが作り直した）とき
  }
  return json({ ok: true, wrote: true }, 200, cors(env));
}

async function unsubscribe(req, env) {
  const body = await readBody(req);
  if (!body || !validEndpoint(body.endpoint)) return json({ error: "bad_endpoint" }, 400, cors(env));
  await env.SUBS.delete(await subKey(body.endpoint));
  return json({ ok: true }, 200, cors(env));
}

// ---------- 見る仕組みから ----------
async function listAll(env, prefix) {
  const out = [];
  let cursor;
  do {
    const r = await env.SUBS.list({ prefix, cursor });
    out.push(...r.keys);
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out;
}

async function notify(req, env) {
  const auth = req.headers.get("Authorization") || "";
  if (!env.NOTIFY_TOKEN || !timingSafeEqual(auth, `Bearer ${env.NOTIFY_TOKEN}`)) return json({ error: "unauthorized" }, 401);
  const body = await readBody(req);
  const { feed, change_date: change, after } = body || {};
  if (typeof feed !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(change || "")) return json({ error: "bad_request" }, 400);
  const test = body.test === true;
  if (test && !/^[0-9a-f]{8}$/.test(body.to || "")) return json({ error: "bad_device_number" }, 400);
  // 合言葉が漏れても、公開中の改正のときにしか送れない：一覧にその改正があり、変わる日が30日より前でないこと
  const cat = await catalog(env, true);
  const item = cat.feeds.find((f) => f.feed === feed);
  const today = todayJst();
  const rev = item && item.revisions.find((r) => r.change_date === change);
  if (!rev || daysBetween(change, today) > RECENT_DAYS) {
    return json({ error: "not_published" }, 409);
  }
  // 中身はバスの番号と変わる日だけ（変わる日が分からない改正は、その印も。一覧から決める）
  // again：公開中の改正が作り直されて便や時刻が変わったときの、もう一度の知らせ（前の知らせを送ったあとのときだけ、1回だけ）
  const again = body.again === true && !test;
  const payload = JSON.stringify({ feed, change_date: change, ...(rev.change_date_known === false ? { known: false } : {}),
                                   ...(test ? { test: true } : {}), ...(again ? { again: true } : {}) });
  const authCache = new Map();
  if (test) return await notifyTest(env, body.to, feed, payload, authCache);
  const first = `n:${feed}:${change}`;
  const mark = again ? `${first}:again` : first;
  if (!after) {
    if (again && !(await env.SUBS.get(first))) return json({ ok: true, skipped: "not_sent_before", sent: 0, next: null });
    if (await env.SUBS.get(mark)) return json({ ok: true, already: true, sent: 0, next: null });
    await env.SUBS.put(mark, today, { expirationTtl: 60 * 86400 });
  }
  const h = await feedHash(feed);
  const targets = (await listAll(env, "s:")).filter((k) => k.metadata && k.metadata.h && k.metadata.h.includes(h))
    .map((k) => k.name).sort().filter((n) => !after || n > after);
  const batch = targets.slice(0, BATCH);
  let sent = 0, removed = 0, failed = 0;
  for (const name of batch) {
    const v = await env.SUBS.get(name, "json");
    if (!v || !v.f.includes(feed)) continue;
    let status;
    try {
      status = await sendPush({ endpoint: v.e, p256dh: v.p, auth: v.a }, payload,
        { privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK), subject: env.VAPID_SUBJECT, authCache });
    } catch {
      failed++;
      continue;
    }
    if (status === 404 || status === 410) {
      await env.SUBS.delete(name); // 宛先がもう無い（通知を止めた・アプリを消したなど）
      removed++;
    } else if (status >= 200 && status < 300) sent++;
    else failed++;
  }
  const next = targets.length > BATCH ? batch[batch.length - 1] : null;
  return json({ ok: true, sent, removed, failed, next, remaining: Math.max(0, targets.length - batch.length) });
}

// 試し：端末の番号（宛先のハッシュの先頭8文字。アプリの画面に出る）の1つの宛先だけに送る。送った印は付けない
async function notifyTest(env, to, feed, payload, authCache) {
  const keys = (await env.SUBS.list({ prefix: `s:${to}` })).keys;
  if (keys.length !== 1) return json({ error: "no_such_device" }, 404);
  const v = await env.SUBS.get(keys[0].name, "json");
  const status = await sendPush({ endpoint: v.e, p256dh: v.p, auth: v.a }, payload,
    { privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK), subject: env.VAPID_SUBJECT, authCache });
  if (status === 404 || status === 410) {
    await env.SUBS.delete(keys[0].name);
    return json({ ok: false, test: true, removed: 1, status });
  }
  return json({ ok: status >= 200 && status < 300, test: true, sent: status >= 200 && status < 300 ? 1 : 0, status, registered_feed: v.f.includes(feed) });
}

// ---------- 毎日の定時の処理 ----------
export async function expire(env, today = todayJst()) {
  let n = 0;
  for (const k of await listAll(env, "s:")) {
    if (!k.metadata || daysBetween(k.metadata.u, today) >= EXPIRE_DAYS) {
      await env.SUBS.delete(k.name);
      n++;
    }
  }
  return n;
}

// ---------- 見る仕組み（GitHub Actions の daily-watch）を、決まった時刻に呼ぶ ----------
// GitHub の定時の実行は、遅れたり抜けたりするので、Cloudflare の定時の仕組みから workflow_dispatch で呼ぶ。
// 鍵（GH_DISPATCH_TOKEN）は、このリポジトリの Actions を動かす権限だけを持つ（Secrets に入れる）。
export const CRON_WATCH = "17 */6 * * *"; // 日本時間 9:17・15:17・21:17・3:17
export const CRON_FULL = "47 18 * * 6";   // 日本時間 日曜 3:47：全フィードの版を取り直す（点検）
export const DISPATCH_LOG = "log:dispatch_failures"; // 呼べなかった記録（新しい順に50件まで）
async function callDispatch(env, full) {
  try {
    const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/daily-watch.yml/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "machi-no-ashi-push",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs: { full: full ? "true" : "false", by: "cloudflare" } }),
    });
    return res.status;
  } catch {
    return 0; // GitHub に届かなかった
  }
}
// GitHub が受け付けなかった（2xx 以外）ときは、少し待って1回だけやり直す。それでもだめなら、時刻と番号を KV に残す
export async function dispatchWatch(env, full, waitMs = 20000) {
  if (!env.GH_DISPATCH_TOKEN || !env.GH_REPO) return { ok: false, status: 0 };
  const first = await callDispatch(env, full);
  if (first >= 200 && first < 300) return { ok: true, status: first };
  if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
  const second = await callDispatch(env, full);
  if (second >= 200 && second < 300) return { ok: true, status: second, retried: true };
  const log = (await env.SUBS.get(DISPATCH_LOG, "json")) || [];
  log.unshift({ at: new Date().toISOString(), full, status: [first, second] });
  await env.SUBS.put(DISPATCH_LOG, JSON.stringify(log.slice(0, 50)));
  return { ok: false, status: second };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const fromApp = url.pathname === "/subscribe" || url.pathname === "/unsubscribe";
    if (fromApp) {
      // アプリのページ（GitHub Pages）からの呼び出しだけを受け付ける
      if (req.headers.get("Origin") !== env.ALLOWED_ORIGIN) return json({ error: "forbidden" }, 403);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });
      // 同じところから短い間に何度も呼ばれたら断る（Cloudflare の回数の制限。IP は数えるのに使うだけで、残さない）
      if (env.SUB_LIMIT) {
        const { success } = await env.SUB_LIMIT.limit({ key: req.headers.get("CF-Connecting-IP") || "unknown" });
        if (!success) return json({ error: "too_many" }, 429, cors(env));
      }
    }
    if (req.method !== "POST") return json({ error: "not_found" }, 404);
    try {
      if (url.pathname === "/subscribe") return await subscribe(req, env);
      if (url.pathname === "/unsubscribe") return await unsubscribe(req, env);
      if (url.pathname === "/notify") return await notify(req, env);
    } catch {
      return json({ error: "server" }, 500, fromApp ? cors(env) : {});
    }
    return json({ error: "not_found" }, 404);
  },
  async scheduled(event, env, ctx) {
    if (event.cron === CRON_WATCH) return ctx.waitUntil(dispatchWatch(env, false));
    if (event.cron === CRON_FULL) return ctx.waitUntil(dispatchWatch(env, true));
    ctx.waitUntil(expire(env));
  },
};

export { b64u };
