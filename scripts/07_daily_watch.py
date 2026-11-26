"""全国のフィードを定期的に見る（GitHub Actions で6時間ごと。手元でも同じように動く）。

  python3 scripts/07_daily_watch.py --site site                 # ふだん（変わったフィードだけ見る）
  python3 scripts/07_daily_watch.py --site site --full          # 週1回の点検（全フィードの版を取り直す）
  python3 scripts/07_daily_watch.py --site site --bootstrap     # 最初の1回：調査（2026-11-23）の版の一覧から始める

site/ は GitHub Pages の中身そのもの（Actions では main と別のブランチ）:
  index.html, js/, css/                アプリ（main の app/ から写す）
  data/status.json                     最後に確かめた日時など（アプリの画面に出す）
  data/found.csv                       いつ・どのフィードの・どの改正を・改正の何日前に見つけたか（ためていく）
  data/revisions/index.json            改正のデータの目次
  data/revisions/{org}__{feed}/...json 改正のデータ（加工・再配布が認められたライセンスのフィードだけ）
  data/attributions.json, ATTRIBUTION.md  出典の一覧（自動で作る）
  state/feeds.json                     前回見たフィードの一覧（事業者のメールアドレスは入れない）
  state/versions_seen.csv              見た版の一覧（初めて見た日時）
  state/fingerprints.json              毎日更新のフィードの「便と時刻の指紋」（zip は残さない）
  state/runs.csv                       実行の記録
  state/notify_queue.json              通知を送る改正の待ち行列（10_notify.py が送ったら消す）

決まり:
  - 1.2秒以上あけて順番に取る。User-Agent の連絡先は環境変数 GTFS_CONTACT（ログに出さない）。
  - zip は作業用の一時フォルダにだけ置き、終わったら消す。
  - found.csv の種類（category）:
      これからの改正 … 変更日が見つけた日より後
      当日          … 変更日が見つけた日
      過ぎた改正    … 変更日が見つけた日より前
      登録し直し    … 新しい版の有効期間が、見つけた日にはもう終わっている（過去のデータの登録し直し）
    「登録し直し」と、変更日が30日より前の「過ぎた改正」は、found.csv に残すが改正のデータは作らない。
  - 毎日更新のフィードは、新しい版の指紋（この先60日の、日ごとの便と時刻）を前の版の指紋と比べ、
    変わったときだけ前の版を API から取り直して、調査と同じ方法で比べる。
"""
import argparse
import csv
import datetime as dt
import hashlib
import json
import shutil
import sys
import tempfile
from collections import Counter
from importlib import import_module
from pathlib import Path

from common import API, DATA, REQUESTS, ROOT, fetch, fetch_json, probe_fresh

dv = import_module("03_diff_versions")
br = import_module("06_build_revision")
rv = import_module("revision2")
ttm = import_module("timetable")
rp = import_module("replaced")
TIMETABLE_REFRESH_DAYS = 7

JST = dt.timezone(dt.timedelta(hours=9))
MAX_PREV = 5
FP_DAYS = 60
BOOTSTRAP_CHECKED_AT = "2026-11-23T12:00:00+09:00"  # 調査で全部の版を取った日時

SEEN_COLS = ["feed", "gtfs_file_uid", "first_seen_at", "source", "published_at", "from_date", "to_date",
             "rid_at_first_seen", "declared_kind", "license", "kind", "actual_change_date", "lead_days_seen",
             "revision", "gone_at"]
FOUND_BASIS_WATCH = "見る仕組みが見つけた日時"
FOUND_BASIS_API = "API の公開日時（見る仕組みを始める前に出ていた版。初めて見た日時は分からない）"
FOUND_BASIS_REPLACED = "同じ版の番号のまま、zip が置き換わった（zip の印 ETag が変わったのを見つけた日時）"
PAST_LIMIT_DAYS = 30  # 変更日がこれより前の改正は、改正のデータを作らない
FOUND_COLS = ["found_at", "found_at_basis", "category", "feed", "feed_name", "operator", "new_uid", "published_at", "from_date",
              "to_date", "change_date", "lead_days_seen", "lead_days_published", "change_censored", "late_publish",
              "license", "revision"]
HELD_COLS = ["held_at", "feed", "feed_name", "operator", "change_date", "old_uid", "new_uid", "reason", "shares",
             "approved_at", "published_path", "resolved", "memo"]  # memo：その版のメモ（GTFSデータリポジトリ。承認して作り直すときに使う）  # resolved：承認ではなく、直しで扱った（その中身）
APPROVALS_PATH = ROOT / "approvals" / "approved.txt"


def read_approvals():
    """承認の一覧（main の approvals/approved.txt）。1行に改正の番号（新しい版の uid の先頭8文字以上）。# から後はメモ"""
    if not APPROVALS_PATH.exists():
        return []
    out = []
    for line in APPROVALS_PATH.read_text(encoding="utf-8").splitlines():
        t = line.split("#", 1)[0].strip()
        if len(t) >= 8:
            out.append(t)
    return out
RULES_PATH = ROOT / "scripts" / "publish_rules.json"


