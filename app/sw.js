// まちの足カルテ：service worker（通知を受けて表示する。画面やデータの読みこみには関わらない）
//
// 届く中身は { feed: バスの番号, change_date: 変わる日 }（変わる日が分からないときは known: false、試しは test: true も）だけ。
// 通知の文は決まった文：変わる日より前「◯◯の時刻表が、◯月◯日から変わります。」
//                       当日かあと  「◯◯の時刻表が、◯月◯日に変わりました。」
// バスの名前は、端末の中（IndexedDB）に保存した一覧から引く。行き先や時刻は、通知の文に入れない。
const DB = "machi-no-ashi-karte";
const STORE = "kv";

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const q = db.transaction(STORE).objectStore(STORE).get(key);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  } catch {
    return undefined;
  }
}

function todayJst() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}

function noticeText(name, change, today, known = true) {
  // 変わる日が分からない（同じ版の番号のまま zip が置き換わった）ときは、日付を入れない
  if (known === false) return `${name}の時刻表が変わりました。`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(change || "")) return `${name}の時刻表が変わります。`;
  const [, m, d] = change.split("-").map(Number);
  return today < change ? `${name}の時刻表が、${m}月${d}日から変わります。` : `${name}の時刻表が、${m}月${d}日に変わりました。`;
}

async function feedName(feed) {
  const names = (await idbGet("feedNames")) || {};
  if (names[feed]) return names[feed];
  try {
    const cat = await (await fetch("data/catalog.json")).json();
    const f = cat.feeds.find((x) => x.feed === feed);
    if (f) return f.name;
  } catch {
    /* 読めなければ、決まった言い方にする */
  }
  return "登録したバス";
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    let d = {};
    try {
      d = e.data ? e.data.json() : {};
    } catch {
      d = {};
    }
    const feed = typeof d.feed === "string" ? d.feed : "";
    const change = typeof d.change_date === "string" ? d.change_date : "";
    // 試し（/notify の test）：本物と同じ文に「（試し）」を付ける
    const body = noticeText(await feedName(feed), change, todayJst(), d.known !== false) + (d.test === true ? "（試し）" : "");
    // iPhone では、届いた通知は必ず表示する決まり
    await self.registration.showNotification("まちの足カルテ", {
      body, tag: `${feed}|${change}${d.test === true ? "|test" : ""}`, icon: "icons/icon-192.png", lang: "ja",
      data: { url: `./#notice/${encodeURIComponent(feed)}/${change}${d.test === true ? "/test" : ""}` },
    });
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope)) {
        await c.focus();
        return c.navigate(url);
      }
    }
    return self.clients.openWindow(url);
  })());
});

// ブラウザが宛先を作り直したとき：新しい宛先をサーバーに伝え、古い宛先を消してもらう
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil((async () => {
    const server = await idbGet("server");
    const feeds = await idbGet("feeds");
    if (!server || !feeds || !feeds.length) return;
    let sub = e.newSubscription;
    if (!sub && e.oldSubscription) sub = await self.registration.pushManager.subscribe(e.oldSubscription.options);
    if (!sub) return;
    await fetch(`${server}/subscribe`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON(), feeds, old_endpoint: e.oldSubscription ? e.oldSubscription.endpoint : undefined }),
    });
  })());
});
