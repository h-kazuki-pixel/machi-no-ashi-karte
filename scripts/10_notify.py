"""公開した改正を、通知のサーバー（Cloudflare Workers）に伝える。GitHub Pages に出したあとで動かす。

  NOTIFY_URL=https://….workers.dev NOTIFY_TOKEN=… python3 scripts/10_notify.py --site site

- 待ち行列は site/state/notify_queue.json（07_daily_watch.py が、改正を公開したときに入れる）。
- サーバーに送るのは「バスの番号」と「変わる日」だけ。サーバーは、そのバスを登録した宛先に10ずつ送り、
  続きの位置（next）を返す。続きは after に入れて、もう一度呼ぶ（無料プランの上限に収めるため）。
- サーバーは、公開中のバスの一覧（catalog.json）にその改正があるときだけ送る。Pages に出した直後は
  一覧がまだ古いことがあるので、409（not_published）のときは2分おきに6回まで待つ。それでもだめなら、次の実行に回す。
- NOTIFY_URL・NOTIFY_TOKEN が無いとき（通知のサーバーを作る前）は、何もしない。
- 待ち行列に7日より長くある改正は、送らずに外す。
- 合言葉はログに出さない。
- again の付いた行（公開中の改正を作り直して、便や時刻が変わった）は、サーバーが「前の知らせを送ったあと」のときだけ、
  もう一度だけ送る（「◯◯の、◯月◯日からの時刻表が、もう一度変わりました。」）。
"""
import argparse
import datetime as dt
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

JST = dt.timezone(dt.timedelta(hours=9))
MAX_QUEUE_DAYS = 7
WAIT_TRIES, WAIT_SEC = 6, 120


def call(url, token, body):
    req = urllib.request.Request(f"{url.rstrip('/')}/notify", data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}",
                                          "User-Agent": "machi-no-ashi-karte-notify/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


def send_one(url, token, q, sleep=time.sleep):
    """1つの改正を、最後の宛先まで送る。戻り値：'done' | 'retry'（次の実行に回す）"""
    tries = 0
    while True:
        body = {"feed": q["feed"], "change_date": q["change_date"], "after": q.get("after")}
        if q.get("again"):  # 公開中の改正が作り直されて、便や時刻が変わった：もう一度だけ知らせる
            body["again"] = True
        status, res = call(url, token, body)
        if status == 409 and res.get("error") == "not_published" and tries < WAIT_TRIES:
            tries += 1
            sleep(WAIT_SEC)
            continue
        if status != 200:
            print(f"  {q['feed']} {q['change_date']}: HTTP {status} {res.get('error', '')}")
            return "retry"
        tag = "（もう一度）" if q.get("again") else ""
        if res.get("already"):
            print(f"  {q['feed']} {q['change_date']}{tag}: 送り済み")
            return "done"
        if res.get("skipped") == "not_sent_before":
            print(f"  {q['feed']} {q['change_date']}{tag}: 前の知らせを送っていないので、送らない")
            return "done"
        print(f"  {q['feed']} {q['change_date']}: 送った {res.get('sent', 0)}、消した宛先 {res.get('removed', 0)}、"
              f"届かなかった {res.get('failed', 0)}、残り {res.get('remaining', 0)}")
        q["after"] = res.get("next")
        if not q["after"]:
            return "done"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="site")
    args = ap.parse_args()
    p = Path(args.site) / "state" / "notify_queue.json"
    queue = json.loads(p.read_text(encoding="utf-8")) if p.exists() else []
    url, token = os.environ.get("NOTIFY_URL", ""), os.environ.get("NOTIFY_TOKEN", "")
    if not queue:
        print("知らせる改正はありません")
        return
    if not url or not token:
        print(f"通知のサーバーが設定されていないため、送りません（待ち行列 {len(queue)}件）")
        return
    now = dt.datetime.now(JST)
    keep = []
    for q in queue:
        age = (now - dt.datetime.fromisoformat(q["queued_at"])).days
        if age > MAX_QUEUE_DAYS:
            print(f"  {q['feed']} {q['change_date']}: {age}日たったので外す")
            continue
        if send_one(url, token, q) == "retry":
            keep.append(q)
    p.write_text(json.dumps(keep, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
