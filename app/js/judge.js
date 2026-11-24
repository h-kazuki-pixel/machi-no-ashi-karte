// まちの足カルテ：判定（端末の中で動く。画面の処理を持たない）
//
// 決まり（2026-11-23 開発者）:
//   便どうしの対応では判定しない。登録した移動について、古い版と新しい版のそれぞれで
//   「いちばん良いバス」を探し、その2つを比べる。乗り換えなし（1本で行けるバス）だけ。

export const THRESHOLDS = {
  bigShift: 30,     // 出る時刻か着く時刻が30分以上ずれる → 大きく変わる
  bigRideLonger: 15, // 乗っている時間が15分以上のびる → 大きく変わる
  smallShift: 5,    // 5〜29分 → 少し変わる（1〜4分 → ほぼ同じ）
  betterWait: 5,    // 待つ時間が5分以上へる → 良くなる
  nearbyMeters: 300, // 代わりに使える近くの停留所（直線）
  compareCount: 4,  // 変更日の前とあとで比べる日の数
  weeklyWindow: 35, // 毎週の移動：変更日の前後35日から選ぶ
  monthlyWindow: 70, // 月1回の移動（毎月第1日曜だけ）：前後70日から選ぶ
  movedMeters: 50,  // 同じ ID のまま、これ以上動いたのりばは知らせる
};

export const LEVELS = {
  cannot: { order: 0, label: "行けなくなる" },
  big: { order: 1, label: "大きく変わる" },
  small: { order: 2, label: "少し変わる" },
  tiny: { order: 3, label: "ほぼ同じ" },
  same: { order: 4, label: "変わらない" },
  better: { order: 5, label: "良くなる" },
  will_be_able: { order: 6, label: "行けるようになる" }, // 前は1本で行けず、新しい時刻表では行ける
  no_route: { order: 7, label: "1本では行けない" },      // 前も後も1本で行けない（登録はできる）
  no_compare: { order: 8, label: "くらべられない" },      // 前か後に、比べられる日（時刻表のデータがある日）が無い
};

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// ---------- 改正のデータ ----------

// 乗り降りの決まり（時刻表のデータの4つ目の印。scripts/06_build_revision.py と同じ）
export const NO_PICKUP = 1;
export const NO_DROP_OFF = 2;
export const PICKUP_PHONE = 4;
export const PICKUP_DRIVER = 8;
export const DROP_OFF_PHONE = 16;
export const DROP_OFF_DRIVER = 32;

// そのバスに乗る・降りるときの注意（pickup_type・drop_off_type が 2・3 の停留所）
export function rideCautions(r) {
  if (!r) return [];
  const out = [];
  if (r.boardF & PICKUP_PHONE) out.push("pickup_phone");
  if (r.boardF & PICKUP_DRIVER) out.push("pickup_driver");
  if (r.alightF & DROP_OFF_PHONE) out.push("drop_off_phone");
  if (r.alightF & DROP_OFF_DRIVER) out.push("drop_off_driver");
  return out;
}

export function prepare(rev) {
  // 停留所を名前でまとめる（利用者が選ぶのは名前。同じ名前ののりばはまとめる）
  const groups = new Map();
  rev.stops.forEach((s, i) => {
    let g = groups.get(s.name);
    if (!g) {
      g = { name: s.name, kana: s.kana || "", oldNames: new Set(), members: [], inOld: false, inNew: false };
      groups.set(s.name, g);
    }
    g.members.push(i);
    if (s.old_name) g.oldNames.add(s.old_name);
    if (!g.kana && s.kana) g.kana = s.kana;
    g.inOld = g.inOld || s.in_old;
    g.inNew = g.inNew || s.in_new;
  });
  const trips = rev.trips.map(([r, headsign, seq]) => ({
    route: rev.routes[r],
    headsign,
    // f：乗り降りの決まり（1 = 乗れない、2 = 降りられない。時刻表のデータの4つ目）
    stops: seq.map((x) => ({ stop: x[0], arr: x[1], dep: x.length > 2 ? x[2] : x[1], f: x[3] || 0 })),
  }));
  return { ...rev, groups, tripObjs: trips };
}

