// まちの足カルテ：service worker（通知を受けて表示する。画面やデータの読みこみには関わらない）
//
// 届く中身は { feed: バスの番号, change_date: 変わる日 }（変わる日が分からないときは known: false、試しは test: true も）だけ。
// 通知の文は決まった文：変わる日より前「◯◯の時刻表が、◯月◯日から変わります。」
//                       当日かあと  「◯◯の時刻表が、◯月◯日に変わりました。」
// バスの名前は、端末の中（IndexedDB）に保存した一覧から引く。行き先や時刻は、通知の文に入れない。
// sw.js の版の番号（画面の app.js の APP_VERSION と同じにする。直したら両方を上げる）
const SW_VERSION = "2026-11-26.6";
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

async function idbPut(key, value) {
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  } catch {
    /* 書けなければ何もしない */
  }
}

// 試しのあいだだけの、短い記録（通知を押したときに何が起きたか）。新しい30件だけ残す
const DEBUG_LOG = true;
async function debugLog(msg) {
  if (!DEBUG_LOG) return;
  const log = (await idbGet("debugLog")) || [];
  log.push({ t: new Date().toISOString(), w: `sw ${SW_VERSION}`, m: msg });
  await idbPut("debugLog", log.slice(-30));
}

function todayJst() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}

function noticeText(name, change, today, known = true, again = false, suspended = false) {
  // 休止（全部の路線が走らなくなり、版のメモに「休止」とある）
  if (suspended && /^\d{4}-\d{2}-\d{2}$/.test(change || "")) {
    const [, m, d] = change.split("-").map(Number);
    return today < change ? `${name}の運行が、${m}月${d}日から休止します。` : `${name}の運行が、${m}月${d}日から休止しています。`;
  }
  // 公開中の改正が作り直されて、便や時刻が変わった（もう一度だけの知らせ）
  if (again && /^\d{4}-\d{2}-\d{2}$/.test(change || "")) {
    const [, m, d] = change.split("-").map(Number);
    return `${name}の、${m}月${d}日からの時刻表が、もう一度変わりました。`;
  }
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

// その改正が休止か（バスの一覧の revisions[].suspended。読めなければ、休止ではないとみなす）
async function isSuspendedRev(feed, change) {
  try {
    const cat = await (await fetch("data/catalog.json", { cache: "no-cache" })).json();
    const f = cat.feeds.find((x) => x.feed === feed);
    const r = f && (f.revisions || []).find((x) => x.change_date === change);
    return !!(r && r.suspended);
  } catch {
    return false;
  }
}

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(debugLog("入った（install）"));
});
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  await self.clients.claim();
  await debugLog("動き始めた（activate）");
})()));

// 画面から「いま動いている sw.js の版」を聞かれたら答える
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "sw-version" && e.ports && e.ports[0]) e.ports[0].postMessage({ version: SW_VERSION });
});

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
    const body = noticeText(await feedName(feed), change, todayJst(), d.known !== false, d.again === true,
                            d.again !== true && await isSuspendedRev(feed, change)) + (d.test === true ? "（試し）" : "");
    // iPhone では、届いた通知は必ず表示する決まり
    // 題名は「時刻表の知らせ」（iPhone は「題名 from ホーム画面の名前」と出すので、アプリの名前と重ねない）
    await self.registration.showNotification("時刻表の知らせ", {
      body, tag: `${feed}|${change}${d.again === true ? "|again" : ""}${d.test === true ? "|test" : ""}`, icon: "icons/icon-192.png", lang: "ja",
      // 知らせの画面の URL。iPhone のホーム画面のアプリは、開くときに「#」より後ろを落とすことがあるため、
      // 「?notice=」で渡し、アプリが読みこんだときに「#notice/…」に直す
      data: { url: `./?notice=${encodeURIComponent(`${feed}/${change}${d.test === true ? "/test" : ""}`)}`,
              feed, change, test: d.test === true },
    });
    await debugLog(`知らせを受けて出した（${feed || "?"} ${change || "?"}${d.test === true ? " 試し" : ""}）`);
  })());
});

// 通知を押したとき：iPhone のホーム画面のアプリは、openWindow や navigate に渡した URL を使わず、
// 最初のページを開くことがある。そのため、URL に頼らず、どの知らせを押したかを IndexedDB に
// 「開くのを待っている知らせ」（pendingNotice）として書き、画面（app.js）がそれを読んで知らせの画面を出す。
self.addEventListener("notificationclick", (e) => {
  const data = e.notification.data || {};
  const first = debugLog(`notificationclick が呼ばれた（${data.feed ? "どの知らせかあり" : "どの知らせかなし"}）`);
  e.notification.close();
  const url = new URL(data.url || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    await first;
    await debugLog(`通知を押した（${data.feed || "?"} ${data.change || "?"}${data.test ? " 試し" : ""}）`);
    if (data.feed && data.change) {
      await idbPut("pendingNotice", { feed: data.feed, change: data.change, test: data.test === true, at: Date.now() });
    }
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const c = list.find((w) => w.url.startsWith(self.registration.scope));
    if (c) {
      // アプリが開いたまま（裏にある）とき：前に出して、待っている知らせを読むように伝える
      try {
        await c.focus();
        await debugLog(`開いている画面を前に出した（画面の数 ${list.length}）`);
      } catch (err) {
        await debugLog(`前に出せなかった：${err && err.name}`);
      }
      c.postMessage({ type: "pending-notice" });
      await debugLog("postMessage を送った");
      return;
    }
    // 閉じているとき：アプリを開く（URL が使われなくても、開いた画面が待っている知らせを読む）
    try {
      const w = await self.clients.openWindow(url);
      await debugLog(`openWindow で開いた（${w ? "画面あり" : "画面の返事なし"}）`);
    } catch (err) {
      await debugLog(`openWindow が失敗：${err && err.name}`);
    }
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
