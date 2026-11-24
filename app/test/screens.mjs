// 画面の試験：判定の段階ごとに、画面が最後まで出る（「読みこんでいます…」で止まらない）ことと、出るべき言葉を確かめる。
//   node app/test/screens.mjs        （Chrome が要る。CHROME で場所を変えられる）
// 米沢市営バスの改正（試験の材料）から、段階ごとの改正のデータを組み立て、手元のサーバーで配る。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "..");
const FX = path.join(here, "fixtures", "yonezawa_rev");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!fs.existsSync(CHROME)) {
  console.log(`Chrome が見つからないので、画面の試験は飛ばします（${CHROME}）`);
  process.exit(0);
}
const TODAY = "2026-11-25";
const WK = ["mon", "tue", "wed", "thu", "fri"];
const base = JSON.parse(fs.readFileSync(path.join(FX, "revision.json"), "utf8"));
const NEW = base.meta.new.uid;
const YZ_EXTRA = { route_last_year: { "万世線": { first_sun: "2026-05-03", sun: "2026-05-03" } }, route_last_run: { "万世線（直行便）": "2026-03-31" } };

// 段階ごとのバス（改正のデータの変え方）
const variants = {
  "yonezawacity/Yonezawa": (r) => ({ ...r, meta: { ...r.meta, ...YZ_EXTRA } }),
  "test/starts": (r) => r, // 前の運行の記録が無い（ただ「運行が始まります」）
  "test/unknown": (r) => ({ ...r, meta: { ...r.meta, ...YZ_EXTRA, change_date_known: false } }),
  "test/norev": null, // 改正のデータが無いバス（「知らせはありません」と「記録がまだ少ない」）
  "test/nocompare": (r) => ({ ...r, days: Object.fromEntries(Object.entries(r.days).map(([d, x]) =>
    [d, x.s === "old" ? { u: null, s: "old", marks: [{ kind: "outside", label: "この日に有効な時刻表のデータが無い" }] } : x])) }),
};
const revPath = (feed) => `data/revisions/${feed.replace("/", "__")}/${base.meta.change_date}__${NEW.slice(0, 8)}.json`;
const holidays = Object.fromEntries(fs.readFileSync(path.resolve(APP, "..", "data", "jp_holidays.csv"), "utf8").trim().split("\n").slice(1)
  .map((l) => l.split(",")).filter(([d]) => d >= "2026-08-01").map(([d, n]) => [d, n]));
