// Web Push の送信（依存なし。WebCrypto だけを使う。Cloudflare Workers と Node 20 以降で動く）
//   中身の暗号化：RFC 8291（aes128gcm）  送り手の名乗り：RFC 8292（VAPID、ES256 の JWT）
const enc = new TextEncoder();

export function b64u(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64u(s) {
  const t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "===".slice((t.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

// RFC 8291：受け手の公開鍵（p256dh, 65バイト）と auth（16バイト）で、中身を暗号化する
//   asKeys・salt は試験のときだけ渡す（ふだんは毎回作る）
export async function encryptPayload(plaintext, p256dh, auth, { asKeys, salt } = {}) {
  const uaPublic = typeof p256dh === "string" ? unb64u(p256dh) : p256dh;
  const authSecret = typeof auth === "string" ? unb64u(auth) : auth;
  const as = asKeys || (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, Uint8Array.of(1)));
  const s = salt || crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(s, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), Uint8Array.of(1)))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), Uint8Array.of(1)))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const body = typeof plaintext === "string" ? enc.encode(plaintext) : plaintext;
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(body, Uint8Array.of(2))));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(s, rs, Uint8Array.of(asPublic.length), asPublic, ct);
}

// RFC 8292：VAPID の JWT（aud＝配達サービスの origin）。privateJwk は {kty, crv, x, y, d}
export async function vapidAuth(endpoint, privateJwk, subject, ttlSec = 12 * 3600, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + ttlSec, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", { ...privateJwk, key_ops: ["sign"], ext: true },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`)));
  const publicRaw = concat(Uint8Array.of(4), unb64u(privateJwk.x), unb64u(privateJwk.y));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${b64u(publicRaw)}`;
}

// 1つの宛先に送る。戻り値は配達サービスの HTTP の状態（201 などは届いた、404・410 は宛先がもう無い）
export async function sendPush(sub, payload, { privateJwk, subject, ttl = 3 * 86400, fetchFn = fetch, authCache } = {}) {
  const body = await encryptPayload(payload, sub.p256dh, sub.auth);
  const aud = new URL(sub.endpoint).origin;
  let authz = authCache && authCache.get(aud);
  if (!authz) {
    authz = await vapidAuth(sub.endpoint, privateJwk, subject);
    if (authCache) authCache.set(aud, authz); // 同じ配達サービスには、同じ名乗りを使い回す（計算を減らす）
  }
  const r = await fetchFn(sub.endpoint, {
    method: "POST",
    headers: { Authorization: authz, "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
               TTL: String(ttl), Urgency: "normal" },
    body,
  });
  return r.status;
}
