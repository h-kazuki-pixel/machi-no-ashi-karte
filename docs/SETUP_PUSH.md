# 通知（Web Push）を動かす手順

通知のサーバーは `push/`（Cloudflare Workers ＋ Workers KV）です。アプリの側は `app/sw.js`・`app/js/push.js`・`app/js/config.js`、見る仕組みの側は `scripts/10_notify.py` です。
`app/js/config.js` が空のあいだは、アプリに通知の画面は出ません。見る仕組みも、`NOTIFY_URL`・`NOTIFY_TOKEN` が無ければ送りません。

## 動かす手順（2026-11-24 の状態）

workers.dev のサブドメインは `h-kazuki`。通知のサーバーの URL は `https://machi-no-ashi-push.h-kazuki.workers.dev` になる。
このアカウントには、ほかの Workers と KV（LINE_STATE）もある。ここで作るのは、名前が `machi-no-ashi-push` の Worker と、
KV `machi-no-ashi-push-SUBS` だけ。回数の制限の番号（namespace_id）も、ほかと重ならない番号にした。

1. ✅ Cloudflare のアカウント・サブドメイン・合言葉（開発者）
2. ✅ wrangler のログイン：この端末は、すでにこのアカウントにログインしている（`npx wrangler@4 whoami` で確かめた）
3. ✅ KV を作る：`machi-no-ashi-push-SUBS`（id は `push/wrangler.toml`）。載せる前の試し（`--dry-run`）も通った
4. **Workers に載せる**（了承をいただいてから、Claude）：`npx wrangler@4 deploy --config push/wrangler.toml`
   - 無料のプランで回数の制限が断られたら、`[[ratelimits]]` を外して載せ直し、そのことを報告する
5. **秘密の値を入れる**（開発者が、この画面で打つ。値は画面にもファイルにも残らない）
   - `! WRANGLER_SEND_METRICS=false node push/tools/make_vapid.mjs | npx wrangler@4 secret put VAPID_PRIVATE_JWK --config push/wrangler.toml`
     （VAPID の鍵の組を作り、秘密の鍵はそのまま Workers へ。公開の鍵は `app/js/config.js` に書かれる）
   - `! WRANGLER_SEND_METRICS=false npx wrangler@4 secret put NOTIFY_TOKEN --config push/wrangler.toml`（聞かれたら、控えた合言葉を貼る）
6. **アプリの設定**（Claude）：`app/js/config.js` の `server` に URL を入れてコミットする。次の定時の実行で、アプリに「知らせを受け取る」が出る
7. **GitHub の Secrets**（開発者）：Settings → Secrets and variables → Actions → New repository secret
   - `NOTIFY_URL`：`https://machi-no-ashi-push.h-kazuki.workers.dev`
   - `NOTIFY_TOKEN`：5 と同じ合言葉
8. **Cloudflare の画面で確かめる**（開発者）：Workers & Pages → machi-no-ashi-push → Settings → Observability（ログ）が無効
9. **手元の iPhone と Android で確かめる**：受け取る・止める・通知を押して開く画面（下の「試しの送り方」）

## 試しの送り方（本物の改正と分ける）

- `/notify` に `"test": true` と `"to": "端末の番号"` を付けると、その1つの宛先だけに送る。送った印（二度送らない記録）は付けない。
- 端末の番号は、アプリの「知らせを受け取っています」の下に出る8文字（宛先のハッシュの先頭。宛先の URL は出さない）。
- 通知の文は、本物と同じ形に「（試し）」が付く。押して開く画面の見出しにも「（試し）」が付く。
- 公開中の改正（一覧にあるもの）でしか送れないのは、本物と同じ。合言葉も要る。

```
read -s T   # 合言葉を貼って Enter（画面に出ない・履歴に残らない）
curl -s -X POST -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  -d '{"feed":"yonezawacity/Yonezawa","change_date":"2026-12-01","test":true,"to":"端末の番号"}' \
  https://machi-no-ashi-push.h-kazuki.workers.dev/notify; echo; unset T
```
返事：`{"ok":true,"test":true,"sent":1,"status":201,"registered_feed":true}`（registered_feed は、その端末がそのバスを登録しているか）

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

