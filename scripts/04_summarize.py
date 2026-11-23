"""集計：メタデータの先行日数（参考）と、版の比較で測った先行日数（主な測定）。

出力（data/summary/）:
  meta_lead_buckets.csv      参考：メタデータの先行日数の分布（毎日更新/それ以外、直近2年/全期間、版の重み/フィードの重み）
  declared_kind_counts.csv   事業者の更新申告の種類ごとの版の数（全部/毎日更新を除く）
  measured_lead_buckets.csv  主：A の版の先行日数の分布（組ごと：全体・種類・地域・大きさ・公開遅れ・打ち切り）
  measured_by_feed.csv       フィードごとの A の版の数・先行日数の中央値・年あたりの A の版の数
  diff_kind_counts.csv       A/B/C/same の数
  next_versions.csv          いま「次」の版が出ているフィード
  history_depth.csv          フィードごとの版の数・いちばん古い版
"""
import csv
import datetime as dt
import statistics as st
from collections import Counter, defaultdict

from common import DATA
from importlib import import_module

_sel = import_module("02_select_sample")
region, op_kind = _sel.region, _sel.op_kind

OUT = DATA / "summary"
TODAY = dt.date(2026, 11, 23)
SINCE = TODAY - dt.timedelta(days=730)
BUCKETS = ["14日以上前", "7〜13日前", "1〜6日前", "当日", "後"]


def bucket(x):
    if x >= 14:
        return BUCKETS[0]
    if x >= 7:
        return BUCKETS[1]
    if x >= 1:
        return BUCKETS[2]
    if x == 0:
        return BUCKETS[3]
    return BUCKETS[4]


def quart(xs):
    if not xs:
        return ("", "", "")
    if len(xs) < 4:
        m = st.median(xs)
        return (min(xs), m, max(xs))
    q = st.quantiles(xs, n=4, method="inclusive")
    return (q[0], q[1], q[2])


def dist(rows, key_feed, key_lead):
    """版の重みとフィードの重みの両方で分布を出す"""
    n = len(rows)
    out = {"版の数": n, "フィードの数": len({r[key_feed] for r in rows})}
    if not n:
        return out
    leads = [int(r[key_lead]) for r in rows]
    c = Counter(bucket(x) for x in leads)
    for b in BUCKETS:
        out[f"版の重み:{b}"] = round(c[b] / n, 4)
    byf = defaultdict(list)
    for r in rows:
        byf[r[key_feed]].append(int(r[key_lead]))
    for b in BUCKETS:
        out[f"フィードの重み:{b}"] = round(st.mean(sum(bucket(x) == b for x in v) / len(v) for v in byf.values()), 4)
    q1, med, q3 = quart(leads)
    out.update({"中央値": med, "第1四分位": q1, "第3四分位": q3})
    fm = [st.median(v) for v in byf.values()]
    out["フィードごとの中央値の中央値"] = st.median(fm)
    out["7日以上前の割合(版)"] = round(sum(x >= 7 for x in leads) / n, 4)
    out["7日以上前の割合(フィード)"] = round(st.mean(sum(x >= 7 for x in v) / len(v) for v in byf.values()), 4)
    return out


def write(name, rows):
    OUT.mkdir(exist_ok=True)
    cols = list(dict.fromkeys(k for r in rows for k in r))
    with open(OUT / name, "w", newline="", encoding="utf-8") as fp:
        w = csv.DictWriter(fp, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)