const catalog = {
  format: "catalog-1", built_at: "2026-11-25T00:00:00+09:00",
  prefs: [{ code: 6, name: "山形県", feeds: Object.keys(variants).length }],
  feeds: Object.keys(variants).map((feed) => ({
    feed, name: "米沢市営バス", operator: "米沢市", pref: 6, license: "CC BY 4.0", license_url: "", usable: true,
    timetables: [{ uid: NEW, from: base.meta.new.from, to: base.meta.new.to, published_at: base.meta.new.published_at, path: base.meta.timetables[NEW] }],
    revisions: variants[feed] ? [{ change_date: base.meta.change_date, path: revPath(feed), published_at: base.meta.new.published_at,
                  ...(feed === "test/unknown" ? { change_date_known: false } : {}) }] : [],
    // 「ふだん何日前に分かるか」：米沢だけ試しの数を入れる（ほかは記録が少ない）
    lead: feed === "yonezawacity/Yonezawa" ? { n: 5, late: 1, censored: 2, median: 12, earliest: 20, latest: 3 } : { n: 1, late: 0, censored: 0 },
  })),
  holidays,
};

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\//, "") || "index.html";
  let body = null;
  if (p === "data/catalog.json") body = JSON.stringify(catalog);
  else if (p === "data/status.json") body = "{}";
  else if (p.startsWith("data/revisions/")) {
    const feed = Object.keys(variants).find((f) => variants[f] && revPath(f) === p);
    if (feed) body = JSON.stringify(variants[feed](base));
  } else if (p.startsWith("data/timetables/")) {
    const f = path.join(FX, path.basename(p));
    if (fs.existsSync(f)) body = fs.readFileSync(f);
  } else {
    const f = path.join(APP, p);
    if (f.startsWith(APP) && fs.existsSync(f) && fs.statSync(f).isFile()) body = fs.readFileSync(f);
  }
  if (body == null) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { "Content-Type": types[path.extname(p)] || "application/octet-stream" });
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const reg = (id, feed, from, to, days, type, time) => ({ id, feed, name: `例${id}`, from, to, days, cond: { type, time } });
const Y = "yonezawacity/Yonezawa";
const regs = [
  reg("same", Y, "工業団地入口", "テクノセンター前", WK, "arriveBy", 480),
  reg("tiny", Y, "上杉神社前", "米沢駅前", WK, "arriveBy", 480),
  reg("small", Y, "工業団地入口", "金谷口", WK, "arriveBy", 480),
  reg("big", Y, "東一丁目", "米沢駅前", WK, "arriveBy", 480),
  reg("cannot", Y, "米沢駅前", "国立米沢病院前", ["tue"], "arriveBy", 600),
  reg("able", Y, "米沢営業所", "東一丁目", WK, "arriveBy", 480),
  reg("starts", "test/starts", "米沢駅前", "鶴城高校前", WK, "arriveBy", 510),
  reg("restarts", Y, "米沢駅前", "鶴城高校前", WK, "arriveBy", 510),
  reg("seasonal", Y, "福祉の里入口", "米沢駅前", ["first_sun"], "departAfter", 540),
  reg("nocompare", "test/nocompare", "上杉神社前", "米沢駅前", WK, "arriveBy", 480),
  reg("unknown", "test/unknown", "米沢駅前", "国立米沢病院前", ["tue"], "arriveBy", 600),
  reg("norev", "test/norev", "上杉神社前", "米沢駅前", WK, "arriveBy", 480),
];
const expect = {
  same: "は変わりません", tiny: "は変わりません", small: "時刻が少し変わります", big: "時刻が大きく変わります",
  cannot: "1本で行けるバスがなくなります", able: "1本で行けるようになります", starts: "このバスの運行が始まります",
  restarts: "この冬の運行が始まります（前の運行は3月31日まで）", seasonal: "季節の運休",
  nocompare: "くらべられません", unknown: "いまの時刻表は、前と変わっています",
  norev: "このバスは記録がまだ少なく、どのくらい前に分かるかは分かりません",
};
const biz = encodeURIComponent(JSON.stringify({ feed: Y, stop: "上杉神社前", open: 540, close: 1080, day: "wk" }));
const cases = [
  ...regs.map((r) => ({ name: `移動の画面：${r.id}`, hash: `#trip/${r.id}`, want: [expect[r.id]] })),
  { name: "ホーム（全部の移動）", hash: "#home", want: ["わたしの移動", ...regs.map((r) => `例${r.id}`)] },
  { name: "通知を押して開く画面", hash: `#notice/${encodeURIComponent(Y)}/2026-12-01`, want: ["米沢市営バスの時刻表が、12月1日から変わります。", "あなたの移動は変わりません"] },
  { name: "通知を押して開く画面（変わる日が分からない）", hash: `#notice/${encodeURIComponent("test/unknown")}/2026-12-01`, want: ["米沢市営バスの時刻表が変わりました。"] },
  { name: "バスを選ぶ画面（ふだん何日前）", hash: "#add/feed/6", want: ["このバスの新しい時刻表は、ふだん、変わる日の約12日前に出ています（これまでの5回。早いときは20日前、遅いときは3日前）"] },
  { name: "改正の知らせの出典の行（ふだん何日前）", hash: "#trip/big", want: ["約12日前に出ています"] },
  // 変わる日を過ぎたあと（12/2）：「変わりました」。古い版はバスの一覧に無いが、改正のデータは古い版の時刻表を読む
  { today: "2026-12-02", name: "12/2 移動の画面：行けなくなる（国立米沢病院前）", hash: "#trip/cannot", want: ["1本で行けるバスがなくなりました", "12月1日（火）から、『例cannot』が変わりました", "9:00発 → 9:13着"] },
  { today: "2026-12-02", name: "12/2 移動の画面：ほぼ変わらない", hash: "#trip/tiny", want: ["12月1日（火）から時刻表が変わりましたが、『例tiny』は変わりません"] },
  { today: "2026-12-02", name: "12/2 ホーム", hash: "#home", want: ["バスの時刻表が変わりました。"] },
  { today: "2026-12-02", name: "12/2 通知を押して開く画面", hash: `#notice/${encodeURIComponent(Y)}/2026-12-01`, want: ["米沢市営バスの時刻表が、12月1日に変わりました。"] },
  { today: "2026-12-02", name: "12/2 事業者の画面", hash: "#biz/result", biz: true, want: ["から、バスの時刻が変わりました"] },
  { today: "2026-12-02", name: "12/2 貼り紙", hash: "#poster", biz: true, want: ["バスの時刻が変わりました", "前の時刻"] },
  // 30日を過ぎたあと（2027/1/5）：知らせは出さない。無くなった停留所は、無くなった改正を言う
  { today: "2027-01-05", name: "1/5 移動の画面：国立米沢病院前", hash: "#trip/cannot", want: ["「国立米沢病院前」：12月1日から、米沢市営バスはこのバス停に止まらなくなりました"] },
  { today: "2027-01-05", name: "1/5 移動の画面：ほぼ変わらない", hash: "#trip/tiny", want: ["いまのところ、時刻が変わる知らせはありません", "いまのバス"] },
  { today: "2027-01-05", name: "1/5 ホーム", hash: "#home", want: ["止まらなくなりました", "いまのバス"] },
  { name: "事業者の画面", hash: "#biz/result", biz: true, want: ["から、バスの時刻が変わります", "最終のバス"] },
  { name: "貼り紙", hash: "#poster", biz: true, want: ["バスの時刻が変わります", "作った日"] },
];
const tryParam = encodeURIComponent(JSON.stringify(regs.map(({ id, ...r }) => r)));
// ?try= は登録に t1, t2… の番号を付けるので、移動の画面は番号で開く
const idOf = Object.fromEntries(regs.map((r, i) => [r.id, `t${i + 1}`]));

