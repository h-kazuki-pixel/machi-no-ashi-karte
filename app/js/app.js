// まちの足カルテ：画面
// 登録した内容は localStorage（この端末の中）だけに保存し、どこにも送らない。
import * as J from "./judge.js";
import { searchStops } from "./search.js";

const REVISION_URL = "data/revisions/yonezawa_20261201.json";
const STORE_KEY = "machi-no-ashi-karte.regs.v1";
const DAY_LABELS = [["mon", "月"], ["tue", "火"], ["wed", "水"], ["thu", "木"], ["fri", "金"], ["sat", "土"], ["sun", "日"]];
const WD_JP = ["日", "月", "火", "水", "木", "金", "土"];

// URL で「今日」を切り替えられる（例：?today=2026-11-25）。?demo=1 で例の移動を表示（保存しない）
const params = new URLSearchParams(location.search);
const TODAY = params.get("today") || new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
const DEMO = params.get("demo") === "1";

const DEMO_REGS = [
  { id: "d1", name: "平日の朝、駅へ", from: "上杉神社前", to: "米沢駅前", days: ["mon", "tue", "wed", "thu", "fri"], cond: { type: "arriveBy", time: 480 } },
  { id: "d2", name: "平日の午後、万世小へ", from: "米沢駅前", to: "万世小学校前", days: ["mon", "tue", "wed", "thu", "fri"], cond: { type: "departAfter", time: 870 } },
  { id: "d3", name: "火曜の病院（行き）", from: "米沢駅前", to: "国立米沢病院前", days: ["tue"], cond: { type: "arriveBy", time: 600 } },
  { id: "d4", name: "平日の朝、鶴城高校へ", from: "米沢駅前", to: "鶴城高校前", days: ["mon", "tue", "wed", "thu", "fri"], cond: { type: "arriveBy", time: 510 } },
  { id: "d5", name: "平日のお昼、上杉神社へ", from: "米沢駅前（東口）", to: "上杉神社前", days: ["mon", "tue", "wed", "thu", "fri"], cond: { type: "departAfter", time: 710 } },
  { id: "d6", name: "第1日曜、駅へ", from: "福祉の里入口", to: "米沢駅前", days: ["first_sun"], cond: { type: "departAfter", time: 540 } },
  { id: "d7", name: "平日の夕方、通町へ", from: "米沢駅前", to: "通町六丁目", days: ["mon", "tue", "wed", "thu", "fri"], cond: { type: "departAfter", time: 1060 } },
  { id: "d8", name: "平日の夕方、上杉神社へ", from: "米沢駅前", to: "上杉神社前", days: ["mon", "tue", "wed", "thu", "fri"], cond: { type: "departAfter", time: 1050 } },
  { id: "d9", name: "平日の夕方、芳泉町へ", from: "米沢駅前", to: "芳泉町", days: ["mon", "tue", "wed", "thu", "fri"], cond: { type: "departAfter", time: 1060 } },
  { id: "d10", name: "平日の朝、スキー場から病院へ", from: "米沢スキー場前", to: "国立米沢病院前", days: ["mon", "tue", "wed", "thu", "fri"], cond: { type: "arriveBy", time: 600 } },
];

let P = null;
let draft = null;

