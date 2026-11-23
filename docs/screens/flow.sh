#!/bin/zsh
# 使い方: ./flow.sh 名前 "アプリのURLの?以降" 高さ "手順"
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
q(){ python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$1"; }
"$CH" --headless=new --disable-gpu --hide-scrollbars --window-size=390,$3 --virtual-time-budget=9000 --screenshot="$1.png" "http://127.0.0.1:8765/dev/phone.html?h=$3&src=$(q "$2")&do=$(q "$4")" >/dev/null 2>&1
echo "$1 $(ls -l $1.png | awk '{print $5}')"
