"""アプリ用の「改正のデータ」を作る：古い版と新しい版の zip → 1つの JSON。

  python3 scripts/06_build_revision.py --feed yonezawacity/Yonezawa \\
      --old 02b67c85-efb0-4dd3-a273-2e2aa80860b1 --new be34d058-22c0-4421-8418-7925e6e12378 \\
      --change-date 2026-12-01 --out app/data/revisions/yonezawa_20261201.json

中身:
  meta     フィード・事業者・ライセンス・出典の書き方・古い版と新しい版の公開日時・実際の変更日
  stops    停留所（ID・名前・読み・緯度経度、どちらの版にあるか、名前や場所の変化）
  routes   路線名
  trips    バス1本ごとの [路線, 行き先, [[停留所, 着, 発], ...]]（時刻は 0時からの分）
  patterns その日に走るバスの組（trips の番号の並び）。同じ中身の日はまとめる
  days     日付 → {版, パターン, 印}（変更日の前70日は古い版、変更日から70日は新しい版）

停留所の対応:
  1. 同じ ID で 30m 以内 → 同じ停留所（名前が変わっていれば old_name に残す）
  2. 同じ ID で 30m を超えて動いた → 同じ停留所として扱い、moved_m を付けて報告する
  3. ID が片方にしかない → もう片方の版の、同じ名前で 30m 以内の停留所に対応させる（match_of）
  4. それでも対応できない → 報告する

日の印は calendar_rules（調査と同じ決まり）で付ける。zip は配らない。この JSON は加工したデータ。
"""
import argparse
import csv
import datetime as dt
import io
import json
import math
import sys
import zipfile
from collections import defaultdict
from importlib import import_module

from calendar_rules import day_marks
from common import CACHE, DATA

dv = import_module("03_diff_versions")
MATCH_M = 30
WINDOW_DAYS = 70  # 月1回の移動のため。毎週の移動は判定の側で前後35日に絞る


def read(z, names, n):
    if n not in names:
        return []
    return list(csv.DictReader(io.StringIO(z.read(names[n]).decode("utf-8-sig"))))


def mins(t):
    if not t:
        return None
    h, m, s = (int(x) for x in t.split(":"))
    return h * 60 + m + (1 if s >= 30 else 0)


def dist(a, b):
    la1, lo1, la2, lo2 = map(math.radians, [a[0], a[1], b[0], b[1]])
    return 6371000 * 2 * math.asin(math.sqrt(
        math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2))


class Version:
    def __init__(self, uid, path=None):
        self.uid = uid
        path = path or (CACHE / "zips" / f"{uid}.zip")
        self.feed = dv.Feed(path)  # services_on / exc（調査と同じ読み方）
        z = zipfile.ZipFile(path)
        names = {n.split("/")[-1]: n for n in z.namelist()}
        self.stops = {s["stop_id"]: s for s in read(z, names, "stops.txt")}
        self.kana = {}
        for t in read(z, names, "translations.txt"):
            if t.get("table_name") == "stops" and t.get("language") == "ja-Hrkt":
                key = t.get("record_id") or t.get("field_value")
                self.kana[key] = t["translation"]
        self.routes = {r["route_id"]: (r.get("route_long_name") or r.get("route_short_name") or r["route_id"])
                       for r in read(z, names, "routes.txt")}
        st = defaultdict(list)
        for r in read(z, names, "stop_times.txt"):
            st[r["trip_id"]].append((int(float(r["stop_sequence"])), r["stop_id"],
                                     mins(r["arrival_time"]) if r["arrival_time"] else mins(r["departure_time"]),
                                     mins(r["departure_time"]) if r["departure_time"] else mins(r["arrival_time"])))
        self.trips = {}
        for t in read(z, names, "trips.txt"):
            seq = sorted(st.get(t["trip_id"], []))
            if seq:
                self.trips[t["trip_id"]] = {"service_id": t["service_id"], "route": self.routes.get(t["route_id"], t["route_id"]),
                                            "headsign": t.get("trip_headsign", ""),
                                            "seq": [(sid, a, d) for _, sid, a, d in seq]}