## 見る仕組みを、Cloudflare の定時の仕組みから呼ぶ（2026-11-25）

GitHub の定時の実行は、遅れたり抜けたりします（11/24〜25 の4回の予定のうち、動いたのは2回で、2時間16分と5時間34分おくれ）。
そこで、通知のサーバーの Worker が、決まった時刻に daily-watch を `workflow_dispatch` で呼びます。

| 時刻（日本時間） | Worker の cron（UTC） | すること |
|---|---|---|
| 9:17・15:17・21:17・3:17 | `17 */6 * * *` | daily-watch を呼ぶ（受け付けられなければ1回だけやり直す） |
| 日曜 3:47 | `47 18 * * 6` | daily-watch を「点検」（全フィードの版を取り直す）で呼ぶ |
| 毎日 3:23 | `23 18 * * *` | 1年間更新の無い宛先を消す（前から） |

- GitHub の定時の実行は予備として残します。前の5時間50分のうちに、ほかの実行がもう始まっていれば（点検の予備は、点検の実行があれば）、何もしないで終わります（`guard` のジョブ）。
- 同時に2つは動かしません（`concurrency`）。
- zip の置き換えの確かめ（ETag）は、日本時間 3時を過ぎて最初の実行でします（1日1回）。

### GitHub の鍵（GH_DISPATCH_TOKEN）の作り方

鍵は、このリポジトリの Actions を動かす権限だけを持たせます。値は Claude にも、ファイルにも渡しません。

1. GitHub の右上のアイコン →「Settings」→ 左の下の「Developer settings」→「Personal access tokens」→「Fine-grained tokens」→「Generate new token」。
2. 次のように入れます。
   - Token name：`machi-no-ashi-dispatch`
   - Expiration：「Custom」を選び、**2027年3月31日**（切れる日の少し前に作り直します。切れると、Worker の呼び出しは断られ（401）、予備の GitHub の定時の実行だけになります）
   - Resource owner：`h-kazuki-pixel`
   - Repository access：「Only select repositories」→ `machi-no-ashi-karte` だけ
   - Permissions →「Repository permissions」→「Actions」を「Read and write」（ほかは触らない。Metadata の Read-only は自動で付きます）
3. 「Generate token」を押し、出てきた値をコピーします（この画面を閉じると、二度と見られません）。
4. Mac のターミナルで、次を打ち、聞かれたら貼りつけて Enter：
   ```
   cd ~/machi-no-ashi-karte/push && npx wrangler secret put GH_DISPATCH_TOKEN
   ```
5. コピーした値は、クリップボードから消しておきます（別の文字をコピーする）。

鍵が入っていないあいだは、Worker は daily-watch を呼びません（GitHub の定時の実行だけで動きます）。

### 呼べなかったときの記録

- GitHub が受け付けなかったとき（2xx 以外、または届かなかったとき）は、20秒待って1回だけやり直します。
- それでもだめなら、KV の `log:dispatch_failures` に、時刻（UTC）・点検かどうか・返ってきた番号（1回目と2回目。届かなかったときは 0）を残します。新しい順に50件までです。
- 見るときは、Mac のターミナルで：
  ```
  cd ~/machi-no-ashi-karte/push && npx wrangler kv key get --binding SUBS "log:dispatch_failures" --remote
  ```
  何も出なければ（「Value not found」）、呼べなかったことはありません。
- 番号の目安：401 は鍵の期限切れ・まちがい、403・404 は鍵の権限かリポジトリの指定のまちがい、422 は daily-watch の入力のまちがい、5xx と 0 は GitHub の側の一時的な不調。

## 試験

- `cd push && npm test`：暗号（RFC 8291）の読み戻し、VAPID（RFC 8292）の署名の確認、登録の断り方、30日の決まり、10ずつ送る・404/410 で消す・二度送らない、1年で消す。
- 手元の iPhone と Android での受け取り・表示・停止は、Workers に載せたあとに確かめます。
