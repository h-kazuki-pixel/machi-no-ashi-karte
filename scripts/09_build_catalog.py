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


def has_timetable(site, key, uid):
    return (site / rv.timetable_path(key, uid)).exists()


def build_catalog(site, seen, feeds, index, today):
    by_feed = {}
    for r in seen:
        if not r.get("gone_at"):
            by_feed.setdefault(r["feed"], []).append(r)
    revs = {}
    for x in index:
        revs.setdefault(x["feed"], []).append({"change_date": x["change_date"], "path": x["path"],
                                               "published_at": x["published_at"]})
    prefs = {}
    items = []
    referenced = set()
    for key, f in sorted(feeds.items()):
        usable = f.get("feed_license") in br.ALLOWED_LICENSES
        vs = [v for v in by_feed.get(key, []) if has_timetable(site, key, v["gtfs_file_uid"])] if usable else []
        eff = sorted(effective(vs, today), key=lambda v: v["from_date"])
        tts = [{"uid": v["gtfs_file_uid"], "from": v["from_date"], "to": v["to_date"],
                "published_at": v["published_at"], "path": rv.timetable_path(key, v["gtfs_file_uid"])} for v in eff]
        referenced.update(t["path"] for t in tts)
        pref = int(f.get("feed_pref_id") or 0)
        item = {"feed": key, "name": f.get("feed_name"), "operator": f.get("organization_name"),
                "pref": pref, "license": f.get("feed_license"), "license_url": f.get("feed_license_url"),
                "usable": usable and bool(tts), "timetables": tts,
                "revisions": sorted(revs.get(key, []), key=lambda r: r["change_date"])}
        if not usable:
            item["note"] = UNUSABLE_NOTE
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
