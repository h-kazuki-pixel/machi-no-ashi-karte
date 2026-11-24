// 公開の前の点検：改正のデータで、停留所の組を無作為に選んで判定し、段階ごとの割合を出す。
//   node app/tools/check_revision.mjs <サイトのフォルダ> <改正のデータのパス> [組の数=200]
// 組の選び方（意味のある組にするため、実際に走るバスから選ぶ）:
//   前の側と後の側から半分ずつ。その側の比べる日（印の無い日、変更日の前後35日）から1日を選び、
//   その日に走るバスを1本選び、止まる停留所から乗る所・降りる所（名前が違う、乗る方が先）を選ぶ。
//   曜日はその日の曜日、時刻の希望は「着きたい」と「乗りたい」を交互に、そのバスの時刻から0〜10分ずらす。
// 乱数の種は改正のデータのパスから決める（同じデータなら同じ結果）。
import fs from "node:fs";
import path from "node:path";
import * as J from "../js/judge.js";
import { assembleRevision } from "../js/timetable.js";

const [site, revPath, nArg] = process.argv.slice(2);
const N = Number(nArg || 200);
const read = (p) => JSON.parse(fs.readFileSync(path.join(site, p), "utf8"));
const raw = read(revPath);
const tts = Object.fromEntries(Object.entries(raw.meta.timetables).map(([u, p]) => [u, read(p)]));
const P = J.prepare(assembleRevision(raw, tts));

let seed = [...revPath].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const rand = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rand() * a.length)];

const change = P.meta.change_date;
const sideDays = (side) => Object.keys(P.days).filter((d) => {
  const x = P.days[d];
  const off = (J.parseDate(d) - J.parseDate(change)) / 86400000;
  return x.v === side && !x.marks.length && off >= -35 && off < 35 && P.patterns[x.p].length;
});
const days = { old: sideDays("old"), new: sideDays("new") };
const counts = {};
const examples = {}; // 段階ごとの例（各 EXAMPLES 件）：承認するときに見る
const EXAMPLES = 3;
const rideOut = (r) => (r ? { dep: J.hhmm(r.dep), arr: J.hhmm(r.arr), route: r.route } : null);
let tried = 0, used = 0;
while (used < N && tried < N * 20) {
  tried++;
  // 前の側と後の側から半分ずつ。片方の側に走るバスが無いとき（季節運行の始まりなど）は、もう片方から選ぶ
  let side = used % 2 === 0 ? "old" : "new";
  if (!days[side].length) side = side === "old" ? "new" : "old";
  if (!days[side].length) break;
  const date = pick(days[side]);
  const t = P.tripObjs[pick(P.patterns[P.days[date].p])];
  if (t.stops.length < 2) continue;
  const i = Math.floor(rand() * (t.stops.length - 1));
  const j = i + 1 + Math.floor(rand() * (t.stops.length - 1 - i));
  const from = P.stops[t.stops[i].stop].name, to = P.stops[t.stops[j].stop].name;
  if (from === to) continue;
  const cond = used % 4 < 2
    ? { type: "arriveBy", time: t.stops[j].arr + Math.floor(rand() * 11) }
    : { type: "departAfter", time: t.stops[i].dep - Math.floor(rand() * 11) };
  const r = J.judge(P, { from, to, days: [J.weekdayKey(date)], cond });
  counts[r.level] = (counts[r.level] || 0) + 1;
  examples[r.level] = examples[r.level] || [];
  if (examples[r.level].length < EXAMPLES) {
    examples[r.level].push({ from, to, day: J.weekdayKey(date), date,
      cond: `${J.hhmm(cond.time)}${cond.type === "arriveBy" ? "までに着く" : "よりあとに乗る"}`,
      before: rideOut(r.before.ride), after: rideOut(r.after.ride),
      notes: r.notes.map((n) => n.kind) });
  }
  used++;
}
const shares = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Math.round((v / used) * 1000) / 1000]));
console.log(JSON.stringify({ revision: revPath, n: used, counts, shares, examples, old_days: days.old.length, new_days: days.new.length }));
