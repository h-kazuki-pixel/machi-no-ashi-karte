// VAPID の鍵の組を作る。
//   公開の鍵 → app/js/config.js に書く（アプリに入れる。公開してよい）
//   秘密の鍵 → 画面に出さず、そのまま Workers の Secrets に入れる：
//     node push/tools/make_vapid.mjs | npx wrangler secret put VAPID_PRIVATE_JWK --config push/wrangler.toml
//   （出力先が画面のときは、秘密の鍵を出さずに止まる）
import crypto from "node:crypto";
import fs from "node:fs";

if (process.stdout.isTTY) {
  console.error("秘密の鍵を画面に出さないため、止めました。上のように | で wrangler secret put につないでください。");
  process.exit(1);
}
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = privateKey.export({ format: "jwk" });
const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-65);
const pub = Buffer.from(raw).toString("base64url");
const p = new URL("../../app/js/config.js", import.meta.url);
const s = fs.readFileSync(p, "utf8").replace(/vapidPublicKey: "[^"]*"/, `vapidPublicKey: "${pub}"`);
fs.writeFileSync(p, s);
console.error(`公開の鍵を app/js/config.js に書きました：${pub}`);
process.stdout.write(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }));
