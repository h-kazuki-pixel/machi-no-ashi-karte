"""改正のデータ（format: "revision-2"）を作る部品。

改正のデータ = 前の版の時刻表 ＋ 後の版の時刻表 ＋ 変更日・日ごとの情報
  meta.timetables  { uid: "data/timetables/{org}__{feed}/{uid}.json", ... }  使う版の時刻表（別のファイル）
  days             { 日付: { "u": その日に使う版の uid（無ければ null）, "s": "old" | "new", "marks": [...] } }
  stop_report      ひとつ前の版と新しい版の停留所の対応（名前の変化・場所の移動など）

前の版をつなげる:
  変更日の前の日は、「新しい版より前に公開された版のうち、有効期間にその日が入り、いちばん新しく公開された版」
  （GTFSデータリポジトリの「現行」と同じ選び方）を使う。そういう版が無い日は u=null と「比べない日」の印。
  変更日からの日は、新しい版を使う（有効期間の外の日は u=null と印）。
日の印（祝日・年末年始・お盆・一日だけの特別な日）は、その日に使う版について calendar_rules で付ける。
"""
import datetime as dt
from importlib import import_module

from calendar_rules import day_marks

br = import_module("06_build_revision")
dv = import_module("03_diff_versions")
ttm = import_module("timetable")

WINDOW_DAYS = 70
OUTSIDE = {"kind": "outside", "label": "この日に有効な時刻表のデータが無い"}


def timetable_path(feed_key, uid):
    org, fid = feed_key.split("/")
    return f"data/timetables/{org}__{fid}/{uid}.json"


def revision_path(feed_key, change, uid):
    org, fid = feed_key.split("/")
    return f"data/revisions/{org}__{fid}/{change.isoformat()}__{uid[:8]}.json"


def _d(s):
    return dt.date.fromisoformat(s)


def build_revision2(feed_key, new, candidates, change, zip_of, built_at):
    """new: 新しい版のメタデータ。candidates: 同じフィードのほかの版のメタデータ（published_at, from_date, to_date,
    gtfs_file_uid）。zip_of(meta) → zip のパス。戻り値は (改正のデータ, {uid: 時刻表のデータ})"""
    for m in [new]:
        if m["feed_license"] not in br.ALLOWED_LICENSES:
            raise ValueError(f"ライセンス {m['feed_license']} は加工データの公開を確かめていない")
    olds = [c for c in candidates if c["gtfs_file_uid"] != new["gtfs_file_uid"] and c["published_at"] < new["published_at"]]
    if not olds:
        raise ValueError("前の版が無い")
    prev = max(olds, key=lambda c: c["published_at"])
    feeds, used = {}, {}

    def feed_of(m):
        u = m["gtfs_file_uid"]
        if u not in feeds:
            feeds[u] = dv.Feed(zip_of(m))
        return feeds[u]

    days = {}
    for k in range(-WINDOW_DAYS, WINDOW_DAYS):
        day = change + dt.timedelta(days=k)
        if k < 0:
            valid = [c for c in olds if _d(c["from_date"]) <= day <= _d(c["to_date"])]
            v = max(valid, key=lambda c: c["published_at"]) if valid else None
        else:
            v = new if _d(new["from_date"]) <= day <= _d(new["to_date"]) else None
        side = "old" if k < 0 else "new"
        if v is None:
            days[day.isoformat()] = {"u": None, "s": side, "marks": [dict(OUTSIDE)]}
            continue
        used[v["gtfs_file_uid"]] = v
        marks = day_marks(feed_of(v), day, _d(v["from_date"]), _d(v["to_date"]))
        days[day.isoformat()] = {"u": v["gtfs_file_uid"], "s": side, "marks": marks}
    used[new["gtfs_file_uid"]] = new
    used[prev["gtfs_file_uid"]] = prev

    meta_common = {k: new[k] for k in ("feed_name", "organization_name", "feed_license", "feed_license_url")}
    timetables = {}
    for u, m in used.items():
        timetables[u] = ttm.build_timetable(zip_of(m), {**m, **meta_common, "feed": feed_key}, built_at=built_at)
    _, _, report = br.compare_stops(br.Version(prev["gtfs_file_uid"], zip_of(prev)),
                                    br.Version(new["gtfs_file_uid"], zip_of(new)))

    def pub(m):
        return dt.datetime.fromisoformat(m["published_at"]).astimezone(dt.timezone(dt.timedelta(hours=9)))

    org, fname = new["organization_name"], new["feed_name"]
    rev = {
        "format": "revision-2",
        "meta": {
            "feed": feed_key, "feed_name": fname, "operator": org,
            "license": new["feed_license"], "license_url": new["feed_license_url"],
            "attribution": f"出典：{org}{br.kq(fname)}GTFSデータ（{new['feed_license']}）、GTFSデータリポジトリ（https://gtfs-data.jp/）。まちの足カルテが加工して作成。",
            "old": {"uid": prev["gtfs_file_uid"], "published_at": pub(prev).isoformat(), "from": prev["from_date"], "to": prev["to_date"]},
            "new": {"uid": new["gtfs_file_uid"], "published_at": pub(new).isoformat(), "from": new["from_date"],
                    "to": new["to_date"], "memo": new.get("memo", "")},
            "change_date": change.isoformat(),
            "lead_days": (change - pub(new).date()).days,
            "window": {"from": (change - dt.timedelta(days=WINDOW_DAYS)).isoformat(),
                       "to": (change + dt.timedelta(days=WINDOW_DAYS - 1)).isoformat()},
            "built_at": built_at,
            "timetables": {u: timetable_path(feed_key, u) for u in timetables},
        },
        "days": days,
        "stop_report": report,
    }
    return rev, timetables