// ---------- 保存 ----------
function loadRegs() {
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
const busText = (r) => `${J.hhmm(r.dep)}発 → ${J.hhmm(r.arr)}着`;
function condText(c) {
  return c.type === "arriveBy" ? `${J.hhmm(c.time)}までに着きたい` : `${J.hhmm(c.time)}よりあとに乗りたい`;
}
function daysText(days) {
  const wk = ["mon", "tue", "wed", "thu", "fri"];
  const parts = [];
  const rest = days.filter((d) => d !== "first_sun");
  if (wk.every((d) => rest.includes(d)) && rest.length === 5) parts.push("平日");
  else DAY_LABELS.forEach(([k, l]) => rest.includes(k) && parts.push(`${l}曜`));
  if (days.includes("first_sun")) parts.push("毎月第1日曜");
  return parts.join("・");
}
function minutesPhrase(d, early, late) {
  return d < 0 ? `${-d}分${early}` : `${d}分${late}`;
}

function levelInfo(res, ph = phase()) {
  const past = ph === "after";
  const L = res.level;
  if (L === "will_be_able") {
    return past ? { cls: "lv-better", badge: "1本で行けるようになりました" } : { cls: "lv-better", badge: "1本で行けるようになります" };
  }
  if (L === "no_route") return { cls: "lv-none", badge: "いまは1本では行けません" };
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
  const out = [];
  if (res.level === "cannot") {
    out.push(`${P.meta.feed_name}では、1本で行けるバスがなくなります。`);
    const firstSunEnds = res.notes.some((n) => n.kind === "first_sunday_service_ends");
    if (firstSunEnds) out.push("第1日曜だけ走っていたバスが、なくなります。");
    for (const n of res.notes) {
      if (n.kind === "stop_not_served" && !firstSunEnds) out.push(`${daysText(res.reg.days)}は、バスが「${n.name}」に止まりません。`);
    }
    if (out.length === 1) out.push(`「${condText(res.reg.cond)}」に合うバスが、なくなります。`);
    return out;
  }
  if (res.level === "will_be_able") {
    out.push(`いままでは、${P.meta.feed_name}に1本で行けるバスがありませんでした。`);
    out.push(`${jDate(firstDay(res))}からは、${busText(res.after.ride)} のバスがあります。`);
    return out;
  }
  if (res.level === "no_route") {
    out.push(`${P.meta.feed_name}には、この組み合わせを1本で行けるバスがありません。行けるようになったら知らせます。`);
    return out;
  }
  if (res.level === "better") {
    out.push(`待つ時間が${res.waitGain}分へります。`);
  }
  if (res.dDep) out.push(`出る時刻が${minutesPhrase(res.dDep, "早くなります。", "おそくなります。")}`);
  if (res.dDep < 0 && res.level !== "better") out[out.length - 1] = `${-res.dDep}分早く出る必要があります。`;
  if (res.dArr) out.push(`着く時刻が${minutesPhrase(res.dArr, "早くなります。", "おそくなります。")}`);
  if (res.dRide >= 5) out.push(`乗っている時間が${res.dRide}分長くなります。`);
  if (res.dRide <= -5) out.push(`乗っている時間が${-res.dRide}分短くなります。`);
  if (res.before.ride && res.after.ride && res.before.ride.route !== res.after.ride.route) {
    out.push(`乗るバスが「${res.after.ride.route}」に変わります。`);
  }
  return out;
}

function noteLines(res) {
  const out = [];
  for (const n of res.notes) {
    if (n.kind === "split") out.push(`${n.side === "before" ? "いまの時刻表" : "新しい時刻表"}では、日によって結果が分かれました。いちばん多い結果を出しています。`);
    if (n.kind === "too_few_dates") out.push(`比べられた日が少ないため（前 ${n.before}回・あと ${n.after}回）、たしかではありません。`);
  }
  return out;
}

function sourceLine() {
  const m = P.meta;
  const pub = m.new.published_at.slice(0, 10);
  return `${jDateShort(pub)}に新しい時刻表が公開されました（変わる日の${m.lead_days}日前）。`;
}

// ---------- 状態 ----------
function phase() {
  const pub = P.meta.new.published_at.slice(0, 10);
  if (TODAY >= P.meta.change_date) return "after";
  if (TODAY >= pub) return "announced";
  return "before";
}

// 登録した曜日に当たる、改正のあとの最初の日（第1日曜の移動なら 12月6日）
function firstDay(res) {
  return res.after.dates[0] || P.meta.change_date;
}

function evaluate(reg) {
  const res = J.judge(P, reg);
  const ph = phase();
  const now = ph === "after" ? res.after : res.before;
  return { res, ph, now };
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

function homeView() {
  const regs = loadRegs();
  const ph = phase();
  let html = `<h1>わたしの移動</h1>`;
  if (!regs.length) {
    html += `<p class="lead">よく使うバスの移動を登録すると、時刻表が変わるときに、あなたの移動がどうなるかをお知らせします。</p>
      <a class="btn" href="#add/from">移動を登録する</a>`;
    return render(html);
  }
  const items = regs.map((r) => ({ reg: r, ...evaluate(r) }));
  const changing = items.filter((x) => !["same", "tiny", "no_route"].includes(x.res.level));
  if (ph !== "before" && changing.length) {
    const verb = ph === "after" ? "変わりました" : "変わります";
    html += `<p class="lead"><strong>${jDate(P.meta.change_date)}から、バスの時刻表が${verb}。</strong>あなたの移動のうち ${changing.length}件 に関係があります。</p>`;
  }
  const order = { cannot: 0, big: 1, small: 2, will_be_able: 3, better: 4, no_route: 5, tiny: 6, same: 7 };
  items.sort((a, b) => order[a.res.level] - order[b.res.level]);
  for (const x of items) {
    const li = levelInfo(x.res);
    const nowLine = x.now.ride ? `いまのバス　${busText(x.now.ride)}` : "いまは1本で行けるバスがありません";
    if (ph === "before") {
      const nowHtml = x.now.ride ? `<div class="muted">いまのバス</div><div class="now nowrap">${busText(x.now.ride)}</div>` : `<div class="now">${esc(nowLine)}</div>`;
      html += `<a class="card" href="#trip/${esc(x.reg.id)}"><div class="name">${esc(x.reg.name)}</div>${nowHtml}</a>`;
    } else if (x.res.level === "no_route") {
      html += `<a class="card" href="#trip/${esc(x.reg.id)}"><div class="name">${esc(x.reg.name)}</div><div class="muted">いまは1本で行けるバスがありません。行けるようになったら知らせます。</div></a>`;
    } else if (["same", "tiny"].includes(x.res.level)) {
      const word = x.res.level === "same" ? "変わりません" : `ほとんど変わりません（${x.res.shift}分）`;
      html += `<a class="card" href="#trip/${esc(x.reg.id)}"><div class="name">${esc(x.reg.name)}　<span class="badge lv-same">${word}</span></div><div class="muted nowrap">${esc(nowLine)}</div></a>`;
    } else {
      const verb = ph === "after" ? "変わりました" : "変わります";
      html += `<a class="card notice ${li.cls}" href="#trip/${esc(x.reg.id)}">
        <span class="badge ${li.cls}">${esc(li.badge)}</span>
        <div class="name" style="color:var(--fg)">${jDate(firstDay(x.res))}から、『${esc(x.reg.name)}』が${verb}</div>
        <div style="color:var(--fg)">${esc(nowLine)}</div></a>`;
    }
  }
  html += `<a class="btn secondary" href="#add/from">移動を登録する</a>`;
  html += `<p class="muted small">${esc(P.meta.attribution)}</p>`;
  if (DEMO) html += `<p class="muted small">例の表示です（保存されません）。</p>`;
  render(html);
}

function tripView(id) {
  const reg = loadRegs().find((r) => r.id === id);
  if (!reg) return alertBox("その移動は見つかりませんでした。");
  const { res, ph } = evaluate(reg);
  const li = levelInfo(res);
  const verb = ph === "after" ? "変わりました" : "変わります";
  let html = `<p class="muted">${esc(reg.from)} → ${esc(reg.to)}<br>${esc(daysText(reg.days))}　${esc(condText(reg.cond))}</p>`;
  if (ph === "before") {
    html += `<h1>${esc(reg.name)}</h1>`;
    html += res.before.ride ? `<div class="compare"><div class="col"><div class="label">いまのバス</div><div class="time">${busText(res.before.ride)}</div><div class="muted">${esc(res.before.ride.route)}</div></div></div>`
      : `<p class="warn">いまの時刻表では、1本で行けるバスがありません。</p>`;
    html += `<p class="muted">いまのところ、時刻表が変わるお知らせはありません。</p>`;
    return render(html + `<a class="btn secondary" href="#home">もどる</a>` + delBtn(reg));
  }
  if (res.level === "no_route") {
    html += `<h1>『${esc(reg.name)}』</h1>`;
    for (const l of detailLines(res)) html += `<p class="lead">${esc(l)}</p>`;
    html += movedHtml(res);
    return render(html + `<a class="btn secondary" href="#home">もどる</a>` + delBtn(reg));
  }
  if (["same", "tiny"].includes(res.level)) {
    html += `<h1>${jDate(P.meta.change_date)}から時刻表が${verb}が、『${esc(reg.name)}』は変わりません</h1>`;
  } else {
    html += `<span class="badge ${li.cls}">${esc(li.badge)}</span><h1>${jDate(firstDay(res))}から、『${esc(reg.name)}』が${verb}</h1>`;
  }
  const col = (label, r, cls) => `<div class="col ${cls}"><div class="label">${label}</div>${r ? `<div class="time">${busText(r)}</div><div class="muted">${esc(r.route)}</div>` : `<div class="time">バスがありません</div>`}</div>`;
  html += `<div class="compare ${li.cls}" style="background:none">${col("いままで", res.before.ride, "")}${col(`${jDateShort(firstDay(res))}から`, res.after.ride, "after")}</div>`;
  for (const l of detailLines(res)) html += `<p class="lead">${esc(l)}</p>`;
  if (res.level === "tiny") html += `<p class="muted">（${Math.max(Math.abs(res.dDep), Math.abs(res.dArr))}分ほどのちがいです）</p>`;
  html += movedHtml(res);
  if (res.alternatives) html += altHtml(res);
  for (const l of noteLines(res)) html += `<p class="muted">${esc(l)}</p>`;
  html += `<div class="source"><p>${esc(sourceLine())}</p><p class="small">${esc(P.meta.attribution)}</p></div>`;
  html += `<a class="btn secondary" href="#home">もどる</a>` + delBtn(reg);
  render(html);
}

function addDaysSafe(s, n) {
  return J.addDays(s, n);
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
    .map((n) => `<p class="warn">「${esc(n.name)}」ののりばの場所が、データの上で${kmText(n.meters)} 動いています。現地の案内を確かめてください。</p>`).join("");
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
      const where = r.note.changed === "from" ? `「${r.from}」から乗る（${kmText(r.note.meters)}）` : `「${r.to}」で降りる（${kmText(r.note.meters)}）`;
      html += `<div class="alt">${esc(where)}<br><strong>${busText(r)}</strong>　<span class="muted">${esc(r.route)}</span><br><span class="muted">${esc(rideText(r, res))}</span></div>`;
    }
  }
  if (!a.nearby.length) {
    html += `<h2>近くのバス停</h2><p>300m以内に、バスが止まるバス停はありません。</p>`;
    for (const n of a.nearest) html += `<p>「${esc(n.of)}」からいちばん近いバス停は、「${esc(n.name)}」（${kmText(n.meters)}）です。</p>`;
  }
  if (!a.same.length && !a.nearby.length) html += `<p>${esc(P.meta.operator)}やバス会社に、ほかの行き方を相談してください。</p>`;
  return html;
}

