// まちの足カルテ：画面
// 登録した内容は localStorage（この端末の中）だけに保存し、どこにも送らない。
//
// データ（GitHub Pages）:
//   data/catalog.json                  都道府県 → バスの一覧、バスごとの時刻表と改正のデータ
//   data/timetables/{feed}/{uid}.json  版ごとの時刻表
//   data/revisions/{feed}/{...}.json   改正のデータ（前の版の時刻表＋後の版の時刻表＋日ごとの情報）
import * as J from "./judge.js";
import { searchStops } from "./search.js";
import { assembleRevision, assembleTimetables } from "./timetable.js";
import { pushConfigured, pushSupported, isIos, isStandalone, registerSw, currentSubscription, enablePush, disablePush, syncPush, deviceNumber } from "./push.js";

const STORE_KEY = "machi-no-ashi-karte.regs.v2";
const DAY_LABELS = [["mon", "月"], ["tue", "火"], ["wed", "水"], ["thu", "木"], ["fri", "金"], ["sat", "土"], ["sun", "日"]];
const WD_JP = ["日", "月", "火", "水", "木", "金", "土"];
const RECENT_DAYS = 30; // 変更日からこの日数までは、改正の知らせを出し続ける

// URL で「今日」を切り替えられる（例：?today=2026-11-25）。?demo=1 で例の移動を表示（保存しない）
const params = new URLSearchParams(location.search);
const TODAY = params.get("today") || new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
// ?try=[{登録}, ...]（JSON）で、その登録を保存せずに表示する（確認用）
const TRY = (() => {
  try {
    const t = JSON.parse(params.get("try") || "null");
    return Array.isArray(t) ? t.map((r, i) => ({ id: `t${i + 1}`, ...r })) : null;
  } catch {
    return null;
  }
})();
const DEMO = params.get("demo") === "1" || !!TRY;

const YZ = "yonezawacity/Yonezawa";
const WK = ["mon", "tue", "wed", "thu", "fri"];
const DEMO_REGS = [
  { id: "d1", feed: YZ, name: "平日の朝、駅へ", from: "上杉神社前", to: "米沢駅前", days: WK, cond: { type: "arriveBy", time: 480 } },
  { id: "d2", feed: YZ, name: "平日の午後、万世小へ", from: "米沢駅前", to: "万世小学校前", days: WK, cond: { type: "departAfter", time: 870 } },
  { id: "d3", feed: YZ, name: "火曜の病院（行き）", from: "米沢駅前", to: "国立米沢病院前", days: ["tue"], cond: { type: "arriveBy", time: 600 } },
  { id: "d4", feed: YZ, name: "平日の朝、鶴城高校へ", from: "米沢駅前", to: "鶴城高校前", days: WK, cond: { type: "arriveBy", time: 510 } },
  { id: "d5", feed: YZ, name: "平日のお昼、上杉神社へ", from: "米沢駅前（東口）", to: "上杉神社前", days: WK, cond: { type: "departAfter", time: 710 } },
  { id: "d6", feed: YZ, name: "第1日曜、駅へ", from: "福祉の里入口", to: "米沢駅前", days: ["first_sun"], cond: { type: "departAfter", time: 540 } },
  { id: "d7", feed: YZ, name: "平日の夕方、通町へ", from: "米沢駅前", to: "通町六丁目", days: WK, cond: { type: "departAfter", time: 1060 } },
  { id: "d8", feed: YZ, name: "平日の夕方、上杉神社へ", from: "米沢駅前", to: "上杉神社前", days: WK, cond: { type: "departAfter", time: 1050 } },
  { id: "d9", feed: YZ, name: "平日の夕方、芳泉町へ", from: "米沢駅前", to: "芳泉町", days: WK, cond: { type: "departAfter", time: 1060 } },
  { id: "d10", feed: YZ, name: "平日の朝、スキー場から病院へ", from: "米沢スキー場前", to: "国立米沢病院前", days: WK, cond: { type: "arriveBy", time: 600 } },
];

let CATALOG = null;
let draft = null;
// 事業者の画面：{ feed, stop, open, close, day }。?biz={...}（JSON）で入れて開ける（確認用）
let bizDraft = (() => {
  try {
    return JSON.parse(params.get("biz") || "null");
  } catch {
    return null;
  }
})();
const cache = new Map(); // パス → JSON

// ---------- 保存 ----------
function loadRegs() {
  if (TRY) return TRY;
  if (DEMO) return DEMO_REGS;
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
  } catch {
    return [];
  }
}
function saveRegs(regs) {
  if (DEMO) return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(regs));
  } catch {
    alertBox("この端末に保存できませんでした。");
  }
  if (CATALOG) syncPush(regs, CATALOG); // 通知を受け取っていれば、登録したバスの一覧をサーバーに伝える
}

// ---------- データ ----------
// 版ごとの時刻表は、版の番号（uid）ごとに中身が変わらないので、一度読んだら端末（Cache Storage）に残す。
// 版が変わるとファイルの名前が変わるので、そのときだけ取り直す。一覧と改正のデータは毎回取る。
const TT_CACHE = "machi-no-ashi-karte-timetables-v1";
// Cache Storage が開けない・返事が無い環境（プライベートブラウズ、一部のブラウザの設定など）では、端末に残さずに読む。
// 開くのは1回だけ試し、その結果をこのページのあいだ使う（開けなかったら、あとは待たずにふつうに読む）
let cacheP = null;
function openCache() {
  if (!cacheP) {
    cacheP = typeof caches === "undefined" ? Promise.reject(new Error("no-cache-storage"))
      : Promise.race([caches.open(TT_CACHE), new Promise((_, rej) => setTimeout(() => rej(new Error("cache-timeout")), 1500))]);
    cacheP.catch(() => {}); // 開けなかったことは、呼ぶ側で扱う
  }
  return cacheP;
}
async function fetchTimetable(path) {
  try {
    const c = await openCache();
    const hit = await c.match(path);
    if (hit) return hit.json();
    const r = await fetch(path);
    if (!r.ok) throw new Error(path);
    await c.put(path, r.clone());
    return r.json();
  } catch (e) {
    if (e.message === path) throw e;
    const r = await fetch(path); // Cache Storage が使えないとき（プライベートブラウズなど）
    if (!r.ok) throw new Error(path);
    return r.json();
  }
}
async function getJSON(path) {
  if (!cache.has(path)) {
    const p = path.startsWith("data/timetables/")
      ? fetchTimetable(path)
      : fetch(path, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(path))));
    cache.set(path, p);
  }
  return cache.get(path);
}

// 一覧にも改正のデータにも出てこない版の時刻表を、端末から消す
async function pruneTimetableCache() {
  try {
    const keep = new Set();
    for (const f of CATALOG.feeds) for (const t of f.timetables) keep.add(new URL(t.path, location.href).href);
    const c = await openCache();
    const used = await usedByRevisions(); // 登録したバスの改正のデータが使う古い版は残す
    for (const req of await c.keys()) {
      if (!keep.has(req.url) && !used.has(req.url)) await c.delete(req);
    }
  } catch {
    /* Cache Storage が使えないときは何もしない */
  }
}
let usedCache = null;
async function usedByRevisions() {
  if (usedCache) return usedCache;
  usedCache = new Set();
  for (const reg of loadRegs()) {
    const item = feedItem(reg.feed);
    for (const r of item ? item.revisions : []) {
      try {
        const raw = await getJSON(r.path);
        for (const p of Object.values(raw.meta.timetables)) usedCache.add(new URL(p, location.href).href);
      } catch {
        /* 読めない改正は飛ばす */
      }
    }
  }
  return usedCache;
}
const feedItem = (key) => CATALOG.feeds.find((f) => f.feed === key);

// いま使える時刻表から「いまのバス」を出すための形（今日から35日）
async function timetableP(item) {
  const key = `tt:${item.feed}`;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      // 時刻表は同時に読む（順番に待たない）
      const list = await Promise.all(item.timetables.map((t) => getJSON(t.path)));
      const tts = Object.fromEntries(item.timetables.map((t, i) => [t.uid, list[i]]));
      return J.prepare(assembleTimetables(tts, TODAY, 35, CATALOG.holidays));
    })());
  }
  return cache.get(key);
}

