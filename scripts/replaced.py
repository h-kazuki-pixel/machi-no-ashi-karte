"""同じ版の番号（uid）のまま、zip が置き換わったときの部品。

  - 見る仕組みは、1日1回（3:17 の実行）、使っている版の zip の印（ETag）を、zip を落とさずに確かめる（毎日更新の12フィードは除く）。
  - 印が変わっていたら zip を落とし、時刻表を作り直して、site にある前の時刻表と「便と時刻の指紋」を比べる。
  - 指紋が違えば、新しい中身を別の名前（{uid}.r{ETag の先頭8文字}）の時刻表として置き、前の時刻表と比べて改正のデータを作る。
    前の中身の zip はもう取れないので、改正のデータは、site に残っている前の時刻表（時刻表のデータ）から作る。
"""
import datetime as dt
import hashlib
import json
from importlib import import_module

from calendar_rules import day_marks

br = import_module("06_build_revision")
rv = import_module("revision2")
ttm = import_module("timetable")

FP_DAYS = 60
SEARCH_DAYS = 120
REPLACED_MEMO = "同じ版の番号のまま、zip が置き換わった"


def content_id(uid, etag):
    """置き換わった中身の時刻表の名前（版の番号＋ETag の先頭8文字）"""
    return f"{uid}.r{etag.strip('\"')[:8]}"


class TTFeed:
    """時刻表のデータを、calendar_rules（特別な日の印）が読める形にする（services_on と exc）"""

    def __init__(self, tt):
        self.tt = tt
        self.exc = {}
        for s in tt["services"]:
            for d in s["add"]:
                self.exc.setdefault(dt.date(int(d[:4]), int(d[4:6]), int(d[6:])), {})[s["id"]] = "1"
            for d in s["rm"]:
                self.exc.setdefault(dt.date(int(d[:4]), int(d[4:6]), int(d[6:])), {})[s["id"]] = "2"

    def services_on(self, day):
        return frozenset(self.tt["services"][i]["id"] for i in ttm.services_on_tt(self.tt, day))


def valid_on(tt, day):
    return tt["meta"]["from"] <= day.isoformat() <= tt["meta"]["to"]


def day_sig(tt, day):
    """その日に走るバスの「路線・行き先・停留所と時刻（と乗り降りの印）」の並び（停留所は ID で）。
    停留所が1つだけの便は除く（勝央町ふれあいバスの置き換えで消えた3便がこれ）"""
    if not valid_on(tt, day):
        return ()
    sv = ttm.services_on_tt(tt, day)
    ids = [s[0] for s in tt["stops"]]
    out = []
    for r, h, s, seq in tt["trips"]:
        if s in sv and len(seq) >= 2:  # 停留所が1つだけの便（乗って降りることができない）は数えない
            out.append((tt["routes"][r], h, tuple((ids[x[0]],) + tuple(x[1:]) for x in seq)))
    return tuple(sorted(out))


def fingerprint(tt, start, days=FP_DAYS):
    h = hashlib.sha1()
    for k in range(days):
        d = start + dt.timedelta(days=k)
        h.update(f"{d}:{hash_sig(day_sig(tt, d))};".encode())
    return h.hexdigest()


def hash_sig(sig):
    return hashlib.sha1(repr(sig).encode()).hexdigest()[:16]


def first_diff_day(old, new, start, days=SEARCH_DAYS):
    """start から days 日で、前と後の時刻表で走るバスが違う最初の日。
    1日だけの違いは除くため、次の同じ曜日も違う（または比べる範囲の外）ことを確かめる。無ければ None"""
    end = start + dt.timedelta(days=days - 1)
    diff = {}

    def differs(d):
        if d not in diff:
            diff[d] = day_sig(old, d) != day_sig(new, d)
        return diff[d]

    for k in range(days):
        d = start + dt.timedelta(days=k)
        nxt = d + dt.timedelta(days=7)
        if differs(d) and (nxt > end or differs(nxt)):
            return d
    return None


class TTVersion:
    """compare_stops が読める形（stops と kana）"""

    def __init__(self, uid, tt):
        self.uid = uid
        self.stops = {s[0]: {"stop_id": s[0], "stop_name": s[1], "stop_lat": s[3], "stop_lon": s[4]} for s in tt["stops"]}
        self.kana = {s[0]: s[2] for s in tt["stops"] if s[2]}


def build_revision_from_tts(feed_key, info, old_id, old_tt, new_id, new_tt, change, built_at, change_known=True):
    """前の時刻表と後の時刻表（同じ版の、置き換わる前と後の中身）から、改正のデータ（revision-2）を作る。
    info：feed_name, organization_name, feed_license, feed_license_url, published_at（前の版）, replaced_at（置き換わった日時）, etag"""
    days = {}
    for k in range(-rv.WINDOW_DAYS, rv.WINDOW_DAYS):
        day = change + dt.timedelta(days=k)
        side = "old" if k < 0 else "new"
        tt, u = (old_tt, old_id) if k < 0 else (new_tt, new_id)
        if not valid_on(tt, day):
            days[day.isoformat()] = {"u": None, "s": side, "marks": [dict(rv.OUTSIDE)]}
            continue
        lo, hi = dt.date.fromisoformat(tt["meta"]["from"]), dt.date.fromisoformat(tt["meta"]["to"])
        days[day.isoformat()] = {"u": u, "s": side, "marks": day_marks(TTFeed(tt), day, lo, hi)}
    _, _, report = br.compare_stops(TTVersion(old_id, old_tt), TTVersion(new_id, new_tt))
    org, fname = info["organization_name"], info["feed_name"]
    jst = dt.timezone(dt.timedelta(hours=9))
    rep_at = dt.datetime.fromisoformat(info["replaced_at"]).astimezone(jst)
    rev = {
        "format": "revision-2",
        "meta": {
            "feed": feed_key, "feed_name": fname, "operator": org,
            "license": info["feed_license"], "license_url": info["feed_license_url"],
            "attribution": f"出典：{org}{br.kq(fname)}GTFSデータ（{info['feed_license']}）、GTFSデータリポジトリ（https://gtfs-data.jp/）。まちの足カルテが加工して作成。",
            "old": {"uid": old_id, "published_at": info["published_at"], "from": old_tt["meta"]["from"], "to": old_tt["meta"]["to"]},
            # 「新しい時刻表が公開された日時」は、zip が置き換わった日時（サーバーの Last-Modified）
            "new": {"uid": new_id, "published_at": rep_at.isoformat(), "from": new_tt["meta"]["from"], "to": new_tt["meta"]["to"],
                    "memo": REPLACED_MEMO},
            "replaced": {"uid": old_id, "etag": info["etag"], "last_modified": rep_at.isoformat()},
            "change_date": change.isoformat(),
            # 変わる日が分からない（見つけた日にはもう違っていた）ときは False。変わる日は、見つけた日にしてある
            "change_date_known": change_known,
            "lead_days": (change - rep_at.date()).days,
            "window": {"from": (change - dt.timedelta(days=rv.WINDOW_DAYS)).isoformat(),
                       "to": (change + dt.timedelta(days=rv.WINDOW_DAYS - 1)).isoformat()},
            "built_at": built_at,
            "timetables": {old_id: rv.timetable_path(feed_key, old_id), new_id: rv.timetable_path(feed_key, new_id)},
            "route_last_run": {},
        },
        "days": days,
        "stop_report": report,
    }
    return rev
