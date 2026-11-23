"""改正の前後で、停留所ごとに「無くなる便」「時刻が変わる便（何分ずれるか）」「新しくできる便」を出す。

旧版と新版から、日の種類ごとに代表の日を1日ずつ選び（--day 名前:旧の日:新の日）、
その日に走る便を、路線名（route_long_name / route_short_name）ごとに突き合わせる。
（direction_id は版によって付け替えられることがあるので使わず、共通する停留所の通る順番で向きをそろえる）

突き合わせ:
  同じ路線の便を、出発順を保ったまま組にする（順序を保つ対応づけ）。
  共通する停留所を通る順番が8割以上そろっている便どうしだけを組にする（逆向きの便は組にしない）。
  組の費用 = 最初に共通する停留所での時刻のずれ（分）。MAX_SHIFT 分を超える組は作らない。
  組にならない便は、1便あたり GAP の費用で「無くなる」「新しくできる」とする。
  停留所は名前で同じとみなす（stop_id の付け替えに左右されない）。

  組になった便で（同じ停留所に2回以上止まるときは、その停留所に止まる時刻どうしを近い順に組にする）:
    共通する停留所で時刻が違う   → その停留所では「時刻が変わる便」（ずれの分）
    旧の便だけが止まる停留所     → その停留所では「無くなる便」
    新の便だけが止まる停留所     → その停留所では「新しくできる便」
  組にならなかった便は、止まる全部の停留所で「無くなる便」または「新しくできる便」。

使い方:
  python3 scripts/05_stop_changes.py --old <uid> --new <uid> \\
      --day 平日:2026-11-25:2026-12-02 --day 土曜:2026-11-28:2026-12-05 --out-prefix data/yonezawa_20261201
"""
import argparse
import csv
import datetime as dt
import io
import zipfile
from collections import defaultdict
from importlib import import_module

from common import CACHE

dv = import_module("03_diff_versions")

MAX_SHIFT = 30  # 分
GAP = MAX_SHIFT / 2  # 便が組にならないときの費用。|ずれ| < 2*GAP なら組にする方が安い


def mins(t):
    h, m, s = (int(x) for x in t.split(":"))
    return h * 60 + m + s / 60


def hhmm(m):
    m = int(round(m))
    return f"{m // 60:02d}:{m % 60:02d}"


def load(uid):
    z = zipfile.ZipFile(CACHE / "zips" / f"{uid}.zip")
    names = {n.split("/")[-1]: n for n in z.namelist()}

    def rd(n):
        return list(csv.DictReader(io.StringIO(z.read(names[n]).decode("utf-8-sig"))))

    stops = {s["stop_id"]: s["stop_name"] for s in rd("stops.txt")}
    routes = {r["route_id"]: (r.get("route_long_name") or r.get("route_short_name") or r["route_id"]) for r in rd("routes.txt")}
    st = defaultdict(list)
    for r in rd("stop_times.txt"):
        st[r["trip_id"]].append((int(float(r["stop_sequence"])), stops.get(r["stop_id"], r["stop_id"]),
                                 mins(r["departure_time"] or r["arrival_time"])))
    trips = {}
    for t in rd("trips.txt"):
        seq = [(n, m) for _, n, m in sorted(st.get(t["trip_id"], []))]
        if seq:
            trips[t["trip_id"]] = {"trip_id": t["trip_id"], "service_id": t["service_id"],
                                   "route": routes.get(t["route_id"], t["route_id"]),
                                   "dir": t.get("direction_id", ""), "headsign": t.get("trip_headsign", ""),
                                   "seq": seq}
    return dv.Feed(CACHE / "zips" / f"{uid}.zip"), trips


def running(feed, trips, day):
    sv = feed.services_on(day)
    return [t for t in trips.values() if t["service_id"] in sv]


def first_common_shift(a, b):
    """最初に共通する停留所での時刻のずれ。共通する停留所を通る順番が新旧でそろっていない
    （逆向きの便など）ときは None（組にしない）。"""
    pos_b, nb = {}, {}
    for i, (n, m) in enumerate(b["seq"]):
        pos_b.setdefault(n, i)
        nb.setdefault(n, m)
    seen, common = set(), []
    for n, m in a["seq"]:
        if n in nb and n not in seen:
            seen.add(n)
            common.append(n)
    if not common:
        return None
    if len(common) >= 3:
        ps = [pos_b[n] for n in common]
        inc = sum(1 for x, y in zip(ps, ps[1:]) if y > x)
        if inc / (len(ps) - 1) < 0.8:
            return None
    m0 = next(m for n, m in a["seq"] if n == common[0])
    return nb[common[0]] - m0