// 改正のデータ（前の版の時刻表＋後の版の時刻表＋日ごとの情報）
async function revisionP(path) {
  const key = `rev:${path}`;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      const raw = await getJSON(path);
      // 前の版と後の版の時刻表は、同時に読む
      const ents = Object.entries(raw.meta.timetables);
      const list = await Promise.all(ents.map(([, p]) => getJSON(p)));
      const tts = Object.fromEntries(ents.map(([u], i) => [u, list[i]]));
      return J.prepare(assembleRevision(raw, tts));
    })());
  }
  return cache.get(key);
}

// 知らせを出す改正：公開日が今日まで、変更日が今日から RECENT_DAYS 日前より後
function activeRevisions(item) {
  return (item.revisions || []).filter((r) => r.published_at.slice(0, 10) <= TODAY && J.addDays(r.change_date, RECENT_DAYS) >= TODAY);
}

// 今日から先の、登録した曜日に当たる日（印の付いた日は外す）
function nextDates(P, reg, n = 4) {
  return Object.keys(P.days).sort().filter((d) => d >= TODAY && J.matchesDays(reg.days, d) && !J.isExcluded(P, d, reg)).slice(0, n);
}

// いまの時刻表に無い、登録した停留所について、その停留所が無くなった改正（前の版にはあり、後の版に無い）を探す
async function removedStops(item, tp, reg) {
  const out = [];
  const missing = [reg.from, reg.to].filter((n) => !tp.groups.has(n));
  const revs = (item.revisions || []).filter((r) => r.change_date <= TODAY).sort((a, b) => (a.change_date < b.change_date ? 1 : -1));
  for (const name of missing) {
    for (const r of revs) {
      try {
        const g = (await revisionP(r.path)).groups.get(name);
        if (g && g.inOld && !g.inNew) {
          out.push({ name, change: r.change_date });
          break;
        }
      } catch {
        /* 読めない改正は飛ばす */
      }
    }
    if (!out.some((x) => x.name === name)) out.push({ name, change: null });
  }
  return out;
}
// 「12月1日から、米沢市営バスはこのバス停に止まらなくなりました」（無くなった改正が分からなければ、いまの時刻表に無いとだけ言う）
function removedLines(item, now) {
  return (now.removed || [{ name: null, change: null }]).map((x) => (x.change
    ? `${x.name ? `${kq(x.name)}：` : ""}${jDateShort(x.change)}から、${item.name}はこのバス停に止まらなくなりました`
    : `${x.name ? `${kq(x.name)}：` : ""}登録した停留所が、いまの時刻表にありません`));
}

async function evaluate(reg) {
  const item = feedItem(reg.feed);
  if (!item) return { reg, missing: true };
  if (!item.usable) return { reg, item, unusable: true };
  const tp = await timetableP(item);
  // いまの時刻表に、登録した停留所が無いことがある（停留所が無くなった改正のあと）。そのときも画面を止めない
  let nowOnly;
  try {
    nowOnly = J.bestOverDates(tp, reg, nextDates(tp, reg));
  } catch {
    nowOnly = { ride: null, missingStop: true, removed: await removedStops(item, tp, reg) };
  }
  const results = [];
  for (const r of activeRevisions(item)) {
    try {
      const P = await revisionP(r.path);
      const res = J.judge(P, reg);
      res.P = P;
      res.ph = phase(P);
      results.push(res);
    } catch {
      /* 停留所がその改正に無いなど。知らせは出さない */
    }
  }
  results.sort((a, b) => (a.P.meta.change_date < b.P.meta.change_date ? -1 : 1));
  const notice = results.find((x) => !["same", "tiny", "no_route"].includes(x.level)) || results[0] || null;
  // 「いまのバス」：改正の知らせがあれば、変わる前は前の時刻表、変わったあとは後の時刻表で出す
  const now = notice ? (notice.ph === "after" ? notice.after : notice.before) : nowOnly;
  return { reg, item, results, notice, now };
}

// ---------- ことば ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function jDate(s) {
  const d = J.parseDate(s);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${WD_JP[d.getUTCDay()]}）`;
}
function jDateShort(s) {
  const d = J.parseDate(s);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}
// 名前を「」でくくる。名前の中にかぎかっこがあるときは、外側を『』にする（「特急バス「雷鳥ライナー」」にしない）
const kq = (s) => (/[「」]/.test(String(s)) ? `『${s}』` : `「${s}」`);
const busText = (r) => `${J.hhmm(r.dep)}発 → ${J.hhmm(r.arr)}着`;
function condText(c) {
  return c.type === "arriveBy" ? `${J.hhmm(c.time)}までに着きたい` : `${J.hhmm(c.time)}よりあとに乗りたい`;
}
function daysText(days) {
  const parts = [];
  const rest = days.filter((d) => d !== "first_sun");
  if (WK.every((d) => rest.includes(d)) && rest.length === 5) parts.push("平日");
  else DAY_LABELS.forEach(([k, l]) => rest.includes(k) && parts.push(`${l}曜`));
  if (days.includes("first_sun")) parts.push("毎月第1日曜");
  return parts.join("・");
}
function minutesPhrase(d, early, late) {
  return d < 0 ? `${-d}分${early}` : `${d}分${late}`;
}

function phase(P) {
  const pub = P.meta.new.published_at.slice(0, 10);
  if (TODAY >= P.meta.change_date) return "after";
  if (TODAY >= pub) return "announced";
  return "before";
}

// 登録した曜日に当たる、改正のあとの最初の日（第1日曜の移動なら 12月6日）
function firstDay(res) {
  return res.after.dates[0] || res.P.meta.change_date;
}

const hasNote = (res, kind) => res.notes && res.notes.some((n) => n.kind === kind);

// 見出し：「12月1日（火）から、『名前』が変わります」。路線の運行が始まる・終わるときは、そう書く
// 変わる日が分からない改正（同じ版の番号のまま zip が置き換わり、見つけた日にもう違っていた）
const unknownDate = (P) => P.meta.change_date_known === false;
const unknownHead = (P) => `いまの時刻表は、前と変わっています（${jDateShort(P.meta.change_date)}に分かりました）`;
const fromText = (res) => (unknownDate(res.P) ? "いまは" : `${jDate(firstDay(res))}からは`);

const SEASON = ["冬", "冬", "春", "春", "春", "夏", "夏", "夏", "秋", "秋", "秋", "冬"];
// 前の運行の最後の日：「4月14日」。変わる日と年が違えば「2025年4月14日」
function prevLastText(prev, first) {
  const d = J.parseDate(prev);
  const y = d.getUTCFullYear() !== J.parseDate(first).getUTCFullYear() ? `${d.getUTCFullYear()}年` : "";
  return `${y}${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}
function headline(res, name) {
  if (unknownDate(res.P)) return unknownHead(res.P);
  const past = res.ph === "after";
  const starts = res.notes && res.notes.find((n) => n.kind === "route_starts");
  if (starts && starts.prevLast) {
    // 前にも走っていた路線の運行が、また始まる（雷鳥ライナーの冬の運行など）
    const first = firstDay(res);
    const season = SEASON[J.parseDate(first).getUTCMonth()];
    return `${jDate(first)}から、この${season}の運行が始まり${past ? "ました" : "ます"}（前の運行は${prevLastText(starts.prevLast, first)}まで）`;
  }
  if (hasNote(res, "route_starts")) return `${jDate(firstDay(res))}から、このバスの運行が始まり${past ? "ました" : "ます"}（『${name}』）`;
  const ends = res.notes && res.notes.find((n) => n.kind === "route_ends");
  if (ends && ends.seasonal) {
    // 季節の運休：「12月6日（日）から、このバスは走りません。前の冬も走らず、5月3日（日）に運行が始まりました」
    const first = firstDay(res);
    return `${jDate(first)}から、このバスは走りません。前の${SEASON[J.parseDate(first).getUTCMonth()]}も走らず、${jDate(ends.seasonal.resumed)}に運行が始まりました`;
  }
  if (hasNote(res, "route_ends")) return `${jDate(firstDay(res))}から、このバスの運行が終わり${past ? "ました" : "ます"}（『${name}』）`;
  return `${jDate(firstDay(res))}から、『${name}』が${past ? "変わりました" : "変わります"}`;
}

