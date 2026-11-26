"""バスの一覧（data/catalog.json）と、版ごとの時刻表を作る。

  python3 scripts/09_build_catalog.py --site site --initial   # 最初の1回：全フィードの時刻表を作る（手元で）
  python3 scripts/09_build_catalog.py --site site             # 一覧だけ作り直す（07 からも呼ぶ）

バスごとに載せる時刻表の版:
  今日から HORIZON_DAYS 日のどこかで「その日に使う版」になる版。
  その日に使う版 = 時刻表を作ってある版のうち、有効期間にその日が入り、いちばん新しく公開された版
  （改正のデータの「前の版をつなげる」と同じ選び方。端末の assembleTimetables も同じ）。
加工・再配布を確かめたライセンスでないフィード（掛川市の2フィード）は、一覧には出すが時刻表は配らない。
"""
import argparse
import csv
import datetime as dt
import json
import shutil
from importlib import import_module
from pathlib import Path

from common import API, DATA, REQUESTS

w = import_module("07_daily_watch")
rv = import_module("revision2")
ttm = import_module("timetable")
br = import_module("06_build_revision")

HORIZON_DAYS = 120
LEAD_MIN_PAIRS = 3  # 印の無い組がこれより少ないバスは「記録がまだ少ない」
PREFS = ["", "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県",
         "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県",
         "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県",
         "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県", "熊本県", "大分県",
         "宮崎県", "鹿児島県", "沖縄県"]
UNUSABLE_NOTE = "このバスは、データの利用の条件を確かめているため、まだ使えません"


def effective(versions, start, days=HORIZON_DAYS):
    """start から days 日のどこかで「その日に使う版」になる版（versions は from_date, to_date, published_at を持つ）"""
    out = {}
    for k in range(days):
        d = (start + dt.timedelta(days=k)).isoformat()
        valid = [v for v in versions if v["from_date"] <= d <= v["to_date"]]
        if valid:
            v = max(valid, key=lambda v: v["published_at"])
            out[v["gtfs_file_uid"]] = v
    return list(out.values())


def has_timetable(site, key, uid, alias=None):
    return (site / rv.timetable_path(key, (alias or {}).get(uid, uid))).exists()


EMPTY_NOTE = "このバスの時刻表のデータに、便か停留所がありません。そのため、まだ使えません"
EXPIRED_NOTE = "このバスの時刻表のデータは、期限が切れています。そのため、まだ使えません"


class Sizes:
    """時刻表の便と停留所の数と、走る日の範囲（state/timetable_sizes.json に控える。ファイルの大きさが変わったら数え直す）"""

    def __init__(self, site, today):
        self.today = today
        self.p = site / "state" / "timetable_sizes.json"
        self.site = site
        self.d = json.loads(self.p.read_text(encoding="utf-8")) if self.p.exists() else {}
        self.used = set()

    def get(self, rel):
        f = self.site / rel
        size = f.stat().st_size
        x = self.d.get(rel)
        # 走る日は、今日の30日前から1年半先まで数えて控える（控えた範囲が今日から HORIZON_DAYS 日を覆わなくなったら数え直す）
        need = (self.today + dt.timedelta(days=HORIZON_DAYS)).isoformat()
        if not x or x[0] != size or len(x) < 5 or x[4] < need or x[5] > self.today.isoformat():
            tt = json.loads(f.read_text(encoding="utf-8"))
            lo, hi = self.today - dt.timedelta(days=30), self.today + dt.timedelta(days=540)
            x = self.d[rel] = [size, len(tt["trips"]), len(tt["stops"]), ttm.run_ranges(tt, lo, hi), hi.isoformat(), lo.isoformat()]
        self.used.add(rel)
        return x[1], x[2]

    def runs_on(self, rel, iso):
        return any(a <= iso <= b for a, b in self.d[rel][3])

    def save(self):
        self.d = {k: v for k, v in self.d.items() if k in self.used}
        w.write_json(self.p, self.d)


def runs_within(sizes, tts, today, days=HORIZON_DAYS):
    """今日から days 日のうち、その日に使う版（有効期間に入る版のうち、いちばん新しく公開された版）で
    バスが1本でも走る日があるか"""
    for k in range(days):
        iso = (today + dt.timedelta(days=k)).isoformat()
        valid = [t for t in tts if t["from"] <= iso <= t["to"]]
        if valid and sizes.runs_on(max(valid, key=lambda t: t["published_at"])["path"], iso):
            return True
    return False


def counted(x):
    """数える組：公開が遅い版を除き、印の無い組と、変わる日が新しい版の有効開始日と同じ組（つながり方によらない）。
    全国の集計（12_national_summary.py）と同じ決まり"""
    return not x["late"] and (not x["censored"] or x.get("change") == x.get("new_from"))


