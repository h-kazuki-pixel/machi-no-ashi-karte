// 米沢市営バス 2026-12-01 の改正（本物のデータ）で、7つの例を確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as J from "../js/judge.js";

const rev = JSON.parse(fs.readFileSync(new URL("../data/revisions/yonezawa_20261201.json", import.meta.url), "utf8"));
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
  assert.deepEqual(r.alternatives.nearby, []); // いちばん近い停留所は 916m（通町三丁目。これも無くなる）
  assert.equal(r.before.dates.includes("2026-11-03"), false); // 文化の日は外す
});

test("4. 米沢駅前→鶴城高校前 平日 8:30までに着きたい：前は1本では行けず、新しい直行便 8:10 で行けるようになる", () => {
  const r = J.judge(P, { from: "米沢駅前", to: "鶴城高校前", days: WEEKDAYS, cond: { type: "arriveBy", time: t(8, 30) } });
  assert.equal(r.before.ride, null);
  assert.equal(fmt(r.after.ride), "8:10→8:19");
  assert.equal(r.after.ride.route, "万世線（直行便）");
  // 期待は「良くなる」。いまの決まりでは「前は1本では行けない」になる（報告して判断を仰ぐ）
  assert.equal(r.level, "no_route_before");
});

test("5. 市街地循環（右回り）の昼の 11:54 が無くなる：大きく変わる、前後のバスと近くの停留所の代わりが出る", () => {
  const r = J.judge(P, { from: "米沢駅前（東口）", to: "上杉神社前", days: WEEKDAYS, cond: { type: "departAfter", time: t(11, 50) } });
  assert.equal(fmt(r.before.ride), "11:54→12:11");
  assert.equal(fmt(r.after.ride), "12:34→12:52");
  assert.equal(r.level, "big");
  assert.deepEqual(r.alternatives.same.map(fmt), ["11:07→11:52", "12:34→12:52"]);
  assert.equal(r.alternatives.nearby[0].from, "米沢駅前");
  assert.equal(fmt(r.alternatives.nearby[0]), "12:23→12:47");
});

test("6. 第1日曜の万世線：12月からは第1日曜の運行が無い", () => {
  const r = J.judge(P, { from: "福祉の里入口", to: "米沢駅前", days: ["first_sun"], cond: { type: "departAfter", time: t(9, 0) } });
  assert.deepEqual(r.before.dates, ["2026-11-01"]);
  assert.deepEqual(r.after.dates, ["2026-12-06"]);
  assert.equal(fmt(r.before.ride), "9:00→9:20");
  assert.equal(r.level, "cannot");
  assert.ok(r.notes.some((n) => n.kind === "first_sunday_service_ends"));
  assert.ok(r.notes.some((n) => n.kind === "too_few_dates"));
});

test("7. 学園都市線の夕方が逆回りになる：行き先によって、行けるか・どれだけかかるかが変わる", () => {
  // 東回りで近かった通町六丁目へは、逆回りの 17:36 では 17:40 以降に乗れず、19:00 になる
  const a = J.judge(P, { from: "米沢駅前", to: "通町六丁目", days: WEEKDAYS, cond: { type: "departAfter", time: t(17, 40) } });
  assert.equal(fmt(a.before.ride), "17:50→17:56");
  assert.equal(fmt(a.after.ride), "19:00→19:37");
  assert.equal(a.level, "big");
  assert.equal(fmt(a.alternatives.same[0]), "17:36→18:02"); // 逆回りの 17:36 に乗れば 18:02 着（26分かかる）
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