function delBtn(reg) {
  if (DEMO) return "";
  return `<button class="btn secondary" data-del="${esc(reg.id)}">この移動を消す</button>`;
}

// ---------- 登録 ----------

function stopSearchView(role) {
  const title = role === "from" ? "どのバス停から乗りますか" : "どのバス停で降りますか";
  const step = role === "from" ? 1 : 2;
  render(`<p class="steps">${step} / 5</p><h1>${title}</h1>
    <input type="search" id="q" placeholder="バス停の名前（ひらがなでも）" autocomplete="off">
    <div id="results"></div>
    <a class="btn secondary" href="#home">やめる</a>`);
  const q = document.getElementById("q");
  const show = () => {
    const list = searchStops(P, q.value, { exclude: role === "to" && draft ? draft.from : null });
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
  render(`<p class="steps">3 / 5</p><h1>何曜日に乗りますか</h1><p class="muted">いくつでも選べます。</p>
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
  render(`<p class="steps">4 / 5</p><h1>時刻の希望を教えてください</h1>
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

function checkView() {
  const reg = { ...draft };
  const chk = J.checkRegistration(P, reg, TODAY);
  const nowText = chk.ok
    ? `いまのバス：${busText(chk.ride)}`
    : `いまは1本で行けるバスがありません。行けるようになったら知らせます。`;
  render(`<p class="steps">5 / 5</p><h1>この移動に名前をつけてください</h1>
    <p class="muted">${esc(reg.from)} → ${esc(reg.to)}<br>${esc(daysText(reg.days))}　${esc(condText(reg.cond))}</p>
    <p class="${chk.ok ? "lead" : "warn"}">${esc(nowText)}</p>
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

// ---------- 道しるべ ----------
function route() {
  const h = location.hash || "#home";
  if (h === "#home") return homeView();
  if (h.startsWith("#trip/")) return tripView(decodeURIComponent(h.slice(6)));
  if (h.startsWith("#add/")) {
    const step = h.slice(5);
    if (step === "from") draft = { days: [] };
    if (!draft) {
      location.hash = "#add/from";
      return;
    }
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
    const res = await fetch(REVISION_URL);
    P = J.prepare(await res.json());
  } catch {
    return alertBox("時刻表のデータを読みこめませんでした。");
  }
  window.addEventListener("hashchange", route);
  route();
}
main();
