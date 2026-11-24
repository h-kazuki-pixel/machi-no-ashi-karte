// 通知（Web Push）の受け取り・止める・サーバーとの同期（端末の側）
// サーバーに送るのは「通知の宛先（ブラウザが作る URL と鍵）」と「登録したバスの番号」だけ。行き先や時刻は送らない。
import { PUSH } from "./config.js";

const DB = "machi-no-ashi-karte";
const STORE = "kv";
const SYNC_KEY = "machi-no-ashi-karte.push.v1"; // 最後にサーバーへ送った日とバスの一覧（端末の中）
const REFRESH_DAYS = 30; // 前に送ってから30日以上たったら、もう一度送る（サーバーの「更新した日」を新しくするため）

export const pushConfigured = () => !!(PUSH.server && PUSH.vapidPublicKey);
export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
export function isIos() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
export function isStandalone() {
  return navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbSet(entries) {
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      for (const [k, v] of Object.entries(entries)) tx.objectStore(STORE).put(v, k);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  } catch {
    /* IndexedDB が使えない環境では、通知の文はバスの一覧（catalog.json）から名前を引く */
  }
}

function regFeeds(regs, catalog) {
  const feeds = [...new Set(regs.map((r) => r.feed))].filter((f) => catalog.feeds.some((x) => x.feed === f && x.usable));
  return feeds.sort();
}

// service worker が通知の文を作るときに使う、登録したバスの名前（端末の中だけ）
export async function saveFeedNames(regs, catalog) {
  const names = {};
  for (const f of regFeeds(regs, catalog)) names[f] = catalog.feeds.find((x) => x.feed === f).name;
  await idbSet({ feedNames: names, feeds: Object.keys(names).sort(), server: PUSH.server });
}

let swReg = null;
export async function registerSw() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    swReg = await navigator.serviceWorker.register("sw.js");
    return swReg;
  } catch {
    return null;
  }
}
async function readyReg() {
  if (swReg) return swReg;
  return Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error("sw-timeout")), 5000))]);
}
export async function currentSubscription() {
  if (!pushSupported()) return null;
  try {
    return await (await readyReg()).pushManager.getSubscription();
  } catch {
    return null;
  }
}

function b64uToBytes(s) {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(t + "===".slice((t.length + 3) % 4)), (c) => c.charCodeAt(0));
}
async function post(path, body) {
  const r = await fetch(`${PUSH.server}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`push-server ${r.status}`);
  return r.json();
}
function readSync() {
  try {
    return JSON.parse(localStorage.getItem(SYNC_KEY) || "null");
  } catch {
    return null;
  }
}
function writeSync(v) {
  try {
    if (v) localStorage.setItem(SYNC_KEY, JSON.stringify(v));
    else localStorage.removeItem(SYNC_KEY);
  } catch {
    /* 保存できなくても動く（次に開いたときに、もう一度送るだけ） */
  }
}
const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const daysSince = (d) => Math.round((Date.parse(today()) - Date.parse(d)) / 86400000);

// 「知らせを受け取る」：ボタンを押したときだけ呼ぶ（許可の確認は、押したときにしか出せない決まり）
export async function enablePush(regs, catalog) {
  const feeds = regFeeds(regs, catalog);
  if (!feeds.length) throw new Error("no-feeds");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm;
  const reg = await readyReg();
  const sub = (await reg.pushManager.getSubscription())
    || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(PUSH.vapidPublicKey) }));
  await saveFeedNames(regs, catalog);
  await post("/subscribe", { subscription: sub.toJSON(), feeds });
  writeSync({ at: today(), feeds });
  return "granted";
}

// 「知らせを止める」：端末の受け取りをやめ、サーバーから宛先を消す
export async function disablePush() {
  const sub = await currentSubscription();
  if (sub) {
    try {
      await post("/unsubscribe", { endpoint: sub.endpoint });
    } finally {
      await sub.unsubscribe();
    }
  }
  writeSync(null);
}

// 登録した移動が変わったとき・アプリを開いたとき：
//   バスの一覧が変わったら、すぐサーバーに伝える。変わらなければ、前に送ってから30日以上たったときだけ送る。
//   登録したバスが無くなったら、通知を止めて宛先を消す。
export async function syncPush(regs, catalog) {
  if (!pushConfigured() || !pushSupported()) return;
  await saveFeedNames(regs, catalog);
  const sub = await currentSubscription();
  if (!sub) return;
  const feeds = regFeeds(regs, catalog);
  if (!feeds.length) return disablePush();
  const last = readSync();
  const same = last && JSON.stringify(last.feeds) === JSON.stringify(feeds);
  if (same && daysSince(last.at) < REFRESH_DAYS) return;
  try {
    await post("/subscribe", { subscription: sub.toJSON(), feeds });
    writeSync({ at: today(), feeds });
  } catch {
    /* 次に開いたときに、もう一度送る */
  }
}
