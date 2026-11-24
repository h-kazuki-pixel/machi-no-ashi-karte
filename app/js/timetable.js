// まちの足カルテ：版ごとの時刻表のデータ（timetable-1）と、改正のデータ（revision-2）を読む
//
// 「その日に走るバス」の決まりは、調査の Python（03_diff_versions.Feed.services_on）と同じ:
//   calendar の曜日と期間で走る運行に、calendar_dates の追加（add）を足し、運休（rm）を除く。
// 同じになることは app/test/timetable.test.js で確かめている。

const ymd = (s) => s.replaceAll("-", "");

function weekdayMon0(s) {
  const [y, m, d] = s.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // 月=0 … 日=6
}

function compile(tt) {
  if (tt._svc) return tt._svc;
  tt._svc = tt.services.map((s) => ({ wd: s.wd, s: s.s, e: s.e, add: new Set(s.add), rm: new Set(s.rm) }));
  return tt._svc;
}

// その日に走る運行（services の番号）
export function servicesOn(tt, date) {
  const d = ymd(date);
  const wd = weekdayMon0(date);
  const out = new Set();
  compile(tt).forEach((s, i) => {
    let on = !!(s.s && s.e && s.s <= d && d <= s.e && s.wd[wd] === "1");
    if (s.add.has(d)) on = true;
    if (s.rm.has(d)) on = false;
    if (on) out.add(i);
  });
  return out;
}

// その日に走るバス（trips の番号）
export function tripsOn(tt, date) {
  const sv = servicesOn(tt, date);
  const out = [];
  tt.trips.forEach((t, i) => {
    if (sv.has(t[2])) out.push(i);
  });
  return out;
}

// 改正のデータ（revision-2）と、そこに出てくる版の時刻表から、判定の部品（judge.js）が読む形を組み立てる
//   rev.days[日付] = { u: その日に有効だった版の uid（無ければ null）, s: "old" | "new", marks: [...] }
export function assembleRevision(rev, timetables) {
  const newUid = rev.meta.new.uid;
  const stopIdx = new Map();
  const stops = [];
  const report = rev.stop_report || {};
  const renamed = new Map((report.renamed || []).map((x) => [x.id, x.old]));
  const moved = new Map((report.moved || []).map((x) => [x.id, x]));
  // 新しい版を先に入れて、名前・位置は新しい版を使う
  const order = [newUid, ...Object.keys(timetables).filter((u) => u !== newUid)];
  for (const uid of order) {
    const tt = timetables[uid];
    if (!tt) continue;
    for (const [id, name, kana, lat, lon] of tt.stops) {
      if (!stopIdx.has(id)) {
        const rec = { id, name, kana, lat, lon, in_old: false, in_new: false };
        if (renamed.has(id)) rec.old_name = renamed.get(id);
        if (moved.has(id)) rec.moved_m = moved.get(id).m;
        stopIdx.set(id, stops.length);
        stops.push(rec);
      }
      const rec = stops[stopIdx.get(id)];
      if (uid === newUid) rec.in_new = true;
      else rec.in_old = true;
    }
  }
  const routes = [];
  const routeIdx = new Map();
  const trips = [];
  const offset = {};
  for (const uid of order) {
    const tt = timetables[uid];
    if (!tt) continue;
    offset[uid] = trips.length;
    for (const [r, headsign, , seq] of tt.trips) {
      const rname = tt.routes[r];
      if (!routeIdx.has(rname)) {
        routeIdx.set(rname, routes.length);
        routes.push(rname);
      }
      trips.push([routeIdx.get(rname), headsign, seq.map((x) => [stopIdx.get(tt.stops[x[0]][0]), ...x.slice(1)])]);
    }
  }
  const patterns = [];
  const pidx = new Map();
  const days = {};
  for (const [date, d] of Object.entries(rev.days)) {
    const tt = d.u ? timetables[d.u] : null;
    const list = tt ? tripsOn(tt, date).map((i) => offset[d.u] + i) : [];
    const key = list.join(",");
    if (!pidx.has(key)) {
      pidx.set(key, patterns.length);
      patterns.push(list);
    }
    days[date] = { v: d.s, p: pidx.get(key), marks: d.marks, u: d.u };
  }
  return { format: "assembled", meta: rev.meta, stops, routes, trips, patterns, days, stop_report: report };
}

// 改正のデータが無いバス：いまの時刻表だけで、今日から先の日を組み立てる（「いまのバス」を出すため）
//   その日に有効な版（有効期間に入る版のうち、いちばん新しく公開された版）を使う
export function assembleTimetables(timetables, fromDate, days, holidays = {}) {
  const uids = Object.keys(timetables);
  const rev = { meta: { change_date: "9999-12-31", new: { uid: "" } }, days: {} };
  const [y, m, d0] = fromDate.split("-").map(Number);
  for (let k = 0; k < days; k++) {
    const dt = new Date(Date.UTC(y, m - 1, d0 + k));
    const date = dt.toISOString().slice(0, 10);
    const valid = uids.map((u) => timetables[u]).filter((t) => t.meta.from <= date && date <= t.meta.to)
      .sort((a, b) => (a.meta.published_at < b.meta.published_at ? 1 : -1));
    const marks = [];
    if (holidays[date]) marks.push({ kind: "holiday", label: holidays[date] });
    const md = date.slice(5);
    if (md >= "12-29" || md <= "01-03") marks.push({ kind: "year_end", label: "年末年始" });
    if (md >= "08-13" && md <= "08-16") marks.push({ kind: "obon", label: "お盆" });
    if (!valid.length) marks.push({ kind: "outside", label: "時刻表のデータが無い日" });
    rev.days[date] = { u: valid.length ? valid[0].meta.uid : null, s: "old", marks };
  }
  return assembleRevision(rev, timetables);
}
