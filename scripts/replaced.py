"""同じ版の番号（uid）のまま、zip が置き換わったときの部品。

  - 見る仕組みは、1日1回（日本時間 3時を過ぎて最初の実行）、使っている版の zip の印（ETag）を、zip を落とさずに確かめる（毎日更新の12フィードは除く）。
  - 印が変わっていたら zip を落とし、時刻表を作り直して、site にある前の時刻表と「便と時刻の指紋」を比べる。
  - 指紋が違えば、新しい中身を別の名前（{uid}.r{ETag の先頭8文字}）の時刻表として置き、前の時刻表と比べて改正のデータを作る。
    前の中身の zip はもう取れないので、改正のデータは、site に残っている前の時刻表（時刻表のデータ）から作る。
  - C′：のりばだけの変更（停留所を名前でまとめると、便と時刻が同じ。移った先が前ののりばから50m未満）は、
    時刻表は差し替えるが、改正も知らせも作らない。50m以上離れたのりばに移る便があれば、改正として扱う。
  - A：まだ有効期間に入っていない版の置き換えは、別の改正にしない。その版を「後」にする公開中の改正を、
    新しい中身で作り直して上書きする（swap_new_content）。
  - B：もう走っている版の置き換えでは、前の中身が有効でない日に、そのとき実際に動いていた版をつなげる（old_chain）。
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
PLATFORM_M = 50  # これ以上離れたのりばに移る便があれば、のりばだけの変更とはみなさない（app の movedMeters と同じ）
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


def first_diff_day(old, new, start, days=SEARCH_DAYS, sig=None):
    """start から days 日で、前と後の時刻表で走るバスが違う最初の日。
    1日だけの違いは除くため、次の同じ曜日も違う（または比べる範囲の外）ことを確かめる。無ければ None"""
    end = start + dt.timedelta(days=days - 1)
    diff = {}

    def differs(d):
        if d not in diff:
            f = sig or day_sig
            diff[d] = f(old, d) != f(new, d)
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


def build_revision_from_tts(feed_key, info, old_id, old_tt, new_id, new_tt, change, built_at, change_known=True, chain=None):
    """前の時刻表と後の時刻表（同じ版の、置き換わる前と後の中身）から、改正のデータ（revision-2）を作る。
    info：feed_name, organization_name, feed_license, feed_license_url, published_at（前の版）, replaced_at（置き換わった日時）, etag
    chain（B）：day → (uid, tt)。前の側で前の中身が有効でない日に、そのとき動いていた版を使う"""
    days = {}
    extra = {}
    for k in range(-rv.WINDOW_DAYS, rv.WINDOW_DAYS):
        day = change + dt.timedelta(days=k)
        side = "old" if k < 0 else "new"
        tt, u = (old_tt, old_id) if k < 0 else (new_tt, new_id)
        if k < 0 and not valid_on(tt, day) and chain:
            got = chain(day)
            if got:
                u, tt = got
                extra[u] = tt
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
            "timetables": {old_id: rv.timetable_path(feed_key, old_id), new_id: rv.timetable_path(feed_key, new_id),
                           **{u: rv.timetable_path(feed_key, u) for u in extra}},
            "route_last_run": {},
        },
        "days": days,
        "stop_report": report,
    }
    return rev


# ---------- C′：のりばだけの変更 ----------

def _named(tt):
    """停留所 ID → 名前"""
    return {s[0]: s[1] for s in tt["stops"]}


def day_sig_named(tt, day):
    """day_sig の停留所 ID を、停留所の名前に置き換えたもの（のりばの違いを見ない）"""
    names = _named(tt)
    return tuple(sorted((r, h, tuple((names.get(x[0], x[0]),) + tuple(x[1:]) for x in seq)) for r, h, seq in day_sig(tt, day)))


def platform_changes(old, new, start, days=SEARCH_DAYS):
    """start から days 日で、停留所を名前でまとめると前と後の便と時刻が同じなら、のりばの移り変わりの一覧を返す。
    違う日があれば None（のりばだけの変更ではない）。
    戻り値：[{"name", "from", "to", "m", "trip_days"}]（m は前ののりばから移った先までの距離。trip_days は、日ごとに数えた延べの便の数）"""
    pos = {s[0]: (s[3], s[4]) for s in old["stops"]}
    pos.update({s[0]: (s[3], s[4]) for s in new["stops"] if s[0] not in pos})
    onames, nnames = _named(old), _named(new)
    moves = {}
    for k in range(days):
        d = start + dt.timedelta(days=k)
        a, b = day_sig(old, d), day_sig(new, d)
        if a == b:
            continue
        if day_sig_named(old, d) != day_sig_named(new, d):
            return None
        # 名前でそろえて並べ、同じ位置の停留所 ID を比べる
        key_o = sorted(a, key=lambda t: (t[0], t[1], tuple((onames.get(x[0], x[0]),) + tuple(x[1:]) for x in t[2])))
        key_n = sorted(b, key=lambda t: (t[0], t[1], tuple((nnames.get(x[0], x[0]),) + tuple(x[1:]) for x in t[2])))
        for to, tn in zip(key_o, key_n):
            for xo, xn in zip(to[2], tn[2]):
                if xo[0] != xn[0]:
                    m = round(br.dist(pos[xo[0]], pos[xn[0]])) if xo[0] in pos and xn[0] in pos else None
                    rec = moves.setdefault((xo[0], xn[0]), {"name": nnames.get(xn[0], xn[0]), "from": xo[0], "to": xn[0],
                                                            "m": m, "trip_days": 0})
                    rec["trip_days"] += 1
    return sorted(moves.values(), key=lambda x: (x["name"], x["from"], x["to"]))


def far_moves(moves):
    """50m以上離れたのりばへの移り（距離が分からないものも、離れているとみなす）"""
    return [x for x in moves if x["m"] is None or x["m"] >= PLATFORM_M]


# ---------- B：前の中身が有効でない日に、そのとき動いていた版をつなげる ----------

def old_chain(others, published_at):
    """others：同じフィードのほかの版の時刻表（いま使う中身）。published_at より前に公開されたものだけを使う。
    戻り値は day → (uid, tt) を返す関数（その日に有効で、いちばん新しく公開された版。無ければ None）"""
    cands = [(u, t) for u, t in others if t["meta"]["published_at"] < published_at]

    def pick(day):
        valid = [(u, t) for u, t in cands if valid_on(t, day)]
        return max(valid, key=lambda ut: ut[1]["meta"]["published_at"]) if valid else None
    return pick


# ---------- A：公開中の改正の「後」の中身を、置き換わったあとの中身にする ----------

def swap_new_content(rev, uid, new_id, new_tt, old_tt_of_prev, feed_key, built_at, replaced):
    """rev（公開中の改正のデータ）の、変わる日からの日で使う版 uid を、置き換わったあとの中身 new_id にする。
    変わる日・前の側の日・路線の記録はそのまま。停留所の報告は、前の版と新しい中身で作り直す。"""
    out = json.loads(json.dumps(rev))
    lo, hi = dt.date.fromisoformat(new_tt["meta"]["from"]), dt.date.fromisoformat(new_tt["meta"]["to"])
    for day, d in out["days"].items():
        if d["u"] == uid:
            dd = dt.date.fromisoformat(day)
            if valid_on(new_tt, dd):
                d["u"] = new_id
                d["marks"] = day_marks(TTFeed(new_tt), dd, lo, hi)
            else:
                d["u"], d["marks"] = None, [dict(rv.OUTSIDE)]
    m = out["meta"]
    used = {d["u"] for d in out["days"].values() if d["u"]} | {m["old"]["uid"], new_id}
    tts = {u: p for u, p in m["timetables"].items() if u in used}
    tts[new_id] = rv.timetable_path(feed_key, new_id)
    m["timetables"] = tts
    if m["new"]["uid"] == uid:
        m["new"]["uid"] = new_id
    m["replaced"] = replaced
    m["rebuilt_at"] = built_at
    _, _, report = br.compare_stops(TTVersion(m["old"]["uid"], old_tt_of_prev), TTVersion(new_id, new_tt))
    out["stop_report"] = report
    return out


def times_differ(old, new, start, days=SEARCH_DAYS):
    """のりばを見ないで（停留所を名前でまとめて）、便や時刻が違う日があるか"""
    return any(day_sig_named(old, start + dt.timedelta(days=k)) != day_sig_named(new, start + dt.timedelta(days=k))
               for k in range(days))
