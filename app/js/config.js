// 通知（Web Push）の設定。どちらも空のあいだは、通知の画面を出さない。
//   server         通知のサーバー（Cloudflare Workers）の URL
//   vapidPublicKey VAPID の公開の鍵（push/tools/make_vapid.mjs が書く。公開してよい鍵）
export const PUSH = {
  server: "",
  vapidPublicKey: "",
};