export function groupOf(P, name) {
  const g = P.groups.get(name);
  if (!g) throw new Error(`停留所が見つかりません: ${name}`);
  return g;
}

// ---------- 日付 ----------

export function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
export function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}
export function addDays(s, n) {
  const d = parseDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmtDate(d);
}
export function weekdayKey(s) {
  return WEEKDAY_KEYS[parseDate(s).getUTCDay()];
}
export function isFirstSunday(s) {
  const d = parseDate(s);
  return d.getUTCDay() === 0 && d.getUTCDate() <= 7;
}

// 登録した曜日に当たるか。days は ["mon", ..., "sun", "first_sun"] の組み合わせ
export function matchesDays(days, s) {
  if (days.includes("first_sun") && isFirstSunday(s)) return true;
  return days.includes(weekdayKey(s));
}

// 比べる日から外すか。第1日曜を登録した移動では「特別なダイヤの日」の印は外さない
// （第1日曜は毎月、ふだんの日曜と違う運行なので、印のとおりに外すと比べる日が無くなるため）
export function isExcluded(P, s, reg) {
  const day = P.days[s];
  if (!day) return true;
  return day.marks.some((m) => {
    if (m.kind === "special" && reg.days.includes("first_sun") && isFirstSunday(s)) return false;
    return true;
  });
}

// 変更日の前の n 回と、あとの n 回（印の付いた日は外す。範囲は改正のデータの35日ずつ）
export function isMonthly(reg) {
  return reg.days.length > 0 && reg.days.every((d) => d === "first_sun");
}

export function compareDates(P, reg, n = THRESHOLDS.compareCount) {
  const change = P.meta.change_date;
  const w = isMonthly(reg) ? THRESHOLDS.monthlyWindow : THRESHOLDS.weeklyWindow;
  const lo = addDays(change, -w);
  const hi = addDays(change, w - 1);
  const all = Object.keys(P.days).sort().filter((s) => s >= lo && s <= hi);
  const ok = (s) => matchesDays(reg.days, s) && !isExcluded(P, s, reg);
  const before = all.filter((s) => s < change && ok(s)).slice(-n);
  const after = all.filter((s) => s >= change && ok(s)).slice(0, n);
  return { before, after };
}

// ---------- 1本で行けるバス ----------

// その日に、from から to へ1本で行けるバス（乗る停留所のあとに降りる停留所に着くものだけ）。
// 同じ停留所に2回止まる循環のバスでは、降りる停留所の直前に乗れる所から乗るとする。
// 乗れない停留所（pickup_type=1）からは乗らず、降りられない停留所（drop_off_type=1）では降りない。
export function ridesOn(P, s, fromName, toName) {
  const day = P.days[s];
  if (!day) return [];
  const from = new Set(groupOf(P, fromName).members);
  const to = new Set(groupOf(P, toName).members);
  const rides = [];
  for (const ti of P.patterns[day.p]) {
    const t = P.tripObjs[ti];
    let board = null;
    t.stops.forEach((st, k) => {
      if (board !== null && to.has(st.stop) && k > board && !(st.f & NO_DROP_OFF)) {
        const b = t.stops[board];
        rides.push({ trip: ti, route: t.route, headsign: t.headsign, dep: b.dep, arr: st.arr,
                     boardStop: b.stop, alightStop: st.stop, version: day.v, boardF: b.f, alightF: st.f });
        board = null;
      }
      if (from.has(st.stop) && !(st.f & NO_PICKUP)) board = k;
    });
  }
  return rides.sort((a, b) => a.dep - b.dep || a.arr - b.arr);
}

// 条件にいちばん合うバス
//   arriveBy:   その時刻までに着くバスのうち、いちばん遅く出るバス
//   departAfter: その時刻よりあと（その時刻ちょうどを含む）に出るバスのうち、いちばん早く出るバス
export function bestRide(rides, cond) {
  if (cond.type === "arriveBy") {
    const c = rides.filter((r) => r.arr <= cond.time);
    c.sort((a, b) => b.dep - a.dep || a.arr - b.arr);
    return c[0] || null;
  }
  const c = rides.filter((r) => r.dep >= cond.time);
  c.sort((a, b) => a.dep - b.dep || a.arr - b.arr);
  return c[0] || null;
}