def feed_leads(site):
    """バスごとの「何日前に分かるか」：調査の版の組（data/feed_leads.json）に、見る仕組みが見つけた改正（found.csv）を足す。
    公開が遅い版と、変わる日がはっきりしない組は、真ん中の日数に入れず、回数だけ数える。"""
    p = DATA / "feed_leads.json"
    pairs = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    # 見る仕組みが見つけた版の、ひとつ前の版の有効期間の終わり（すき間なくつながっているかを見るため）
    seen = w.read_csv(site / "state" / "versions_seen.csv")
    by_feed = {}
    for r in seen:
        by_feed.setdefault(r["feed"], []).append(r)
    fp = site / "data" / "found.csv"
    if fp.exists():
        for r in csv.DictReader(open(fp, encoding="utf-8")):
            if not r.get("change_date") or r.get("lead_days_published") in ("", None):
                continue
            # D：止めた改正（公開していない）と、zip の置き換えで見つけたもの（改正の公開日ではない）は数えない
            if str(r.get("revision", "")).startswith("止めた") or str(r.get("found_at_basis", "")).startswith("同じ版の番号のまま"):
                continue
            lst = pairs.setdefault(r["feed"], [])
            if any(x["new_uid"] == r["new_uid"] for x in lst):
                continue
            prev = [v for v in by_feed.get(r["feed"], []) if v["published_at"] < r["published_at"] and v["gtfs_file_uid"] != r["new_uid"]]
            old_to = max(prev, key=lambda v: v["published_at"])["to_date"] if prev else ""
            lst.append({"new_uid": r["new_uid"], "published": r["published_at"][:10], "change": r["change_date"],
                        "lead": int(float(r["lead_days_published"])), "late": r.get("late_publish") == "True",
                        "censored": r.get("change_censored") == "True", "src": "found",
                        "old_to": old_to, "new_from": r.get("from_date", "")})
    out = {}
    for feed, lst in pairs.items():
        ok = sorted((x for x in lst if counted(x)), key=lambda x: x["published"])
        clean = sorted(x["lead"] for x in ok)
        info = {"n": len(clean), "late": sum(1 for x in lst if x["late"]),
                "censored": sum(1 for x in lst if not x["late"] and not counted(x))}
        if 1 <= len(ok) < LEAD_MIN_PAIRS:
            info["leads"] = [x["lead"] for x in ok]  # 1回・2回のバスは、その回の日数をそのまま出す（公開の古い順）
        if len(clean) >= LEAD_MIN_PAIRS:
            k = len(clean)
            info["median"] = clean[k // 2] if k % 2 else round((clean[k // 2 - 1] + clean[k // 2]) / 2)
            info["earliest"] = clean[-1]  # いちばん早く出た回（いちばん前）
            info["latest"] = clean[0]     # いちばん遅く出た回
        out[feed] = info
    return out


def build_catalog(site, seen, feeds, index, today):
    by_feed = {}
    for r in seen:
        if not r.get("gone_at"):
            by_feed.setdefault(r["feed"], []).append(r)
    revs = {}
    for x in index:
        r = {"change_date": x["change_date"], "path": x["path"], "published_at": x["published_at"]}
        if x.get("change_date_known") is False:
            r["change_date_known"] = False  # 変わる日が分からない（zip の置き換えを見つけた日にもう違っていた）
        # 休止：全部の路線が走らなくなり、版のメモに「休止」とある（通知の文を「◯◯の運行が、◯月◯日から休止します。」にする）
        try:
            rm = json.loads((site / x["path"]).read_text(encoding="utf-8"))["meta"]
            if rm.get("all_routes_stop") and "休止" in (rm.get("new", {}).get("memo") or ""):
                r["suspended"] = True
        except (OSError, ValueError, KeyError):
            pass
        revs.setdefault(x["feed"], []).append(r)
    prefs = {}
    items = []
    referenced = set()
    sizes = Sizes(site, today)
    leads = feed_leads(site)
    daily = w.daily_feed_keys()
    # 同じ版の番号のまま zip が置き換わった版は、新しい中身の時刻表（{uid}.r{ETag}）を使う
    ap = site / "state" / "timetable_alias.json"
    alias = json.loads(ap.read_text(encoding="utf-8")) if ap.exists() else {}
    for key, f in sorted(feeds.items()):
        usable = f.get("feed_license") in br.ALLOWED_LICENSES
        vs = [v for v in by_feed.get(key, []) if has_timetable(site, key, v["gtfs_file_uid"], alias)] if usable else []
        eff = sorted(effective(vs, today), key=lambda v: v["from_date"])
        tts = [{"uid": alias.get(v["gtfs_file_uid"], v["gtfs_file_uid"]), "from": v["from_date"], "to": v["to_date"],
                "published_at": v["published_at"],
                "path": rv.timetable_path(key, alias.get(v["gtfs_file_uid"], v["gtfs_file_uid"]))} for v in eff]
        referenced.update(t["path"] for t in tts)
        # 便か停留所が0の時刻表（ファイルの名前が違うなどで読めなかった版）は配らない
        empty = [t for t in tts if 0 in sizes.get(t["path"])]
        tts = [t for t in tts if t not in empty]
        expired = bool(tts) and not runs_within(sizes, tts, today)
        pref = int(f.get("feed_pref_id") or 0)
        item = {"feed": key, "name": f.get("feed_name"), "operator": f.get("organization_name"),
                "pref": pref, "license": f.get("feed_license"), "license_url": f.get("feed_license_url"),
                "usable": usable and bool(tts) and not expired, "timetables": tts,
                "revisions": sorted(revs.get(key, []), key=lambda r: r["change_date"])}
        if key in daily:
            item["daily"] = True  # 毎日新しい版が出るバス（「何日前に分かるか」は出さない）
        else:
            item["lead"] = leads.get(key, {"n": 0, "late": 0, "censored": 0})
        if not usable:
            item["note"] = UNUSABLE_NOTE
        elif not tts and empty:
            item["note"] = EMPTY_NOTE
        elif expired:
            item["note"] = EXPIRED_NOTE
        elif not tts:
            item["note"] = "このバスの、いま使える時刻表のデータがありません"
        items.append(item)
        prefs.setdefault(pref, 0)
        prefs[pref] += 1
    for x in index:  # 改正のデータが使う時刻表も残す
        p = site / x["path"]
        if p.exists():
            referenced.update(json.loads(p.read_text(encoding="utf-8"))["meta"].get("timetables", {}).values())
    holidays = {}
    for r in csv.DictReader(open(DATA / "jp_holidays.csv", encoding="utf-8")):
        if r["date"] >= (today - dt.timedelta(days=90)).isoformat():
            holidays[r["date"]] = r["name"]
    catalog = {
        "format": "catalog-1", "built_at": w.now_jst().isoformat(),
        "prefs": [{"code": c, "name": PREFS[c] if 0 < c < len(PREFS) else "その他", "feeds": n}
                  for c, n in sorted(prefs.items())],
        "feeds": items, "holidays": holidays,
    }
    w.write_json(site / "data" / "catalog.json", catalog)
    sizes.save()
    return catalog, referenced


def prune_timetables(site, referenced):
    """一覧からも改正のデータからも使われない時刻表を消す（Pages の大きさを抑える）"""
    n = 0
    for p in (site / "data" / "timetables").rglob("*.json"):
        rel = p.relative_to(site).as_posix()
        if rel not in referenced:
            p.unlink()
            n += 1
    for d in sorted((site / "data" / "timetables").glob("*"), reverse=True):
        if d.is_dir() and not any(d.iterdir()):
            d.rmdir()
    return n


def initial(site, watch, feeds, today):
    """全フィードの「今日から120日で使う版」の時刻表を作る（zip は一時フォルダにだけ置く）"""
    by_feed = {}
    for r in watch.seen:
        if not r.get("gone_at"):
            by_feed.setdefault(r["feed"], []).append(r)
    made = skipped = errors = 0
    for i, (key, f) in enumerate(sorted(feeds.items()), 1):
        if f.get("feed_license") not in br.ALLOWED_LICENSES:
            skipped += 1
            continue
        org, fid = key.split("/")
        for v in effective(by_feed.get(key, []), today):
            if has_timetable(site, key, v["gtfs_file_uid"]):
                continue
            m = {**v, "feed": key, "feed_name": f.get("feed_name"), "organization_name": f.get("organization_name"),
                 "feed_license": f.get("feed_license"), "feed_license_url": f.get("feed_license_url"),
                 "gtfs_url": f"{API}/organizations/{org}/feeds/{fid}/files/feed.zip?uid={v['gtfs_file_uid']}"}
            try:
                z = watch.zip_for(m)
                watch.write_timetable(key, v["gtfs_file_uid"], ttm.build_timetable(z, m, built_at=watch.started.isoformat()))
                z.unlink()  # zip は残さない
                made += 1
            except Exception as e:  # noqa: BLE001
                errors += 1
                watch.errors.append(f"{key} {v['gtfs_file_uid'][:8]}: {e!r}"[:200])
        if i % 50 == 0:
            print(f"[{i}/{len(feeds)}] 作った {made}、リクエスト {REQUESTS['count']}", flush=True)
    print(f"時刻表を作った版 {made}、ライセンスのため作らないフィード {skipped}、エラー {errors}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="site")
    ap.add_argument("--initial", action="store_true")
    args = ap.parse_args()
    site = Path(args.site)
    watch = w.Watch(site, full=False)
    feeds = watch.prev_feeds
    today = watch.started.date()
    if args.initial:
        initial(site, watch, feeds, today)
    catalog, referenced = build_catalog(site, watch.seen, feeds, watch.index, today)
    removed = prune_timetables(site, referenced)
    shutil.rmtree(watch.tmp, ignore_errors=True)
    usable = sum(1 for x in catalog["feeds"] if x["usable"])
    print(f"一覧：フィード {len(catalog['feeds'])}（使える {usable}）、都道府県 {len(catalog['prefs'])}、消した時刻表 {removed}")
    for e in watch.errors[:10]:
        print("  エラー:", e)


if __name__ == "__main__":
    main()
