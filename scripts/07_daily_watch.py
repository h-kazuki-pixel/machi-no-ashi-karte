"""全国のフィードを定期的に見る（GitHub Actions で6時間ごと。手元でも同じように動く）。

  python3 scripts/07_daily_watch.py --site site                 # ふだん（変わったフィードだけ見る）
  python3 scripts/07_daily_watch.py --site site --full          # 週1回の点検（全フィードの版を取り直す）
  python3 scripts/07_daily_watch.py --site site --bootstrap     # 最初の1回：調査（2026-11-23）の版の一覧から始める

site/ は GitHub Pages の中身そのもの（Actions では main と別のブランチ）:
  index.html, js/, css/                アプリ（main の app/ から写す）
  data/status.json                     最後に確かめた日時など（アプリの画面に出す）
  data/found.csv                       いつ・どのフィードの・どの改正を・改正の何日前に見つけたか（ためていく）
  data/revisions/index.json            改正のデータの目次
  data/revisions/{org}__{feed}/...json 改正のデータ（加工・再配布が認められたライセンスのフィードだけ）
  data/attributions.json, ATTRIBUTION.md  出典の一覧（自動で作る）
  state/feeds.json                     前回見たフィードの一覧（事業者のメールアドレスは入れない）
  state/versions_seen.csv              見た版の一覧（初めて見た日時）
  state/fingerprints.json              毎日更新のフィードの「便と時刻の指紋」（zip は残さない）
  state/runs.csv                       実行の記録

決まり:
  - 1.2秒以上あけて順番に取る。User-Agent の連絡先は環境変数 GTFS_CONTACT（ログに出さない）。
  - zip は作業用の一時フォルダにだけ置き、終わったら消す。
  - 毎日更新のフィードは、新しい版の指紋（この先60日の、日ごとの便と時刻）を前の版の指紋と比べ、
    変わったときだけ前の版を API から取り直して、調査と同じ方法で比べる。
"""
import argparse
import csv
import datetime as dt
import hashlib
import json
import shutil
import sys
import tempfile
from collections import Counter
from importlib import import_module
from pathlib import Path

from common import API, DATA, REQUESTS, ROOT, fetch, fetch_json

dv = import_module("03_diff_versions")
br = import_module("06_build_revision")

JST = dt.timezone(dt.timedelta(hours=9))
MAX_PREV = 5
FP_DAYS = 60
BOOTSTRAP_CHECKED_AT = "2026-11-23T12:00:00+09:00"  # 調査で全部の版を取った日時

SEEN_COLS = ["feed", "gtfs_file_uid", "first_seen_at", "source", "published_at", "from_date", "to_date",
             "rid_at_first_seen", "declared_kind", "license", "kind", "actual_change_date", "lead_days_seen",
             "revision", "gone_at"]
FOUND_COLS = ["found_at", "feed", "feed_name", "operator", "new_uid", "published_at", "from_date",
              "change_date", "lead_days_seen", "lead_days_published", "change_censored", "late_publish",
              "license", "revision"]
RUN_COLS = ["started_at", "finished_at", "mode", "feeds_checked", "requests", "new_versions", "found", "errors"]


def now_jst():
    return dt.datetime.now(JST).replace(microsecond=0)


def jst_date(s):
    return dt.datetime.fromisoformat(s).astimezone(JST).date()


def read_csv(p):
    return list(csv.DictReader(open(p, encoding="utf-8"))) if p.exists() else []