function rideKey(r) {
  return r ? `${r.dep}|${r.arr}|${r.route}` : "none";
}

// 何日かで探して、いちばん多い結果を使う（分かれたら split に書く）
export function bestOverDates(P, reg, dates) {
  const per = dates.map((s) => ({ date: s, ride: bestRide(ridesOn(P, s, reg.from, reg.to), reg.cond) }));
  const counts = new Map();
  per.forEach((x) => {
    const k = rideKey(x.ride);
    counts.set(k, (counts.get(k) || 0) + 1);
  });
  let topKey = null;
  let top = -1;
  for (const x of per) {
    const k = rideKey(x.ride);
    if (counts.get(k) > top) {
      top = counts.get(k);
      topKey = k;
    }
  }
  const chosen = per.find((x) => rideKey(x.ride) === topKey);
  return {
    ride: chosen ? chosen.ride : null,
    date: chosen ? chosen.date : null,
    dates,
    perDate: per,
    split: counts.size > 1,
    tooFewDates: dates.length < THRESHOLDS.compareCount,
  };
}

// ---------- 段階 ----------

function waitOf(r, cond) {
  return cond.type === "arriveBy" ? cond.time - r.arr : r.dep - cond.time;
}

export function classify(oldR, newR, cond) {
  if (!oldR) return { level: newR ? "will_be_able" : "no_route" };
  if (!newR) return { level: "cannot" };
  const dDep = newR.dep - oldR.dep;
  const dArr = newR.arr - oldR.arr;
  const dRide = (newR.arr - newR.dep) - (oldR.arr - oldR.dep);
  const waitGain = waitOf(oldR, cond) - waitOf(newR, cond);
  const shift = Math.max(Math.abs(dDep), Math.abs(dArr));
  const info = { dDep, dArr, dRide, waitGain, shift };
  // 「良くなる」を先に見る：条件の時刻に前より近いバスがあり、乗っている時間が大きくのびない
  if (waitGain >= THRESHOLDS.betterWait && dRide < THRESHOLDS.bigRideLonger) return { level: "better", ...info };
  if (shift >= THRESHOLDS.bigShift || dRide >= THRESHOLDS.bigRideLonger) return { level: "big", ...info };
  if (shift >= THRESHOLDS.smallShift) return { level: "small", ...info };
  if (shift >= 1) return { level: "tiny", ...info };
  return { level: "same", ...info };
}

// ---------- 代わり ----------

function distM(a, b) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function groupDistance(P, g1, g2) {
  let best = Infinity;
  for (const i of g1.members) for (const j of g2.members) best = Math.min(best, distM(P.stops[i], P.stops[j]));
  return best;
}

export function nearbyGroups(P, name, meters = THRESHOLDS.nearbyMeters) {
  const g = groupOf(P, name);
  const out = [];
  for (const h of P.groups.values()) {
    if (h.name === name || !h.inNew) continue;
    const d = groupDistance(P, g, h);
    if (d <= meters) out.push({ name: h.name, meters: Math.round(d) });
  }
  return out.sort((a, b) => a.meters - b.meters);
}

