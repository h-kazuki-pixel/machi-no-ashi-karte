// 「その日に走るバス」を、端末の計算（timetable.js）と調査の Python（Feed.services_on）で突き合わせる
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { tripsOn } from "../js/timetable.js";

const dir = new URL("./fixtures/", import.meta.url);
const expected = JSON.parse(fs.readFileSync(new URL("parity_expected.json", dir), "utf8"));
const digest = (ids) => crypto.createHash("sha1").update(ids.join(",")).digest("hex").slice(0, 16);

for (const [name, c] of Object.entries(expected)) {
  test(`その日に走るバスが Python と同じ：${name}（${c.feed}、${c.days}日）`, () => {
    const tt = JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL(`${name}.timetable.json.gz`, dir))).toString("utf8"));
    const wrong = [];
    for (const [date, [count, hash]] of Object.entries(c.expected)) {
      const ids = tripsOn(tt, date);
      if (ids.length !== count || digest(ids) !== hash) wrong.push(`${date}: 端末 ${ids.length} / Python ${count}`);
    }
    assert.deepEqual(wrong, []);
  });
}

test("八戸（運行日を calendar_dates に全部書くフィード）でも、走る日と走らない日がある", () => {
  const c = expected.hachinohe.expected;
  const counts = new Set(Object.values(c).map((x) => x[0]));
  assert.ok(counts.size > 1);
});
