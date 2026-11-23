"""手順3の50フィードを選ぶ（乱数の種を固定して、やり直せるようにする）。

選ぶ元: 毎日自動取り込みのフィード（メモが「自動取り込み」の版が50以上）を除き、
        直近2年に公開された（最初の版でない）版が1つ以上あるフィード。
割り当て: 自治体・協議会 28 / 民間バス等 15 / 鉄道・船 7（事業者の種類は名前から推定）。
地域: 8地方から、選べる範囲で2つ以上ずつ。
組が2つ以上あるフィードを先に選ぶ。試しの5フィードは必ず入れる。

出力: data/sample_feeds.csv, data/sample_feeds.txt, data/daily_feeds.txt
"""
import csv
import datetime as dt
import random
import re
from collections import Counter, defaultdict

from common import DATA

SEED = 20261123
QUOTA = {"自治体・協議会": 28, "民間バス等": 15, "鉄道・船": 7}
REGIONS = ["北海道", "東北", "関東", "中部", "近畿", "中国", "四国", "九州沖縄"]
MIN_PER_REGION = 2


def region(pref):
    p = int(pref or 0)
    for name, lo, hi in [("北海道", 1, 1), ("東北", 2, 7), ("関東", 8, 14), ("中部", 15, 23),
                         ("近畿", 24, 30), ("中国", 31, 35), ("四国", 36, 39), ("九州沖縄", 40, 47)]:
        if lo <= p <= hi:
            return name
    return "不明"


# 名前からの推定で誤るものの手直し（目で見て確かめたもの）
OVERRIDE = {
    "towadakankodentetsu/toutetsu_airport_line": "民間バス等",  # 鉄道会社のバス路線
    "towadakankodentetsu/toutetsu": "民間バス等",  # 同上（一般路線＝バス）
    "gan-wu/shiokazeline": "自治体・協議会",  # 協議会のバス
    "setouchicity/setouchicitykankobus": "自治体・協議会",  # 「長船」は地名
    "tsu-airportline/airportline": "鉄道・船",  # 高速船（ベルラインはバス。フィードは船が主）
}


def op_kind(org_name, feed_name, key=""):
    """事業者の種類（名前からの推定）。乗り物（フィード名）を先に見て、次に運営主体を見る。"""
    if key in OVERRIDE:
        return OVERRIDE[key]
    if re.search(r"船|航路|フェリー|汽船|海運", feed_name + org_name) and "バス" not in feed_name:
        return "鉄道・船"
    if re.search(r"鉄道|電鉄|市電|電車|軌道|モノレール|ロープウェ", feed_name) and "バス" not in feed_name:
        return "鉄道・船"
    if re.search(r"[市町村]$|[市町村]役場|協議会|組合|交通局|交通部|県営|市営|町営|村営", org_name) or (
            re.search(r"[市町村]", org_name) and not re.search(r"株式会社|有限会社|鉄道|電鉄|バス|交通", org_name)):
        return "自治体・協議会"
    return "民間バス等"


def load():
    feeds = defaultdict(list)
    for r in csv.DictReader(open(DATA / "versions.csv", encoding="utf-8")):
        feeds[f"{r['organization_id']}/{r['feed_id']}"].append(r)
    return feeds


def daily_feeds(feeds):
    return sorted(k for k, v in feeds.items() if sum("自動取り込み" in r["memo"] for r in v) >= 50)


def main():
    feeds = load()
    daily = set(daily_feeds(feeds))
    since = (dt.date(2026, 11, 23) - dt.timedelta(days=730)).isoformat()
    info = {}
    for k, v in feeds.items():
        if k in daily:
            continue
        pairs = sum(1 for r in v if r["published_at"][:10] >= since and r["is_first_version"] == "False")
        if pairs == 0:
            continue
        r = v[0]
        info[k] = {"feed": k, "feed_name": r["feed_name"], "organization_name": r["organization_name"],
                   "kind": op_kind(r["organization_name"], r["feed_name"], k),
                   "region": region(r["feed_pref_id"]), "pairs": pairs}

    rng = random.Random(SEED)
    keys = sorted(info)
    rng.shuffle(keys)
    keys.sort(key=lambda k: info[k]["pairs"] < 2)  # 組が2つ以上を先に（安定ソートで乱数順を保つ）

    chosen, reason = [], {}
    trial = [l.strip() for l in open(DATA / "trial5_feeds.txt", encoding="utf-8") if l.strip()]
    for k in trial:
        chosen.append(k)
        reason[k] = "試しの5フィード"
    used = Counter(info[k]["kind"] for k in chosen)

    def can(k):
        return k not in chosen and used[info[k]["kind"]] < QUOTA[info[k]["kind"]]

    for reg in REGIONS:
        while sum(info[k]["region"] == reg for k in chosen) < MIN_PER_REGION:
            cand = [k for k in keys if info[k]["region"] == reg and can(k)]
            if not cand:
                break
            chosen.append(cand[0])
            used[info[cand[0]]["kind"]] += 1
            reason[cand[0]] = f"地域の最低数（{reg}）"
    for k in keys:
        if can(k):
            chosen.append(k)
            used[info[k]["kind"]] += 1
            reason[k] = "割り当ての残りを乱数順で"

    with open(DATA / "sample_feeds.csv", "w", newline="", encoding="utf-8") as fp:
        w = csv.DictWriter(fp, fieldnames=["feed", "feed_name", "organization_name", "kind", "region", "pairs", "reason"])
        w.writeheader()
        for k in chosen:
            w.writerow({**info[k], "reason": reason[k]})
    (DATA / "sample_feeds.txt").write_text("\n".join(chosen) + "\n", encoding="utf-8")
    (DATA / "daily_feeds.txt").write_text("\n".join(sorted(daily)) + "\n", encoding="utf-8")
    print(f"選ぶ元 {len(info)} フィード、選んだ {len(chosen)}")
    print(Counter(info[k]["kind"] for k in chosen))
    print(Counter(info[k]["region"] for k in chosen))
    print("組の数:", sum(info[k]["pairs"] for k in chosen))
    for k in chosen:
        i = info[k]
        print(f"  {i['kind']}\t{i['region']}\t{i['pairs']}\t{k}\t{i['organization_name']} {i['feed_name']}")


if __name__ == "__main__":
    main()
