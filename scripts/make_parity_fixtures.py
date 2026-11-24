"""テストの材料：版の時刻表（timetable-1）と、調査の決まり（Python）で出した「その日に走るバス」。
app/test/timetable.test.js が、端末の計算（app/js/timetable.js）と同じになることを確かめる。

  python3 scripts/make_parity_fixtures.py   （cache/zips にある版から作る）
"""
import csv
import datetime as dt
import gzip
import hashlib
import json
from importlib import import_module
from pathlib import Path

from common import CACHE, DATA, ROOT

tt_mod = import_module("timetable")
dv = import_module("03_diff_versions")

CASES = [  # 名前, フィード, uid
    ("yonezawa_old", "yonezawacity/Yonezawa", "02b67c85-efb0-4dd3-a273-2e2aa80860b1"),
    ("yonezawa_new", "yonezawacity/Yonezawa", "be34d058-22c0-4421-8418-7925e6e12378"),
    ("nagasaki_kenei", "keneibus/nagasaki-kenei-bus", "9dc8e290-c7c9-4f6a-9234-5f37605d6d1a"),
    ("hachinohe", "hachinohe/hachinohe-citybus", "11ebf75a-7423-46d8-9f11-60b43ac31a42"),
    ("nemuro", "nemurokotsu/nemurobus", "31577a0e-b0e1-47fe-aeef-a839516856dc"),
]
MAX_DAYS = 400


def digest(ids):
    return hashlib.sha1(",".join(map(str, ids)).encode()).hexdigest()[:16]


def main():
    out_dir = ROOT / "app" / "test" / "fixtures"
    out_dir.mkdir(parents=True, exist_ok=True)
    meta = {r["gtfs_file_uid"]: r for r in csv.DictReader(open(DATA / "versions.csv", encoding="utf-8"))}
    index = {}
    for name, feed, uid in CASES:
        m = {**meta[uid], "feed": feed}
        z = CACHE / "zips" / f"{uid}.zip"
        tt = tt_mod.build_timetable(z, m, built_at="fixture")
        f = dv.Feed(z)
        start = dt.date.fromisoformat(m["from_date"])
        end = min(dt.date.fromisoformat(m["to_date"]), start + dt.timedelta(days=MAX_DAYS - 1))
        expected = {}
        d = start
        while d <= end:
            ids = tt_mod.trips_on_expected(tt, f, d)
            expected[d.isoformat()] = [len(ids), digest(ids)]
            d += dt.timedelta(days=1)
        (out_dir / f"{name}.timetable.json.gz").write_bytes(
            gzip.compress(json.dumps(tt, ensure_ascii=False, separators=(",", ":")).encode(), mtime=0))
        index[name] = {"feed": feed, "uid": uid, "days": len(expected), "expected": expected}
        print(f"{name}: バス {len(tt['trips'])}、運行 {len(tt['services'])}、比べる日 {len(expected)}")
    (out_dir / "parity_expected.json").write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
