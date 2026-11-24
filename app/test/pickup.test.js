// 乗るだけ・降りるだけの停留所（pickup_type / drop_off_type = 1）を、判定と停留所の時刻で守るか
import { test } from "node:test";
import assert from "node:assert/strict";
import * as J from "../js/judge.js";
import { assembleRevision } from "../js/timetable.js";

// 1つの版・1本のバス：A（乗るだけ）→ B（降りるだけ）→ C → D（乗るだけ：降りられない）
const tt = {
  stops: [["a", "A", "", 36, 140], ["b", "B", "", 36, 140.001], ["c", "C", "", 36, 140.002], ["d", "D", "", 36, 140.003]],
  routes: ["特急"], services: [{ id: "s", wd: "1111111", s: "20261101", e: "20270331", add: [], rm: [] }],
  trips: [[0, "D行き", 0, [[0, 600, 600, 2], [1, 610, 610, 1], [2, 620], [3, 630, 630, 2]]]],
};
const days = {};
for (let k = -35; k < 35; k++) days[J.addDays("2026-12-01", k)] = { u: "x", s: k < 0 ? "old" : "new", marks: [] };
const rev = { meta: { change_date: "2026-12-01", timetables: { x: "" }, old: { uid: "x" }, new: { uid: "x" } }, days, stop_report: {} };
const P = J.prepare(assembleRevision(rev, { x: tt }));
const rides = (a, b) => J.ridesOn(P, "2026-12-02", a, b).length;

test("降りるだけの停留所からは乗れない・乗るだけの停留所では降りられない", () => {
  assert.equal(rides("A", "C"), 1); // A で乗り C で降りる
  assert.equal(rides("B", "C"), 0); // B は降りるだけ
  assert.equal(rides("A", "B"), 1); // B では降りられる
  assert.equal(rides("C", "D"), 0); // D は乗るだけ（降りられない）
  assert.equal(rides("A", "D"), 0);
});

test("停留所の時刻：降りられない所に「着く」、乗れない所から「出る」を出さない", () => {
  const ev = (n) => J.stopEvents(P, "2026-12-02", n)[0] || null;
  assert.deepEqual([ev("A").arr, ev("A").dep], [null, 600]);
  assert.deepEqual([ev("B").arr, ev("B").dep], [610, null]);
  assert.deepEqual([ev("C").arr, ev("C").dep], [620, 620]);
  assert.equal(ev("D"), null); // 終点で降りられない＝この停留所では乗り降りできない
});

test("2（電話）・3（運転士）は乗り降りできるが、注意が付く", () => {
  const tt2 = {
    stops: [["a", "A", "", 36, 140], ["b", "B", "", 36, 140.001], ["c", "C", "", 36, 140.002]],
    routes: ["デマンド"], services: [{ id: "s", wd: "1111111", s: "20261101", e: "20270331", add: [], rm: [] }],
    // A：乗る前に電話（4）、B：乗るとき運転士（8）＋降りるとき運転士（32）、C：降りるには電話（16）
    trips: [[0, "C行き", 0, [[0, 600, 600, 4], [1, 610, 610, 40], [2, 620, 620, 16]]]],
  };
  const Q = J.prepare(assembleRevision(rev, { x: tt2 }));
  const [r1] = J.ridesOn(Q, "2026-12-02", "A", "C");
  assert.deepEqual(J.rideCautions(r1), ["pickup_phone", "drop_off_phone"]);
  const [r2] = J.ridesOn(Q, "2026-12-02", "B", "C");
  assert.deepEqual(J.rideCautions(r2), ["pickup_driver", "drop_off_phone"]);
  const [r3] = J.ridesOn(Q, "2026-12-02", "A", "B");
  assert.deepEqual(J.rideCautions(r3), ["pickup_phone", "drop_off_driver"]);
});
