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
};

export const LEVELS = {
  cannot: { order: 0, label: "行けなくなる" },
  big: { order: 1, label: "大きく変わる" },
  small: { order: 2, label: "少し変わる" },
  tiny: { order: 3, label: "ほぼ同じ" },
  same: { order: 4, label: "変わらない" },
  better: { order: 5, label: "良くなる" },
};

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// ---------- 改正のデータ ----------

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
    stops: seq.map((x) => ({ stop: x[0], arr: x[1], dep: x.length > 2 ? x[2] : x[1] })),
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
export function compareDates(P, reg, n = THRESHOLDS.compareCount) {
  const change = P.meta.change_date;
  const all = Object.keys(P.days).sort();
  const ok = (s) => matchesDays(reg.days, s) && !isExcluded(P, s, reg);
  const before = all.filter((s) => s < change && ok(s)).slice(-n);
  const after = all.filter((s) => s >= change && ok(s)).slice(0, n);
  return { before, after };
}

// ---------- 1本で行けるバス ----------

// その日に、from から to へ1本で行けるバス（乗る停留所のあとに降りる停留所に着くものだけ）。
// 同じ停留所に2回止まる循環のバスでは、降りる停留所の直前に乗れる所から乗るとする。
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
      if (board !== null && to.has(st.stop) && k > board) {
        const b = t.stops[board];
        rides.push({ trip: ti, route: t.route, headsign: t.headsign, dep: b.dep, arr: st.arr,
                     boardStop: b.stop, alightStop: st.stop, version: day.v });
        board = null;
      }
      if (from.has(st.stop)) board = k;
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
  if (!oldR) return { level: "no_route_before" };
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
  return { same, nearby: nearby.slice(0, 3) };
}

// ---------- まとめ ----------

// その日に、その停留所に止まるバスがあるか
export function servedOn(P, s, name) {
  const day = P.days[s];
  if (!day) return false;
  const m = new Set(groupOf(P, name).members);
  return P.patterns[day.p].some((ti) => P.tripObjs[ti].stops.some((st) => m.has(st.stop)));
}

export function judge(P, reg) {
  const { before, after } = compareDates(P, reg);
  const b = bestOverDates(P, reg, before);
  const a = bestOverDates(P, reg, after);
  const c = classify(b.ride, a.ride, reg.cond);
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
  if (b.split) out.notes.push({ kind: "split", side: "before" });
  if (a.split) out.notes.push({ kind: "split", side: "after" });
  if (b.tooFewDates || a.tooFewDates) out.notes.push({ kind: "too_few_dates", before: b.dates.length, after: a.dates.length });
  if ((c.level === "cannot" || c.level === "big") && a.dates.length) {
    out.alternatives = alternatives(P, reg, a.date || a.dates[0]);
  }
  return out;
}

// 登録の時点で：古い版（いまの時刻表）で1本で行けるか
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
