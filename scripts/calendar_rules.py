"""日付の決まり（調査とアプリで共通に使う部品）

- 国の祝日（data/jp_holidays.csv。内閣府「国民の祝日」CSV。2027-11-23 まで）
- 年末年始（12/29〜1/3）とお盆（8/13〜8/16）
- 一日だけの特別な日：calendar_dates に指定があり、その日の前後4週の同じ曜日で
  いちばん多い運行の組み合わせと違う日（運行日を calendar_dates に全部書くフィードや、
  版の途中の改正後の日を、特別な日としないため）

ここにある決まりは、03_diff_versions.py（調査）と 06_build_revision.py（アプリのデータ）の両方が使う。
"""
import csv
import datetime as dt
from collections import Counter
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
NEIGHBOR_WEEKS = 4

HOLIDAYS = {dt.date.fromisoformat(r["date"]): r["name"]
            for r in csv.DictReader(open(DATA / "jp_holidays.csv", encoding="utf-8"))}
HOLIDAY_LIST_END = max(HOLIDAYS)


def is_year_end(day):
    md = (day.month, day.day)
    return md >= (12, 29) or md <= (1, 3)


def is_obon(day):
    return (8, 13) <= (day.month, day.day) <= (8, 16)


def season_excluded(day):
    return is_year_end(day) or is_obon(day)


def is_special(feed, day, lo, hi):
    """feed は services_on(day) と exc（calendar_dates の日付→指定）を持つもの。lo〜hi はその版の有効期間。"""
    if day not in feed.exc or not (lo <= day <= hi):
        return False
    neigh = [day + dt.timedelta(days=7 * k) for k in range(-NEIGHBOR_WEEKS, NEIGHBOR_WEEKS + 1) if k]
    cnt = Counter(feed.services_on(x) for x in neigh if lo <= x <= hi)
    if not cnt:
        return False
    top = max(cnt.values())
    return feed.services_on(day) not in {k for k, v in cnt.items() if v == top}


def day_marks(feed, day, lo, hi):
    """アプリに渡す日の印（比べる日から外す理由）。空なら印なし。"""
    marks = []
    if day in HOLIDAYS:
        marks.append({"kind": "holiday", "label": HOLIDAYS[day]})
    if is_year_end(day):
        marks.append({"kind": "year_end", "label": "年末年始"})
    if is_obon(day):
        marks.append({"kind": "obon", "label": "お盆"})
    if is_special(feed, day, lo, hi):
        marks.append({"kind": "special", "label": "特別なダイヤの日"})
    return marks