function levelInfo(res) {
  const past = res.ph === "after";
  const L = res.level;
  if (hasNote(res, "route_starts")) return { cls: "lv-better", badge: past ? "運行が始まりました" : "運行が始まります" };
  if (res.notes && res.notes.some((n) => n.kind === "route_ends" && n.seasonal)) return { cls: "lv-big", badge: "季節の運休" };
  if (hasNote(res, "route_ends")) return { cls: "lv-cannot", badge: past ? "運行が終わりました" : "運行が終わります" };
  if (L === "will_be_able") {
    return past ? { cls: "lv-better", badge: "1本で行けるようになりました" } : { cls: "lv-better", badge: "1本で行けるようになります" };
  }
  if (L === "no_route") return { cls: "lv-none", badge: "いまは1本では行けません" };
  if (L === "no_compare") return { cls: "lv-none", badge: "くらべられません" };
  const map = {
    cannot: ["lv-cannot", "1本で行けるバスがなくなります", "1本で行けるバスがなくなりました"],
    big: ["lv-big", "時刻が大きく変わります", "時刻が大きく変わりました"],
    small: ["lv-small", "時刻が少し変わります", "時刻が少し変わりました"],
    tiny: ["lv-tiny", "ほとんど変わりません", "ほとんど変わりません"],
    same: ["lv-same", "変わりません", "変わりません"],
    better: ["lv-better", "便利になります", "便利になりました"],
  };
  return { cls: map[L][0], badge: map[L][past ? 2 : 1] };
}

// 変わる中身を、やさしい言葉で
function detailLines(res) {
  const m = res.P.meta;
  const out = [];
  const ends = res.notes.find((n) => n.kind === "route_ends");
  const starts = res.notes.find((n) => n.kind === "route_starts");
  if (ends && ends.seasonal) {
    const first = firstDay(res);
    const fm = J.parseDate(first).getUTCMonth() + 1;
    const rmDate = J.parseDate(ends.seasonal.resumed);
    const lm = rmDate.getUTCMonth() === 0 ? 12 : rmDate.getUTCMonth(); // 運行が始まった月の前の月
    out.push(`${daysText(res.reg.days)}の${kq(ends.route)}は、${jDateShort(first)}から走りません。`);
    out.push(lm === fm ? `前の年も、${fm}月は走りませんでした。` : `前の年も、${fm}月から${lm}月までは走りませんでした。`);
    out.push(`次の${SEASON[rmDate.getUTCMonth()]}に走るかどうかは、バス会社の案内を確かめてください。`);
    return out;
  }
  if (ends) {
    out.push(`${daysText(res.reg.days)}は、${kq(ends.route)}が走らなくなります。`);
    out.push(`${m.feed_name}では、この移動に1本で行けるバスがなくなります。`);
    return out;
  }
  if (starts) {
    out.push(`${daysText(res.reg.days)}に、${kq(starts.route)}が走り始めます。`);
    out.push(`${fromText(res)}、${busText(res.after.ride)} のバスがあります。`);
    return out;
  }
  if (res.level === "cannot") {
    out.push(`${m.feed_name}では、1本で行けるバスがなくなります。`);
    const firstSunEnds = res.notes.some((n) => n.kind === "first_sunday_service_ends");
    if (firstSunEnds) out.push("第1日曜だけ走っていたバスが、なくなります。");
    for (const n of res.notes) {
      if (n.kind === "stop_not_served" && !firstSunEnds) out.push(`${daysText(res.reg.days)}は、バスが${kq(n.name)}に止まりません。`);
    }
    if (out.length === 1) out.push(`${kq(condText(res.reg.cond))}に合うバスが、なくなります。`);
    return out;
  }
  if (res.level === "will_be_able") {
    out.push(`いままでは、${m.feed_name}に1本で行けるバスがありませんでした。`);
    out.push(`${fromText(res)}、${busText(res.after.ride)} のバスがあります。`);
    return out;
  }
  if (res.level === "no_compare") {
    out.push(res.missing === "before"
      ? `${jDate(m.change_date)}より前の時刻表のデータが無いため、くらべられません。`
      : `${jDate(m.change_date)}からの時刻表のデータが無いため、くらべられません。`);
    if (res.after.ride) out.push(`${fromText(res)}、${busText(res.after.ride)} のバスがあります。`);
    return out;
  }
  if (res.level === "no_route") {
    out.push(`${m.feed_name}には、この組み合わせを1本で行けるバスがありません。行けるようになったら知らせます。`);
    return out;
  }
  if (res.level === "better") out.push(`待つ時間が${res.waitGain}分へります。`);
  if (res.dDep) out.push(`出る時刻が${minutesPhrase(res.dDep, "早くなります。", "おそくなります。")}`);
  if (res.dDep < 0 && res.level !== "better") out[out.length - 1] = `${-res.dDep}分早く出る必要があります。`;
  if (res.dArr) out.push(`着く時刻が${minutesPhrase(res.dArr, "早くなります。", "おそくなります。")}`);
  if (res.dRide >= 5) out.push(`乗っている時間が${res.dRide}分長くなります。`);
  if (res.dRide <= -5) out.push(`乗っている時間が${-res.dRide}分短くなります。`);
  if (res.before.ride && res.after.ride && res.before.ride.route !== res.after.ride.route) {
    out.push(`乗るバスが${kq(res.after.ride.route)}に変わります。`);
  }
  return out;
}

const CAUTION_TEXT = {
  pickup_phone: "このバスは、乗る前にバス会社への電話（予約）がいります",
  pickup_driver: "このバスは、乗るときに運転士に伝える必要があります",
  drop_off_phone: "このバスは、降りるにはバス会社への電話（予約）がいります",
  drop_off_driver: "このバスは、降りるときに運転士に伝える必要があります",
};
// 出しているバス（いままで・変わる日から・いまのバス）の、乗り降りの注意
function cautionHtml(...rides) {
  const kinds = [...new Set(rides.flatMap((r) => J.rideCautions(r)))];
  return kinds.map((k) => `<p class="warn">${esc(CAUTION_TEXT[k])}</p>`).join("");
}
// 停留所から見た注意（事業者の画面・貼り紙）：f はその停留所で乗る・降りるときの印
function stopCautionHtml(f, cls = "warn") {
  return J.flagCautions(f, f).map((k) => `<p class="${cls}">${esc(CAUTION_TEXT[k])}</p>`).join("");
}

// 年末年始（12/29〜1/3）とお盆（8/13〜8/16）：データに書かれていない運休や特別な時刻があるかもしれない
function seasonCautions(dates) {
  const md = dates.filter(Boolean).map((s) => s.slice(5));
  const out = [];
  if (md.some((x) => x >= "12-29" || x <= "01-03")) out.push("年末年始は、時刻が変わったり運休したりすることがあります。バス会社の案内を確かめてください。");
  if (md.some((x) => x >= "08-13" && x <= "08-16")) out.push("お盆は、時刻が変わったり運休したりすることがあります。バス会社の案内を確かめてください。");
  return out;
}
// 登録した曜日に当たる、今日から先の最初の日（印の付いた日も外さない＝実際に乗る日）
function nextRawDate(reg) {
  for (let k = 0; k < 45; k++) {
    const s = J.addDays(TODAY, k);
    if (J.matchesDays(reg.days, s)) return s;
  }
  return null;
}
// 「いまのバス」と知らせを出すときに見る日：次に乗る日と、知らせの変わる日
function cautionDates(x) {
  return [nextRawDate(x.reg), ...((x.results || []).filter((r) => r.ph !== "before").map((r) => r.P.meta.change_date))];
}

// バスごとの「ふだん、変わる日の何日前に新しい時刻表が出るか」（catalog の lead。公開が遅い版・変わる日がはっきりしない組は除いた回数と日数）
function leadDayText(d) {
  // 90日を超える回は「3か月以上前（あと）」とまとめる（「257日前」のような回）
  if (d > 90) return "3か月以上前";
  if (d < -90) return "3か月以上あと";
  return d > 0 ? `${d}日前` : d === 0 ? "当日" : `${-d}日あと`;
}
function leadText(item) {
  const l = item && item.lead;
  if (!l || l.median == null) return null;
  const head = "このバスの新しい時刻表は、ふだん、";
  if (l.median >= 7) return `${head}変わる日の約${l.median}日前に出ています（これまでの${l.n}回。早いときは${leadDayText(l.earliest)}、遅いときは${leadDayText(l.latest)}）`;
  if (l.median >= 1) return `${head}変わる日の直前（約${l.median}日前）に出ています（これまでの${l.n}回）`;
  return `${head}変わる日の当日かあとに出ています（これまでの${l.n}回）。前もって知らせられないことが多いです`;
}
// 「変わる日の5日前」「変わる日の当日」「変わる日の3日あと」
const leadAt = (d) => `変わる日の${leadDayText(d)}`;
// 「知らせはありません」の下と、改正の知らせの出典の行に出す文。3回以上は「ふだん」、1回・2回は事実だけ、0回は「記録がまだ無い」。
// 毎日新しい版が出るバスは出さない
function leadOrFewText(item) {
  if (!item || item.daily) return null;
  const t = leadText(item);
  if (t) return t;
  const ls = (item.lead && item.lead.leads) || [];
  if (ls.length === 2) return `このバスの新しい時刻表は、これまでの2回、${leadAt(ls[0])}と${leadDayText(ls[1])}に出ました`;
  if (ls.length === 1) return `このバスの新しい時刻表は、前回、${leadAt(ls[0])}に出ました`;
  return "このバスは記録がまだ無く、どのくらい前に分かるかは分かりません";
}