function dump(url) {
  return new Promise((resolve) => {
    execFile(CHROME, ["--headless=new", "--disable-gpu", "--enable-logging=stderr", "--v=0", "--virtual-time-budget=120000", "--dump-dom", url],
      { maxBuffer: 20 * 1024 * 1024, timeout: 90000 }, (err, out, errOut) => {
        // 画面の中の誤り（Uncaught …）を集める
        const errs = (errOut || "").split("\n").filter((l) => l.includes(":CONSOLE") && /Uncaught|Error/.test(l))
          .map((l) => l.replace(/^.*?"(.*)".*$/, "$1"));
        resolve({ html: err ? "" : out, errs });
      });
  });
}
const text = (html) => {
  const m = html.match(/<main[^>]*>([\s\S]*)<\/main>/);
  return (m ? m[1] : html).replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ").replace(/\s+/g, " ");
};
let fail = 0;
for (const c of cases) {
  const hash = c.hash.startsWith("#trip/") ? `#trip/${idOf[c.hash.slice(6)]}` : c.hash;
  const day = c.today || TODAY;
  const q = c.biz ? `today=${day}&biz=${biz}` : `today=${day}&try=${tryParam}`;
  // ヘッドレスの Chrome は、仮想の時間の進み方で、まれに読みこみの途中で打ち切ることがある。
  // 画面の誤りが無いのに止まったときだけ、4回までやり直す（本当に止まる誤りは、何度やっても止まる）
  let html, errs, t, tries = 0;
  do {
    ({ html, errs } = await dump(`http://127.0.0.1:${port}/?${q}${hash}`));
    t = text(html);
    tries++;
  } while (!errs.length && t.includes("読みこんでいます") && tries < 5);
  const problems = errs.map((e) => `画面の誤り：${e}`);
  if (!t.trim()) problems.push("画面が空");
  if (t.includes("読みこんでいます")) problems.push("「読みこんでいます…」で止まった");
  for (const w of c.want) if (!t.includes(w)) problems.push(`「${w}」が無い`);
  if (problems.length) fail++;
  console.log(`${problems.length ? "✖" : "✔"} ${c.name}${tries > 1 ? `（${tries}回目）` : ""}${problems.length ? "：" + problems.join("、") : ""}`);
}
server.close();
console.log(fail ? `失敗 ${fail}` : `全部 ${cases.length} 通った`);
process.exit(fail ? 1 : 0);
