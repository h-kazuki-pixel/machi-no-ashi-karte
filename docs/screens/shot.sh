#!/bin/zsh
# 使い方: ./shot.sh 名前 "today=2026-11-25#home" 高さ
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
src=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "demo=1&$2")
"$CH" --headless=new --disable-gpu --hide-scrollbars --window-size=390,$3 --virtual-time-budget=5000 --screenshot="$1.png" "http://127.0.0.1:8765/dev/phone.html?h=$3&src=$src" >/dev/null 2>&1
echo "$1 $(ls -l $1.png | awk '{print $5}')"