function noteLines(res) {
  const out = [];
  for (const n of res.notes) {
    if (n.kind === "split") out.push(`${n.side === "before" ? "いまの時刻表" : "新しい時刻表"}では、日によって結果が分かれました。いちばん多い結果を出しています。`);
    if (n.kind === "too_few_dates") out.push(`比べられた日が少ないため（前 ${n.before}回・あと ${n.after}回）、たしかではありません。`);
  }
  return out;
}

function sourceLine(res) {
  const m = res.P.meta;
  if (unknownDate(res.P)) return `${jDateShort(m.new.published_at.slice(0, 10))}に、時刻表のデータが差し替えられました（同じ版の番号のまま）。変わった日は分かりません。`;
  return `${jDateShort(m.new.published_at.slice(0, 10))}に新しい時刻表が公開されました（変わる日の${m.lead_days}日前）。`;
}

function attribution(item) {
  return `出典：${item.operator}${kq(item.name)}GTFSデータ（${item.license}）、GTFSデータリポジトリ（https://gtfs-data.jp/）。まちの足カルテが加工して作成。`;
}

function kmText(m) {
  return m < 1000 ? `約${Math.round(m / 10) * 10}m` : `約${(m / 1000).toFixed(1)}km`;
}

function rideText(r, res) {
  const mins = J.rideMinutes(r);
  const before = res.before.ride ? J.rideMinutes(res.before.ride) : null;
  const detour = before && mins >= before * 2 ? "　遠回りです" : "";
  return `（乗っている時間 ${mins}分${detour}）`;
}

function movedHtml(res) {
  return res.notes.filter((n) => n.kind === "stop_moved")
    .map((n) => `<p class="warn">${kq(esc(n.name))}ののりばの場所が、データの上で${kmText(n.meters)} 動いています。現地の案内を確かめてください。</p>`).join("");
}

function altHtml(res) {
  const a = res.alternatives;
  let html = "";
  if (a.same.length || a.nearby.length) html += `<h2>代わりに使えるバス</h2>`;
  if (a.same.length) {
    html += `<p class="muted">同じバス停で</p>`;
    for (const r of a.same) {
      const label = r.which === "prev" ? "ひとつ前のバス" : "ひとつあとのバス";
      html += `<div class="alt">${label}<br><strong>${busText(r)}</strong>　<span class="muted">${esc(r.route)}</span><br><span class="muted">${esc(rideText(r, res))}</span></div>`;
    }
  }
  if (a.nearby.length) {
    html += `<p class="muted">近くのバス停を使うと（300m以内）</p>`;
    for (const r of a.nearby) {
      const where = r.note.changed === "from" ? `${kq(r.from)}から乗る（${kmText(r.note.meters)}）` : `${kq(r.to)}で降りる（${kmText(r.note.meters)}）`;
      html += `<div class="alt">${esc(where)}<br><strong>${busText(r)}</strong>　<span class="muted">${esc(r.route)}</span><br><span class="muted">${esc(rideText(r, res))}</span></div>`;
    }
  }
  if (!a.nearby.length) {
    html += `<h2>近くのバス停</h2><p>300m以内に、バスが止まるバス停はありません。</p>`;
    for (const n of a.nearest) html += `<p>${kq(esc(n.of))}からいちばん近いバス停は、${kq(esc(n.name))}（${kmText(n.meters)}）です。</p>`;
  }
  if (!a.same.length && !a.nearby.length) html += `<p>${esc(res.P.meta.operator)}やバス会社に、ほかの行き方を相談してください。</p>`;
  return html;
}

// ---------- 画面 ----------
const view = () => document.getElementById("view");
const screen = () => document.getElementById("screen");
function render(html) {
  // 画面ごとに中身を作り直す（前の画面のイベントが残らないように）
  view().innerHTML = `<section id="screen">${html}</section>`;
  window.scrollTo(0, 0);
}
function alertBox(msg) {
  render(`<p class="warn">${esc(msg)}</p><a class="btn secondary" href="#home">はじめに戻る</a>`);
}
const ORDER = { cannot: 0, big: 1, small: 2, will_be_able: 3, better: 4, no_compare: 5, no_route: 6, tiny: 7, same: 8 };

async function homeView() {
  const regs = loadRegs();
  let html = `<h1>わたしの移動</h1>`;
  if (!regs.length) {
    html += `<p class="lead">よく使うバスの移動を登録すると、時刻表が変わるときに、あなたの移動がどうなるかをお知らせします。</p>
      <a class="btn" href="#add/pref">移動を登録する</a>
      <a class="btn secondary" href="#biz/pref">お店や施設の方へ（時刻の変わり目を調べる・貼り紙を作る）</a>`;
    return render(html);
  }
  render(`<h1>わたしの移動</h1><p class="muted">読みこんでいます…</p>`);
  const items = await Promise.all(regs.map(evaluate));
  const changing = items.filter((x) => x.notice && !["same", "tiny", "no_route"].includes(x.notice.level));
  if (changing.length) {
    const allPast = changing.every((x) => x.notice.ph === "after");
    html += `<p class="lead"><strong>バスの時刻表が${allPast ? "変わりました" : "変わります"}。</strong>あなたの移動のうち ${changing.length}件 に関係があります。</p>`;
  }
  const rank = (x) => (x.notice ? ORDER[x.notice.level] : 9);
  items.sort((a, b) => rank(a) - rank(b));
  for (const x of items) {
    const href = `#trip/${esc(x.reg.id)}`;
    const caution = x.missing || x.unusable ? "" : seasonCautions(cautionDates(x)).map((c) => `<div class="small warn-text">${esc(c)}</div>`).join("");
    if (x.missing || x.unusable) {
      html += `<a class="card" href="${href}"><div class="name">${esc(x.reg.name)}</div><div class="muted">${esc(x.unusable ? x.item.note : "このバスのデータが見つかりません")}</div></a>`;
      continue;
    }
    const nowLine = x.now.ride ? `いまのバス　${busText(x.now.ride)}`
      : x.now.missingStop ? removedLines(x.item, x.now).join("。") : "いまは1本で行けるバスがありません";
    const n = x.notice;
    if (!n) {
      const nowHtml = x.now.ride ? `<div class="muted">いまのバス</div><div class="now nowrap">${busText(x.now.ride)}</div>` : `<div class="now">${esc(nowLine)}</div>`;
      html += `<a class="card" href="${href}"><div class="name">${esc(x.reg.name)}</div>${nowHtml}<div class="muted small">いまのところ、時刻が変わる知らせはありません</div>${caution}</a>`;
    } else if (n.level === "no_route") {
      html += `<a class="card" href="${href}"><div class="name">${esc(x.reg.name)}</div><div class="muted">いまは1本で行けるバスがありません。行けるようになったら知らせます。</div>${caution}</a>`;
    } else if (["same", "tiny"].includes(n.level)) {
      const word = n.level === "same" ? "変わりません" : `ほとんど変わりません（${n.shift}分）`;
      html += `<a class="card" href="${href}"><div class="name">${esc(x.reg.name)}　<span class="badge lv-same">${word}</span></div><div class="muted nowrap">${esc(nowLine)}</div>${caution}</a>`;
    } else {
      const li = levelInfo(n);
      const verb = n.ph === "after" ? "変わりました" : "変わります";
      // 見出しに移動の名前が入らない言い方（運行がまた始まる）のときは、名前を先に出す
      const hl = headline(n, x.reg.name);
      const nameLine = hl.includes(x.reg.name) ? "" : `<div class="muted">『${esc(x.reg.name)}』</div>`;
      html += `<a class="card notice ${li.cls}" href="${href}">
        <span class="badge ${li.cls}">${esc(li.badge)}</span>${nameLine}
        <div class="name" style="color:var(--fg)">${esc(hl)}</div>
        <div style="color:var(--fg)">${esc(nowLine)}</div>${caution}</a>`;
    }
  }
  html += `<a class="btn secondary" href="#add/pref">移動を登録する</a>`;
  if (pushConfigured() && !DEMO) html += `<div id="push" class="pushbox"></div>`;
  html += `<a class="btn secondary" href="#biz/pref">お店や施設の方へ</a>`;
  if (DEMO) html += `<p class="muted small">例の表示です（保存されません）。</p>`;
  render(html);
  if (pushConfigured() && !DEMO) pushBox(document.getElementById("push"));
}

