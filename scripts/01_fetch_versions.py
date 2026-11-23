"""手順1：全フィードの全部の版（現行・過去・次）のメタデータを集めて data/versions.csv に書く。

使い方:
  python3 scripts/01_fetch_versions.py --limit 10   # 試しに10フィード
  python3 scripts/01_fetch_versions.py              # 全件（途中で止めても、取得済みは飛ばして再開）
"""
import argparse
import csv
import json
import time

from common import API, CACHE, DATA, fetch_json

MAX_PREV = 999
LATE_DAYS = 30  # 公開日 − 有効開始日 がこれを超えたら「公開日時が最初の公開とは限らない」


def meta_lead_group(lead):
    """メタデータの先行日数（参考の数字）の3つの組"""
    if lead == 0:
        return "同日"
    if lead <= -15:
        return "さかのぼり(-15日以前)"
    return "読める範囲(-14〜-1,+1以上)"  # 「指定しないと過去分は返さない」ので大きく指定

COLUMNS = [
    "organization_id", "organization_name", "organization_pref_id",
    "feed_id", "feed_name", "feed_pref_id",
    "feed_license", "feed_license_url",
    "feed_is_discontinued", "feed_discontinued_date",
    "gtfs_file_uid", "rid", "created_at", "published_at",
    "from_date", "to_date", "update_type",
    "upd_timetable", "upd_routes", "upd_stops", "upd_fare",
    "upd_available_period", "upd_temporary_timetable", "upd_others",
    "declared_kind", "feed_has_current",
    "is_first_version", "meta_lead_days", "meta_lead_group", "late_publish",
    "memo", "gtfs_url",
]

# 事業者が付けた更新内容の申告（update_info）を1列の文字列にする
DECLARED = [
    ("update_timetable", "時刻表"), ("update_routes", "路線"), ("update_stops", "停留所"),
    ("update_fare", "運賃"), ("update_available_period", "期間"),
    ("temporary_timetable", "臨時ダイヤ"), ("others", "その他"),
]


def declared_kind(u):
    if not u:
        return "申告なし(項目なし)"
    on = [label for k, label in DECLARED if u.get(k)]
    return "+".join(on) if on else "申告なし(すべて未選択)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--refresh-list", action="store_true", help="フィード一覧を取り直す")
    args = ap.parse_args()

    list_path = CACHE / "api" / "feeds.json"
    if args.refresh_list and list_path.exists():
        list_path.unlink()
    feeds = fetch_json(f"{API}/feeds", list_path)["body"]
    if args.limit:
        feeds = feeds[: args.limit]

    t0 = time.monotonic()
    rows = []
    for i, f in enumerate(feeds, 1):
        org, fid = f["organization_id"], f["feed_id"]
        dest = CACHE / "api" / "feed" / f"{org}__{fid}__prev{MAX_PREV}.json"
        url = f"{API}/organizations/{org}/feeds/{fid}?max_prev={MAX_PREV}"
        try:
            d = fetch_json(url, dest)
        except Exception as e:  # noqa: BLE001
            print(f"[{i}/{len(feeds)}] {org}/{fid} 取得失敗: {e}")
            continue
        body = d.get("body") or {}
        files = body.get("gtfs_files") or []
        if i % 25 == 0 or i == len(feeds):
            el = time.monotonic() - t0
            print(f"[{i}/{len(feeds)}] {el:.0f}s 経過")
        has_current = any(g.get("rid") == "current" for g in files)
        for g in files:
            u = g.get("update_info") or {}
            rows.append({
                "organization_id": org,
                "organization_name": f.get("organization_name"),
                "organization_pref_id": f.get("organization_pref_id"),
                "feed_id": fid,
                "feed_name": f.get("feed_name"),
                "feed_pref_id": f.get("feed_pref_id"),
                "feed_license": body.get("feed_license", f.get("feed_license")),
                "feed_license_url": body.get("feed_license_url", f.get("feed_license_url")),
                "feed_is_discontinued": f.get("feed_is_discontinued"),
                "feed_discontinued_date": f.get("feed_discontinued_date"),
                "gtfs_file_uid": g.get("gtfs_file_uid"),
                "rid": g.get("rid"),
                "created_at": g.get("created_at"),
                "published_at": g.get("published_at"),
                "from_date": g.get("from_date"),
                "to_date": g.get("to_date"),
                "update_type": g.get("update_type"),
                "upd_timetable": u.get("update_timetable"),
                "upd_routes": u.get("update_routes"),
                "upd_stops": u.get("update_stops"),
                "upd_fare": u.get("update_fare"),
                "upd_available_period": u.get("update_available_period"),
                "upd_temporary_timetable": u.get("temporary_timetable"),
                "upd_others": u.get("others"),
                "declared_kind": declared_kind(g.get("update_info")),
                "feed_has_current": has_current,
                "memo": (g.get("memo") or "").replace("\r", " ").replace("\n", " "),
                "gtfs_url": g.get("gtfs_url"),
            })

    import datetime as dt
    jst = dt.timezone(dt.timedelta(hours=9))
    first = {}
    for r in rows:
        k = (r["organization_id"], r["feed_id"])
        if k not in first or r["published_at"] < first[k]:
            first[k] = r["published_at"]
    for r in rows:
        pub = dt.datetime.fromisoformat(r["published_at"]).astimezone(jst).date()
        lead = (dt.date.fromisoformat(r["from_date"]) - pub).days
        r["is_first_version"] = r["published_at"] == first[(r["organization_id"], r["feed_id"])]
        r["meta_lead_days"] = lead
        r["meta_lead_group"] = meta_lead_group(lead)
        r["late_publish"] = -lead > LATE_DAYS

    out = DATA / "versions.csv"
    out.parent.mkdir(exist_ok=True)
    with out.open("w", newline="", encoding="utf-8") as fp:
        w = csv.DictWriter(fp, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(rows)
    print(f"フィード {len(feeds)} 件、版 {len(rows)} 件 → {out}")
    print(f"所要 {time.monotonic() - t0:.0f} 秒")


if __name__ == "__main__":
    main()
