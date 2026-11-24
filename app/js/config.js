// 通知（Web Push）の設定。どちらも空のあいだは、通知の画面を出さない。
//   server         通知のサーバー（Cloudflare Workers）の URL
//   vapidPublicKey VAPID の公開の鍵（push/tools/make_vapid.mjs が書く。公開してよい鍵）
export const PUSH = {
  server: "https://machi-no-ashi-push.h-kazuki.workers.dev",
  vapidPublicKey: "BIciEufCK7Xlf4dWvTKuPiiYWmODATTa04vVxpC0eHl8wDGi3yWso2RAozAg6AmTS4O9jWw266WWvROaQbTceaM",
};