// ---------- 知らせ（通知） ----------
const PUSH_NOTE = "サーバーに送るのは、知らせの宛先と、登録したバスの番号だけです。行き先や時刻は送りません。";
async function pushBox(el) {
  if (!el) return;
  const head = `<h2>時刻表が変わるときに知らせる</h2>`;
  if (!pushSupported()) {
    if (isIos() && !isStandalone()) {
      el.innerHTML = `${head}<p>iPhone・iPad で知らせを受け取るには、このアプリをホーム画面に追加してください。</p>
        <ol class="howto"><li>下の共有ボタン（四角から上向きの矢印）を押す</li><li>「ホーム画面に追加」を押す</li>
        <li>ホーム画面の「まちの足」のアイコンから開く</li><li>この画面の「知らせを受け取る」を押す</li></ol>
        <p class="muted small">iOS 16.4 以降で使えます。</p>`;
    } else {
      el.innerHTML = `${head}<p class="muted">この端末のブラウザでは、知らせを受け取れません。アプリを開くと、変わることが出ます。</p>`;
    }
    return;
  }
  if (Notification.permission === "denied") {
    el.innerHTML = `${head}<p>通知が許可されていません。${isIos() ? "iPhone の「設定 → 通知 → まちの足」" : "ブラウザの設定"}から許可してください。</p>`;
    return;
  }
  const sub = await currentSubscription();
  if (sub) {
    el.innerHTML = `${head}<p><strong>知らせを受け取っています。</strong>登録したバスの時刻表が変わるとき、この端末に知らせます。</p>
      <button class="btn secondary" id="push-off">知らせを止める</button><p class="muted small">${PUSH_NOTE}</p>
      <p class="muted small">この端末の番号：<strong>${esc(await deviceNumber(sub))}</strong>（試しの知らせを送るときに使います）</p>`;
    el.querySelector("#push-off").addEventListener("click", async (e) => {
      e.target.disabled = true;
      try {
        await disablePush();
      } catch {
        /* サーバーに届かなくても、端末の受け取りはやめる。宛先は、届かなくなったときにサーバーが消す */
      }
      pushBox(el);
    });
    return;
  }
  el.innerHTML = `${head}<p>登録したバスの時刻表が変わるとき、この端末に知らせます。</p>
    <button class="btn" id="push-on">知らせを受け取る</button><p class="muted small">${PUSH_NOTE}</p>`;
  el.querySelector("#push-on").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const r = await enablePush(loadRegs(), CATALOG);
      if (r !== "granted") e.target.insertAdjacentHTML("afterend", `<p class="warn">通知が許可されませんでした。</p>`);
      else pushBox(el);
    } catch {
      e.target.disabled = false;
      e.target.insertAdjacentHTML("afterend", `<p class="warn">知らせの登録ができませんでした。しばらくしてから、もう一度押してください。</p>`);
    }
  });
}

// 通知を押して開く画面：そのバスの、登録した移動ごとの結果。変わらない移動は、最初に「あなたの移動は変わりません」
async function noticeView(feed, change, test = false) {
  const item = feedItem(feed);
  if (!item) return alertBox("このバスのデータが見つかりません。");
  // 通知の文と同じ見出し（変わる日が分からないときは、日付を入れない）
  const rv = (item.revisions || []).find((r) => r.change_date === change);
  const head = rv && rv.change_date_known === false ? `${item.name}の時刻表が変わりました。`
    : `${item.name}の時刻表が、${TODAY < change ? `${jDateShort(change)}から変わります` : `${jDateShort(change)}に変わりました`}。`;
  render(`<p class="muted">読みこんでいます…</p>`);
  const regs = loadRegs().filter((r) => r.feed === feed);
  let html = `<h1>${esc(head)}${test ? "（試し）" : ""}</h1>`;
  if (test) html += `<p class="muted">これは試しの知らせです。下は、いまの改正のデータでの本当の結果です。</p>`;
  if (!regs.length) {
    html += `<p class="lead">この端末には、このバスの移動が登録されていません。</p>`;
    return render(html + `<a class="btn secondary" href="#home">わたしの移動へ</a>`);
  }
  const items = await Promise.all(regs.map(evaluate));
  const rows = items.map((x) => ({ x, res: (x.results || []).find((r) => r.P.meta.change_date === change) || null }));
  const unchanged = (res) => !!res && ["same", "tiny"].includes(res.level);
  const n = rows.filter((r) => r.res && !unchanged(r.res) && r.res.level !== "no_route").length;
  html += `<p class="lead">${n ? `登録した移動 ${rows.length}件のうち、${n}件 に関係があります。` : "登録した移動は、どれも変わりません。"}</p>`;
  for (const { x, res } of rows) {
    const href = `#trip/${esc(x.reg.id)}`;
    if (res && unchanged(res)) {
      const nowLine = x.now && x.now.ride ? `いまのバス　${busText(x.now.ride)}` : "";
      html += `<a class="card" href="${href}"><div class="verdict same">あなたの移動は変わりません${res.level === "tiny" ? `<span class="small">（${res.shift}分ほどのちがい）</span>` : ""}</div><div class="name">${esc(x.reg.name)}</div><div class="muted nowrap">${esc(nowLine)}</div></a>`;
    } else if (!res) {
      html += `<a class="card" href="${href}"><div class="verdict">この移動は、くらべられませんでした</div><div class="name">${esc(x.reg.name)}</div></a>`;
    } else if (res.level === "no_route") {
      html += `<a class="card" href="${href}"><div class="verdict">いまも、変わったあとも、1本で行けるバスがありません</div><div class="name">${esc(x.reg.name)}</div></a>`;
    } else {
      const li = levelInfo(res);
      const hl = headline(res, x.reg.name);
      const nameLine = hl.includes(x.reg.name) ? "" : `<div class="muted">『${esc(x.reg.name)}』</div>`;
      html += `<a class="card notice ${li.cls}" href="${href}"><span class="badge ${li.cls}">${esc(li.badge)}</span>${nameLine}
        <div class="name" style="color:var(--fg)">${esc(hl)}</div></a>`;
    }
  }
  render(html + `<a class="btn secondary" href="#home">わたしの移動へ</a>`);
}

function revisionHtml(res) {
  const li = levelInfo(res);
  const verb = res.ph === "after" ? "変わりました" : "変わります";
  let html = "";
  if (["same", "tiny"].includes(res.level)) {
    html += unknownDate(res.P)
      ? `<h1>${esc(unknownHead(res.P))}が、『${esc(res.reg.name)}』は変わりません</h1>`
      : `<h1>${jDate(res.P.meta.change_date)}から時刻表が${verb}が、『${esc(res.reg.name)}』は変わりません</h1>`;
  } else if (res.level === "no_route") {
    html += `<h1>『${esc(res.reg.name)}』</h1>`;
  } else {
    html += `<span class="badge ${li.cls}">${esc(li.badge)}</span><h1>${esc(headline(res, res.reg.name))}</h1>`;
  }
  if (res.level !== "no_route") {
    const col = (label, r, cls) => `<div class="col ${cls}"><div class="label">${label}</div>${r ? `<div class="time">${busText(r)}</div><div class="muted">${esc(r.route)}</div>` : `<div class="time">バスがありません</div>`}</div>`;
    html += `<div class="compare ${li.cls}" style="background:none">${col("いままで", res.before.ride, "")}${col(unknownDate(res.P) ? "いまの時刻表" : `${jDateShort(firstDay(res))}から`, res.after.ride, "after")}</div>`;
  }
  for (const l of detailLines(res)) html += `<p class="lead">${esc(l)}</p>`;
  html += cautionHtml(res.before.ride, res.after.ride);
  if (res.level === "tiny") html += `<p class="muted">（${Math.max(Math.abs(res.dDep), Math.abs(res.dArr))}分ほどのちがいです）</p>`;
  html += movedHtml(res);
  if (res.alternatives) html += altHtml(res);
  for (const l of noteLines(res)) html += `<p class="muted">${esc(l)}</p>`;
  const lt = leadOrFewText(feedItem(res.P.meta.feed));
  html += `<div class="source"><p>${esc(sourceLine(res))}${lt ? `${esc(lt)}。` : ""}</p><p class="small">${esc(res.P.meta.attribution)}</p></div>`;
  return html;
}

