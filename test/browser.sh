#!/bin/sh
# Drives the manager in headless Chrome against the pretend WVR and prints the results.
cd "$(dirname "$0")/.." || exit 1
PORT=8033
python3 tools/mock.py $PORT >/dev/null 2>&1 &
MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
sleep 1
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless=new --disable-gpu --autoplay-policy=no-user-gesture-required --window-size=1500,1100 \
  --virtual-time-budget=30000 --dump-dom "http://localhost:$PORT/test/browser.html" 2>/dev/null \
  | sed -n '/<pre id="result">/,/<\/pre>/p' | sed 's/<[^>]*>//g'