// ①同じ停留所の組の、前後のバス（いちばん合うバスの、ひとつ前とひとつあと。
//   合うバスが無いときは、条件の時刻の前とあと）
// ②300m以内の別の停留所を使うバス
export function alternatives(P, reg, date) {
  const rides = ridesOn(P, date, reg.from, reg.to);
  const best = bestRide(rides, reg.cond);
  let prev, next;
  if (best) {
    prev = rides.filter((r) => r.dep < best.dep).at(-1);
    next = rides.find((r) => r.dep > best.dep);
  } else {
    const key = reg.cond.type === "arriveBy" ? (r) => r.arr : (r) => r.dep;
    prev = rides.filter((r) => key(r) <= reg.cond.time).at(-1);
    next = rides.find((r) => key(r) > reg.cond.time);
  }
  const same = [];
  if (prev) same.push({ ...prev, which: "prev" });
  if (next) same.push({ ...next, which: "next" });

  const nearby = [];
  const tryPair = (from, to, note) => {
    const r = bestRide(ridesOn(P, date, from, to), reg.cond);
    if (r) nearby.push({ ...r, from, to, note });
  };
  for (const n of nearbyGroups(P, reg.from)) tryPair(n.name, reg.to, { changed: "from", name: n.name, meters: n.meters });
  for (const n of nearbyGroups(P, reg.to)) tryPair(reg.from, n.name, { changed: "to", name: n.name, meters: n.meters });
  nearby.sort((a, b) => waitOf(a, reg.cond) - waitOf(b, reg.cond) || a.note.meters - b.note.meters);
  // 300m以内に代わりが無いとき：その日にバスが止まる、いちばん近いバス停（代わりとは呼ばない）
  const nearest = [];
  if (!nearby.length) {
    for (const [role, name] of [["from", reg.from], ["to", reg.to]]) {
      if (servedOn(P, date, name)) continue;
      const n = nearestServed(P, date, name);
      if (n) nearest.push({ role, of: name, ...n });
    }
  }
  return { same, nearby: nearby.slice(0, 3), nearest };
}

export function nearestServed(P, date, name) {
  const g = groupOf(P, name);
  let best = null;
  for (const h of P.groups.values()) {
    if (h.name === name || !servedOn(P, date, h.name)) continue;
    const d = groupDistance(P, g, h);
    if (!best || d < best.meters) best = { name: h.name, meters: Math.round(d) };
  }
  return best;
}

export function rideMinutes(r) {
  return r.arr - r.dep;
}

// ---------- まとめ ----------

// その日に、その停留所に止まるバスがあるか
const servedCache = new WeakMap();
function servedStops(P, s) {
  let byDate = servedCache.get(P);
  if (!byDate) servedCache.set(P, (byDate = new Map()));
  if (!byDate.has(s)) {
    const set = new Set();
    const day = P.days[s];
    // 乗ることも降りることもできない停留所（通過と同じ）は、止まるとみなさない
    if (day) for (const ti of P.patterns[day.p]) for (const st of P.tripObjs[ti].stops) if (!(st.f & NO_PICKUP && st.f & NO_DROP_OFF)) set.add(st.stop);
    byDate.set(s, set);
  }
  return byDate.get(s);
}

export function servedOn(P, s, name) {
  const set = servedStops(P, s);
  return groupOf(P, name).members.some((i) => set.has(i));
}

export function judge(P, reg) {
  const { before, after } = compareDates(P, reg);
  const b = bestOverDates(P, reg, before);
  const a = bestOverDates(P, reg, after);
  // 比べられる日が無い側があるときは、行ける・行けないを言わない
  const c = !before.length || !after.length
    ? { level: "no_compare", missing: !before.length ? "before" : "after" }
    : classify(b.ride, a.ride, reg.cond);
  const out = { reg, before: b, after: a, ...c, notes: [] };
  const hasSpecial = (dates) => dates.some((d) => P.days[d].marks.some((m) => m.kind === "special"));
  if (reg.days.includes("first_sun") && hasSpecial(b.dates) && !hasSpecial(a.dates)) {
    out.notes.push({ kind: "first_sunday_service_ends" });
  }
  if (a.dates.length) {
    for (const [role, name] of [["from", reg.from], ["to", reg.to]]) {
      const wasServed = b.dates.some((d) => servedOn(P, d, name));
      const isServed = a.dates.some((d) => servedOn(P, d, name));
      if (wasServed && !isServed) out.notes.push({ kind: "stop_not_served", role, name });
    }
  }
  // 路線の運行が始まる・終わる（比べる日＝登録した曜日の日に、その路線のバスが1本も走らない側がある）
  const routeRuns = (dates, route) => dates.some((d) => P.patterns[P.days[d].p].some((ti) => P.tripObjs[ti].route === route));
  if (c.level === "will_be_able" && a.ride && !routeRuns(b.dates, a.ride.route)) {
    // 前の運行の最後の日（季節運行の再開など。改正のデータの meta.route_last_run）
    const prevLast = (P.meta.route_last_run || {})[a.ride.route];
    out.notes.push({ kind: "route_starts", route: a.ride.route, ...(prevLast ? { prevLast } : {}) });
  }
  if (c.level === "cannot" && b.ride && !routeRuns(a.dates, b.ride.route)) {
    out.notes.push({ kind: "route_ends", route: b.ride.route });
  }
  for (const m of movedStops(P, reg)) out.notes.push({ kind: "stop_moved", ...m });
  if (b.split) out.notes.push({ kind: "split", side: "before" });
  if (a.split) out.notes.push({ kind: "split", side: "after" });
  if (b.tooFewDates || a.tooFewDates) out.notes.push({ kind: "too_few_dates", before: b.dates.length, after: a.dates.length });
  if ((c.level === "cannot" || c.level === "big") && a.dates.length) {
    out.alternatives = alternatives(P, reg, a.date || a.dates[0]);
  }
  return out;
}