async function tripView(id) {
  const reg = loadRegs().find((r) => r.id === id);
  if (!reg) return alertBox("その移動は見つかりませんでした。");
  render(`<p class="muted">読みこんでいます…</p>`);
  const x = await evaluate(reg);
  let html = `<p class="muted">${esc(x.item ? x.item.name : "")}<br>${esc(reg.from)} → ${esc(reg.to)}<br>${esc(daysText(reg.days))}　${esc(condText(reg.cond))}</p>`;
  if (x.missing || x.unusable) {
    html += `<p class="warn">${esc(x.unusable ? x.item.note : "このバスのデータが見つかりません")}</p>`;
    return render(html + `<a class="btn secondary" href="#home">もどる</a>` + delBtn(reg));
  }
  const shown = x.results.filter((r) => r.ph !== "before");
  if (shown.length && shown.every((r) => r.level === "no_route")) {
    html += revisionHtml(shown[0]); // どの改正でも1本で行けないときは、1回だけ出す
    return render(html + `<a class="btn secondary" href="#home">もどる</a>` + delBtn(reg));
  }
  if (!shown.length) {
    html += `<h1>${esc(reg.name)}</h1>`;
    html += x.now.missingStop ? removedLines(x.item, x.now).map((l) => `<p class="warn">${esc(l)}</p>`).join("")
      : x.now.ride ? `<div class="compare"><div class="col"><div class="label">いまのバス</div><div class="time">${busText(x.now.ride)}</div><div class="muted">${esc(x.now.ride.route)}</div></div></div>`
      : `<p class="warn">いまの時刻表では、1本で行けるバスがありません。行けるようになったら知らせます。</p>`;
    html += cautionHtml(x.now.ride);
    html += `<p class="lead">いまのところ、時刻が変わる知らせはありません。</p>`;
    if (leadOrFewText(x.item)) html += `<p class="muted">${esc(leadOrFewText(x.item))}</p>`;
    for (const c of seasonCautions(cautionDates(x))) html += `<p class="warn">${esc(c)}</p>`;
    html += `<div class="source"><p class="small">${esc(attribution(x.item))}</p></div>`;
    return render(html + `<a class="btn secondary" href="#home">もどる</a>` + delBtn(reg));
  }
  // 改正が2つ以上あるときは、変わる日の順に出す
  html += shown.map(revisionHtml).join(`<hr style="border:none;border-top:2px solid var(--line);margin:24px 0">`);
  for (const c of seasonCautions(cautionDates(x))) html += `<p class="warn">${esc(c)}</p>`;
  render(html + `<a class="btn secondary" href="#home">もどる</a>` + delBtn(reg));
}

function delBtn(reg) {
  if (DEMO) return "";
  return `<button class="btn secondary" data-del="${esc(reg.id)}">この移動を消す</button>`;
}

// ---------- 登録 ----------
function prefView(mode = "add") {
  if (mode === "add") draft = { days: [] };
  else bizDraft = {};
  const list = CATALOG.prefs.filter((p) => p.code > 0);
  render(`<p class="steps">1 / 7</p><h1>どこのバスですか</h1><p class="muted">都道府県を選んでください。</p>
    ${list.map((p) => `<button class="choice" data-pref="${p.code}">${esc(p.name)}<span class="kana">${p.feeds}のバス</span></button>`).join("")}
    <a class="btn secondary" href="#home">やめる</a>`);
  screen().addEventListener("click", (e) => {
    const b = e.target.closest("[data-pref]");
    if (b) location.hash = `#${mode}/feed/${b.dataset.pref}`;
  });
}

function feedView(pref, mode = "add") {
  if (mode === "add" && !draft) draft = { days: [] };
  if (mode === "biz" && !bizDraft) bizDraft = {};
  const list = CATALOG.feeds.filter((f) => String(f.pref) === String(pref)).sort((a, b) => a.name.localeCompare(b.name, "ja"));
  render(`<p class="steps">2 / 7</p><h1>どのバスですか</h1>
    ${list.map((f) => `<button class="choice" data-feed="${esc(f.feed)}">${esc(f.name)}<span class="kana">${esc(f.operator)}${f.usable ? "" : "（まだ使えません）"}</span>${f.usable && leadText(f) ? `<span class="kana lead-note">${esc(leadText(f))}</span>` : ""}</button>`).join("")}
    <a class="btn secondary" href="#${mode}/pref">都道府県を選びなおす</a>`);
  screen().addEventListener("click", (e) => {
    const b = e.target.closest("[data-feed]");
    if (!b) return;
    const item = feedItem(b.dataset.feed);
    if (!item.usable) {
      render(`<h1>${esc(item.name)}</h1><p class="lead">${esc(item.note)}</p><a class="btn secondary" href="#${mode}/feed/${pref}">ほかのバスを選ぶ</a>`);
      return;
    }
    if (mode === "biz") {
      bizDraft.feed = item.feed;
      location.hash = "#biz/stop";
      return;
    }
    draft.feed = item.feed;
    location.hash = "#add/from";
  });
}

async function stopSearchView(role) {
  const item = feedItem(draft.feed);
  const tp = await timetableP(item);
  const title = role === "from" ? "どのバス停から乗りますか" : "どのバス停で降りますか";
  const step = role === "from" ? 3 : 4;
  render(`<p class="steps">${step} / 7</p><p class="muted">${esc(item.name)}</p><h1>${title}</h1>
    <input type="search" id="q" placeholder="バス停の名前（ひらがなでも）" autocomplete="off">
    <div id="results"></div>
    <a class="btn secondary" href="#home">やめる</a>`);
  const q = document.getElementById("q");
  const show = () => {
    const list = searchStops(tp, q.value, { exclude: role === "to" ? draft.from : null });
    document.getElementById("results").innerHTML = list.length
      ? list.map((g) => `<button class="choice" data-stop="${esc(g.name)}">${esc(g.name)}<span class="kana">${esc(g.kana)}</span></button>`).join("")
      : `<p class="muted">見つかりませんでした。ほかの言い方で探してください。</p>`;
  };
  q.addEventListener("input", show);
  show();
  document.getElementById("results").addEventListener("click", (e) => {
    const b = e.target.closest("[data-stop]");
    if (!b) return;
    draft[role] = b.dataset.stop;
    location.hash = role === "from" ? "#add/to" : "#add/days";
  });
}

function daysView() {
  const sel = new Set(draft.days || []);
  const btn = (k, l, cls = "") => `<button class="choice ${cls}" data-day="${k}" aria-pressed="${sel.has(k)}">${l}</button>`;
  render(`<p class="steps">5 / 7</p><h1>何曜日に乗りますか</h1><p class="muted">いくつでも選べます。</p>
    <div class="days">${DAY_LABELS.map(([k, l]) => btn(k, l)).join("")}${btn("first_sun", "毎月 第1日曜", "wide")}</div>
    <button class="btn" id="next">つぎへ</button><a class="btn secondary" href="#home">やめる</a>`);
  screen().addEventListener("click", (e) => {
    const b = e.target.closest("[data-day]");
    if (b) {
      const k = b.dataset.day;
      sel.has(k) ? sel.delete(k) : sel.add(k);
      b.setAttribute("aria-pressed", sel.has(k));
    }
    if (e.target.id === "next") {
      if (!sel.size) return;
      draft.days = [...sel];
      location.hash = "#add/time";
    }
  });
}

