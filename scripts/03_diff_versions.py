"""手順3：前後の版を日付ごとに比べ、「実際の変更日」を出す。

公開日時の順に並べた前後の版（旧→新）について:
  便の比較は ID を使わない。便の署名 = その便の (到着時刻, 出発時刻) を停車順に並べたもの。
  その日に走る便の署名の集まり（多重集合）が違えば「その日は食い違う」とする。

  除外日（比べる相手にしない日）:
    国の祝日（data/jp_holidays.csv）、12/29〜1/3、8/13〜8/16、
    旧版・新版どちらかで「calendar_dates に指定があり、その日の前後4週の同じ曜日で
    いちばん多い運行の組み合わせと違う日」。

  1. 両方の版が有効な日（API の from_date〜to_date の重なり）があるとき:
     除外日以外を1日ずつ比べ、食い違った日 d について、
     次の週以降の同じ曜日（除外日なら更に次の週、最大4週先）も食い違えば d を「実際の変更日」とする。
     次の週が一致すれば「一時的な相違」として記録し、先へ進む。
     次の週が比べられない（重なりの外）なら d を採り、「持続を確かめられない」の印を付ける。
  2. 重なる日が無いとき:
     新版の最初の除外日でない各曜日1日ずつを、旧版の最後の除外日でない同じ曜日（最大4週さかのぼる）と比べる。
     食い違えば、新版の次の週の同じ曜日も同じ旧版の日と比べて持続を確かめる。
  旧版の有効期間が切れたあとの日は比べない（期間切れを変更に数えない）。

  印:
    change_censored   … 変更日より前に「一致した日」が1日も無い（本当の変更日はもっと前かもしれない）
    late_publish      … 新版の公開日が有効開始日より LATE_DAYS 日を超えて遅い
                         （公開日時が最初の公開とは限らない。先行日数の集計から分ける）

  先行日数 = 実際の変更日 − 新版の公開日（日本時間）。

毎日更新のフィード（--weekly）:
  直近2年の版を ISO 週ごとに1つ（その週の最後の版）選んで前後を比べ、
  A（便や時刻の変更）が出た週だけ、その週の毎日の版を順に比べて、変更が初めて入った版を特定する。

使い方:
  python3 scripts/03_diff_versions.py --feeds-file data/trial5_feeds.txt --out data/diff_pairs_trial5.csv
  python3 scripts/03_diff_versions.py --weekly --feeds mie-kotsu/sancoise --out data/diff_pairs_daily.csv
"""
import argparse
import csv
import datetime as dt
import hashlib
import io
import zipfile
from collections import Counter, defaultdict

from common import CACHE, DATA, fetch

JST = dt.timezone(dt.timedelta(hours=9))
WD = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
PERIOD_ONLY = {"calendar.txt", "calendar_dates.txt", "feed_info.txt"}
LATE_DAYS = 30  # 公開日 − 有効開始日 がこれを超えたら late_publish
PERSIST_WEEKS = 4

HOLIDAYS = {dt.date.fromisoformat(r["date"]) for r in csv.DictReader(open(DATA / "jp_holidays.csv", encoding="utf-8"))}
HOLIDAY_LIST_END = max(HOLIDAYS)


def d8(s):
    s = (s or "").strip().replace("-", "")
    return dt.date(int(s[:4]), int(s[4:6]), int(s[6:8]))


def season_excluded(day):
    md = (day.month, day.day)
    return md >= (12, 29) or md <= (1, 3) or (8, 13) <= md <= (8, 16)


