"""全国の版の組の集計（REPORT.md の「全国」の節の数）。

  python3 scripts/12_national_summary.py        # 表を Markdown で出す（data/summary/national_*.csv も書く）

材料：調査の手順3の組（data/diff_pairs_sample/meikobus/large/daily.csv）＋ 残りの全部のフィード（diff_pairs_all.csv）。
  同じ組（フィードと新しい版）が2つの材料にあれば1つにする。毎日更新のフィードは、調査と同じく2つ（伊勢・熊本都市）だけ。
A の組 = 便や時刻が変わった組。公開が遅い版（late_publish）は分けて数える。先行日数 = 実際に変わった日 − 新しい版の公開日。
"""
import csv
import json
import statistics as st
from collections import Counter, defaultdict
from importlib import import_module

from common import DATA

_sel = import_module("02_select_sample")
region, op_kind = _sel.region, _sel.op_kind
B4 = ["7日以上前", "1〜6日前", "当日", "あと"]


def b4(x):
    return B4[0] if x >= 7 else B4[1] if x >= 1 else B4[2] if x == 0 else B4[3]


def seamless(r):
    try:
        import datetime as dt
        return r["actual_change_date"] == r["new_from"] and (
            dt.date.fromisoformat(r["old_to"]) + dt.timedelta(days=1)).isoformat() == r["new_from"]
    except (KeyError, ValueError):
        return False


def load():
    versions = list(csv.DictReader(open(DATA / "versions.csv", encoding="utf-8")))
    pref = {f"{r['organization_id']}/{r['feed_id']}": r["feed_pref_id"] for r in versions}
    org = {f"{r['organization_id']}/{r['feed_id']}": r["organization_name"] for r in versions}
    rows, seen = [], set()
    for name, grp in [("diff_pairs_sample.csv", "50フィード"), ("diff_pairs_meikobus.csv", "50フィード"),
                      ("diff_pairs_large.csv", "大きいフィード"), ("diff_pairs_daily.csv", "毎日更新"),
                      ("diff_pairs_all.csv", "残り")]:
        for r in csv.DictReader(open(DATA / name, encoding="utf-8")):
            if (r["feed"], r["new_uid"]) in seen:
                continue
            if grp == "毎日更新" and (r["kind"] != "A" or r["granularity"] != "daily"):
                if r["kind"] == "A":
                    continue  # 毎日更新は、毎日の版で特定した最初の変更版だけ
            seen.add((r["feed"], r["new_uid"]))
            r["group"] = grp
            r["kind_op"] = op_kind(org.get(r["feed"], ""), r["feed_name"], r["feed"])
            r["region"] = region(pref.get(r["feed"], 0))
            t = int(r.get("new_trips") or 0)
            r["size"] = "小(便200未満)" if t < 200 else ("中(200〜1999)" if t < 2000 else "大(2000以上)")
            rows.append(r)
    return rows


def counted(r):
    """数える組（バスごとの表示と同じ）：公開が遅い版を除き、印の無い組と、変わる日が新しい版の有効開始日と同じ組"""
    return r["late_publish"] != "True" and (r["change_censored"] != "True" or r["actual_change_date"] == r["new_from"])


def is_a(r):
    return r["kind"] == "A" and r.get("lead_days") not in ("", None) and not (r["new_to"] < r["old_from"])


def dist(rs):
    n = len(rs)
    if not n:
        return {"組": 0, "フィード": 0}
    leads = [int(float(r["lead_days"])) for r in rs]
    c = Counter(b4(x) for x in leads)
    byf = defaultdict(list)
    for r, x in zip(rs, leads):
        byf[r["feed"]].append(x)
    out = {"組": n, "フィード": len(byf)}
    for b in B4:
        out[b] = round(100 * c[b] / n)
    out["中央値"] = st.median(leads)
    out["7日以上前（フィードの重み）"] = round(100 * st.mean(sum(x >= 7 for x in v) / len(v) for v in byf.values()))
    return out


def main():
    rows = load()
    a = [r for r in rows if is_a(r)]
    main_rows = [r for r in a if counted(r)]
    sample = [r for r in main_rows if r["group"] == "50フィード"]
    table = [("全国（数える組）", main_rows),
             ("（参考）全国・印なしの組だけ", [r for r in main_rows if r["change_censored"] != "True"]),
             ("（参考）全国・公開遅れを除く全部（印のある組も全部）", [r for r in a if r["late_publish"] != "True"]),
             ("（参考）全国・公開遅れの組だけ", [r for r in a if r["late_publish"] == "True"]),
             ("（比べる）50フィード＋明光バス（調査）", sample),
             ("（比べる）全国から50フィード＋明光を除いた残り", [r for r in main_rows if r["group"] != "50フィード"])]
    for k in ["自治体・協議会", "民間バス等", "鉄道・船"]:
        table.append((f"種類：{k}", [r for r in main_rows if r["kind_op"] == k]))
    for sz in ["小(便200未満)", "中(200〜1999)", "大(2000以上)"]:
        table.append((f"大きさ：{sz}", [r for r in main_rows if r["size"] == sz]))
    out = [{"区分": lab, **dist(rs)} for lab, rs in table]
    (DATA / "summary").mkdir(exist_ok=True)
    cols = list(dict.fromkeys(k for r in out for k in r))
    with open(DATA / "summary" / "national_lead_buckets.csv", "w", newline="", encoding="utf-8") as fp:
        w = csv.DictWriter(fp, fieldnames=cols)
        w.writeheader()
        w.writerows(out)
    # 3回に届くフィード（バスごとの「ふだん何日前」）：2つの数え方
    byf = defaultdict(list)
    for r in a:
        byf[r["feed"]].append(r)
    cnt = Counter(sum(1 for r in v if counted(r)) for v in byf.values())
    meta = {"フィード（組がある）": len({r["feed"] for r in rows}), "組": len(rows), "A の組": len(a),
            "種類": dict(Counter(r["kind"] for r in rows)), "A の組があるフィード": len(byf),
            "数える組": len(main_rows), "除いた組（公開遅れ）": sum(1 for r in a if r["late_publish"] == "True"),
            "除いた組（印があり、変わる日が有効開始日より後）": sum(1 for r in a if r["late_publish"] != "True" and not counted(r)),
            "数える組の回数ごとのフィード": {str(k): v for k, v in sorted(cnt.items())}}
    json.dump(meta, open(DATA / "summary" / "national_meta.json", "w"), ensure_ascii=False, indent=1)
    print(json.dumps(meta, ensure_ascii=False))
    print("| 区分 | 組 | フィード | 7日以上前 | 1〜6日前 | 当日 | あと | 中央値 | 7日以上前（フィードの重み） |")
    print("|---|---|---|---|---|---|---|---|---|")
    for r in out:
        print(f"| {r['区分']} | {r['組']} | {r['フィード']} | " + " | ".join(f"{r.get(b, '')}%" for b in B4)
              + f" | {r.get('中央値', '')}日 | {r.get('7日以上前（フィードの重み）', '')}% |")


if __name__ == "__main__":
    main()