function timeView() {
  render(`<p class="steps">6 / 7</p><h1>時刻の希望を教えてください</h1>
    <button class="choice" data-type="arriveBy" aria-pressed="true">この時刻までに着きたい</button>
    <button class="choice" data-type="departAfter" aria-pressed="false">この時刻よりあとに乗りたい</button>
    <p><input type="time" id="t" value="08:00" step="300"></p>
    <button class="btn" id="next">つぎへ</button><a class="btn secondary" href="#home">やめる</a>`);
  let type = "arriveBy";
  screen().addEventListener("click", (e) => {
    const b = e.target.closest("[data-type]");
    if (b) {
      type = b.dataset.type;
      screen().querySelectorAll("[data-type]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    }
    if (e.target.id === "next") {
      const [h, m] = document.getElementById("t").value.split(":").map(Number);
      draft.cond = { type, time: h * 60 + m };
      location.hash = "#add/check";
    }
  });
}

async function checkView() {
  const reg = { ...draft };
  const item = feedItem(reg.feed);
  const tp = await timetableP(item);
  const chk = J.bestOverDates(tp, reg, nextDates(tp, reg));
  const nowText = chk.ride
    ? `いまのバス：${busText(chk.ride)}`
    : `いまは1本で行けるバスがありません。行けるようになったら知らせます。`;
  render(`<p class="steps">7 / 7</p><h1>この移動に名前をつけてください</h1>
    <p class="muted">${esc(item.name)}<br>${esc(reg.from)} → ${esc(reg.to)}<br>${esc(daysText(reg.days))}　${esc(condText(reg.cond))}</p>
    <p class="${chk.ride ? "lead" : "warn"}">${esc(nowText)}</p>${cautionHtml(chk.ride)}
    <input type="text" id="n" placeholder="例：火曜の病院（行き）" value="">
    <button class="btn" id="save">登録する</button><a class="btn secondary" href="#home">やめる</a>`);
  document.getElementById("save").addEventListener("click", () => {
    const name = document.getElementById("n").value.trim() || `${reg.from}→${reg.to}`;
    const regs = loadRegs();
    regs.push({ ...reg, id: String(Date.now()), name });
    saveRegs(regs);
    draft = null;
    location.hash = "#home";
  });
}

// ---------- 事業者の画面と貼り紙 ----------
const DAY_TYPES = { wk: { label: "平日", days: WK }, sat: { label: "土曜", days: ["sat"] }, sun: { label: "日曜・祝日", days: ["sun"] } };

async function bizStopView() {
  const item = feedItem(bizDraft.feed);
  const tp = await timetableP(item);
  render(`<p class="steps">お店や施設の方へ</p><p class="muted">${esc(item.name)}</p><h1>お店や施設の近くのバス停は</h1>
    <input type="search" id="q" placeholder="バス停の名前（ひらがなでも）" autocomplete="off"><div id="results"></div>
    <a class="btn secondary" href="#home">やめる</a>`);
  const q = document.getElementById("q");
  const show = () => {
    const list = searchStops(tp, q.value);
    document.getElementById("results").innerHTML = list.map((g) => `<button class="choice" data-stop="${esc(g.name)}">${esc(g.name)}<span class="kana">${esc(g.kana)}</span></button>`).join("");
  };
  q.addEventListener("input", show);
  show();
  document.getElementById("results").addEventListener("click", (e) => {
    const b = e.target.closest("[data-stop]");
    if (!b) return;
    bizDraft.stop = b.dataset.stop;
    location.hash = "#biz/hours";
  });
}

function bizHoursView() {
  render(`<p class="steps">お店や施設の方へ</p><h1>開く時刻と閉まる時刻</h1>
    <p>開く時刻<input type="time" id="o" value="${J.hhmm(bizDraft.open ?? 540).padStart(5, "0")}" step="300"></p>
    <p>閉まる時刻<input type="time" id="c" value="${J.hhmm(bizDraft.close ?? 1080).padStart(5, "0")}" step="300"></p>
    <p class="muted">曜日</p>
    ${Object.entries(DAY_TYPES).map(([k, v]) => `<button class="choice" data-dt="${k}" aria-pressed="${(bizDraft.day || "wk") === k}">${v.label}</button>`).join("")}
    <button class="btn" id="next">調べる</button><a class="btn secondary" href="#home">やめる</a>`);
  let dayType = bizDraft.day || "wk";
  screen().addEventListener("click", (e) => {
    const b = e.target.closest("[data-dt]");
    if (b) {
      dayType = b.dataset.dt;
      screen().querySelectorAll("[data-dt]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    }
    if (e.target.id === "next") {
      const t = (id) => document.getElementById(id).value.split(":").map(Number).reduce((h, m) => h * 60 + m);
      Object.assign(bizDraft, { open: t("o"), close: t("c"), day: dayType });
      location.hash = "#biz/result";
    }
  });
}

// その停留所に関わる改正（公開済みで、変更日から30日以内）。無ければ null
async function bizRevision(item) {
  for (const r of activeRevisions(item)) {
    try {
      const P = await revisionP(r.path);
      J.groupOf(P, bizDraft.stop);
      return P;
    } catch {
      /* その停留所が出てこない改正は飛ばす */
    }
  }
  return null;
}

async function bizResultView() {
  render(`<p class="muted">読みこんでいます…</p>`);
  const item = feedItem(bizDraft.feed);
  const dt = DAY_TYPES[bizDraft.day];
  const reg = { days: dt.days };
  const P = await bizRevision(item);
  const tm = (v) => (v == null ? "なし" : J.hhmm(v));
  let html = `<p class="muted">${esc(item.name)}<br>${kq(esc(bizDraft.stop))}バス停・${dt.label}<br>開く ${J.hhmm(bizDraft.open)}・閉まる ${J.hhmm(bizDraft.close)}</p>`;
  if (!P) {
    const tp = await timetableP(item);
    const h = J.stopHours(tp, bizDraft.stop, nextDates(tp, reg), bizDraft.open, bizDraft.close);
    html += `<h1>いまのバス</h1><p class="lead">いまのところ、時刻が変わる知らせはありません。</p>`;
    for (const d of Object.values(h.dirs)) {
      html += `<div class="card"><div class="name">${esc(d.route)}（${esc(d.headsign)}行き）</div>
        <p>開く時刻までに着く、いちばん遅いバス：<strong>${tm(d.latestArr)}</strong>着</p>
        <p>閉まる時刻のあとに乗れる、いちばん早いバス：<strong>${tm(d.firstDepAfter)}</strong>発</p>
        <p>最終のバス：<strong>${tm(d.lastDep)}</strong>発</p>${stopCautionHtml(d.f)}</div>`;
    }
    html += `<div class="source"><p class="small">${esc(attribution(item))}</p></div>`;
    return render(html + `<a class="btn secondary" href="#biz/hours">時刻を変える</a><a class="btn secondary" href="#home">はじめに戻る</a>`);
  }
  const { before, after } = J.compareDates(P, reg);
  const first = after[0] || P.meta.change_date;
  const hb = J.stopHours(P, bizDraft.stop, before, bizDraft.open, bizDraft.close);
  const ha = J.stopHours(P, bizDraft.stop, after, bizDraft.open, bizDraft.close);
  const bizVerb = TODAY >= P.meta.change_date ? "変わりました" : "変わります";
  html += unknownDate(P) ? `<h1>${esc(unknownHead(P))}</h1>` : `<h1>${jDate(first)}から、バスの時刻が${bizVerb}</h1>`;
  const dirs = [...new Set([...Object.keys(hb.dirs), ...Object.keys(ha.dirs)])].sort();
  const cell = (b, a, unit) => {
    const changed = b !== a;
    return `<td>${tm(b)}${b != null ? unit : ""}</td><td${changed ? ' class="chg"' : ""}>${tm(a)}${a != null ? unit : ""}${changed ? " ●" : ""}</td>`;
  };
  for (const k of dirs) {
    const b = hb.dirs[k] || {}, a = ha.dirs[k] || {};
    const x = hb.dirs[k] || ha.dirs[k];
    html += `<div class="card"><div class="name">${esc(x.route)}（${esc(x.headsign)}行き）</div>
      <table class="hours"><tr><th></th><th>いままで</th><th>${unknownDate(P) ? "いま" : `${jDateShort(first)}から`}</th></tr>
      <tr><th>開く時刻までに着く、いちばん遅いバス</th>${cell(b.latestArr, a.latestArr, "着")}</tr>
      <tr><th>閉まる時刻のあとに乗れる、いちばん早いバス</th>${cell(b.firstDepAfter, a.firstDepAfter, "発")}</tr>
      <tr><th>最終のバス</th>${cell(b.lastDep, a.lastDep, "発")}</tr></table>${stopCautionHtml((b.f || 0) | (a.f || 0))}</div>`;
  }
  html += `<p class="muted small">● は変わる時刻です。比べた日：${before.map(jDateShort).join("・")} と ${after.map(jDateShort).join("・")}${hb.split || ha.split ? "（日によって分かれたため、いちばん多い結果）" : ""}</p>`;
  html += `<div class="source"><p>${esc(`${jDateShort(P.meta.new.published_at.slice(0, 10))}に新しい時刻表が公開されました。`)}</p><p class="small">${esc(P.meta.attribution)}</p></div>`;
  html += `<a class="btn" href="#poster">貼り紙を作る（A4 1枚）</a><a class="btn secondary" href="#biz/hours">時刻を変える</a><a class="btn secondary" href="#home">はじめに戻る</a>`;
  render(html);
}

async function posterView() {
  const item = feedItem(bizDraft.feed);
  const P = await bizRevision(item);
  if (!P) return alertBox("このバス停には、いま時刻が変わる知らせがありません。");
  const dt = DAY_TYPES[bizDraft.day];
  const { before, after } = J.compareDates(P, { days: dt.days });
  const first = after[0] || P.meta.change_date;
  const ch = J.stopChanges(P, bizDraft.stop, before, after);
  const tm = (v) => J.hhmm(v);
  // 変わる本数に合わせて並べ方を変える（A4 1枚に収める）：15本まで 1列、40本まで 2列、それより多いと 3列
  const total = ch.dirs.reduce((n, d) => n + d.rows.filter((r) => r.kind !== "same").length, 0);
  const cols = total <= 15 ? 1 : total <= 40 ? 2 : 3;
  let body = "";
  for (const d of ch.dirs) {
    const changed = d.rows.filter((r) => r.kind !== "same");
    const same = d.rows.length - changed.length;
    if (!changed.length) continue;
    body += `<h2>${esc(d.route)}（${esc(d.headsign)}行き）</h2>${stopCautionHtml(d.f, "pnote")}<div class="pgrid cols${cols}">`;
    for (const r of changed) {
      const left = r.old == null ? "―" : tm(r.old);
      const right = r.kind === "removed" ? "なし" : tm(r.new);
      const note = r.kind === "removed" ? "なくなります" : r.kind === "added" ? "新しく走ります" : `${Math.abs(r.shift)}分${r.shift < 0 ? "早く" : "おそく"}`;
      body += `<div class="pitem"><span class="pold">${left}</span> → <span class="pnew">${right}</span> <small>${note}</small></div>`;
    }
    body += `</div>${same ? `<p class="psame">ほかの${same}本は、時刻が変わりません。</p>` : ""}`;
  }
  if (!body) body = `<p class="plead">この停留所から出るバスの時刻は、${dt.label}は変わりません。</p>`;
  view().innerHTML = `<section id="screen" class="poster">
    <p class="noprint"><button class="btn" onclick="window.print()">印刷する</button><a class="btn secondary" href="#biz/result">もどる</a></p>
    <div class="sheet-wrap"><div class="sheet fixed">
      <p class="pkicker">${kq(esc(bizDraft.stop))}バス停（${esc(item.name)}）</p>
      ${unknownDate(P)
        ? `<h1 class="ptitle">${dt.label}のバスの時刻が<br>前と変わっています</h1>
      <p class="plead">このバス停から出るバスのうち、時刻が変わったもの（前の時刻 → いまの時刻）です。${jDateShort(P.meta.change_date)}に分かりました。</p>`
        : TODAY >= P.meta.change_date
          ? `<h1 class="ptitle">${jDate(first)}から<br>${dt.label}のバスの時刻が変わりました</h1>
      <p class="plead">このバス停から出るバスのうち、時刻が変わったもの（前の時刻 → ${jDateShort(first)}からの時刻）です。</p>`
          : `<h1 class="ptitle">${jDate(first)}から<br>${dt.label}のバスの時刻が変わります</h1>
      <p class="plead">このバス停から出るバスのうち、時刻が変わるもの（いまの時刻 → ${jDateShort(first)}からの時刻）です。</p>`}
      ${body}
      <div class="pfoot">
        <p>くわしくは、${esc(item.operator)}の時刻表でご確認ください。</p>
        <p>${esc(P.meta.attribution)}</p>
        <p>作った日：${jDate(TODAY)}　まちの足カルテ</p>
      </div>
    </div></div></section>`;
  fitSheet();
  document.body.classList.add("printing");
  window.addEventListener("hashchange", () => document.body.classList.remove("printing"), { once: true });
}

// 貼り紙を A4 1枚に収める：A4 の印刷できる高さ（297mm − 上下の余白 28mm）を超えたら、紙面を縮める
function fitSheet() {
  const sheet = document.querySelector(".sheet.fixed");
  if (!sheet) return;
  const mm = 96 / 25.4;
  const avail = (297 - 28) * mm - 4;
  sheet.style.zoom = "";
  const h = sheet.scrollHeight;
  if (h > avail) sheet.style.zoom = String(Math.floor((avail / h) * 1000) / 1000);
}

// ---------- 道しるべ ----------
function route() {
  const h = location.hash || "#home";
  if (h === "#home") return homeView();
  if (h.startsWith("#trip/")) return tripView(decodeURIComponent(h.slice(6)));
  if (h.startsWith("#notice/")) {
    const [feed, change, test] = h.slice(8).split("/");
    return noticeView(decodeURIComponent(feed), change, test === "test");
  }
  if (h === "#add/pref") return prefView();
  if (h.startsWith("#add/feed/")) return feedView(h.slice(10));
  if (h === "#biz/pref") return prefView("biz");
  if (h.startsWith("#biz/feed/")) return feedView(h.slice(10), "biz");
  if (h.startsWith("#biz/") || h === "#poster") {
    if (!bizDraft || !bizDraft.feed) {
      location.hash = "#biz/pref";
      return;
    }
    if (h === "#biz/stop") return bizStopView();
    if (h === "#biz/hours") return bizHoursView();
    if (h === "#biz/result") return bizResultView();
    if (h === "#poster") return posterView();
  }
  if (h.startsWith("#add/")) {
    if (!draft || !draft.feed) {
      location.hash = "#add/pref";
      return;
    }
    const step = h.slice(5);
    if (step === "from" || step === "to") return stopSearchView(step);
    if (step === "days") return daysView();
    if (step === "time") return timeView();
    if (step === "check") return checkView();
  }
  homeView();
}

document.addEventListener("click", (e) => {
  const d = e.target.closest("[data-del]");
  if (!d) return;
  saveRegs(loadRegs().filter((r) => r.id !== d.dataset.del));
  location.hash = "#home";
});

async function main() {
  document.getElementById("today").textContent = `今日：${jDate(TODAY)}`;
  try {
    CATALOG = await getJSON("data/catalog.json");
  } catch {
    return alertBox("バスの一覧を読みこめませんでした。");
  }
  showChecked();
  pruneTimetableCache();
  registerSw(); // ホーム画面のアプリとして動かす・通知を受ける
  if (!DEMO) syncPush(loadRegs(), CATALOG);
  window.addEventListener("hashchange", route);
  // 通知を押して開いたとき（?notice=バスの番号/変わる日[/test]）：知らせの画面の「#notice/…」に直して開く
  const notice = params.get("notice");
  if (notice && /^[\w.-]+\/[\w.-]+\/\d{4}-\d{2}-\d{2}(\/test)?$/.test(notice)) {
    const [org, fid, ...rest] = notice.split("/");
    const u = new URL(location.href);
    u.searchParams.delete("notice");
    u.hash = `#notice/${encodeURIComponent(`${org}/${fid}`)}/${rest.join("/")}`;
    history.replaceState(null, "", u.href);
  }
  route();
}
main();

// 「最後に確かめた日時」（GitHub Pages では data/status.json がある）
async function showChecked() {
  const el = document.getElementById("checked");
  try {
    const st = await (await fetch("data/status.json", { cache: "no-store" })).json();
    if (!st.last_checked_at) return;
    const t = new Date(st.last_checked_at);
    // ほかの画面と同じ「11月24日（火）9:35」の書き方（日本時間）
    const j = new Date(t.getTime() + 9 * 3600000);
    const jst = `${j.getUTCMonth() + 1}月${j.getUTCDate()}日（${WD_JP[j.getUTCDay()]}）${j.getUTCHours()}:${String(j.getUTCMinutes()).padStart(2, "0")}`;
    const hours = (Date.now() - t.getTime()) / 3600000;
    el.textContent = `時刻表を最後に確かめた日時：${jst}` + (hours > 48 ? "（しばらく確かめられていません）" : "");
  } catch {
    el.textContent = "";
  }
}
