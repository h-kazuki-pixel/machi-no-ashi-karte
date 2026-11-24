// 米沢市営バス 2026-12-01 の改正（本物のデータ）で、7つの例を確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as J from "../js/judge.js";

import { assembleRevision } from "../js/timetable.js";
// 改正のデータ（revision-2）＝ 日ごとの情報 ＋ 版ごとの時刻表（scripts/revision2.py で作ったもの）
const fx = new URL("./fixtures/yonezawa_rev/", import.meta.url);
const read = (name) => JSON.parse(fs.readFileSync(new URL(name, fx), "utf8"));
const revRaw = read("revision.json");
const rev = assembleRevision(revRaw, Object.fromEntries(Object.keys(revRaw.meta.timetables).map((u) => [u, read(`${u}.json`)])));
const P = J.prepare(rev);
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];
const t = (h, m) => h * 60 + m;
const fmt = (r) => (r ? `${J.hhmm(r.dep)}→${J.hhmm(r.arr)}` : null);

test("1. 上杉神社前→米沢駅前 平日 8:00までに着きたい：循環で2回止まるので、2回目の 7:49 に乗れる（ほぼ同じ）", () => {
  const r = J.judge(P, { from: "上杉神社前", to: "米沢駅前", days: WEEKDAYS, cond: { type: "arriveBy", time: t(8, 0) } });
  assert.equal(fmt(r.before.ride), "7:47→7:55");
  assert.equal(fmt(r.after.ride), "7:49→7:57");
  assert.equal(r.level, "tiny");
  // 調査の一覧の「7:47→7:18」は、このバスが上杉神社前に1回目に止まる時刻（7:18）。7:18 に乗ると米沢駅前は 7:25 着
  const rides = J.ridesOn(P, "2026-12-02", "上杉神社前", "米沢駅前").map(fmt);
  assert.ok(rides.includes("7:18→7:25") && rides.includes("7:49→7:57"));
});

test("2. 万世線の変わらないバス：変わらない", () => {
  for (const reg of [
    { from: "米沢駅前", to: "万世小学校前", days: WEEKDAYS, cond: { type: "departAfter", time: t(14, 30) } },
    { from: "福祉の里入口", to: "米沢市役所前", days: WEEKDAYS, cond: { type: "departAfter", time: t(11, 0) } },
  ]) {
    const r = J.judge(P, reg);
    assert.equal(r.level, "same", `${reg.from}→${reg.to}`);
  }
});

test("3. 学園都市線が国立米沢病院前に止まらなくなる：行けなくなる（300m以内に代わりの停留所は無い）", () => {
  const r = J.judge(P, { from: "米沢駅前", to: "国立米沢病院前", days: ["tue"], cond: { type: "arriveBy", time: t(10, 0) } });
  assert.equal(fmt(r.before.ride), "9:00→9:13");
  assert.equal(r.level, "cannot");
  assert.ok(r.notes.some((n) => n.kind === "stop_not_served" && n.name === "国立米沢病院前"));
  assert.deepEqual(r.alternatives.nearby, []);
  // 300m以内に代わりは無い。12月1日にバスが止まるいちばん近いバス停を、距離つきで出す（通町三丁目 916m は無くなる）
  assert.deepEqual(r.alternatives.nearest.map((n) => [n.role, n.name]), [["to", "通町二丁目"]]);
  assert.ok(r.alternatives.nearest[0].meters > 1500 && r.alternatives.nearest[0].meters < 1600);
  assert.equal(r.before.dates.includes("2026-11-03"), false); // 文化の日は外す
});

test("4. 米沢駅前→鶴城高校前 平日 8:30までに着きたい：新しい直行便 8:10 で「行けるようになる」", () => {
  const r = J.judge(P, { from: "米沢駅前", to: "鶴城高校前", days: WEEKDAYS, cond: { type: "arriveBy", time: t(8, 30) } });
  assert.equal(r.before.ride, null);
  assert.equal(fmt(r.after.ride), "8:10→8:19");
  assert.equal(r.after.ride.route, "万世線（直行便）");
  assert.equal(r.level, "will_be_able");
});

test("5. 市街地循環（右回り）の昼の 11:54 が無くなる：大きく変わる、前後のバスと近くの停留所の代わりが出る", () => {
  const r = J.judge(P, { from: "米沢駅前（東口）", to: "上杉神社前", days: WEEKDAYS, cond: { type: "departAfter", time: t(11, 50) } });
  assert.equal(fmt(r.before.ride), "11:54→12:11");
  assert.equal(fmt(r.after.ride), "12:34→12:52");
  assert.equal(r.level, "big");
  // 新しい時刻表でいちばん合う 12:34 の、ひとつ前とひとつあと
  assert.deepEqual(r.alternatives.same.map((x) => [x.which, fmt(x)]), [["prev", "11:07→11:52"], ["next", "12:41→13:26"]]);
  assert.equal(r.alternatives.nearby[0].from, "米沢駅前");
  assert.equal(fmt(r.alternatives.nearby[0]), "12:23→12:47");
});

test("6. 第1日曜の万世線：12月からは第1日曜の運行が無い", () => {
  const r = J.judge(P, { from: "福祉の里入口", to: "米沢駅前", days: ["first_sun"], cond: { type: "departAfter", time: t(9, 0) } });
  // 月1回の移動は前後70日から選ぶ（2027-01-03 は年末年始なので外す）
  assert.deepEqual(r.before.dates, ["2026-10-04", "2026-11-01"]);
  assert.deepEqual(r.after.dates, ["2026-12-06", "2027-02-07"]);
  assert.equal(fmt(r.before.ride), "9:00→9:20");
  assert.equal(r.level, "cannot");
  assert.ok(r.notes.some((n) => n.kind === "first_sunday_service_ends"));
  // 第1日曜には、万世線が1本も走らなくなる → 「運行が終わる」
  assert.ok(r.notes.some((n) => n.kind === "route_ends" && n.route === "万世線"));
  assert.ok(r.notes.some((n) => n.kind === "too_few_dates"));
});