def main():
    versions = list(csv.DictReader(open(DATA / "versions.csv", encoding="utf-8")))
    daily = {l.strip() for l in open(DATA / "daily_feeds.txt", encoding="utf-8") if l.strip()}
    for r in versions:
        r["feed"] = f"{r['organization_id']}/{r['feed_id']}"
        r["group"] = "毎日更新" if r["feed"] in daily else "それ以外"

    # --- 参考：メタデータの先行日数 ---
    nonfirst = [r for r in versions if r["is_first_version"] == "False"]
    meta = []
    for grp in ["それ以外", "毎日更新"]:
        for period in ["直近2年", "全期間"]:
            for late in ["公開遅れを除く", "公開遅れのみ"]:
                rs = [r for r in nonfirst if r["group"] == grp
                      and (period == "全期間" or r["published_at"][:10] >= SINCE.isoformat())
                      and (r["late_publish"] == "True") == (late == "公開遅れのみ")]
                meta.append({"組": grp, "期間": period, "公開遅れ": late, **dist(rs, "feed", "meta_lead_days")})
    write("meta_lead_buckets.csv", meta)
    late = Counter((r["group"], r["late_publish"]) for r in nonfirst)
    groups3 = Counter((r["group"], r["meta_lead_group"]) for r in nonfirst)

    # --- 申告 ---
    c_all = Counter(r["declared_kind"] for r in nonfirst)
    c_nd = Counter(r["declared_kind"] for r in nonfirst if r["group"] == "それ以外")
    ta, tn = sum(c_all.values()), sum(c_nd.values())
    write("declared_kind_counts.csv", [
        {"declared_kind": k, "版の数(全部)": x, "割合(全部)": round(x / ta, 4),
         "版の数(毎日更新を除く)": c_nd[k], "割合(毎日更新を除く)": round(c_nd[k] / tn, 4) if tn else ""}
        for k, x in c_all.most_common()])

    # --- 主：版の比較 ---
    pref = {r["feed"]: r["feed_pref_id"] for r in versions}
    orgname = {r["feed"]: r["organization_name"] for r in versions}
    sample = {r["feed"]: r for r in csv.DictReader(open(DATA / "sample_feeds.csv", encoding="utf-8"))}
    pairs = []
    for name, grp in [("diff_pairs_sample.csv", "50フィード"), ("diff_pairs_meikobus.csv", "明光バス"),
                      ("diff_pairs_daily.csv", "毎日更新"), ("diff_pairs_large.csv", "大きいフィード")]:
        p = DATA / name
        if not p.exists():
            continue
        for r in csv.DictReader(open(p, encoding="utf-8")):
            r["group"] = grp
            r["organization_name"] = orgname.get(r["feed"], "")
            s = sample.get(r["feed"], {})
            r["kind_op"] = s.get("kind") or op_kind(r["organization_name"], r["feed_name"], r["feed"])
            r["region"] = s.get("region") or region(pref.get(r["feed"], 0))
            pairs.append(r)
    write("diff_kind_counts.csv", [
        {"組": g, "粒度": gr, "kind": k, "数": x}
        for (g, gr, k), x in sorted(Counter((r["group"], r["granularity"], r["kind"]) for r in pairs).items())])

    # 毎日更新は「daily」で特定できた最初の変更版だけを A の版として数える
    def reversed_period(r):
        # あとから公開された版のほうが前の期間だけを持つ組（変更日を測れない）
        return r["kind"] != "error" and r["new_to"] < r["old_from"]

    def is_a(r):
        if r["kind"] != "A" or reversed_period(r):
            return False
        if r["group"] == "毎日更新":
            return r["granularity"] == "daily"
        return True

    a_rows = [r for r in pairs if is_a(r)]
    for r in a_rows:
        t = int(r["new_trips"] or 0)
        r["size"] = "小(便200未満)" if t < 200 else ("中(200〜1999)" if t < 2000 else "大(2000以上)")
    main_rows = [r for r in a_rows if r["late_publish"] != "True"]
    meas = []

    def add(label, rs):
        meas.append({"区分": label, **dist(rs, "feed", "lead_days")})

    g50 = ("50フィード", "明光バス")
    add("A全部（公開遅れを除く・50フィード＋明光）", [r for r in main_rows if r["group"] in g50])
    add("A全部（公開遅れを除く・打ち切りの印なし）",
        [r for r in main_rows if r["group"] in g50 and r["change_censored"] != "True"])
    add("A全部（公開遅れを除く・打ち切りの印あり）",
        [r for r in main_rows if r["group"] in g50 and r["change_censored"] == "True"])
    add("A（公開遅れのみ）", [r for r in a_rows if r["late_publish"] == "True" and r["group"] in g50])
    add("A 毎日更新（伊勢・熊本都市）", [r for r in main_rows if r["group"] == "毎日更新"])
    base = [r for r in main_rows if r["group"] in ("50フィード", "明光バス")]
    large = [r for r in main_rows if r["group"] == "大きいフィード"]
    add("大きいフィード（民間バスの便の多い10、公開遅れを除く）", large)
    add("大きいフィード・打ち切りの印なし", [r for r in large if r["change_censored"] != "True"])
    add("大きいフィード（公開遅れのみ）", [r for r in a_rows if r["late_publish"] == "True" and r["group"] == "大きいフィード"])
    add("50フィード＋明光＋大きいフィード（公開遅れを除く）", base + large)
    for k in ["自治体・協議会", "民間バス等", "鉄道・船"]:
        add(f"種類:{k}", [r for r in base if r["kind_op"] == k])
    for reg in ["北海道", "東北", "関東", "中部", "近畿", "中国", "四国", "九州沖縄"]:
        add(f"地域:{reg}", [r for r in base if r["region"] == reg])
    for sz in ["小(便200未満)", "中(200〜1999)", "大(2000以上)"]:
        add(f"大きさ:{sz}", [r for r in base if r["size"] == sz])
    write("measured_lead_buckets.csv", meas)

    # 参考と主の比較（同じ組で）
    same = sum(1 for r in base if r["lead_days"] != "" and int(r["lead_days"]) == int(r["meta_lead_days"]))

    # フィードごと
    byf = defaultdict(list)
    for r in pairs:
        if r["group"] == "毎日更新" and r["granularity"] != "daily" and r["kind"] == "A":
            continue
        byf[r["feed"]].append(r)
    feed_rows = []
    for f, rs in byf.items():
        a = [r for r in rs if is_a(r)]
        al = [int(r["lead_days"]) for r in a if r["late_publish"] != "True"]
        recent_a = [r for r in a if r["new_published"][:10] >= SINCE.isoformat()]
        feed_rows.append({
            "feed": f, "feed_name": rs[0]["feed_name"], "group": rs[0]["group"],
            "kind_op": rs[0]["kind_op"], "region": rs[0]["region"],
            "trips": max(int(r["new_trips"] or 0) for r in rs) if any(r.get("new_trips") for r in rs) else "",
            "pairs": len([r for r in rs if r["granularity"] != "daily"]) if rs[0]["group"] == "毎日更新" else len(rs),
            "A": len(a), "B": sum(r["kind"] == "B" for r in rs), "C": sum(r["kind"] == "C" for r in rs),
            "same": sum(r["kind"] == "same" for r in rs), "error": sum(r["kind"] == "error" for r in rs),
            "A_late_publish": sum(r["late_publish"] == "True" for r in a),
            "A_per_year(直近2年)": round(len(recent_a) / 2, 1),
            "lead_median": st.median(al) if al else "", "lead_min": min(al) if al else "",
            "lead_max": max(al) if al else "", "leads": " ".join(map(str, al)),
        })
    feed_rows.sort(key=lambda r: (r["lead_median"] == "", -(r["lead_median"] or 0)))
    write("measured_by_feed.csv", feed_rows)

    # feed_info の開始日と API の有効開始日
    fi = Counter(r["feed_info_start_matches_api"] for r in pairs if r["kind"] != "error")
    fi_bad = [r for r in pairs if r["feed_info_start_matches_api"] == "False"]

    # 次の版
    nxt = []
    for r in versions:
        if r["rid"].startswith("next"):
            fd = dt.date.fromisoformat(r["from_date"])
            nxt.append({"feed": r["feed"], "organization_name": r["organization_name"], "feed_name": r["feed_name"],
                        "feed_pref_id": r["feed_pref_id"], "rid": r["rid"], "published_at": r["published_at"][:16],
                        "from_date": r["from_date"], "to_date": r["to_date"], "meta_lead_days": r["meta_lead_days"],
                        "declared_kind": r["declared_kind"], "license": r["feed_license"],
                        "dec_jan": "★" if (fd.month == 12 or fd.month == 1) else ""})
    nxt.sort(key=lambda r: r["from_date"])
    write("next_versions.csv", nxt)

    # 過去の版の残り具合
    byfeed = defaultdict(list)
    for r in versions:
        byfeed[r["feed"]].append(r)
    hist = [{"feed": k, "group": v[0]["group"], "versions": len(v),
             "oldest_published": min(x["published_at"] for x in v)[:10],
             "oldest_from_date": min(x["from_date"] for x in v),
             "has_current": v[0]["feed_has_current"]} for k, v in byfeed.items()]
    write("history_depth.csv", hist)

    # 画面に要点
    print("late_publish:", dict(late))
    print("meta 3組:", dict(groups3))
    print("申告(毎日更新を除く) 上位:", c_nd.most_common(6), tn)
    print("比較の結果:", Counter((r["group"], r["kind"]) for r in pairs if r["granularity"] != "daily"))
    print("A の版（公開遅れを除く、50＋明光）:", len(base), " メタと一致:", same)
    print("期間が逆向きの組:", [(r["feed"], r["old_rid"], r["new_rid"]) for r in pairs if reversed_period(r)])
    print("feed_info 一致:", dict(fi), "不一致の例:",
          [(r["feed"], r["new_from"], r["feed_info_start"]) for r in fi_bad[:5]])
    print("次の版:", len(nxt), "フィード", len({r['feed'] for r in nxt}), "12〜1月:", sum(r["dec_jan"] == "★" for r in nxt))
    vc = sorted(len(v) for v in byfeed.values())
    print("版の数/フィード 中央値", st.median(vc), "最大", vc[-1], "1版だけ", sum(x == 1 for x in vc))
    for m in meas:
        print({k: m[k] for k in m if not k.startswith("フィードの重み")})


if __name__ == "__main__":
    main()
