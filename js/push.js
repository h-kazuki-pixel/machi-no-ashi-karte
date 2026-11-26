// 通知（Web Push）の受け取り・止める・サーバーとの同期（端末の側）
// サーバーに送るのは「通知の宛先（ブラウザが作る URL と鍵）」と「登録したバスの番号」だけ。行き先や時刻は送らない。
import { PUSH } from "./config.js";

// 画面の版の番号（sw.js の SW_VERSION と同じにする。直したら両方を上げる）
export const APP_VERSION = "2026-11-26.6";

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

// IndexedDB が返事をしない環境（一部のブラウザの設定など）でも止まらないよう、開くのは1.5秒まで待つ
function idb() {
  return Promise.race([idbOpen(), new Promise((_, rej) => setTimeout(() => rej(new Error("idb-timeout")), 1500))]);
}
function idbOpen() {
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

// 通知を押したときに service worker が書く「開くのを待っている知らせ」を読み、読んだ印として消す（1回のやりとりで）
export async function takePendingNotice() {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      const st = tx.objectStore(STORE);
      let v;
      const q = st.get("pendingNotice");
      q.onsuccess = () => {
        v = q.result;
        if (v !== undefined) st.delete("pendingNotice");
      };
      tx.oncomplete = () => res(v || null);
      tx.onerror = () => rej(tx.error);
    });
  } catch {
    return null;
  }
}

// 試しのあいだだけの、短い記録（service worker と同じ「debugLog」に足す。新しい30件だけ残す）
export const DEBUG_LOG = true;
export async function debugLog(msg) {
  if (!DEBUG_LOG) return;
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      const st = tx.objectStore(STORE);
      const q = st.get("debugLog");
      q.onsuccess = () => st.put([...(q.result || []), { t: new Date().toISOString(), w: `画面 ${APP_VERSION}`, m: msg }].slice(-30), "debugLog");
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  } catch {
    /* 記録できなくても、動きは変えない */
  }
}
export async function readDebugLog() {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const q = db.transaction(STORE).objectStore(STORE).get("debugLog");
      q.onsuccess = () => res(q.result || []);
      q.onerror = () => rej(q.error);
    });
  } catch {
    return [];
  }
}
export async function clearDebugLog() {
  await idbSet({ debugLog: [] });
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
function showUpdateBar() {
  if (document.getElementById("update-bar")) return;
  const bar = document.createElement("div");
  bar.id = "update-bar";
  bar.className = "update-bar";
  bar.setAttribute("role", "status");
  bar.innerHTML = `<p>新しい版があります。開き直してください。</p><button class="btn" type="button">開き直す</button>`;
  bar.querySelector("button").addEventListener("click", () => location.reload());
  document.body.prepend(bar);
}
export async function registerSw() {
  if (!("serviceWorker" in navigator)) return null;
  // 前から service worker が動いていたのに入れ替わったら（sw.js が新しくなった）、開いている画面は古いままなので、
  // 開き直すように出す（最初に入ったときは出さない）
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController) showUpdateBar();
  });
  try {
    // updateViaCache: "none"：sw.js（と、その中で読むファイル）を、HTTP のキャッシュを使わずに確かめる
    swReg = await navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
    await checkSwUpdate("起動した");
    return swReg;
  } catch (err) {
    debugLog(`sw.js の登録に失敗：${err && err.name}`);
    return null;
  }
}

// sw.js に新しい版が出ていないかを確かめる。register() だけでは確かめないため、画面を開いたとき・前に出たときに呼ぶ
let lastUpdateCheck = 0;
export async function checkSwUpdate(source) {
  if (!swReg || Date.now() - lastUpdateCheck < 60000) return;
  lastUpdateCheck = Date.now();
  try {
    await swReg.update();
    const w = swReg.installing || swReg.waiting;
    debugLog(`${source}：sw.js の新しい版を確かめた（${w ? "新しい版を入れている" : "新しい版なし"}）`);
  } catch (err) {
    debugLog(`${source}：sw.js の新しい版を確かめられなかった（${err && err.name}）`);
  }
}

// いま動いている sw.js の版を聞く（答えが無ければ、版の番号を答えない古い sw.js）
export async function swVersion() {
  const c = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!c) return null;
  return new Promise((res) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => res("答えなし（版の番号を持たない古い sw.js）"), 1500);
    ch.port1.onmessage = (e) => {
      clearTimeout(t);
      res((e.data && e.data.version) || "?");
    };
    c.postMessage({ type: "sw-version" }, [ch.port2]);
  });
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

// この端末の番号：宛先のハッシュの先頭8文字（サーバーの宛先のキーと同じ計算）。試しの通知を送るときに使う。宛先の URL は出さない
export async function deviceNumber(sub) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sub.endpoint)));
  return [...d].slice(0, 4).map((x) => x.toString(16).padStart(2, "0")).join("");
}

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
