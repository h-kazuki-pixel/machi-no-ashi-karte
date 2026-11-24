# 通知（Web Push）を動かす手順

通知のサーバーは `push/`（Cloudflare Workers ＋ Workers KV）です。アプリの側は `app/sw.js`・`app/js/push.js`・`app/js/config.js`、見る仕組みの側は `scripts/10_notify.py` です。
`app/js/config.js` が空のあいだは、アプリに通知の画面は出ません。見る仕組みも、`NOTIFY_URL`・`NOTIFY_TOKEN` が無ければ送りません。

## 開発者がすること（順番に）

1. **Cloudflare のアカウントを作る**：https://dash.cloudflare.com/sign-up（無料のプラン）。メールの確認まで済ませる。
2. **workers.dev のサブドメインを決める**：「Workers & Pages」を開くと聞かれる。公開の URL に出るので、個人の名前を避ける（例：`machi-no-ashi`）。
3. **合言葉を作って控える**：手元で `openssl rand -base64 32`。GitHub と Workers の両方に入れる。
4. **wrangler にログインする**：この画面で `! npx wrangler@4 login` と打ち、開いたブラウザで許可する。
5. **KV を作る**（Claude がします）：`npx wrangler@4 kv namespace create SUBS --config push/wrangler.toml` → 出た id を `push/wrangler.toml` に入れる。
6. **秘密の値を Workers に入れる**（開発者が打つ。値は画面にもファイルにも残りません）：
   - `! node push/tools/make_vapid.mjs | npx wrangler@4 secret put VAPID_PRIVATE_JWK --config push/wrangler.toml`
     （VAPID の鍵の組を作り、秘密の鍵はそのまま Workers へ。公開の鍵は `app/js/config.js` に書かれる）
   - `! npx wrangler@4 secret put NOTIFY_TOKEN --config push/wrangler.toml`（聞かれたら 3 の合言葉を貼る）
7. **Workers に載せる**（了承をいただいてから、Claude がします）：`npx wrangler@4 deploy --config push/wrangler.toml` → 出た URL（`https://machi-no-ashi-push.○○.workers.dev`）を `app/js/config.js` の `server` に入れる。
8. **GitHub の Secrets に入れる**：リポジトリの Settings → Secrets and variables → Actions → New repository secret
   - `NOTIFY_URL`：7 の URL
   - `NOTIFY_TOKEN`：3 の合言葉
9. **Cloudflare の画面で確かめる**：Workers → machi-no-ashi-push → Settings → Observability（ログ）が「無効」になっていること。

## 動き

| いつ | 何が起きるか |
|---|---|
| 使う人が「知らせを受け取る」を押す | 通知の許可 → ブラウザが宛先（URL と鍵）を作る → `/subscribe` に宛先と登録したバスの番号を送る |
| 登録した移動を足す・消す | バスの一覧が変わったら、すぐ `/subscribe` で上書き。登録したバスが無くなったら、通知を止めて宛先を消す |
| アプリを開く | バスの一覧が同じなら、前に送ってから30日以上たったときだけ送る（サーバーの「更新した日」を新しくする） |
| 見る仕組みが改正を公開する | 待ち行列に入れる → Pages に出したあと `10_notify.py` が `/notify` を呼ぶ → そのバスを登録した宛先に10ずつ送る |
| 端末に届く | 中身は「バスの番号と変わる日」だけ。service worker が「◯◯の時刻表が、◯月◯日から変わります。」（当日かあとは「◯月◯日に変わりました。」）と出す |
| 通知を押す | そのバスの、登録した移動ごとの結果の画面。変わらない移動は「あなたの移動は変わりません」 |
| 「知らせを止める」 | 端末の受け取りをやめ、`/unsubscribe` でサーバーから宛先をその場で消す |
| 毎日 3:23 | 1年間更新の無い宛先を消す |

## 守り

- `/subscribe`・`/unsubscribe`：アプリのページ（`https://h-kazuki-pixel.github.io`）からの呼び出しだけ。宛先は Apple・Google・Mozilla・Microsoft の配達サービスの URL だけ。鍵の長さを確かめる。バスは一覧にある使えるバスを20まで。同じ宛先は上書き。同じところから60秒に10回まで（Cloudflare の回数の制限。IP は数えるのに使うだけで、残さない）。
- `/notify`：合言葉（`Authorization: Bearer`）が要る。そのうえ、公開中の一覧（catalog.json）にその改正があり、変わる日から30日以内のときだけ送る。同じ改正は二度送らない（60日の印）。
- 届かなくなった宛先：配達サービスが 404・410 を返したら消す。

## サーバーに残るもの

| キー | 中身 |
|---|---|
| `s:{宛先のハッシュ}` | 値：宛先 URL・p256dh・auth・バスの番号の一覧。メタデータ：バスの番号のハッシュ（8文字）・登録した日・更新した日（日付だけ） |
| `n:{バスの番号}:{変わる日}` | 送った印（60日で自動で消える） |

IP アドレス・端末の情報・停留所・時刻・移動の名前は残しません。ログも取りません。Cloudflare は、動かすために IP アドレスを扱います（Cloudflare の方針による）。

## 無料のプランの範囲（Cloudflare の説明で確かめたもの）

- リクエスト：1日10万回。KV：読み1日10万回・書き1,000回・消す1,000回・一覧1,000回。
- 1回の呼び出しの CPU の時間が短い（10ms）ため、1回の `/notify` で送るのは10の宛先まで。続きは見る仕組みが続けて呼ぶ。
- 定時の処理（Cron Triggers）：アカウントで5つまで。ここで使うのは1つ。
- 回数の制限（Rate Limiting の仕組み）が無料のプランで使えるかは、説明で確かめられませんでした。載せるときに断られたら、`push/wrangler.toml` の `[[ratelimits]]` を外します（ほかの守りは残ります）。

## 試験

- `cd push && npm test`：暗号（RFC 8291）の読み戻し、VAPID（RFC 8292）の署名の確認、登録の断り方、30日の決まり、10ずつ送る・404/410 で消す・二度送らない、1年で消す。
- 手元の iPhone と Android での受け取り・表示・停止は、Workers に載せたあとに確かめます。