def align_times(xs, ys):
    """1本のバスの中の、ある停留所に止まる時刻の並び（旧 xs・新 ys）を、順番を保って組にする。
    ずれが MAX_SHIFT 分を超える組は作らない。戻り値は (旧の時刻 or None, 新の時刻 or None) の並び。"""
    xs, ys = sorted(xs), sorted(ys)
    n, m = len(xs), len(ys)
    INF = float("inf")
    cost = [[INF] * (m + 1) for _ in range(n + 1)]
    back = [[None] * (m + 1) for _ in range(n + 1)]
    cost[0][0] = 0
    for i in range(n + 1):
        for j in range(m + 1):
            c = cost[i][j]
            if c == INF:
                continue
            if i < n and c + GAP < cost[i + 1][j]:
                cost[i + 1][j], back[i + 1][j] = c + GAP, (i, j, "old")
            if j < m and c + GAP < cost[i][j + 1]:
                cost[i][j + 1], back[i][j + 1] = c + GAP, (i, j, "new")
            if i < n and j < m and abs(ys[j] - xs[i]) <= MAX_SHIFT and c + abs(ys[j] - xs[i]) < cost[i + 1][j + 1]:
                cost[i + 1][j + 1], back[i + 1][j + 1] = c + abs(ys[j] - xs[i]), (i, j, "pair")
    out, i, j = [], n, m
    while (i, j) != (0, 0):
        pi, pj, kind = back[i][j]
        out.append((xs[pi] if kind in ("old", "pair") else None, ys[pj] if kind in ("new", "pair") else None))
        i, j = pi, pj
    return out[::-1]