def run_check(site, rel):
    """公開の前の点検（app/tools/check_revision.mjs）。停留所の組を無作為に選んで判定し、段階ごとの割合を返す"""
    import subprocess
    rules = json.loads(RULES_PATH.read_text(encoding="utf-8")) if RULES_PATH.exists() else {}
    r = subprocess.run(["node", str(ROOT / "app" / "tools" / "check_revision.mjs"), str(site), rel,
                        str(rules.get("sample_pairs", 200))], capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        return {"error": r.stderr[-300:]}
    return json.loads(r.stdout.strip().splitlines()[-1])


def hold_reason(check):
    """しきい値（scripts/publish_rules.json の max_share）を超える段階があれば、その理由"""
    if "error" in check:
        return f"点検が動かなかった: {check['error'][:100]}"
    rules = json.loads(RULES_PATH.read_text(encoding="utf-8")) if RULES_PATH.exists() else {}
    over = [f"{k} {check['shares'].get(k, 0):.0%}（上限 {v:.0%}）" for k, v in rules.get("max_share", {}).items()
            if check["shares"].get(k, 0) > v]
    for rule in rules.get("max_share_sum", []):
        tot = sum(check["shares"].get(k, 0) for k in rule["levels"])
        if tot > rule["max"]:
            over.append(f"{'＋'.join(rule['levels'])} {tot:.0%}（上限 {rule['max']:.0%}）")
    if check.get("n", 0) == 0:
        over.append("点検で組を1つも選べなかった")
    return "、".join(over)


RUN_COLS = ["started_at", "finished_at", "mode", "feeds_checked", "requests", "new_versions", "found", "errors"]


def now_jst():
    return dt.datetime.now(JST).replace(microsecond=0)


def jst_date(s):
    return dt.datetime.fromisoformat(s).astimezone(JST).date()


def read_csv(p):
    return list(csv.DictReader(open(p, encoding="utf-8"))) if p.exists() else []


def write_csv(p, cols, rows):
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", newline="", encoding="utf-8") as fp:
        w = csv.DictWriter(fp, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def append_csv(p, cols, rows):
    """行を足す。前の版の列のファイルなら、新しい列の見出しに直してから足す"""
    if p.exists():
        with open(p, encoding="utf-8") as fp:
            header = next(csv.reader(fp), [])
        if header != cols:
            old = read_csv(p)
            for r in old:
                if "found_at_basis" in cols and not r.get("found_at_basis"):
                    r["found_at_basis"] = FOUND_BASIS_WATCH
            write_csv(p, cols, old)
    new = not p.exists()
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a", newline="", encoding="utf-8") as fp:
        w = csv.DictWriter(fp, fieldnames=cols, extrasaction="ignore")
        if new:
            w.writeheader()
        w.writerows(rows)


def read_json(p, default):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


NOTIFY_RECENT_DAYS = 30  # アプリが改正の知らせを出し続ける日数と同じ


def write_json(p, obj):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")


def clean_feed(f):
    """フィードの一覧から、記録に要るものだけ（事業者のメールアドレスは入れない）"""
    keys = ["organization_id", "organization_name", "feed_id", "feed_name", "feed_pref_id", "feed_license",
            "feed_license_url", "last_updated_at", "last_published_at", "latest_feed_start_date",
            "latest_feed_end_date", "feed_is_discontinued"]
    return {k: f.get(k) for k in keys}


def daily_feed_keys():
    p = DATA / "daily_feeds.txt"
    return {l.strip() for l in open(p, encoding="utf-8") if l.strip()} if p.exists() else set()


def found_category(change, found_date, to_date):
    if to_date < found_date:
        return "登録し直し"
    if change > found_date:
        return "これからの改正"
    if change == found_date:
        return "当日"
    return "過ぎた改正"


def skip_reason(category, change, found_date):
    if category == "登録し直し":
        return "作らない（登録し直し）"
    if category == "過ぎた改正" and (found_date - change).days > PAST_LIMIT_DAYS:
        return f"作らない（{PAST_LIMIT_DAYS}日より前の改正）"
    return ""


# ---------- 指紋 ----------

def fingerprint(feed, start, from_date, to_date, days=FP_DAYS):
    """start から days 日の、日ごとの「その日に走るバスの時刻の並び」の指紋"""
    out = {}
    for k in range(days):
        d = start + dt.timedelta(days=k)
        if not (from_date <= d <= to_date):
            continue
        sig = feed.day_sig(d)
        h = hashlib.sha1(repr(sorted(sig.items())).encode()).hexdigest()[:12]
        out[d.isoformat()] = h
    return out


def same_fingerprint(a, b):
    common = set(a) & set(b)
    if not common:
        return None  # 比べられる日が無い
    return all(a[d] == b[d] for d in common)


# ---------- 本体 ----------

class Watch:
    def __init__(self, site: Path, full: bool):
        self.site = site
        self.full = full
        self.tmp = Path(tempfile.mkdtemp(prefix="machi-watch-"))
        self.started = now_jst()
        self.errors = []
        self.state = site / "state"
        self.data = site / "data"
        self.seen = read_csv(self.state / "versions_seen.csv")
        self.seen_by_uid = {r["gtfs_file_uid"]: r for r in self.seen}
        self.fps = read_json(self.state / "fingerprints.json", {})
        self.prev_feeds = read_json(self.state / "feeds.json", {})
        self.status = read_json(self.data / "status.json", {})
        self.index = read_json(self.data / "revisions" / "index.json", [])
        self.daily = daily_feed_keys()
        self.new_rows, self.found_rows = [], []
        self.held = read_csv(self.data / "held.csv")
        # 通知を送る改正の待ち行列（scripts/10_notify.py が、Pages に出したあとで送る）
        self.notify_queue = read_json(self.state / "notify_queue.json", [])
        # 同じ版の番号のまま zip が置き換わった版：版の番号 → いま使う時刻表の名前（{uid}.r{ETag}）
        self.alias = read_json(self.state / "timetable_alias.json", {})
        self.force_etag = False
        self.queue_notices = True  # 作り直し（08 の --rebuild など）では False にする
        self.held_examples = read_json(self.data / "held_examples.json", {})
        self._feeds = {}

    # zip は一時フォルダにだけ置く
    def loader(self, v):
        uid = v["gtfs_file_uid"]
        if uid not in self._feeds:
            p = fetch(v["gtfs_url"], self.tmp / "zips" / f"{uid}.zip")
            self._feeds[uid] = dv.Feed(p)
        return self._feeds[uid]

    def zip_path(self, uid):
        return self.tmp / "zips" / f"{uid}.zip"

    def run(self):
        try:
            feeds = fetch_json(f"{API}/feeds", self.tmp / "feeds.json")["body"]
        except Exception as e:  # noqa: BLE001
            self.errors.append(f"フィードの一覧が取れない: {e!r}"[:200])
            return self.finish(feeds_checked=0)
        last_checked = self.status.get("last_checked_at", BOOTSTRAP_CHECKED_AT)
        last_date = jst_date(last_checked).isoformat()
        new_snapshot = dict(self.prev_feeds)
        checked = 0
        for f in feeds:
            key = f"{f['organization_id']}/{f['feed_id']}"
            prev = self.prev_feeds.get(key)
            look = self.full or prev is None or key in self.daily or (
                f.get("last_published_at") != prev.get("last_published_at")
                or f.get("last_updated_at") != prev.get("last_updated_at")
                or (f.get("last_published_at") or "") >= last_date)
            if not look:
                continue
            checked += 1
            try:
                self.check_feed(key, f)
                new_snapshot[key] = clean_feed(f)
            except Exception as e:  # noqa: BLE001
                self.errors.append(f"{key}: {e!r}"[:200])  # 次の回に取り直す（一覧を書き換えない）
        self.prev_feeds = new_snapshot
        self.process_approvals()
        if self.etag_due():
            try:
                self.check_replaced()
            except Exception as e:  # noqa: BLE001
                self.errors.append(f"zip の置き換えの確かめ: {e!r}"[:200])
        return self.finish(feeds_checked=checked)

    # ---------- 同じ版の番号のまま zip が置き換わった（1日1回、日本時間 3時を過ぎて最初の実行で） ----------

    def etag_due(self):
        """日本時間 3時を過ぎた実行で、その日まだ確かめていなければ確かめる。
        定時の実行が遅れたり抜けたりしても、その日のうちに1回は確かめる（0時〜3時の実行では確かめない）"""
        if self.force_etag:
            return True
        now = self.started.astimezone(JST)
        last = self.status.get("last_etag_check_at")
        return now.hour >= 3 and (not last or jst_date(last) < now.date())

    def check_replaced(self, only=None):
        """使っている版（site にある時刻表）の zip の印（ETag）を、zip を落とさずに確かめる。毎日更新のフィードは除く。
        前の印が無い版（始めたばかり）は、zip の Last-Modified が時刻表を作った日時より後なら、置き換わったとみなす。"""
        etags = read_json(self.state / "zip_etags.json", {})
        alias = self.alias
        n = changed = 0
        for p in sorted((self.site / "data" / "timetables").glob("*/*.json")):
            uid = p.stem
            if ".r" in uid:
                continue
            key = p.parent.name.replace("__", "/", 1)
            if key in self.daily or (only and key not in only):
                continue
            r = self.seen_by_uid.get(uid)
            if r is None:
                continue
            org, fid = key.split("/")
            url = f"{API}/organizations/{org}/feeds/{fid}/files/feed.zip?uid={uid}"
            try:
                pr = probe_fresh(url)
            except Exception as e:  # noqa: BLE001
                self.errors.append(f"{key} {uid[:8]} の印: {e!r}"[:200])
                continue
            n += 1
            prev = etags.get(uid)
            cur_path = self.site / rv.timetable_path(key, alias.get(uid, uid))
            if prev is not None:
                is_new = prev["etag"] != pr["etag"]
            else:
                built = json.loads(cur_path.read_text(encoding="utf-8"))["meta"]["built_at"]
                is_new = bool(pr["last_modified"]) and pr["last_modified"] > dt.datetime.fromisoformat(built)
            if is_new:
                changed += 1
                try:
                    self.handle_replaced(key, uid, r, pr, cur_path)
                except Exception as e:  # noqa: BLE001
                    self.errors.append(f"{key} {uid[:8]} の置き換え: {e!r}"[:200])
                    continue  # 印は書き換えない（次の日に、もう一度確かめる）
            etags[uid] = {"etag": pr["etag"], "checked_at": self.started.isoformat()}
        write_json(self.state / "zip_etags.json", etags)
        self.status["last_etag_check_at"] = self.started.isoformat()
        self.status["last_etag_check"] = {"versions": n, "changed": changed}
        print(f"  zip の印を確かめた版 {n}、変わっていた版 {changed}")

    def handle_replaced(self, key, uid, r, pr, cur_path):
        """zip を落として時刻表を作り直し、前の時刻表と便と時刻の指紋を比べる。違えば改正のデータを作る"""
        org, fid = key.split("/")
        f = self.prev_feeds.get(key, {})
        old_tt = json.loads(cur_path.read_text(encoding="utf-8"))
        om = old_tt["meta"]
        z = fetch(f"{API}/organizations/{org}/feeds/{fid}/files/feed.zip?uid={uid}", self.tmp / "replaced" / f"{uid}.zip")
        try:
            meta = {"feed": key, "gtfs_file_uid": uid, "published_at": om["published_at"], "from_date": om["from"], "to_date": om["to"],
                    "feed_name": om["feed_name"], "organization_name": om["operator"], "feed_license": om["license"],
                    "feed_license_url": om["license_url"]}
            new_tt = ttm.build_timetable(z, meta, built_at=self.started.isoformat())
        finally:
            z.unlink(missing_ok=True)  # zip は残さない
        today = self.started.astimezone(JST).date()
        if rp.fingerprint(old_tt, today) == rp.fingerprint(new_tt, today):
            print(f"  {key} {uid[:8]}: zip は置き換わったが、便と時刻は同じ")
            return
        new_id = rp.content_id(uid, pr["etag"])
        cur_id = self.alias.get(uid, uid)  # これまで使っていた中身（公開中の改正のデータが指している）
        new_tt["meta"]["content"] = {"of": uid, "etag": pr["etag"], "last_modified": pr["last_modified"].isoformat()}
        self.write_timetable(key, new_id, new_tt)
        self.alias[uid] = new_id  # これから、この版の時刻表は新しい中身を使う
        rep_at = pr["last_modified"].astimezone(JST)
        row = {"found_at": self.started.isoformat(), "found_at_basis": FOUND_BASIS_REPLACED, "feed": key,
               "feed_name": om["feed_name"], "operator": om["operator"], "new_uid": new_id, "published_at": rep_at.isoformat(),
               "from_date": om["from"], "to_date": om["to"], "license": om["license"], "late_publish": ""}
        # C′：停留所を名前でまとめると便と時刻が同じで、移った先が50m未満なら「のりばだけの変更」
        moves = rp.platform_changes(old_tt, new_tt, today)
        platform_only = moves is not None and not rp.far_moves(moves)
        replaced = {"uid": uid, "etag": pr["etag"], "last_modified": rep_at.isoformat()}
        # A：まだ有効期間に入っていない版は、別の改正にしない。その版を「後」にする公開中の改正を作り直す
        if om["from"] > today.isoformat():
            pubs = [x for x in self.index if x["feed"] == key and x["new_uid"].split(".r")[0] == uid]
            if pubs:
                for x in pubs:
                    res = self.rebuild_with_content(key, x, cur_id, old_tt, new_id, new_tt, today, platform_only, moves, replaced)
                    change = dt.date.fromisoformat(x["change_date"])
                    self.found_rows.append({**row, "category": found_category(change, today, dt.date.fromisoformat(om["to"])),
                                            "change_date": x["change_date"], "lead_days_seen": (change - today).days,
                                            "lead_days_published": (change - rep_at.date()).days, "change_censored": "",
                                            "revision": res})
                    print(f"  {key} {uid[:8]}: zip が置き換わった（まだ走っていない版）→ {res}")
                return
        if platform_only:
            what = "、".join(f"{x['name']} 約{x['m']}m" for x in moves)
            self.found_rows.append({**row, "category": "", "change_date": "", "lead_days_seen": "", "lead_days_published": "",
                                    "change_censored": "", "revision": f"作らない（のりばだけの変更：{what}）"})
            print(f"  {key} {uid[:8]}: zip が置き換わったが、のりばだけの変更（{what}）")
            return
        change = rp.first_diff_day(old_tt, new_tt, today)
        if change is None:
            self.found_rows.append({**row, "category": "", "change_date": "", "lead_days_seen": "", "lead_days_published": "",
                                    "change_censored": "", "revision": f"作らない（これから{rp.SEARCH_DAYS}日に、便と時刻の違いが無い）"})
            return
        # 変わる日が分からない：見つけた日にはもう違っていた（本当はもっと前に変わっていたかもしれない）
        censored = change == today
        category = found_category(change, today, dt.date.fromisoformat(om["to"]))
        skip = skip_reason(category, change, today)
        revision = skip
        if not skip and om["license"] in br.ALLOWED_LICENSES:
            info = {"feed_name": om["feed_name"], "organization_name": om["operator"], "feed_license": om["license"],
                    "feed_license_url": om["license_url"], "published_at": om["published_at"],
                    "replaced_at": rep_at.isoformat(), "etag": pr["etag"]}
            rev = rp.build_revision_from_tts(key, info, cur_id, old_tt, new_id, new_tt, change, self.started.isoformat(),
                                             change_known=not censored, chain=self.replaced_chain(key, uid, om["published_at"]))
            if moves:  # 50m以上離れたのりばに移る便がある（画面に出す文は、決まってから足す）
                rev["meta"]["platform_moves"] = moves
            m = {"feed_name": om["feed_name"], "organization_name": om["operator"], "published_at": rep_at.isoformat(),
                 "feed_license": om["license"], "feed_license_url": om["license_url"], "gtfs_file_uid": new_id}
            revision = self.publish_built(key, m, rev, {}, change, self.started, FOUND_BASIS_REPLACED)
        elif not skip:
            revision = "作らない（ライセンス）"
        self.found_rows.append({**row, "category": category, "change_date": change.isoformat(),
                                "lead_days_seen": (change - today).days, "lead_days_published": (change - rep_at.date()).days,
                                "change_censored": censored, "revision": revision})
        print(f"  {key} {uid[:8]}: zip が置き換わった。変わる日 {change}{'（分からない）' if censored else ''} → {revision}")

    def replaced_chain(self, key, uid, published_at):
        """B：同じフィードのほかの版の時刻表（いま使う中身）から、その日に動いていた版を選ぶ関数"""
        d = self.site / rv.timetable_path(key, "x").rsplit("/", 1)[0]
        others = []
        for p in sorted(d.glob("*.json")) if d.exists() else []:
            base = p.stem.split(".r")[0]
            if base == uid or p.stem != self.alias.get(base, base):
                continue
            others.append((p.stem, json.loads(p.read_text(encoding="utf-8"))))
        return rp.old_chain(others, published_at)

    def rebuild_with_content(self, key, x, cur_id, old_tt, new_id, new_tt, today, platform_only, moves, replaced):
        """A：公開中の改正 x の「後」の中身を、置き換わったあとの中身にして上書きする。
        変わる日が動いたら上書きせずに止める。便や時刻が違い、その改正の知らせを送ったあとなら、もう一度だけ知らせる"""
        p = self.site / x["path"]
        before_text = p.read_text(encoding="utf-8")
        rev = json.loads(before_text)
        old_uid = rev["meta"]["old"]["uid"]
        prev_tt = json.loads((self.site / rev["meta"]["timetables"][old_uid]).read_text(encoding="utf-8"))
        c1 = rp.first_diff_day(prev_tt, old_tt, today, sig=rp.day_sig_named)
        c2 = rp.first_diff_day(prev_tt, new_tt, today, sig=rp.day_sig_named)
        if c1 != c2:
            reason = f"作り直すと変わる日が動く（{c1} → {c2}）。上書きせずに止めた"
            self.hold_row(key, x, new_id, reason)
            return f"止めた：{reason}"
        new_rev = rp.swap_new_content(rev, cur_id, new_id, new_tt, prev_tt, key, self.started.isoformat(), replaced)
        if moves:
            new_rev["meta"]["platform_moves"] = moves
        p.write_text(json.dumps(new_rev, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        check = run_check(self.site, x["path"])
        held = hold_reason(check)
        if held:
            p.write_text(before_text, encoding="utf-8")  # 公開中のものを残す
            reason = f"作り直した改正が点検で止まった：{held}。上書きしなかった"
            self.hold_row(key, x, new_id, reason, check)
            return f"止めた：{reason}"
        x["new_uid"] = new_id
        x["check"] = check
        kind = "のりばだけの変更" if platform_only else "便や時刻の変更"
        again = ""
        if not platform_only and rp.times_differ(old_tt, new_tt, today):
            again = "、" + self.queue_again(key, x["change_date"])
        return f"{x['path']} を新しい中身で作り直した（{kind}）{again}"

    def hold_row(self, key, x, new_id, reason, check=None):
        self.held = [h for h in self.held if not (h["new_uid"] == new_id and h["change_date"] == x["change_date"])]
        self.held.append({"held_at": self.started.isoformat(), "feed": key, "feed_name": x["feed_name"], "operator": x["operator"],
                          "change_date": x["change_date"], "old_uid": x["old_uid"], "new_uid": new_id, "reason": reason,
                          "shares": json.dumps((check or {}).get("shares", {}), ensure_ascii=False),
                          "approved_at": "", "published_path": ""})
        if check:
            self.held_examples[new_id] = {"feed_name": x["feed_name"], "change_date": x["change_date"],
                                          "shares": check.get("shares", {}), "examples": check.get("examples", {})}

    def queue_again(self, key, change):
        """公開中の改正が作り直されて便や時刻が変わったとき、もう一度だけ知らせる（その改正の知らせを送ったあとのときだけ。
        送ったかどうかは通知のサーバーが決める：前の知らせの印が無ければ送らない）"""
        if not self.queue_notices:
            return "作り直しなので知らせない"
        if any(q["feed"] == key and q["change_date"] == change and not q.get("again") for q in self.notify_queue):
            return "前の知らせがまだ待ち行列にある（送るときは新しい中身なので、もう一度は送らない）"
        if any(q["feed"] == key and q["change_date"] == change and q.get("again") for q in self.notify_queue):
            return "もう一度の知らせは待ち行列にある"
        self.notify_queue.append({"feed": key, "change_date": change, "queued_at": self.started.isoformat(), "after": None,
                                  "again": True})
        return "もう一度の知らせを待ち行列に入れた（前の知らせを送ったあとのときだけ送る）"

    def check_feed(self, key, f):
        org, fid = key.split("/")
        mp = 999 if self.full else MAX_PREV
        body = fetch_json(f"{API}/organizations/{org}/feeds/{fid}?max_prev={mp}", self.tmp / "feed" / f"{org}__{fid}.json")["body"]
        files = body.get("gtfs_files") or []
        meta = {g["gtfs_file_uid"]: self.meta(key, f, body, g) for g in files}
        if self.full:  # 全部の版を取ったときだけ、消えた版に気づける
            for r in self.seen:
                if r["feed"] == key and r["gtfs_file_uid"] not in meta and not r.get("gone_at"):
                    r["gone_at"] = self.started.isoformat()
        new = sorted((m for u, m in meta.items() if u not in self.seen_by_uid), key=lambda m: m["published_at"])
        for m in new:
            self.handle_new(key, f, m, meta)

    def meta(self, key, f, body, g):
        u = g.get("update_info") or {}
        labels = [("update_timetable", "時刻表"), ("update_routes", "路線"), ("update_stops", "停留所"),
                  ("update_fare", "運賃"), ("update_available_period", "期間"),
                  ("temporary_timetable", "臨時ダイヤ"), ("others", "その他")]
        on = [l for k, l in labels if u.get(k)]
        return {
            "feed": key, "gtfs_file_uid": g["gtfs_file_uid"], "rid": g.get("rid"),
            "published_at": g.get("published_at") or g.get("created_at"), "created_at": g.get("created_at"),
            "from_date": g.get("from_date"), "to_date": g.get("to_date"),
            "declared_kind": "+".join(on) if on else "申告なし",
            "feed_name": f.get("feed_name"), "organization_name": f.get("organization_name"),
            "feed_license": body.get("feed_license", f.get("feed_license")),
            "feed_license_url": body.get("feed_license_url", f.get("feed_license_url")),
            "memo": (g.get("memo") or "").replace("\r", " ").replace("\n", " "),
            "gtfs_url": g.get("gtfs_url") or f"{API}/organizations/{key.split('/')[0]}/feeds/{key.split('/')[1]}/files/feed.zip?uid={g['gtfs_file_uid']}",
        }

    def previous(self, key, m, meta):
        """公開日時の順で、ひとつ前の版（API の応答か、見た版の一覧から）"""
        cands = [x for x in meta.values() if x["published_at"] < m["published_at"]]
        for r in self.seen:
            if r["feed"] == key and r["published_at"] < m["published_at"] and r["gtfs_file_uid"] not in meta:
                org, fid = key.split("/")
                cands.append({**r, "rid": r.get("rid_at_first_seen"),
                              "feed_license": r.get("license"), "feed_license_url": "",
                              "gtfs_url": f"{API}/organizations/{org}/feeds/{fid}/files/feed.zip?uid={r['gtfs_file_uid']}"})
        return max(cands, key=lambda x: x["published_at"]) if cands else None

    def handle_new(self, key, f, m, meta):
        row = {"feed": key, "gtfs_file_uid": m["gtfs_file_uid"], "first_seen_at": self.started.isoformat(),
               "source": "watch", "published_at": m["published_at"], "from_date": m["from_date"],
               "to_date": m["to_date"], "rid_at_first_seen": m["rid"], "declared_kind": m["declared_kind"],
               "license": m["feed_license"], "kind": "", "actual_change_date": "", "lead_days_seen": "", "revision": ""}
        self.seen.append(row)
        self.seen_by_uid[m["gtfs_file_uid"]] = row
        self.new_rows.append(row)
        prev = self.previous(key, m, meta)
        if prev is None:
            row["kind"] = "first"
            self.maybe_timetable(key, m, force=True)
            return
        try:
            # 毎日更新のフィード：指紋が同じなら、前の版は取らない
            if key in self.daily:
                fn = self.loader(m)
                today = self.started.date()
                fp_new = fingerprint(fn, today, dt.date.fromisoformat(m["from_date"]), dt.date.fromisoformat(m["to_date"]))
                stored = self.fps.get(key) or {}
                self.fps[key] = {"uid": m["gtfs_file_uid"], "computed_at": self.started.isoformat(), "days": fp_new,
                                 "timetable_built_at": stored.get("timetable_built_at", "")}
                if stored and stored.get("uid") == prev["gtfs_file_uid"] and same_fingerprint(stored["days"], fp_new):
                    row["kind"] = "same(指紋)"
                    # 便と時刻は同じ。時刻表は、前に作ってから TIMETABLE_REFRESH_DAYS 日たったときだけ作り直す
                    self.maybe_timetable(key, m, force=False)
                    return
            res = dv.compare_pair(key, prev, m, loader=self.loader)
            if res.get("kind") == "error":
                raise RuntimeError(res.get("note"))
            row["kind"] = res["kind"]
            if res["kind"] == "A" and res.get("actual_change_date"):
                self.found(key, f, prev, m, res, row)
            self.maybe_timetable(key, m, force=True)
        except Exception as e:  # noqa: BLE001
            row["kind"] = "error"
            self.errors.append(f"{key} {m['gtfs_file_uid'][:8]}: {e!r}"[:200])

    def maybe_timetable(self, key, m, force):
        """新しい版の時刻表を作る（加工・再配布を確かめたライセンスだけ）。毎日更新のフィードで指紋が同じときは、
        前に作ってから TIMETABLE_REFRESH_DAYS 日たったときだけ作る"""
        if m["feed_license"] not in br.ALLOWED_LICENSES:
            return
        if not force and key in self.daily:
            last = self.fps.get(key, {}).get("timetable_built_at") or ""
            if last and (self.started - dt.datetime.fromisoformat(last)).days < TIMETABLE_REFRESH_DAYS:
                return
        try:
            tt = ttm.build_timetable(self.zip_for(m), m, built_at=self.started.isoformat())
            self.write_timetable(key, m["gtfs_file_uid"], tt)
            if key in self.daily and key in self.fps:
                self.fps[key]["timetable_built_at"] = self.started.isoformat()
        except Exception as e:  # noqa: BLE001
            self.errors.append(f"{key} {m['gtfs_file_uid'][:8]} 時刻表: {e!r}"[:200])

    def found(self, key, f, prev, m, res, row, found_at=None, basis=FOUND_BASIS_WATCH):
        found_at = found_at or self.started
        change = dt.date.fromisoformat(res["actual_change_date"])
        seen_date = found_at.astimezone(JST).date()
        row["actual_change_date"] = change.isoformat()
        row["lead_days_seen"] = (change - seen_date).days
        lic_ok = m["feed_license"] in br.ALLOWED_LICENSES and prev.get("feed_license", m["feed_license"]) in br.ALLOWED_LICENSES
        category = found_category(change, seen_date, dt.date.fromisoformat(m["to_date"]))
        skip = skip_reason(category, change, seen_date)
        revision = ""
        if skip:
            revision = skip
        elif lic_ok:
            try:
                revision = self.publish_revision(key, m, change, found_at, basis)
            except Exception as e:  # noqa: BLE001
                revision = f"作れなかった: {e!r}"[:120]
                self.errors.append(f"{key} 改正のデータ: {e!r}"[:200])
        else:
            revision = "作らない（ライセンス）"
        row["revision"] = revision
        self.found_rows.append({
            "found_at": found_at.isoformat(), "found_at_basis": basis, "category": category, "feed": key, "feed_name": m["feed_name"],
            "operator": m["organization_name"], "new_uid": m["gtfs_file_uid"], "published_at": m["published_at"],
            "from_date": m["from_date"], "to_date": m["to_date"], "change_date": change.isoformat(),
            "lead_days_seen": (change - seen_date).days,
            "lead_days_published": (change - jst_date(m["published_at"])).days,
            "change_censored": res.get("change_censored"), "late_publish": res.get("late_publish"),
            "license": m["feed_license"], "revision": revision})

    # ---------- 改正のデータ（revision-2）と時刻表、公開の前の点検 ----------

    def zip_for(self, m):
        return fetch(m["gtfs_url"], self.tmp / "zips" / f"{m['gtfs_file_uid']}.zip")

    def feed_versions(self, key):
        """見た版の一覧から、そのフィードの版のメタデータ（改正のデータの「前の版をつなげる」ため）"""
        org, fid = key.split("/")
        out = []
        for r in self.seen:
            if r["feed"] != key or r.get("gone_at"):
                continue
            out.append({**r, "feed": key,
                        "gtfs_url": f"{API}/organizations/{org}/feeds/{fid}/files/feed.zip?uid={r['gtfs_file_uid']}"})
        return out

    def write_timetable(self, key, uid, tt):
        p = self.site / rv.timetable_path(key, uid)
        if not p.exists():
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps(tt, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    def publish_revision(self, key, m, change, found_at, basis, approved=False):
        """改正のデータを作り、点検に通れば公開する（目次に載せる）。止めたら held.csv に記録する。
        approved=True（人が承認した改正）は、点検の結果を記録するが止めない。"""
        rev, tts = rv.build_revision2(key, m, self.feed_versions(key), change, self.zip_for, self.started.isoformat())
        return self.publish_built(key, m, rev, tts, change, found_at, basis, approved)

    def publish_built(self, key, m, rev, tts, change, found_at, basis, approved=False):
        """作った改正のデータを、点検に通れば公開する（publish_revision と、zip の置き換えの両方から使う）"""
        rev["meta"]["first_seen_at"] = found_at.isoformat()
        rev["meta"]["first_seen_basis"] = basis
        for uid, tt in tts.items():
            self.write_timetable(key, uid, tt)
        rel = rv.revision_path(key, change, m["gtfs_file_uid"])
        p = self.site / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(rev, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        check = run_check(self.site, rel)
        held = "" if approved else hold_reason(check)
        entry = {"feed": key, "feed_name": m["feed_name"], "operator": m["organization_name"],
                 "change_date": change.isoformat(), "published_at": m["published_at"],
                 "first_seen_at": found_at.isoformat(), "first_seen_basis": basis,
                 "license": m["feed_license"], "license_url": m["feed_license_url"], "path": rel,
                 "old_uid": rev["meta"]["old"]["uid"], "new_uid": m["gtfs_file_uid"],
                 "change_date_known": rev["meta"].get("change_date_known", True),
                 "check": check}
        self.index = [x for x in self.index if x["path"] != rel]
        if held and rev["meta"].get("all_routes_stop"):
            held = f"全部の路線が{change.isoformat()}から走らない（運行する日を外した）。{held}"
        if held:
            p.unlink()  # 公開しない（Pages に出さない）。版の番号から、いつでも作り直せる
            if p.parent.exists() and not any(p.parent.iterdir()):
                p.parent.rmdir()
            self.held = [h for h in self.held if not (h["new_uid"] == entry["new_uid"] and h["change_date"] == entry["change_date"])]
            self.held.append({"held_at": self.started.isoformat(), "feed": key, "feed_name": m["feed_name"],
                              "operator": m["organization_name"], "change_date": change.isoformat(),
                              "old_uid": entry["old_uid"], "new_uid": entry["new_uid"], "reason": held,
                              "shares": json.dumps(check.get("shares", {}), ensure_ascii=False),
                              "approved_at": "", "published_path": "", "memo": m.get("memo", "")})
            self.held_examples[entry["new_uid"]] = {"feed_name": m["feed_name"], "change_date": change.isoformat(),
                                                   "shares": check.get("shares", {}), "examples": check.get("examples", {}),
                                                   "memo": m.get("memo", ""),
                                                   "all_routes_stop": bool(rev["meta"].get("all_routes_stop"))}
            return f"止めた（点検）: {held}"
        self.index.append(entry)
        self.queue_notice(key, change)
        return rel

    def queue_notice(self, key, change):
        """公開した改正を、通知の待ち行列に入れる（変わる日から30日より前の改正は、知らせない）"""
        if not self.queue_notices or (self.started.date() - change).days > NOTIFY_RECENT_DAYS:
            return
        if any(q["feed"] == key and q["change_date"] == change.isoformat() for q in self.notify_queue):
            return
        self.notify_queue.append({"feed": key, "change_date": change.isoformat(), "queued_at": self.started.isoformat(), "after": None})

    def process_approvals(self):
        """承認の一覧に書かれた、止めた改正を公開する（作り直して、点検の結果は記録するが止めない）"""
        approvals = read_approvals()
        if not approvals:
            return
        found = read_csv(self.data / "found.csv")
        for h in self.held:
            if h.get("approved_at") or h.get("resolved") or not any(h["new_uid"].startswith(a) for a in approvals):
                continue
            key = h["feed"]
            if ".r" in h["new_uid"]:  # zip が置き換わった改正：site に残っている前と後の時刻表から作り直す
                self.approve_replaced(h, found)
                continue
            r = self.seen_by_uid.get(h["new_uid"])
            if r is None:
                self.errors.append(f"承認：{h['new_uid'][:8]} が見た版の一覧にない")
                continue
            f = self.prev_feeds.get(key, {})
            org, fid = key.split("/")
            m = {**r, "feed": key, "feed_name": h["feed_name"], "organization_name": h["operator"],
                 "feed_license": r.get("license") or f.get("feed_license"), "feed_license_url": f.get("feed_license_url", ""),
                 "memo": h.get("memo", ""), "gtfs_url": f"{API}/organizations/{org}/feeds/{fid}/files/feed.zip?uid={h['new_uid']}"}
            fr = next((x for x in found if x["new_uid"] == h["new_uid"]), {})
            found_at = dt.datetime.fromisoformat(fr.get("found_at") or self.started.isoformat())
            try:
                rel = self.publish_revision(key, m, dt.date.fromisoformat(h["change_date"]), found_at,
                                            fr.get("found_at_basis", FOUND_BASIS_WATCH), approved=True)
            except Exception as e:  # noqa: BLE001
                self.errors.append(f"承認 {h['new_uid'][:8]}: {e!r}"[:200])
                continue
            h["approved_at"] = self.started.isoformat()
            h["published_path"] = rel
            r["revision"] = rel
            for x in found:
                if x["new_uid"] == h["new_uid"]:
                    x["revision"] = f"{rel}（承認して公開）"
            self.held_examples.pop(h["new_uid"], None)
            print(f"  承認して公開: {h['feed_name']} {h['change_date']} → {rel}")
        write_csv(self.data / "found.csv", FOUND_COLS, found)

    def approve_replaced(self, h, found):
        key = h["feed"]
        try:
            old_tt = json.loads((self.site / rv.timetable_path(key, h["old_uid"])).read_text(encoding="utf-8"))
            new_tt = json.loads((self.site / rv.timetable_path(key, h["new_uid"])).read_text(encoding="utf-8"))
            om, c = old_tt["meta"], new_tt["meta"]["content"]
            fr = next((x for x in found if x["new_uid"] == h["new_uid"]), {})
            change = dt.date.fromisoformat(h["change_date"])
            info = {"feed_name": om["feed_name"], "organization_name": om["operator"], "feed_license": om["license"],
                    "feed_license_url": om["license_url"], "published_at": om["published_at"],
                    "replaced_at": c["last_modified"], "etag": c["etag"]}
            rev = rp.build_revision_from_tts(key, info, h["old_uid"], old_tt, h["new_uid"], new_tt, change, self.started.isoformat(),
                                             change_known=str(fr.get("change_censored")) != "True",
                                             chain=self.replaced_chain(key, h["old_uid"].split(".r")[0], om["published_at"]))
            m = {"feed_name": om["feed_name"], "organization_name": om["operator"], "published_at": c["last_modified"],
                 "feed_license": om["license"], "feed_license_url": om["license_url"], "gtfs_file_uid": h["new_uid"]}
            found_at = dt.datetime.fromisoformat(fr.get("found_at") or self.started.isoformat())
            rel = self.publish_built(key, m, rev, {}, change, found_at, FOUND_BASIS_REPLACED, approved=True)
        except Exception as e:  # noqa: BLE001
            self.errors.append(f"承認 {h['new_uid'][:8]}: {e!r}"[:200])
            return
        h["approved_at"] = self.started.isoformat()
        h["published_path"] = rel
        for x in found:
            if x["new_uid"] == h["new_uid"]:
                x["revision"] = f"{rel}（承認して公開）"
        self.held_examples.pop(h["new_uid"], None)
        print(f"  承認して公開: {h['feed_name']} {h['change_date']} → {rel}")

    def migrate_found(self):
        """前の決まりで書いた found.csv に種類の列を足し、作らない決まりに当たる改正のデータを取り下げる"""
        p = self.data / "found.csv"
        rows = read_csv(p)
        if rows and "category" in rows[0] and "found_at_basis" not in rows[0]:
            for r in rows:
                r["found_at_basis"] = FOUND_BASIS_WATCH
            write_csv(p, FOUND_COLS, rows)  # 見つけた日時の根拠の列を足す
            return
        if not rows or "category" in rows[0]:
            return
        seen = {r["gtfs_file_uid"]: r for r in self.seen}
        for r in rows:
            fd = jst_date(r["found_at"])
            to = r.get("to_date") or seen.get(r["new_uid"], {}).get("to_date", "9999-12-31")
            r["to_date"] = to
            change = dt.date.fromisoformat(r["change_date"])
            r["category"] = found_category(change, fd, dt.date.fromisoformat(to))
            r["found_at_basis"] = FOUND_BASIS_WATCH
            skip = skip_reason(r["category"], change, fd)
            if skip and r["revision"].startswith("data/revisions/"):
                f = self.site / r["revision"]
                f.unlink(missing_ok=True)
                if f.parent.exists() and not any(f.parent.iterdir()):
                    f.parent.rmdir()
                self.index = [x for x in self.index if x["path"] != r["revision"]]
                if r["new_uid"] in seen:
                    seen[r["new_uid"]]["revision"] = skip
                r["revision"] = skip
        write_csv(p, FOUND_COLS, rows)
        print(f"  found.csv を新しい決まりに直しました（{len(rows)}行）")

    def finish(self, feeds_checked):
        self.migrate_found()
        fin = now_jst()
        write_csv(self.state / "versions_seen.csv", SEEN_COLS, self.seen)
        write_json(self.state / "fingerprints.json", self.fps)
        write_json(self.state / "feeds.json", self.prev_feeds)
        if self.found_rows:
            append_csv(self.data / "found.csv", FOUND_COLS, self.found_rows)
        elif not (self.data / "found.csv").exists():
            write_csv(self.data / "found.csv", FOUND_COLS, [])
        write_json(self.data / "revisions" / "index.json", self.index)
        write_held(self.data, self.held, self.held_examples)
        write_json(self.state / "notify_queue.json", self.notify_queue)
        write_json(self.state / "timetable_alias.json", self.alias)
        write_attributions(self.site, self.index)
        try:  # バスの一覧を作り直し、使われなくなった時刻表を消す
            cat = import_module("09_build_catalog")
            _, referenced = cat.build_catalog(self.site, self.seen, self.prev_feeds, self.index, self.started.date())
            cat.prune_timetables(self.site, referenced)
        except Exception as e:  # noqa: BLE001
            self.errors.append(f"バスの一覧: {e!r}"[:200])
        ok = feeds_checked > 0 or not self.errors
        status = {
            **self.status,
            "last_run_started_at": self.started.isoformat(),
            "last_run_finished_at": fin.isoformat(),
            "last_run_mode": "full" if self.full else "normal",
            "last_run_errors": self.errors[:20],
            "feeds_total": len(self.prev_feeds),
            "versions_seen": len(self.seen),
            "revisions": len(self.index),
        }
        if ok:  # フィードの一覧が取れたときだけ「確かめた」とする
            status["last_checked_at"] = self.started.isoformat()
            if self.full:
                status["last_full_check_at"] = self.started.isoformat()
        write_json(self.data / "status.json", status)
        append_csv(self.state / "runs.csv", RUN_COLS, [{
            "started_at": self.started.isoformat(), "finished_at": fin.isoformat(),
            "mode": "full" if self.full else "normal", "feeds_checked": feeds_checked,
            "requests": REQUESTS["count"], "new_versions": len(self.new_rows), "found": len(self.found_rows),
            "errors": len(self.errors)}])
        shutil.rmtree(self.tmp, ignore_errors=True)  # zip を残さない
        print(f"{self.started.isoformat()} {'点検' if self.full else 'ふだん'}: 見たフィード {feeds_checked}、"
              f"リクエスト {REQUESTS['count']}、新しい版 {len(self.new_rows)}、"
              f"見つけた改正 {len(self.found_rows)}、エラー {len(self.errors)}")
        kinds = Counter(r["kind"] for r in self.new_rows)
        print("  新しい版の内訳:", dict(kinds))
        for r in self.found_rows:
            print(f"  改正: {r['feed_name']}（{r['operator']}） 変更日 {r['change_date']}"
                  f"（見つけたのは {r['lead_days_seen']}日前） → {r['revision']}")
        for e in self.errors[:10]:
            print("  エラー:", e)
        return 0 if ok else 1


def write_held(data, held, examples):
    """止めた改正の一覧（held.csv）、段階ごとの例（held_examples.json）、人が読む形（held_review.md）"""
    write_csv(data / "held.csv", HELD_COLS, held)
    write_json(data / "held_examples.json", examples)
    names = {"same": "変わらない", "tiny": "ほぼ同じ", "small": "少し変わる", "big": "大きく変わる", "better": "良くなる",
             "cannot": "行けなくなる", "will_be_able": "行けるようになる", "no_compare": "くらべられない",
             "no_route": "1本では行けない"}
    note_names = {"route_starts": "運行が始まる", "route_ends": "運行が終わる", "stop_not_served": "止まらなくなる停留所",
                  "stop_moved": "のりばが動いた", "too_few_dates": "比べた日が少ない", "split": "日によって分かれた"}
    lines = ["# 止めた改正（承認を待つもの）", "",
             "承認するときは、main ブランチの `approvals/approved.txt` に「改正の番号」を1行ずつ書いて push してください。"
             "次の実行（6時間ごと）で作り直して公開します。", ""]
    waiting = [h for h in held if not h.get("approved_at") and not h.get("resolved")]
    if not waiting:
        lines.append("いま承認を待つ改正はありません。")
    for h in waiting:
        ex = examples.get(h["new_uid"], {})
        lines += [f"## {h['feed_name']}（{h['operator']}） {h['change_date']}", "",
                  f"- 改正の番号：`{h['new_uid'][:8]}`（新しい版 {h['new_uid']}）",
                  f"- 止めた理由：{h['reason']}",
                  *([f"- 版のメモ（GTFSデータリポジトリ）：「{' '.join((h.get('memo') or ex.get('memo') or '').split())}」"]
                    if (h.get("memo") or ex.get("memo")) else []),
                  "- 段階ごとの割合：" + "、".join(f"{names.get(k, k)} {v:.0%}" for k, v in
                                          sorted(ex.get("shares", {}).items(), key=lambda kv: -kv[1])), ""]
        for lv, xs in ex.get("examples", {}).items():
            lines.append(f"### {names.get(lv, lv)}（例 {len(xs)}件）")
            lines.append("")
            lines.append("| 乗る → 降りる | 日・条件 | 前 | 後 | 印 |")
            lines.append("|---|---|---|---|---|")
            for x in xs:
                b = f"{x['before']['dep']}発→{x['before']['arr']}着（{x['before']['route']}）" if x["before"] else "なし"
                a = f"{x['after']['dep']}発→{x['after']['arr']}着（{x['after']['route']}）" if x["after"] else "なし"
                wd = {"mon": "月", "tue": "火", "wed": "水", "thu": "木", "fri": "金", "sat": "土", "sun": "日"}.get(x["day"], x["day"])
                marks = "、".join(note_names.get(n, n) for n in x.get("notes", []) if n in note_names)
                lines.append(f"| {x['from']} → {x['to']} | {x['date']}（{wd}）・{x['cond']} | {b} | {a} | {marks} |")
            lines.append("")
    (data / "held_review.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_attributions(site, index=None):
    """出典の一覧を、公開している改正のデータ（data/revisions/ の JSON 全部）から自動で作る"""
    feeds = {}
    for p in sorted((site / "data" / "revisions").rglob("*.json")):
        if p.name == "index.json":
            continue
        try:
            m = json.loads(p.read_text(encoding="utf-8"))["meta"]
        except Exception:  # noqa: BLE001
            continue
        feeds.setdefault(m["feed"], {"operator": m["operator"], "feed_name": m["feed_name"],
                                     "license": m["license"], "license_url": m["license_url"]})
    items = [{"feed": k, **v, "text": f"{v['operator']}{br.kq(v['feed_name'])}GTFSデータ（{v['license']}）"}
             for k, v in sorted(feeds.items())]
    write_json(site / "data" / "attributions.json", {
        "note": "このサイトの改正のデータは、GTFSデータリポジトリ（https://gtfs-data.jp/）で公開されている次のGTFSデータを、まちの足カルテが加工して作成したものです。",
        "items": items})
    lines = ["# 出典", "", "このサイトの改正のデータは、GTFSデータリポジトリ（https://gtfs-data.jp/）で公開されている次のGTFSデータを、まちの足カルテが加工して作成したものです。", ""]
    lines += [f"- {i['text']} — {i['license_url']}" for i in items] or ["- （まだありません）"]
    lines += ["", "メタデータ（版の一覧など）は、GTFSデータリポジトリの付帯データ（CC BY 4.0）です。", ""]
    (site / "ATTRIBUTION.md").write_text("\n".join(lines), encoding="utf-8")


def bootstrap(site):
    """最初の1回：調査（2026-11-23）で取った版の一覧と、フィードの一覧を、見た版として入れる"""
    state = site / "state"
    if (state / "versions_seen.csv").exists():
        sys.exit("site/state/versions_seen.csv がすでにあります。--bootstrap は最初の1回だけです。")
    rows = []
    for r in csv.DictReader(open(DATA / "versions.csv", encoding="utf-8")):
        rows.append({"feed": f"{r['organization_id']}/{r['feed_id']}", "gtfs_file_uid": r["gtfs_file_uid"],
                     "first_seen_at": "", "source": "調査(2026-11-23)", "published_at": r["published_at"],
                     "from_date": r["from_date"], "to_date": r["to_date"], "rid_at_first_seen": r["rid"],
                     "declared_kind": r["declared_kind"], "license": r["feed_license"], "kind": "", "revision": ""})
    write_csv(state / "versions_seen.csv", SEEN_COLS, rows)
    feeds = json.loads((ROOT / "cache" / "api" / "feeds.json").read_text(encoding="utf-8"))["body"]
    write_json(state / "feeds.json", {f"{f['organization_id']}/{f['feed_id']}": clean_feed(f) for f in feeds})
    write_json(site / "data" / "status.json", {"last_checked_at": BOOTSTRAP_CHECKED_AT, "bootstrap": "調査(2026-11-23)の版の一覧から始めた"})
    print(f"始めの状態：版 {len(rows)}、フィード {len(feeds)}")


def publish_app(site):
    """main の app/ をサイトに写す（dev/ と test/ は写さない）"""
    app = ROOT / "app"
    for name in ("index.html", "sw.js", "manifest.webmanifest"):
        shutil.copy2(app / name, site / name)
    for d in ("js", "css", "icons"):
        if (site / d).exists():
            shutil.rmtree(site / d)
        shutil.copytree(app / d, site / d)
    (site / "data" / "revisions").mkdir(parents=True, exist_ok=True)
    (site / ".nojekyll").write_text("")
    readme = site / "README.md"
    if not readme.exists():
        readme.write_text("# まちの足カルテ（公開用のブランチ）\n\nこのブランチは GitHub Actions が自動で更新します。コードは main ブランチにあります。開発中です。\n", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="site")
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--bootstrap", action="store_true")
    ap.add_argument("--no-app", action="store_true", help="アプリを写さない")
    ap.add_argument("--etag", action="store_true", help="時刻に関係なく、zip の置き換え（ETag）を確かめる")
    args = ap.parse_args()
    site = Path(args.site)
    if args.bootstrap:
        bootstrap(site)
    if not args.no_app:
        publish_app(site)  # 先にアプリ（とアプリに入れた改正のデータ）を写し、出典の一覧に含める
    watch = Watch(site, args.full)
    watch.force_etag = args.etag
    rc = watch.run()
    sys.exit(rc)


if __name__ == "__main__":
    main()