test("7. 学園都市線の夕方が逆回りになる：行き先によって、行けるか・どれだけかかるかが変わる", () => {
  // 東回りで近かった通町六丁目へは、逆回りの 17:36 では 17:40 以降に乗れず、19:00 になる
  const a = J.judge(P, { from: "米沢駅前", to: "通町六丁目", days: WEEKDAYS, cond: { type: "departAfter", time: t(17, 40) } });
  assert.equal(fmt(a.before.ride), "17:50→17:56");
  assert.equal(fmt(a.after.ride), "19:00→19:37");
  assert.equal(a.level, "big");
  assert.equal(fmt(a.alternatives.same.find((x) => x.which === "prev")), "17:36→18:02"); // 逆回りの 17:36 に乗れば 18:02 着（26分かかる）
  // 逆回りの先の方にある上杉神社前へは、早く着けるようになる
  const b = J.judge(P, { from: "米沢駅前", to: "上杉神社前", days: WEEKDAYS, cond: { type: "departAfter", time: t(17, 30) } });
  assert.equal(fmt(b.before.ride), "17:50→18:12");
  assert.equal(fmt(b.after.ride), "17:36→17:43");
  assert.equal(b.level, "better");
});

test("循環：乗る停留所のあとに降りる停留所に着くバスだけ", () => {
  // 米沢駅前（東口）を出て米沢駅前（東口）に戻る循環で、同じ停留所どうしは数えない
  for (const r of J.ridesOn(P, "2026-12-02", "上杉神社前", "米沢駅前")) assert.ok(r.arr > r.dep);
});

test("比べる日：祝日・年末年始・特別な日を外し、前4回・後4回", () => {
  const d = J.compareDates(P, { days: ["mon"], from: "米沢駅前", to: "上杉神社前" });
  assert.deepEqual(d.before, ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-30"]); // 11-23 勤労感謝の日を外す
  assert.deepEqual(d.after, ["2026-12-07", "2026-12-14", "2026-12-21", "2026-12-28"]);
});

import { searchStops } from "../js/search.js";
test("停留所はひらがな・カタカナ・漢字・前の名前で探せる", () => {
  const names = (q) => searchStops(P, q).map((g) => g.name);
  assert.ok(names("こくりつ").includes("国立米沢病院前"));
  assert.ok(names("コクリツ").includes("国立米沢病院前"));
  assert.ok(names("病院").includes("国立米沢病院前"));
  assert.ok(names("成島一丁目").includes("成島町一丁目")); // 名前が変わった停留所は前の名前でも
  assert.ok(names("ｱﾊﾟｰﾄ").length > 0); // 半角カナの名前
});

test("いまは1本で行けない移動も登録できる（前も後も行けない：no_route）", () => {
  const r = J.judge(P, { from: "米沢スキー場前", to: "国立米沢病院前", days: WEEKDAYS, cond: { type: "arriveBy", time: t(10, 0) } });
  assert.equal(r.level, "no_route");
  const c = J.checkRegistration(P, { from: "米沢スキー場前", to: "国立米沢病院前", days: WEEKDAYS, cond: { type: "arriveBy", time: t(10, 0) } }, "2026-11-25");
  assert.equal(c.ok, false);
});

test("同じ ID のまま 50m 以上動いたのりばに印が付く", () => {
  const m = J.movedStops(P, { from: "米沢駅前", to: "芳泉町" });
  assert.deepEqual(m, [{ name: "芳泉町", meters: 330 }]);
  assert.deepEqual(J.movedStops(P, { from: "米沢駅前", to: "太田町五丁目" }), []); // 48m は出さない
});

test("毎週の移動は前後35日から選ぶ", () => {
  const d = J.compareDates(P, { days: ["tue"], from: "米沢駅前", to: "上杉神社前" });
  assert.ok(d.before[0] >= "2026-10-27" && d.after.at(-1) <= "2027-01-04");
});

test("前の版の有効期間の外の日は比べず、比べる日が無ければ「くらべられない」", () => {
  const Q = J.prepare(JSON.parse(JSON.stringify(rev)));
  for (const [d, v] of Object.entries(Q.days)) {
    if (d < Q.meta.change_date) v.marks.push({ kind: "outside", label: "この版の有効期間の外" });
  }
  const r = J.judge(Q, { from: "上杉神社前", to: "米沢駅前", days: WEEKDAYS, cond: { type: "arriveBy", time: t(8, 0) } });
  assert.equal(r.level, "no_compare");
  assert.equal(r.missing, "before");
  assert.deepEqual(r.before.dates, []);
});

test("運行が始まる・終わるの印は、路線がもう片方の側でも走っているときには付かない", () => {
  // 国立米沢病院前：学園都市線は12月からも走る（止まらなくなるだけ）→ 運行が終わる、ではない
  const r = J.judge(P, { from: "米沢駅前", to: "国立米沢病院前", days: ["tue"], cond: { type: "arriveBy", time: t(10, 0) } });
  assert.equal(r.level, "cannot");
  assert.equal(r.notes.some((n) => n.kind === "route_ends"), false);
  // 鶴城高校前：直行便は新しい路線 → 運行が始まる
  const b = J.judge(P, { from: "米沢駅前", to: "鶴城高校前", days: WEEKDAYS, cond: { type: "arriveBy", time: t(8, 30) } });
  assert.ok(b.notes.some((n) => n.kind === "route_starts" && n.route === "万世線（直行便）"));
});