# 加工したデータの公開（加工・再配布）を確かめたライセンス
ALLOWED_LICENSES = ("CC BY 4.0", "CC0 1.0", "CC BY 2.1 JP")


def build_revision(feed_key, mo, mn, change, old_path=None, new_path=None, built_at=None):
    """mo, mn は版のメタデータ（gtfs_file_uid, published_at, from_date, to_date, feed_license,
    feed_license_url, organization_name, feed_name, memo）。戻り値は (改正のデータ, 停留所の報告)。"""
    for m in (mo, mn):
        if m["feed_license"] not in ALLOWED_LICENSES:
            raise ValueError(f"ライセンス {m['feed_license']} は加工データの公開を確かめていない")
    old, new = Version(mo["gtfs_file_uid"], old_path), Version(mn["gtfs_file_uid"], new_path)

    # --- 停留所の対応 ---
    report = {"same_id": 0, "renamed": [], "moved": [], "matched_by_name": [], "unmatched": []}
    stops, idx = [], {}

    def pos(s):
        return (float(s["stop_lat"]), float(s["stop_lon"]))

    for sid in sorted(set(old.stops) | set(new.stops)):
        so, sn = old.stops.get(sid), new.stops.get(sid)
        cur = sn or so
        rec = {"id": sid, "name": cur["stop_name"], "kana": (new.kana if sn else old.kana).get(sid, ""),
               "lat": round(float(cur["stop_lat"]), 6), "lon": round(float(cur["stop_lon"]), 6),
               "in_old": so is not None, "in_new": sn is not None}
        if so and sn:
            d = dist(pos(so), pos(sn))
            report["same_id"] += 1
            if so["stop_name"] != sn["stop_name"]:
                rec["old_name"] = so["stop_name"]
                report["renamed"].append({"id": sid, "old": so["stop_name"], "new": sn["stop_name"], "m": round(d)})
            if d > MATCH_M:
                rec["moved_m"] = round(d)
                rec["old_lat"], rec["old_lon"] = round(float(so["stop_lat"]), 6), round(float(so["stop_lon"]), 6)
                report["moved"].append({"id": sid, "name": sn["stop_name"], "m": round(d)})
        else:
            other = new if so else old
            near = [(dist(pos(cur), pos(s)), oid) for oid, s in other.stops.items()
                    if s["stop_name"] == cur["stop_name"] and oid != sid]
            near = [x for x in near if x[0] <= MATCH_M]
            if near:
                rec["match_of"] = min(near)[1]
                report["matched_by_name"].append({"id": sid, "name": cur["stop_name"], "to": rec["match_of"],
                                                  "m": round(min(near)[0]), "only_in": "old" if so else "new"})
            else:
                report["unmatched"].append({"id": sid, "name": cur["stop_name"], "only_in": "old" if so else "new"})
        idx[sid] = len(stops)
        stops.append(rec)

    # --- バスと日ごとの運行 ---
    routes, ridx = [], {}
    trips, tidx = [], {}

    def trip_index(t):
        r = t["route"]
        if r not in ridx:
            ridx[r] = len(routes)
            routes.append(r)
        key = (r, t["headsign"], tuple(t["seq"]))
        if key not in tidx:
            tidx[key] = len(trips)
            trips.append([ridx[r], t["headsign"], [[idx[s], a, d] if a != d else [idx[s], d] for s, a, d in t["seq"]]])
        return tidx[key]

    patterns, pidx, days = [], {}, {}
    o_lo, o_hi = dt.date.fromisoformat(mo["from_date"]), dt.date.fromisoformat(mo["to_date"])
    n_lo, n_hi = dt.date.fromisoformat(mn["from_date"]), dt.date.fromisoformat(mn["to_date"])
    for k in range(-WINDOW_DAYS, WINDOW_DAYS):
        day = change + dt.timedelta(days=k)
        v, lo, hi, label = (old, o_lo, o_hi, "old") if k < 0 else (new, n_lo, n_hi, "new")
        sv = v.feed.services_on(day)
        tl = sorted(trip_index(t) for t in v.trips.values() if t["service_id"] in sv)
        key = tuple(tl)
        if key not in pidx:
            pidx[key] = len(patterns)
            patterns.append(tl)
        marks = day_marks(v.feed, day, lo, hi)
        if not (lo <= day <= hi):
            # 版の有効期間の外の日（その版にはバスが無い）。比べる日から外す
            marks.append({"kind": "outside", "label": "この版の有効期間の外"})
        days[day.isoformat()] = {"v": label, "p": pidx[key], "marks": marks}

    def pub(m):
        return dt.datetime.fromisoformat(m["published_at"]).astimezone(dt.timezone(dt.timedelta(hours=9)))

    org, fname = mn["organization_name"], mn["feed_name"]
    out = {
        "format": 1,
        "meta": {
            "feed": feed_key, "feed_name": fname, "operator": org,
            "license": mn["feed_license"], "license_url": mn["feed_license_url"],
            "attribution": f"出典：{org}「{fname}」GTFSデータ（{mn['feed_license']}）、GTFSデータリポジトリ（https://gtfs-data.jp/）。まちの足カルテが加工して作成。",
            "old": {"uid": mo["gtfs_file_uid"], "published_at": pub(mo).isoformat(), "from": mo["from_date"], "to": mo["to_date"]},
            "new": {"uid": mn["gtfs_file_uid"], "published_at": pub(mn).isoformat(), "from": mn["from_date"], "to": mn["to_date"],
                    "memo": mn["memo"]},
            "change_date": change.isoformat(),
            "lead_days": (change - pub(mn).date()).days,
            "window": {"from": (change - dt.timedelta(days=WINDOW_DAYS)).isoformat(),
                       "to": (change + dt.timedelta(days=WINDOW_DAYS - 1)).isoformat()},
            "built_at": built_at or dt.date.today().isoformat(),
        },
        "stops": stops, "routes": routes, "trips": trips, "patterns": patterns, "days": days,
        "stop_report": report,
    }
    return out, report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--feed", required=True)
    ap.add_argument("--old", required=True)
    ap.add_argument("--new", required=True)
    ap.add_argument("--change-date", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    change = dt.date.fromisoformat(args.change_date)
    meta_rows = {r["gtfs_file_uid"]: r for r in csv.DictReader(open(DATA / "versions.csv", encoding="utf-8"))}
    try:
        out, report = build_revision(args.feed, meta_rows[args.old], meta_rows[args.new], change)
    except ValueError as e:
        sys.exit(f"{e}ので止めます")
    stops, routes, trips, patterns, days = (out[k] for k in ("stops", "routes", "trips", "patterns", "days"))
    from pathlib import Path
    p = Path(args.out)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    import gzip
    raw = p.read_bytes()
    print(f"→ {p}  {len(raw)/1024:.1f}KB（gzip {len(gzip.compress(raw))/1024:.1f}KB）")
    print(f"停留所 {len(stops)}、路線 {len(routes)}、バス {len(trips)}、パターン {len(patterns)}、日 {len(days)}")
    print("停留所の対応:", json.dumps({k: (v if k == 'same_id' else len(v)) for k, v in report.items()}, ensure_ascii=False))
    for k in ("renamed", "moved", "matched_by_name", "unmatched"):
        for x in report[k]:
            print(f"  {k}: {x}")
    print("印のある日:", [(d, [m['label'] for m in v['marks']]) for d, v in days.items() if v["marks"]])


if __name__ == "__main__":
    main()