def read_csv(z, name):
    raw = z.read(name)
    for enc in ("utf-8-sig", "cp932"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    rows = list(csv.DictReader(io.StringIO(text)))
    return [{(k or "").strip(): (v or "").strip() for k, v in r.items()} for r in rows]


class Feed:
    def __init__(self, path):
        z = zipfile.ZipFile(path)  # 展開せずに読むだけ
        names = {n.split("/")[-1]: n for n in z.namelist() if not n.endswith("/")}
        rd = lambda n: read_csv(z, names[n]) if n in names else []  # noqa: E731
        self.hash = {n: hashlib.sha1(z.read(p)).hexdigest() for n, p in names.items()}
        self.feed_info = (rd("feed_info.txt") or [{}])[0]
        self.has_freq = bool(rd("frequencies.txt"))
        st = defaultdict(list)
        for r in rd("stop_times.txt"):
            try:
                seq = int(float(r.get("stop_sequence") or 0))
            except ValueError:
                seq = 0
            st[r["trip_id"]].append((seq, r.get("arrival_time", ""), r.get("departure_time", "")))
        sig = {t: tuple((a, d) for _, a, d in sorted(lst)) for t, lst in st.items()}
        self.by_service = defaultdict(Counter)
        trips = rd("trips.txt")
        self.n_trips = len(trips)
        for t in trips:
            s = sig.get(t["trip_id"])
            if s is not None:
                self.by_service[t["service_id"]][s] += 1
        self.base = []
        for c in rd("calendar.txt"):
            try:
                self.base.append((c["service_id"], d8(c["start_date"]), d8(c["end_date"]),
                                  [c.get(w) == "1" for w in WD]))
            except Exception:  # noqa: BLE001
                pass
        self.exc = defaultdict(dict)
        for r in rd("calendar_dates.txt"):
            try:
                self.exc[d8(r["date"])][r["service_id"]] = r.get("exception_type")
            except Exception:  # noqa: BLE001
                pass
        self._cache = {}

    def services_on(self, day):
        s = {sid for sid, a, b, w in self.base if a <= day <= b and w[day.weekday()]}
        for sid, et in self.exc.get(day, {}).items():
            if et == "1":
                s.add(sid)
            elif et == "2":
                s.discard(sid)
        return frozenset(s)

    def day_sig(self, day):
        key = self.services_on(day)
        if key not in self._cache:
            c = Counter()
            for sid in key:
                c.update(self.by_service.get(sid, {}))
            self._cache[key] = c
        return self._cache[key]


def daterange(a, b):
    while a <= b:
        yield a
        a += dt.timedelta(days=1)


def ndiff(a, b):
    return sum(((a - b) + (b - a)).values())


class Comparer:
    def __init__(self, old, new):
        self.old, self.new = old, new
        self._ex = {}

    def special(self, f, day, lo, hi):
        """calendar_dates に指定があり、かつ前後4週の同じ曜日でいちばん多い運行の組み合わせと違う日。
        （運行日を calendar_dates に全部書くフィードや、版の途中の改正後の日を特別な日としないため）"""
        if day not in f.exc or not (lo <= day <= hi):
            return False
        neigh = [day + dt.timedelta(days=7 * k) for k in range(-PERSIST_WEEKS, PERSIST_WEEKS + 1) if k]
        cnt = Counter(f.services_on(x) for x in neigh if lo <= x <= hi)
        if not cnt:
            return False
        top = max(cnt.values())
        return f.services_on(day) not in {k for k, v in cnt.items() if v == top}

    def excluded(self, day):
        key = day
        if key not in self._ex:
            self._ex[key] = (day in HOLIDAYS or season_excluded(day)
                             or self.special(self.old, day, *self.orange)
                             or self.special(self.new, day, *self.nrange))
        return self._ex[key]

    def next_same_weekday(self, d, limit):
        for k in range(1, PERSIST_WEEKS + 1):
            p = d + dt.timedelta(days=7 * k)
            if p > limit:
                return None
            if not self.excluded(p):
                return p
        return None

    def run(self, o_from, o_to, n_from, n_to):
        res = {"method": "", "actual_change_date": None, "compared_days": 0, "first_diff_trips": "",
               "change_censored": "", "last_equal_day": "", "persistence": "", "temp_diff_dates": "", "note": ""}
        temps = []
        self.orange, self.nrange = (o_from, o_to), (n_from, n_to)
        lo, hi = max(o_from, n_from), min(o_to, n_to)
        if lo <= hi:
            res["method"] = "overlap"
            seen_equal = False
            for d in daterange(lo, hi):
                if self.excluded(d):
                    continue
                res["compared_days"] += 1
                a, b = self.old.day_sig(d), self.new.day_sig(d)
                if a == b:
                    seen_equal = True
                    res["last_equal_day"] = d.isoformat()
                    continue
                p = self.next_same_weekday(d, hi)
                if p is not None and self.old.day_sig(p) == self.new.day_sig(p):
                    temps.append(d)
                    continue
                res.update(actual_change_date=d, first_diff_trips=ndiff(a, b),
                           change_censored=not seen_equal,
                           persistence="confirmed" if p else "unknown(次の週が重なりの外)")
                break
            if res["actual_change_date"] is None and n_to > o_to:
                res["note"] = f"重なりは一致。旧版の期限 {o_to} より先の {(n_to - o_to).days} 日は比べていない"
        else:
            res["method"] = "weekday"
            res["note"] = f"旧版の終わりと新版の始まりの間隔 {(n_from - o_to).days} 日"
            refs = {}
            for d in daterange(max(o_from, o_to - dt.timedelta(days=7 * PERSIST_WEEKS - 1)), o_to):
                if not self.excluded(d):
                    refs[d.weekday()] = d  # 後の日で上書き → 最後の除外日でない同じ曜日
            picks = {}
            for d in daterange(n_from, min(n_to, n_from + dt.timedelta(days=7 * PERSIST_WEEKS - 1))):
                if not self.excluded(d) and d.weekday() not in picks:
                    picks[d.weekday()] = d
            seen_equal = False
            for d in sorted(picks.values()):
                ref = refs.get(d.weekday())
                if ref is None:
                    continue
                res["compared_days"] += 1
                a, b = self.old.day_sig(ref), self.new.day_sig(d)
                if a == b:
                    seen_equal = True
                    continue
                p = self.next_same_weekday(d, n_to)
                if p is not None and self.new.day_sig(p) == a:
                    temps.append(d)
                    continue
                res.update(actual_change_date=d, first_diff_trips=ndiff(a, b),
                           change_censored=not seen_equal,
                           persistence="confirmed" if p else "unknown(次の週が新版の外)")
                res["note"] += f"。旧 {ref} と比べて相違"
                break
        res["temp_diff_dates"] = " ".join(t.isoformat() for t in temps)
        return res


def classify(old, new, change_day):
    changed = sorted(n for n in set(old.hash) | set(new.hash) if old.hash.get(n) != new.hash.get(n))
    if change_day is not None:
        return "A", changed
    if not changed:
        return "same", changed
    if set(changed) <= PERIOD_ONLY:
        return "B", changed
    return "C", changed


def jst_date(s):
    return dt.datetime.fromisoformat(s).astimezone(JST).date()


_loaded = {}


def load(v):
    uid = v["gtfs_file_uid"]
    if uid not in _loaded:
        if len(_loaded) > 40:
            _loaded.clear()
        _loaded[uid] = Feed(fetch(v["gtfs_url"], CACHE / "zips" / f"{uid}.zip"))
    return _loaded[uid]


def compare_pair(key, o, n, granularity="all"):
    pub = jst_date(n["published_at"])
    meta_lead = (dt.date.fromisoformat(n["from_date"]) - pub).days
    row = {
        "feed": key, "feed_name": n["feed_name"], "granularity": granularity,
        "old_uid": o["gtfs_file_uid"], "old_rid": o["rid"], "old_published": o["published_at"],
        "old_from": o["from_date"], "old_to": o["to_date"],
        "new_uid": n["gtfs_file_uid"], "new_rid": n["rid"], "new_published": n["published_at"],
        "new_from": n["from_date"], "new_to": n["to_date"],
        "declared": n.get("declared_kind", ""),
        "meta_lead_days": meta_lead,
        "late_publish": -meta_lead > LATE_DAYS,
    }
    try:
        fo, fn = load(o), load(n)
        r = Comparer(fo, fn).run(d8(o["from_date"]), d8(o["to_date"]), d8(n["from_date"]), d8(n["to_date"]))
        day = r.pop("actual_change_date")
        kind, changed = classify(fo, fn, day)
        fi_start = fn.feed_info.get("feed_start_date", "")
        row.update({
            "kind": kind,
            "actual_change_date": day.isoformat() if day else "",
            "lead_days": (day - pub).days if day else "",
            **r,
            "changed_files": " ".join(changed),
            "feed_info_start": fi_start,
            "feed_info_start_matches_api": (d8(fi_start) == d8(n["from_date"])) if fi_start else "",
            "has_frequencies": fo.has_freq or fn.has_freq,
            "old_trips": fo.n_trips, "new_trips": fn.n_trips,
            "beyond_holiday_list": d8(n["to_date"]) > HOLIDAY_LIST_END,
        })
    except Exception as e:  # noqa: BLE001
        row.update({"kind": "error", "note": repr(e)[:200]})
    return row


def show(row):
    flags = [k for k in ("change_censored", "late_publish") if row.get(k) is True]
    print(f"{row['feed']} {row['old_rid']}→{row['new_rid']} [{row['granularity']}] {row.get('kind')} "
          f"変更日 {row.get('actual_change_date', '')} 先行 {row.get('lead_days', '')} "
          f"(参考メタ {row['meta_lead_days']}) {' '.join(flags)} {row.get('persistence', '')} "
          f"一時的:{row.get('temp_diff_dates', '')} {row.get('note', '')}")


def run_all_pairs(key, vs, since):
    out = []
    for i in range(1, len(vs)):
        if jst_date(vs[i]["published_at"]) < since:
            continue
        row = compare_pair(key, vs[i - 1], vs[i])
        show(row)
        out.append(row)
    return out


def run_weekly(key, vs, since):
    """週に1版を比べ、A が出た週だけ毎日の版を比べて最初の変更版を特定する。"""
    out = []
    recent = [v for v in vs if jst_date(v["published_at"]) >= since]
    if not recent:
        return out
    # 比べる起点として、期間の直前の版も入れる
    start_idx = vs.index(recent[0])
    pool = vs[max(0, start_idx - 1):]
    weeks = {}
    for v in pool:
        weeks[jst_date(v["published_at"]).isocalendar()[:2]] = v  # 週の最後の版
    picks = sorted(weeks.values(), key=lambda v: v["published_at"])
    for i in range(1, len(picks)):
        o, n = picks[i - 1], picks[i]
        row = compare_pair(key, o, n, "weekly")
        show(row)
        out.append(row)
        if row.get("kind") != "A":
            continue
        a, b = pool.index(o), pool.index(n)
        for j in range(a + 1, b + 1):
            drow = compare_pair(key, pool[j - 1], pool[j], "daily")
            show(drow)
            out.append(drow)
            if drow.get("kind") == "A":
                drow["first_change_in_week"] = True
                break
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--feeds", nargs="*", default=[])
    ap.add_argument("--feeds-file")
    ap.add_argument("--weekly", action="store_true", help="毎日更新のフィード用（週に1版→変更週だけ毎日）")
    ap.add_argument("--since", default=None, help="新版の公開日がこの日以降のペアだけ（既定：2年前）")
    ap.add_argument("--out", default=str(DATA / "diff_pairs.csv"))
    args = ap.parse_args()
    feeds = list(args.feeds)
    if args.feeds_file:
        feeds += [l.strip() for l in open(args.feeds_file, encoding="utf-8") if l.strip() and not l.startswith("#")]
    since = dt.date.fromisoformat(args.since) if args.since else dt.date.today() - dt.timedelta(days=730)

    versions = defaultdict(list)
    for r in csv.DictReader(open(DATA / "versions.csv", encoding="utf-8")):
        versions[f"{r['organization_id']}/{r['feed_id']}"].append(r)

    out_rows = []
    for key in feeds:
        vs = sorted(versions.get(key, []), key=lambda r: r["published_at"])
        if len(vs) < 2:
            print(f"{key}: 版が {len(vs)} つなので比べられない")
            continue
        out_rows += (run_weekly if args.weekly else run_all_pairs)(key, vs, since)

    if out_rows:
        cols = list(dict.fromkeys(k for r in out_rows for k in r))
        with open(args.out, "w", newline="", encoding="utf-8") as fp:
            w = csv.DictWriter(fp, fieldnames=cols)
            w.writeheader()
            w.writerows(out_rows)
        print(f"→ {args.out}")


if __name__ == "__main__":
    main()
