"""zip の置き換え（同じ版の番号のまま zip が置き換わった）で止めた改正を、いまの決まり（A・B・C′）で扱い直す。1回だけ手で動かす。

  python3 scripts/13_redo_replaced_held.py --site site [--uid 8af5b399]

- 止めた行（held.csv）のうち、新しい中身（{uid}.r{ETag}）のものを選ぶ。前の中身と新しい中身の時刻表は site に残っている。
- まだ有効期間に入っていない版で、その版を「後」にする公開中の改正があれば（A）、新しい中身で作り直して上書きする。
  のりばだけの変更（C′）なら、改正も知らせも作らない。
- 止めた行には resolved（直しで扱った中身）を書き、found.csv のその行の revision も書き換える。承認を待つ一覧からは外れる。
- バスの一覧（catalog.json）も作り直す。zip は落とさない。
"""
import argparse
import datetime as dt
import json
from importlib import import_module
from pathlib import Path

w = import_module("07_daily_watch")
rp = import_module("replaced")
rv = import_module("revision2")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="site")
    ap.add_argument("--uid", default="")
    a = ap.parse_args()
    site = Path(a.site)
    x = w.Watch(site, False)
    x.queue_notices = True
    today = x.started.astimezone(w.JST).date()
    found = w.read_csv(x.data / "found.csv")
    for h in x.held:
        if h.get("approved_at") or h.get("resolved") or ".r" not in h["new_uid"] or not h["new_uid"].startswith(a.uid):
            continue
        key, uid, new_id = h["feed"], h["new_uid"].split(".r")[0], h["new_uid"]
        old_tt = json.loads((site / rv.timetable_path(key, uid)).read_text(encoding="utf-8"))
        new_tt = json.loads((site / rv.timetable_path(key, new_id)).read_text(encoding="utf-8"))
        om, c = old_tt["meta"], new_tt["meta"]["content"]
        moves = rp.platform_changes(old_tt, new_tt, today)
        platform_only = moves is not None and not rp.far_moves(moves)
        replaced = {"uid": uid, "etag": c["etag"], "last_modified": c["last_modified"]}
        pubs = [e for e in x.index if e["feed"] == key and e["new_uid"].split(".r")[0] == uid]
        if om["from"] > today.isoformat() and pubs:
            res = "；".join(x.rebuild_with_content(key, e, uid, old_tt, new_id, new_tt, today, platform_only, moves, replaced)
                           for e in pubs)
        elif platform_only:
            res = "作らない（のりばだけの変更：" + "、".join(f"{m['name']} 約{m['m']}m" for m in moves) + "）"
        else:
            print(f"  {h['feed_name']} {new_id}: A・C′ に当たらないので、そのまま（承認を待つ）")
            continue
        if platform_only:
            res += "。のりばだけの変更：" + "、".join(f"{m['name']} {m['from']}→{m['to']} 約{m['m']}m" for m in moves)
        note = f"{x.started.isoformat()} 直しで扱った（A・B・C′）：{res}"
        h["resolved"] = note
        x.held_examples.pop(new_id, None)
        for r in found:
            if r["new_uid"] == new_id and r["revision"].startswith("止めた"):
                r["revision"] = f"{r['revision']} → {note}"
        print(f"  {h['feed_name']} {h['change_date']}：{note}")
    w.write_csv(x.data / "found.csv", w.FOUND_COLS, found)
    w.write_json(x.data / "revisions" / "index.json", x.index)
    w.write_held(x.data, x.held, x.held_examples)
    w.write_json(x.state / "notify_queue.json", x.notify_queue)
    w.write_attributions(x.site, x.index)
    cat = import_module("09_build_catalog")
    _, referenced = cat.build_catalog(x.site, x.seen, x.prev_feeds, x.index, today)
    cat.prune_timetables(x.site, referenced)


if __name__ == "__main__":
    main()