def write_csv(p, cols, rows):
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", newline="", encoding="utf-8") as fp:
        w = csv.DictWriter(fp, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def append_csv(p, cols, rows):
    new = not p.exists()
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a", newline="", encoding="utf-8") as fp:
        w = csv.DictWriter(fp, fieldnames=cols, extrasaction="ignore")
        if new:
            w.writeheader()
        w.writerows(rows)


def read_json(p, default):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


def write_json(p, obj):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")


def clean_feed(f):
    """フィードの一覧から、記録に要るものだけ（事業者のメールアドレスは入れない）"""
    keys = ["organization_id", "organization_name", "feed_id", "feed_name", "feed_pref_id", "feed_license",
            "feed_license_url", "last_updated_at", "last_published_at", "latest_feed_start_date",
            "latest_feed_end_date", "feed_is_discontinued"]
    return {k: f.get(k) for k in keys}


def daily_feed_keys():
    p = DATA / "daily_feeds.txt"
    return {l.strip() for l in open(p, encoding="utf-8") if l.strip()} if p.exists() else set()


# ---------- 指紋 ----------

def fingerprint(feed, start, from_date, to_date, days=FP_DAYS):
    """start から days 日の、日ごとの「その日に走るバスの時刻の並び」の指紋"""
    out = {}
    for k in range(days):
        d = start + dt.timedelta(days=k)
        if not (from_date <= d <= to_date):
            continue
        sig = feed.day_sig(d)
        h = hashlib.sha1(repr(sorted(sig.items())).encode()).hexdigest()[:12]
        out[d.isoformat()] = h
    return out


def same_fingerprint(a, b):
    common = set(a) & set(b)
    if not common:
        return None  # 比べられる日が無い
    return all(a[d] == b[d] for d in common)


# ---------- 本体 ----------

class Watch:
    def __init__(self, site: Path, full: bool):
        self.site = site
        self.full = full
        self.tmp = Path(tempfile.mkdtemp(prefix="machi-watch-"))
        self.started = now_jst()
        self.errors = []
        self.state = site / "state"
        self.data = site / "data"
        self.seen = read_csv(self.state / "versions_seen.csv")
        self.seen_by_uid = {r["gtfs_file_uid"]: r for r in self.seen}
        self.fps = read_json(self.state / "fingerprints.json", {})
        self.prev_feeds = read_json(self.state / "feeds.json", {})
        self.status = read_json(self.data / "status.json", {})
        self.index = read_json(self.data / "revisions" / "index.json", [])
        self.daily = daily_feed_keys()
        self.new_rows, self.found_rows = [], []
        self._feeds = {}

    # zip は一時フォルダにだけ置く
    def loader(self, v):
        uid = v["gtfs_file_uid"]
        if uid not in self._feeds:
            p = fetch(v["gtfs_url"], self.tmp / "zips" / f"{uid}.zip")
            self._feeds[uid] = dv.Feed(p)
        return self._feeds[uid]

    def zip_path(self, uid):
        return self.tmp / "zips" / f"{uid}.zip"

    def run(self):
        try:
            feeds = fetch_json(f"{API}/feeds", self.tmp / "feeds.json")["body"]
        except Exception as e:  # noqa: BLE001
            self.errors.append(f"フィードの一覧が取れない: {e!r}"[:200])
            return self.finish(feeds_checked=0)
        last_checked = self.status.get("last_checked_at", BOOTSTRAP_CHECKED_AT)
        last_date = jst_date(last_checked).isoformat()
        new_snapshot = dict(self.prev_feeds)
        checked = 0
        for f in feeds:
            key = f"{f['organization_id']}/{f['feed_id']}"
            prev = self.prev_feeds.get(key)
            look = self.full or prev is None or key in self.daily or (
                f.get("last_published_at") != prev.get("last_published_at")
                or f.get("last_updated_at") != prev.get("last_updated_at")
                or (f.get("last_published_at") or "") >= last_date)
            if not look:
                continue
            checked += 1
            try:
                self.check_feed(key, f)
                new_snapshot[key] = clean_feed(f)
            except Exception as e:  # noqa: BLE001
                self.errors.append(f"{key}: {e!r}"[:200])  # 次の回に取り直す（一覧を書き換えない）
        self.prev_feeds = new_snapshot
        return self.finish(feeds_checked=checked)

    def check_feed(self, key, f):
        org, fid = key.split("/")
        mp = 999 if self.full else MAX_PREV
        body = fetch_json(f"{API}/organizations/{org}/feeds/{fid}?max_prev={mp}", self.tmp / "feed" / f"{org}__{fid}.json")["body"]
        files = body.get("gtfs_files") or []
        meta = {g["gtfs_file_uid"]: self.meta(key, f, body, g) for g in files}
        if self.full:  # 全部の版を取ったときだけ、消えた版に気づける
            for r in self.seen:
                if r["feed"] == key and r["gtfs_file_uid"] not in meta and not r.get("gone_at"):
                    r["gone_at"] = self.started.isoformat()
        new = sorted((m for u, m in meta.items() if u not in self.seen_by_uid), key=lambda m: m["published_at"])
        for m in new:
            self.handle_new(key, f, m, meta)

    def meta(self, key, f, body, g):
        u = g.get("update_info") or {}
        labels = [("update_timetable", "時刻表"), ("update_routes", "路線"), ("update_stops", "停留所"),
                  ("update_fare", "運賃"), ("update_available_period", "期間"),
                  ("temporary_timetable", "臨時ダイヤ"), ("others", "その他")]
        on = [l for k, l in labels if u.get(k)]
        return {
            "feed": key, "gtfs_file_uid": g["gtfs_file_uid"], "rid": g.get("rid"),
            "published_at": g.get("published_at") or g.get("created_at"), "created_at": g.get("created_at"),
            "from_date": g.get("from_date"), "to_date": g.get("to_date"),
            "declared_kind": "+".join(on) if on else "申告なし",
            "feed_name": f.get("feed_name"), "organization_name": f.get("organization_name"),
            "feed_license": body.get("feed_license", f.get("feed_license")),
            "feed_license_url": body.get("feed_license_url", f.get("feed_license_url")),
            "memo": (g.get("memo") or "").replace("\r", " ").replace("\n", " "),
            "gtfs_url": g.get("gtfs_url") or f"{API}/organizations/{key.split('/')[0]}/feeds/{key.split('/')[1]}/files/feed.zip?uid={g['gtfs_file_uid']}",
        }

    def previous(self, key, m, meta):
        """公開日時の順で、ひとつ前の版（API の応答か、見た版の一覧から）"""
        cands = [x for x in meta.values() if x["published_at"] < m["published_at"]]
        for r in self.seen:
            if r["feed"] == key and r["published_at"] < m["published_at"] and r["gtfs_file_uid"] not in meta:
                org, fid = key.split("/")
                cands.append({**r, "rid": r.get("rid_at_first_seen"),
                              "feed_license": r.get("license"), "feed_license_url": "",
                              "gtfs_url": f"{API}/organizations/{org}/feeds/{fid}/files/feed.zip?uid={r['gtfs_file_uid']}"})
        return max(cands, key=lambda x: x["published_at"]) if cands else None

    def handle_new(self, key, f, m, meta):
        row = {"feed": key, "gtfs_file_uid": m["gtfs_file_uid"], "first_seen_at": self.started.isoformat(),
               "source": "watch", "published_at": m["published_at"], "from_date": m["from_date"],
               "to_date": m["to_date"], "rid_at_first_seen": m["rid"], "declared_kind": m["declared_kind"],
               "license": m["feed_license"], "kind": "", "actual_change_date": "", "lead_days_seen": "", "revision": ""}
        self.seen.append(row)
        self.seen_by_uid[m["gtfs_file_uid"]] = row
        self.new_rows.append(row)
        prev = self.previous(key, m, meta)
        if prev is None:
            row["kind"] = "first"
            return
        try:
            # 毎日更新のフィード：指紋が同じなら、前の版は取らない
            if key in self.daily:
                fn = self.loader(m)
                today = self.started.date()
                fp_new = fingerprint(fn, today, dt.date.fromisoformat(m["from_date"]), dt.date.fromisoformat(m["to_date"]))
                stored = self.fps.get(key)
                self.fps[key] = {"uid": m["gtfs_file_uid"], "computed_at": self.started.isoformat(), "days": fp_new}
                if stored and stored.get("uid") == prev["gtfs_file_uid"] and same_fingerprint(stored["days"], fp_new):
                    row["kind"] = "same(指紋)"
                    return
            res = dv.compare_pair(key, prev, m, loader=self.loader)
            if res.get("kind") == "error":
                raise RuntimeError(res.get("note"))
            row["kind"] = res["kind"]
            if res["kind"] == "A" and res.get("actual_change_date"):
                self.found(key, f, prev, m, res, row)
        except Exception as e:  # noqa: BLE001
            row["kind"] = "error"
            self.errors.append(f"{key} {m['gtfs_file_uid'][:8]}: {e!r}"[:200])

    def found(self, key, f, prev, m, res, row):
        change = dt.date.fromisoformat(res["actual_change_date"])
        seen_date = self.started.date()
        row["actual_change_date"] = change.isoformat()
        row["lead_days_seen"] = (change - seen_date).days
        lic_ok = m["feed_license"] in br.ALLOWED_LICENSES and prev.get("feed_license", m["feed_license"]) in br.ALLOWED_LICENSES
        revision = ""
        if lic_ok:
            try:
                prev_meta = {**prev, "feed_license": prev.get("feed_license") or m["feed_license"],
                             "feed_license_url": prev.get("feed_license_url") or m["feed_license_url"],
                             "organization_name": m["organization_name"], "feed_name": m["feed_name"], "memo": prev.get("memo", "")}
                out, _ = br.build_revision(key, prev_meta, m, change, self.zip_path(prev["gtfs_file_uid"]),
                                           self.zip_path(m["gtfs_file_uid"]), built_at=self.started.isoformat())
                out["meta"]["first_seen_at"] = self.started.isoformat()
                org, fid = key.split("/")
                rel = f"data/revisions/{org}__{fid}/{change.isoformat()}__{m['gtfs_file_uid'][:8]}.json"
                p = self.site / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
                revision = rel
                self.index.append({"feed": key, "feed_name": m["feed_name"], "operator": m["organization_name"],
                                   "change_date": change.isoformat(), "published_at": m["published_at"],
                                   "first_seen_at": self.started.isoformat(), "license": m["feed_license"],
                                   "license_url": m["feed_license_url"], "path": rel,
                                   "old_uid": prev["gtfs_file_uid"], "new_uid": m["gtfs_file_uid"]})
            except Exception as e:  # noqa: BLE001
                revision = f"作れなかった: {e!r}"[:120]
                self.errors.append(f"{key} 改正のデータ: {e!r}"[:200])
        else:
            revision = "作らない（ライセンス）"
        row["revision"] = revision
        self.found_rows.append({
            "found_at": self.started.isoformat(), "feed": key, "feed_name": m["feed_name"],
            "operator": m["organization_name"], "new_uid": m["gtfs_file_uid"], "published_at": m["published_at"],
            "from_date": m["from_date"], "change_date": change.isoformat(),
            "lead_days_seen": (change - seen_date).days,
            "lead_days_published": (change - jst_date(m["published_at"])).days,
            "change_censored": res.get("change_censored"), "late_publish": res.get("late_publish"),
            "license": m["feed_license"], "revision": revision})

    def finish(self, feeds_checked):
        fin = now_jst()
        write_csv(self.state / "versions_seen.csv", SEEN_COLS, self.seen)
        write_json(self.state / "fingerprints.json", self.fps)
        write_json(self.state / "feeds.json", self.prev_feeds)
        if self.found_rows:
            append_csv(self.data / "found.csv", FOUND_COLS, self.found_rows)
        elif not (self.data / "found.csv").exists():
            write_csv(self.data / "found.csv", FOUND_COLS, [])
        write_json(self.data / "revisions" / "index.json", self.index)
        write_attributions(self.site, self.index)
        ok = feeds_checked > 0 or not self.errors
        status = {
            **self.status,
            "last_run_started_at": self.started.isoformat(),
            "last_run_finished_at": fin.isoformat(),
            "last_run_mode": "full" if self.full else "normal",
            "last_run_errors": self.errors[:20],
            "feeds_total": len(self.prev_feeds),
            "versions_seen": len(self.seen),
            "revisions": len(self.index),
        }
        if ok:  # フィードの一覧が取れたときだけ「確かめた」とする
            status["last_checked_at"] = self.started.isoformat()
            if self.full:
                status["last_full_check_at"] = self.started.isoformat()
        write_json(self.data / "status.json", status)
        append_csv(self.state / "runs.csv", RUN_COLS, [{
            "started_at": self.started.isoformat(), "finished_at": fin.isoformat(),
            "mode": "full" if self.full else "normal", "feeds_checked": feeds_checked,
            "requests": REQUESTS["count"], "new_versions": len(self.new_rows), "found": len(self.found_rows),
            "errors": len(self.errors)}])
        shutil.rmtree(self.tmp, ignore_errors=True)  # zip を残さない
        print(f"{self.started.isoformat()} {'点検' if self.full else 'ふだん'}: 見たフィード {feeds_checked}、"
              f"リクエスト {REQUESTS['count']}、新しい版 {len(self.new_rows)}、"
              f"見つけた改正 {len(self.found_rows)}、エラー {len(self.errors)}")
        kinds = Counter(r["kind"] for r in self.new_rows)
        print("  新しい版の内訳:", dict(kinds))
        for r in self.found_rows:
            print(f"  改正: {r['feed_name']}（{r['operator']}） 変更日 {r['change_date']}"
                  f"（見つけたのは {r['lead_days_seen']}日前） → {r['revision']}")
        for e in self.errors[:10]:
            print("  エラー:", e)
        return 0 if ok else 1


def write_attributions(site, index):
    """出典の一覧（改正のデータを公開しているフィードごと）を自動で作る"""
    feeds = {}
    for x in index:
        feeds.setdefault(x["feed"], x)
    items = [{"feed": k, "operator": v["operator"], "feed_name": v["feed_name"], "license": v["license"],
              "license_url": v["license_url"],
              "text": f"{v['operator']}「{v['feed_name']}」GTFSデータ（{v['license']}）"} for k, v in sorted(feeds.items())]
    write_json(site / "data" / "attributions.json", {
        "note": "このサイトの改正のデータは、GTFSデータリポジトリ（https://gtfs-data.jp/）で公開されている次のGTFSデータを、まちの足カルテが加工して作成したものです。",
        "items": items})
    lines = ["# 出典", "", "このサイトの改正のデータは、GTFSデータリポジトリ（https://gtfs-data.jp/）で公開されている次のGTFSデータを、まちの足カルテが加工して作成したものです。", ""]
    lines += [f"- {i['text']} — {i['license_url']}" for i in items] or ["- （まだありません）"]
    lines += ["", "メタデータ（版の一覧など）は、GTFSデータリポジトリの付帯データ（CC BY 4.0）です。", ""]
    (site / "ATTRIBUTION.md").write_text("\n".join(lines), encoding="utf-8")


def bootstrap(site):
    """最初の1回：調査（2026-11-23）で取った版の一覧と、フィードの一覧を、見た版として入れる"""
    state = site / "state"
    if (state / "versions_seen.csv").exists():
        sys.exit("site/state/versions_seen.csv がすでにあります。--bootstrap は最初の1回だけです。")
    rows = []
    for r in csv.DictReader(open(DATA / "versions.csv", encoding="utf-8")):
        rows.append({"feed": f"{r['organization_id']}/{r['feed_id']}", "gtfs_file_uid": r["gtfs_file_uid"],
                     "first_seen_at": "", "source": "調査(2026-11-23)", "published_at": r["published_at"],
                     "from_date": r["from_date"], "to_date": r["to_date"], "rid_at_first_seen": r["rid"],
                     "declared_kind": r["declared_kind"], "license": r["feed_license"], "kind": "", "revision": ""})
    write_csv(state / "versions_seen.csv", SEEN_COLS, rows)
    feeds = json.loads((ROOT / "cache" / "api" / "feeds.json").read_text(encoding="utf-8"))["body"]
    write_json(state / "feeds.json", {f"{f['organization_id']}/{f['feed_id']}": clean_feed(f) for f in feeds})
    write_json(site / "data" / "status.json", {"last_checked_at": BOOTSTRAP_CHECKED_AT, "bootstrap": "調査(2026-11-23)の版の一覧から始めた"})
    print(f"始めの状態：版 {len(rows)}、フィード {len(feeds)}")


def publish_app(site):
    """main の app/ をサイトに写す（dev/ と test/ は写さない）"""
    app = ROOT / "app"
    for name in ("index.html",):
        shutil.copy2(app / name, site / name)
    for d in ("js", "css"):
        if (site / d).exists():
            shutil.rmtree(site / d)
        shutil.copytree(app / d, site / d)
    (site / "data" / "revisions").mkdir(parents=True, exist_ok=True)
    for p in (app / "data" / "revisions").glob("*.json"):
        shutil.copy2(p, site / "data" / "revisions" / p.name)
    (site / ".nojekyll").write_text("")
    readme = site / "README.md"
    if not readme.exists():
        readme.write_text("# まちの足カルテ（公開用のブランチ）\n\nこのブランチは GitHub Actions が自動で更新します。コードは main ブランチにあります。開発中です。\n", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="site")
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--bootstrap", action="store_true")
    ap.add_argument("--no-app", action="store_true", help="アプリを写さない")
    args = ap.parse_args()
    site = Path(args.site)
    if args.bootstrap:
        bootstrap(site)
    rc = Watch(site, args.full).run()
    if not args.no_app:
        publish_app(site)
    sys.exit(rc)


if __name__ == "__main__":
    main()