// 登録の時点で：古い版（いまの時刻表）で1本で行けるか
// 同じ ID のまま 50m 以上動いたのりば（データの上で）
export function movedStops(P, reg) {
  const out = [];
  for (const name of [reg.from, reg.to]) {
    for (const i of groupOf(P, name).members) {
      const s = P.stops[i];
      if (s.moved_m >= THRESHOLDS.movedMeters) out.push({ name, meters: s.moved_m });
    }
  }
  return out;
}

export function checkRegistration(P, reg, today) {
  const { before } = compareDates(P, reg);
  const dates = today >= P.meta.change_date ? compareDates(P, reg).after : before;
  const r = bestOverDates(P, reg, dates);
  return { ok: !!r.ride, ...r };
}

export function hhmm(m) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}:${String(mm).padStart(2, "0")}`;
}

// ---------- 停留所から見た時刻（事業者の画面・貼り紙） ----------

// その日に、その停留所（名前でまとめたのりば）に止まるバス。同じバスが2回止まるときは2つ
//   arr: 着く時刻（始発の停留所では null）、dep: 出る時刻（終点では null）
export function stopEvents(P, date, name) {
  const day = P.days[date];
  if (!day) return [];
  const m = new Set(groupOf(P, name).members);
  const out = [];
  for (const ti of P.patterns[day.p]) {
    const t = P.tripObjs[ti];
    t.stops.forEach((st, k) => {
      if (!m.has(st.stop)) return;
      // 着く時刻は降りられるときだけ、出る時刻は乗れるときだけ
      const arr = k > 0 && !(st.f & NO_DROP_OFF) ? st.arr : null;
      const dep = k < t.stops.length - 1 && !(st.f & NO_PICKUP) ? st.dep : null;
      if (arr == null && dep == null) return;
      out.push({ route: t.route, headsign: t.headsign, dir: `${t.route}｜${t.headsign}`, arr, dep });
    });
  }
  return out.sort((a, b) => (a.dep ?? a.arr) - (b.dep ?? b.arr));
}

// 何日かのうち、いちばん多い結果（同じ数なら先の日）
function majorityBy(perDate, keyOf) {
  const cnt = new Map();
  for (const x of perDate) cnt.set(keyOf(x.v), (cnt.get(keyOf(x.v)) || 0) + 1);
  let best = null;
  for (const x of perDate) if (!best || cnt.get(keyOf(x.v)) > cnt.get(keyOf(best.v))) best = x;
  return best ? { ...best, split: cnt.size > 1 } : null;
}

// 開く時刻・閉まる時刻から見たバス（行き先ごと）。dates は比べる日（compareDates などで選ぶ）
export function stopHours(P, name, dates, openT, closeT) {
  const perDate = dates.map((d) => {
    const ev = stopEvents(P, d, name);
    const dirs = {};
    for (const e of ev) {
      const x = (dirs[e.dir] ||= { route: e.route, headsign: e.headsign, latestArr: null, firstDepAfter: null, lastDep: null });
      if (e.arr != null && e.arr <= openT && (x.latestArr == null || e.arr > x.latestArr)) x.latestArr = e.arr;
      if (e.dep != null && e.dep >= closeT && (x.firstDepAfter == null || e.dep < x.firstDepAfter)) x.firstDepAfter = e.dep;
      if (e.dep != null && (x.lastDep == null || e.dep > x.lastDep)) x.lastDep = e.dep;
    }
    return { date: d, v: dirs };
  });
  const m = majorityBy(perDate, (v) => JSON.stringify(v));
  return { dirs: m ? m.v : {}, date: m ? m.date : null, dates, split: m ? m.split : false };
}

// 出る時刻を、前と後で組にする（順番を保つ。ずれが maxShift 分を超える組は作らない）
export function alignTimes(xs, ys, maxShift = 30) {
  const gap = maxShift / 2;
  const n = xs.length, m = ys.length;
  const cost = Array.from({ length: n + 1 }, () => Array(m + 1).fill(Infinity));
  const back = Array.from({ length: n + 1 }, () => Array(m + 1).fill(null));
  cost[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const c = cost[i][j];
      if (c === Infinity) continue;
      if (i < n && c + gap < cost[i + 1][j]) { cost[i + 1][j] = c + gap; back[i + 1][j] = [i, j, "old"]; }
      if (j < m && c + gap < cost[i][j + 1]) { cost[i][j + 1] = c + gap; back[i][j + 1] = [i, j, "new"]; }
      if (i < n && j < m) {
        const d = Math.abs(ys[j] - xs[i]);
        if (d <= maxShift && c + d < cost[i + 1][j + 1]) { cost[i + 1][j + 1] = c + d; back[i + 1][j + 1] = [i, j, "pair"]; }
      }
    }
  }
  const out = [];
  let i = n, j = m;
  while (i || j) {
    const [pi, pj, k] = back[i][j];
    out.push({ old: k !== "new" ? xs[pi] : null, new: k !== "old" ? ys[pj] : null });
    i = pi; j = pj;
  }
  return out.reverse();
}

// 停留所から出るバスの時刻の、前と後の対応（行き先ごと）。貼り紙に使う
export function stopChanges(P, name, beforeDates, afterDates) {
  const deps = (dates) => {
    const perDate = dates.map((d) => {
      const by = {};
      for (const e of stopEvents(P, d, name)) if (e.dep != null) (by[e.dir] ||= { route: e.route, headsign: e.headsign, times: [] }).times.push(e.dep);
      return { date: d, v: by };
    });
    const m = majorityBy(perDate, (v) => JSON.stringify(v));
    return { by: m ? m.v : {}, split: m ? m.split : false };
  };
  const b = deps(beforeDates), a = deps(afterDates);
  const dirs = [...new Set([...Object.keys(b.by), ...Object.keys(a.by)])];
  const rows = dirs.map((dir) => {
    const x = b.by[dir] || a.by[dir];
    const pairs = alignTimes((b.by[dir] || { times: [] }).times.sort((p, q) => p - q), (a.by[dir] || { times: [] }).times.sort((p, q) => p - q));
    return { dir, route: x.route, headsign: x.headsign, rows: pairs.map((p) => ({ ...p,
      kind: p.old == null ? "added" : p.new == null ? "removed" : p.old === p.new ? "same" : "shifted",
      shift: p.old != null && p.new != null ? p.new - p.old : 0 }))
      .sort((p, q) => (p.old ?? p.new) - (q.old ?? q.new) || (p.new ?? p.old) - (q.new ?? q.old)) }; // 時刻の順
  });
  rows.sort((p, q) => p.route.localeCompare(q.route, "ja") || p.headsign.localeCompare(q.headsign, "ja"));
  return { dirs: rows, split: b.split || a.split };
}
