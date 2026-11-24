"""見る仕組みを始める前に出ていた版について、改正のデータと found.csv の行を、あとから作る。

  python3 scripts/08_backfill_versions.py --site site                 # 11/23 の時点の「次」の版（data/versions.csv の next_*）
  python3 scripts/08_backfill_versions.py --site site --uids <uid> ...  # 版を指定する

- 比べ方・改正のデータの作り方・作らない決まり（ライセンス、登録し直し、30日より前の改正）は、
  07_daily_watch.py と同じ部品を使う。
- 「初めて見た日時」が分からないので、found.csv の found_at には API の公開日時を入れ、
  found_at_basis に、そのことが分かる印を付ける。
- すでに found.csv にある版は、二重に入れない。
- zip は一時フォルダにだけ置き、終わったら消す。
"""
import argparse
import csv
import datetime as dt
import json
import shutil
from importlib import import_module
from pathlib import Path

from common import DATA, REQUESTS

w = import_module("07_daily_watch")
dv = import_module("03_diff_versions")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="site")
    ap.add_argument("--uids", nargs="*")
    ap.add_argument("--rebuild", action="store_true", help="目次にある改正のデータを、いまの作り方で作り直す")
    args = ap.parse_args()
    site = Path(args.site)
    if args.rebuild:
        return rebuild(site)

    survey = {r["gtfs_file_uid"]: r for r in csv.DictReader(open(DATA / "versions.csv", encoding="utf-8"))}
    uids = args.uids or [u for u, r in survey.items() if r["rid"].startswith("next")]

    watch = w.Watch(site, full=False)
    already = {r["new_uid"] for r in w.read_csv(watch.data / "found.csv")}
    done = []
    for uid in sorted(uids, key=lambda u: survey[u]["published_at"]):
        s = survey[uid]
        key = f"{s['organization_id']}/{s['feed_id']}"
        row = watch.seen_by_uid.get(uid)
        if row is None:
            print(f"{key} {uid[:8]}: 見た版の一覧にありません。飛ばします")
            continue
        if uid in already:
            print(f"{key} {uid[:8]}: found.csv にもうあります。飛ばします")
            continue
        org, fid = key.split("/")
        m = {"feed": key, "gtfs_file_uid": uid, "rid": s["rid"], "published_at": s["published_at"],
             "from_date": s["from_date"], "to_date": s["to_date"], "declared_kind": s["declared_kind"],
             "feed_name": s["feed_name"], "organization_name": s["organization_name"],
             "feed_license": s["feed_license"], "feed_license_url": s["feed_license_url"], "memo": s["memo"],
             "gtfs_url": s["gtfs_url"]}
        # ひとつ前の版（公開日時の順。見た版の一覧から）
        prevs = [r for r in watch.seen if r["feed"] == key and r["published_at"] < m["published_at"]]
        if not prevs:
            row["kind"] = "first"
            continue
        p = max(prevs, key=lambda r: r["published_at"])
        ps = survey.get(p["gtfs_file_uid"], {})
        prev = {**p, "rid": p.get("rid_at_first_seen"), "feed_license": p.get("license"),
                "feed_license_url": ps.get("feed_license_url", m["feed_license_url"]), "memo": ps.get("memo", ""),
                "gtfs_url": f"https://api.gtfs-data.jp/v2/organizations/{org}/feeds/{fid}/files/feed.zip?uid={p['gtfs_file_uid']}"}
        res = dv.compare_pair(key, prev, m, loader=watch.loader)
        row["kind"] = res.get("kind", "error")
        line = f"{s['feed_name']}（{s['organization_name']}） {s['rid']} 公開 {s['published_at'][:10]} 有効開始 {s['from_date']}: {row['kind']}"
        if res.get("kind") == "A" and res.get("actual_change_date"):
            found_at = dt.datetime.fromisoformat(s["published_at"]).astimezone(w.JST).replace(microsecond=0)
            watch.found(key, {}, prev, m, res, row, found_at=found_at, basis=w.FOUND_BASIS_API)
            f = watch.found_rows[-1]
            line += f" 変更日 {f['change_date']}（公開から{f['lead_days_seen']}日後） {f['category']} → {f['revision']}"
        elif res.get("kind") == "error":
            line += f" {res.get('note')}"
        print(line)
        done.append(uid)

    # 記録する（status の「最後に確かめた日時」は変えない）
    w.write_csv(watch.state / "versions_seen.csv", w.SEEN_COLS, watch.seen)
    watch.migrate_found()
    if watch.found_rows:
        w.append_csv(watch.data / "found.csv", w.FOUND_COLS, watch.found_rows)
    w.write_json(watch.data / "revisions" / "index.json", watch.index)
    w.write_attributions(site)
    st = w.read_json(watch.data / "status.json", {})
    st["revisions"] = len(watch.index)
    w.write_json(watch.data / "status.json", st)
    w.append_csv(watch.state / "runs.csv", w.RUN_COLS, [{
        "started_at": watch.started.isoformat(), "finished_at": w.now_jst().isoformat(), "mode": "backfill",
        "feeds_checked": 0, "requests": REQUESTS["count"], "new_versions": 0, "found": len(watch.found_rows),
        "errors": len(watch.errors)}])
    shutil.rmtree(watch.tmp, ignore_errors=True)
    print(f"比べた版 {len(done)}、found.csv に入れた {len(watch.found_rows)}、リクエスト {REQUESTS['count']}、エラー {len(watch.errors)}")
    for e in watch.errors:
        print("  エラー:", e)


def rebuild(site):
    """目次（data/revisions/index.json）にある改正のデータを、いまの作り方で作り直す"""
    br = import_module("06_build_revision")
    watch = w.Watch(site, full=False)
    survey = {r["gtfs_file_uid"]: r for r in csv.DictReader(open(DATA / "versions.csv", encoding="utf-8"))}
    for x in watch.index:
        org, fid = x["feed"].split("/")
        metas = []
        for uid in (x["old_uid"], x["new_uid"]):
            r = watch.seen_by_uid[uid]
            s = survey.get(uid, {})
            metas.append({"gtfs_file_uid": uid, "published_at": r["published_at"], "from_date": r["from_date"],
                          "to_date": r["to_date"], "feed_license": r["license"],
                          "feed_license_url": s.get("feed_license_url") or x["license_url"],
                          "organization_name": x["operator"], "feed_name": x["feed_name"], "memo": s.get("memo", ""),
                          "gtfs_url": f"https://api.gtfs-data.jp/v2/organizations/{org}/feeds/{fid}/files/feed.zip?uid={uid}"})
        for mm in metas:
            watch.loader(mm)  # 一時フォルダに落とす
        p = site / x["path"]
        old = json.loads(p.read_text(encoding="utf-8"))["meta"]
        out, _ = br.build_revision(x["feed"], metas[0], metas[1], dt.date.fromisoformat(x["change_date"]),
                                   watch.zip_path(x["old_uid"]), watch.zip_path(x["new_uid"]), built_at=w.now_jst().isoformat())
        out["meta"]["first_seen_at"] = old.get("first_seen_at")
        out["meta"]["first_seen_basis"] = old.get("first_seen_basis")
        p.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        outside = sum(1 for d in out["days"].values() if any(m["kind"] == "outside" for m in d["marks"]))
        print(f"{x['feed_name']} {x['change_date']}: 作り直した（有効期間の外の日 {outside}）")
    shutil.rmtree(watch.tmp, ignore_errors=True)
    print(f"リクエスト {REQUESTS['count']}")


if __name__ == "__main__":
    main()
