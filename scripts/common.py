"""共通：API への控えめなアクセス（1秒以上あける・キャッシュ・再開）"""
import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "cache"
DATA = ROOT / "data"
API = "https://api.gtfs-data.jp/v2"
MIN_INTERVAL = 1.2  # 秒。指示は「1秒以上」

_last = 0.0


# 呼び出しの回数（毎日の仕組みの記録用）
REQUESTS = {"count": 0}


def user_agent() -> str:
    contact = os.environ.get("GTFS_CONTACT", "").strip()
    if not contact:
        sys.exit(
            "環境変数 GTFS_CONTACT が未設定です。User-Agent に入れる連絡先を設定してください。\n"
            "  例: export GTFS_CONTACT=you@example.com"
        )
    return f"machi-no-ashi-karte-research/0.1 (+mailto:{contact})"


def _wait():
    global _last
    REQUESTS["count"] += 1
    dt = time.monotonic() - _last
    if dt < MIN_INTERVAL:
        time.sleep(MIN_INTERVAL - dt)
    _last = time.monotonic()


def fetch(url: str, dest: Path, retries: int = 3) -> Path:
    """url を dest に保存。既にあれば取らない（同じものを二度取らない）。"""
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    ua = user_agent()
    for i in range(retries):
        _wait()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": ua})
            with urllib.request.urlopen(req, timeout=120) as r:
                body = r.read()
                enc = (r.headers.get("Content-Encoding") or "").lower()
            # 頼んでいなくても gzip で返ることがある（/files で確認）。zip（PK…）はそのまま
            if enc == "gzip" or (body[:2] == b"\x1f\x8b" and dest.suffix == ".json"):
                body = gzip.decompress(body)
            tmp = dest.with_suffix(dest.suffix + ".part")
            tmp.write_bytes(body)
            tmp.replace(dest)  # 途中で止まっても壊れたファイルを残さない
            return dest
        except urllib.error.HTTPError as e:
            if e.code in (400, 403, 404):
                raise
            print(f"  HTTP {e.code} {url} retry {i+1}", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print(f"  {e!r} {url} retry {i+1}", file=sys.stderr)
        time.sleep(5 * (i + 1))
    raise RuntimeError(f"failed: {url}")


def fetch_json(url: str, dest: Path):
    return json.loads(fetch(url, dest).read_text(encoding="utf-8"))


def probe(url: str, dest: Path) -> dict:
    """zip を落とさず、先頭1バイトだけ取って S3 の ETag と全体のサイズを得る（キャッシュする）。"""
    if dest.exists():
        return json.loads(dest.read_text())
    dest.parent.mkdir(parents=True, exist_ok=True)
    _wait()
    req = urllib.request.Request(url, headers={"User-Agent": user_agent(), "Range": "bytes=0-0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        h = r.headers
        info = {
            "status": r.status,
            "etag": (h.get("ETag") or "").strip('"'),
            "size": (h.get("Content-Range") or "").split("/")[-1],
            "last_modified": h.get("Last-Modified"),
        }
    dest.write_text(json.dumps(info))
    return info


def probe_fresh(url: str, retries: int = 3) -> dict:
    """zip を落とさず、先頭1バイトだけ取って ETag と Last-Modified を得る（キャッシュしない。毎日の確かめ用）。"""
    from email.utils import parsedate_to_datetime
    for i in range(retries):
        _wait()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": user_agent(), "Range": "bytes=0-0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                h = r.headers
                lm = h.get("Last-Modified")
                return {"etag": (h.get("ETag") or "").strip('"'),
                        "last_modified": parsedate_to_datetime(lm) if lm else None,
                        "size": (h.get("Content-Range") or "").split("/")[-1]}
        except urllib.error.HTTPError as e:
            if e.code in (400, 403, 404):
                raise
        except Exception:  # noqa: BLE001
            pass
        time.sleep(5 * (i + 1))
    raise RuntimeError(f"probe failed: {url}")


def zip_members(z, aliases=True):
    """zip の中のファイル：名前（フォルダを除く）→ zip の中のパス。
    aliases=True のとき、「stop_times.csv」のように .csv の名前で入っているファイルも、
    同じ名前の .txt が無ければ「stop_times.txt」として読めるようにする（つくば市の2フィードなど）。"""
    names = {n.split("/")[-1]: n for n in z.namelist() if not n.endswith("/")}
    if aliases:
        for n, p in list(names.items()):
            if n.lower().endswith(".csv"):
                txt = n[:-4] + ".txt"
                names.setdefault(txt, p)
    return names
