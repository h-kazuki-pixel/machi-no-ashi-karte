"""版ごとの「時刻表のデータ」（端末で読む形）を作る部品。

形（format: "timetable-1"）:
  meta      フィード・事業者・ライセンス・版（uid, 公開日時, 有効期間）・作った日時
  stops     [[stop_id, 名前, 読み, 緯度, 経度], ...]          そのバスが使う停留所だけ
  routes    [路線名, ...]
  services  [{"id", "wd": "1111100", "s": "YYYYMMDD", "e": "YYYYMMDD", "add": [...], "rm": [...]}, ...]
            運行の決まり（calendar.txt と calendar_dates.txt をそのまま）。その日に走るかは端末で計算する
  trips     [[路線, 行き先, 運行, [[停留所, 時刻] か [停留所, 着, 発] か [停留所, 着, 発, 印], ...]], ...]
            時刻は 0時からの分。印（4つ目）は乗り降りの決まりのビットの組み合わせ：
            1 = 乗れない、4 = 乗る前に電話、8 = 乗るとき運転士に伝える（pickup_type=1/2/3）、
            2 = 降りられない、16 = 降りるには電話、32 = 降りるとき運転士に伝える（drop_off_type=1/2/3）。
            印が無ければ、ふつうに乗り降りできる。

路線の形（shapes.txt）は入れない。
「その日に走るバス」の決まりは、調査と同じ（03_diff_versions.Feed.services_on）:
  calendar の曜日と期間で走る運行に、calendar_dates の 1（追加）を足し、2（運休）を除く。
"""
import datetime as dt
from importlib import import_module

br = import_module("06_build_revision")


def build_timetable(zip_path, meta, built_at=None):
    """meta: feed, gtfs_file_uid, published_at, from_date, to_date, feed_name, organization_name,
    feed_license, feed_license_url"""
    v = br.Version(meta["gtfs_file_uid"], zip_path)
    trips_src = list(v.trips.values())
    sids = sorted({t["service_id"] for t in trips_src})
    sidx = {s: i for i, s in enumerate(sids)}
    base = {sid: (a, b, w) for sid, a, b, w in v.feed.base}
    add = {s: [] for s in sids}
    rm = {s: [] for s in sids}
    for d, m in v.feed.exc.items():
        for sid, et in m.items():
            if sid in sidx:
                if et == "1":
                    add[sid].append(d.strftime("%Y%m%d"))
                elif et == "2":
                    rm[sid].append(d.strftime("%Y%m%d"))
    services = []
    for s in sids:
        a, b, w = base.get(s, (None, None, [False] * 7))
        services.append({"id": s, "wd": "".join("1" if x else "0" for x in w),
                         "s": a.strftime("%Y%m%d") if a else "", "e": b.strftime("%Y%m%d") if b else "",
                         "add": sorted(add[s]), "rm": sorted(rm[s])})
    stop_ids = sorted({sid for t in trips_src for sid, _, _ in t["seq"]})
    st_idx = {s: i for i, s in enumerate(stop_ids)}
    stops = []
    for s in stop_ids:
        r = v.stops.get(s, {})
        stops.append([s, r.get("stop_name", s), v.kana.get(s, ""),
                      round(float(r.get("stop_lat") or 0), 6), round(float(r.get("stop_lon") or 0), 6)])
    routes = sorted({t["route"] for t in trips_src})
    ridx = {r: i for i, r in enumerate(routes)}
    trips = []
    for t in trips_src:
        seq = []
        last = len(t["seq"]) - 1
        for k, ((s, a, d), f) in enumerate(zip(t["seq"], t["flags"])):
            # 始発で降りる・終点から乗ることは無いので、その印は持たない（ほとんどのフィードが「できない」と書いている）
            if k == 0:
                f &= ~br.DROP_OFF_BITS
            if k == last:
                f &= ~br.PICKUP_BITS
            if f:
                seq.append([st_idx[s], a, d, f])
            elif a == d:
                seq.append([st_idx[s], a])
            else:
                seq.append([st_idx[s], a, d])
        trips.append([ridx[t["route"]], t["headsign"], sidx[t["service_id"]], seq])
    return {
        "format": "timetable-1",
        "meta": {
            "feed": meta["feed"], "feed_name": meta["feed_name"], "operator": meta["organization_name"],
            "license": meta["feed_license"], "license_url": meta["feed_license_url"],
            "uid": meta["gtfs_file_uid"], "published_at": meta["published_at"],
            "from": meta["from_date"], "to": meta["to_date"],
            "built_at": built_at or dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).replace(microsecond=0).isoformat(),
        },
        "stops": stops, "routes": routes, "services": services, "trips": trips,
    }


def trips_on_expected(tt, feed, day):
    """調査の決まり（Feed.services_on）で、その日に走るバスの番号（trips の並びの番号）"""
    active = feed.services_on(day)
    return [i for i, t in enumerate(tt["trips"]) if tt["services"][t[2]]["id"] in active]


def services_on_tt(tt, day):
    """時刻表のデータ（timetable-1）で、その日に走る運行の番号（端末の servicesOn と同じ決まり）"""
    d = day.strftime("%Y%m%d")
    wd = day.weekday()
    out = set()
    for i, s in enumerate(tt["services"]):
        on = bool(s["s"] and s["e"] and s["s"] <= d <= s["e"] and s["wd"][wd] == "1")
        if d in s["add"]:
            on = True
        if d in s["rm"]:
            on = False
        if on:
            out.add(i)
    return out


def run_ranges(tt, lo=None, hi=None):
    """lo〜hi（有効期間の中だけ）のうち、バスが1本でも走る日を、[始め, 終わり] の並びで返す"""
    lo = max(dt.date.fromisoformat(tt["meta"]["from"]), lo or dt.date.min)
    hi = min(dt.date.fromisoformat(tt["meta"]["to"]), hi or dt.date.max)
    used = {t[2] for t in tt["trips"]}
    out = []
    d = lo
    while d <= hi:
        if services_on_tt(tt, d) & used:
            iso = d.isoformat()
            if out and (d - dt.date.fromisoformat(out[-1][1])).days == 1:
                out[-1][1] = iso
            else:
                out.append([iso, iso])
        d += dt.timedelta(days=1)
    return out
