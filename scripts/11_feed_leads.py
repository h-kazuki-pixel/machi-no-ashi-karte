"""バスごとの「ふだん、変わる日の何日前に新しい時刻表が出るか」の材料（data/feed_leads.json）を作る。

  python3 scripts/11_feed_leads.py

- 材料は調査の手順3の版の組（data/diff_pairs_*.csv。試しの trial5 は除く）のうち、便や時刻が変わった組（A）。
- 何日前 = 実際に変わった日 − 新しい版の公開日（日本時間）。
- 公開が遅い版（late_publish）と、変わる日がはっきりしない組（change_censored）は、真ん中の日数に入れず、回数だけ数える。
- 見る仕組みが見つけた改正（site の found.csv）は、バスの一覧を作るとき（09_build_catalog.py）に足す。
"""
import csv
import json
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"


def load_pairs():
    out = {}
    for p in sorted(DATA.glob("diff_pairs_*.csv")):
        if "trial5" in p.name:
            continue
        for r in csv.DictReader(open(p, encoding="utf-8")):
            if r.get("kind") != "A" or r.get("lead_days") in ("", None):
                continue
            out.setdefault(r["feed"], {})[r["new_uid"]] = {
                "new_uid": r["new_uid"], "published": r["new_published"][:10], "change": r["actual_change_date"],
                "lead": int(float(r["lead_days"])), "late": r.get("late_publish") == "True",
                "censored": r.get("change_censored") == "True", "src": p.stem.replace("diff_pairs_", "")}
    return {k: sorted(v.values(), key=lambda x: x["published"]) for k, v in out.items()}


def main():
    pairs = load_pairs()
    (DATA / "feed_leads.json").write_text(json.dumps(pairs, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")
    n = sum(len(v) for v in pairs.values())
    print(f"フィード {len(pairs)}、便や時刻が変わった組 {n} → data/feed_leads.json")


if __name__ == "__main__":
    main()
