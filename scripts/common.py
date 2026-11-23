"""共通：API への控えめなアクセス（1秒以上あける・キャッシュ・再開）"""
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