def align(olds, news):
    """順序を保つ対応づけ（編集距離と同じ動的計画法）"""
    olds = sorted(olds, key=lambda t: t["seq"][0][1])
    news = sorted(news, key=lambda t: t["seq"][0][1])
    n, m = len(olds), len(news)
    INF = float("inf")
    cost = [[INF] * (m + 1) for _ in range(n + 1)]
    back = [[None] * (m + 1) for _ in range(n + 1)]
    cost[0][0] = 0
    for i in range(n + 1):
        for j in range(m + 1):
            c = cost[i][j]
            if c == INF:
                continue
            if i < n and c + GAP < cost[i + 1][j]:
                cost[i + 1][j], back[i + 1][j] = c + GAP, (i, j, "old")
            if j < m and c + GAP < cost[i][j + 1]:
                cost[i][j + 1], back[i][j + 1] = c + GAP, (i, j, "new")
            if i < n and j < m:
                s = first_common_shift(olds[i], news[j])
                if s is not None and abs(s) <= MAX_SHIFT and c + abs(s) < cost[i + 1][j + 1]:
                    cost[i + 1][j + 1], back[i + 1][j + 1] = c + abs(s), (i, j, "pair")
    out, i, j = [], n, m
    while (i, j) != (0, 0):
        pi, pj, kind = back[i][j]
        out.append((olds[pi] if kind in ("old", "pair") else None, news[pj] if kind in ("new", "pair") else None))
        i, j = pi, pj
    return out[::-1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--old", required=True)
    ap.add_argument("--new", required=True)
    ap.add_argument("--day", action="append", required=True, help="名前:旧の日:新の日")
    ap.add_argument("--out-prefix", required=True)
    args = ap.parse_args()

    fo, to = load(args.old)
    fn, tn = load(args.new)
    trip_rows, by_stop = [], defaultdict(lambda: defaultdict(lambda: {"removed": [], "shifted": [], "added": []}))
    for spec in args.day:
        label, od, nd = spec.split(":")
        od, nd = dt.date.fromisoformat(od), dt.date.fromisoformat(nd)
        ro, rn = running(fo, to, od), running(fn, tn, nd)
        groups = defaultdict(lambda: ([], []))
        for t in ro:
            groups[t["route"]][0].append(t)
        for t in rn:
            groups[t["route"]][1].append(t)
        for route, (olds, news) in sorted(groups.items()):
            for a, b in align(olds, news):
                if a and b:
                    # 同じ停留所に2回以上止まるバスがあるので、停留所ごとに止まる時刻を全部並べ、
                    # 新旧で時刻の近いものどうしを（順番を保って）組にする
                    shifts, only_old, only_new = [], [], []
                    oo, nn = defaultdict(list), defaultdict(list)
                    for n_, m_ in a["seq"]:
                        oo[n_].append(m_)
                    for n_, m_ in b["seq"]:
                        nn[n_].append(m_)
                    for n_ in set(oo) | set(nn):
                        for x, y in align_times(oo.get(n_, []), nn.get(n_, [])):
                            if x is not None and y is not None:
                                shifts.append((n_, x, y))
                            elif x is not None:
                                only_old.append((n_, x))
                            else:
                                only_new.append((n_, y))
                    changed = any(abs(y - x) > 0.01 for _, x, y in shifts) or only_old or only_new
                    status = "時刻・停留所が変わる" if changed else "変わらない"
                    for n_, x, y in shifts:
                        if abs(y - x) > 0.01:
                            by_stop[n_][label]["shifted"].append((x, y, y - x, route))
                    for n_, x in only_old:
                        by_stop[n_][label]["removed"].append((x, route))
                    for n_, y in only_new:
                        by_stop[n_][label]["added"].append((y, route))
                    sv = sorted(round(y - x) for _, x, y in shifts if abs(y - x) > 0.01)
                    detail = (f"ずれ {sv[0]:+d}〜{sv[-1]:+d}分" if sv else "") + (
                        f" 止まらなくなる {len(only_old)}" if only_old else "") + (
                        f" 新たに止まる {len(only_new)}" if only_new else "")
                elif a:
                    status, detail = "無くなる", ""
                    for n, m in a["seq"]:
                        by_stop[n][label]["removed"].append((m, route))
                else:
                    status, detail = "新しくできる", ""
                    for n, m in b["seq"]:
                        by_stop[n][label]["added"].append((m, route))
                trip_rows.append({
                    "日の種類": label, "旧の日": od, "新の日": nd, "路線": route, "向き(旧/新)": f"{a['dir'] if a else ''}/{b['dir'] if b else ''}",
                    "結果": status,
                    "旧の便": f"{hhmm(a['seq'][0][1])} {a['seq'][0][0]}→{a['seq'][-1][0]}" if a else "",
                    "新の便": f"{hhmm(b['seq'][0][1])} {b['seq'][0][0]}→{b['seq'][-1][0]}" if b else "",
                    "中身": detail,
                    "旧trip_id": a["trip_id"] if a else "", "新trip_id": b["trip_id"] if b else "",
                })

    with open(f"{args.out_prefix}_trips.csv", "w", newline="", encoding="utf-8") as fp:
        w = csv.DictWriter(fp, fieldnames=list(trip_rows[0].keys()))
        w.writeheader()
        w.writerows(trip_rows)

    labels = [s.split(":")[0] for s in args.day]
    stop_rows = []
    for n, per in by_stop.items():
        row = {"停留所": n}
        total = 0
        for lb in labels:
            x = per.get(lb, {"removed": [], "shifted": [], "added": []})
            total += len(x["removed"]) + len(x["shifted"]) + len(x["added"])
            row[f"{lb}:無くなる便"] = " ".join(f"{hhmm(m)}" for m, _ in sorted(x["removed"]))
            row[f"{lb}:時刻が変わる便"] = " ".join(f"{hhmm(o)}→{hhmm(nn)}({v:+.0f}分)" for o, nn, v, _ in sorted(x["shifted"]))
            row[f"{lb}:新しくできる便"] = " ".join(f"{hhmm(m)}" for m, _ in sorted(x["added"]))
            row[f"{lb}:件数(無/変/新)"] = f"{len(x['removed'])}/{len(x['shifted'])}/{len(x['added'])}"
        row["影響する便の数(日の種類の合計)"] = total
        stop_rows.append(row)
    stop_rows.sort(key=lambda r: -r["影響する便の数(日の種類の合計)"])
    with open(f"{args.out_prefix}_by_stop.csv", "w", newline="", encoding="utf-8") as fp:
        w = csv.DictWriter(fp, fieldnames=list(stop_rows[0].keys()))
        w.writeheader()
        w.writerows(stop_rows)

    from collections import Counter
    print(Counter((r["日の種類"], r["結果"]) for r in trip_rows))
    print(f"停留所 {len(stop_rows)} → {args.out_prefix}_by_stop.csv")


if __name__ == "__main__":
    main()
