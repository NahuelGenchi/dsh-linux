#!/bin/sh
# Test helper: installs a built package into an isolated home and walks through closing and quitting
# the way a user does on the private display: close button, notice, reopen, Ctrl+Q.
# Usage: test/quit.sh <run name> <package folder>
set -u
run=$1
package=$2
here=$(dirname -- "$(readlink -f -- "$0")")
work=$(readlink -f -- "$here/../.work")
home=$work/$run/home
shots=$work/$run/shots
launcher=$home/.local/share/deepseek-harness/deepseek-harness
port=${DSH_TEST_PORT:-39433}
container=${DSH_TEST_CONTAINER:-dsh-xvfb}
mkdir -p "$shots"

alive() { ps -eo args | grep -cE "[.]work/$run/home/[.]local/share/deepseek-harness/"; }
visible() { docker exec "$container" sh -c "DISPLAY=:99 xdotool search --onlyvisible --name 'DeepSeek Harness' 2>/dev/null | wc -l"; }
key() { docker exec "$container" sh -c "export DISPLAY=:99; w=\$(xdotool search --onlyvisible --name 'DeepSeek Harness' | tail -1); xdotool windowfocus \$w; sleep 1; xdotool key $1"; }
shot() { docker exec "$container" sh -c 'export DISPLAY=:99; import -pause 1 -window root /tmp/shot.png'; docker cp "$container":/tmp/shot.png "$shots/$1.png" 2>&1 | grep -v Successfully; }
open_app() {
  DEEPSEEK_API_KEY=mock-local-test DEEPSEEK_BASE_URL=http://127.0.0.1:39422/anthropic \
  "$here/env.sh" "$run" "$launcher" --remote-debugging-port=$port --disable-gpu --ozone-platform=x11 --enable-logging=stderr "$@"
}

"$here/env.sh" "$run" sh "$package/install.sh" > /dev/null </dev/null
open_app > "$work/$run/app.log" 2>&1 &

tries=0
until TARGET_MATCH=dsh-app node "$here/cdp.mjs" "$port" eval 'document.querySelector("[data-windows-menu]") ? "ready" : ""' 2>/dev/null | grep -q ready; do
  tries=$((tries + 1))
  if [ "$tries" -gt 60 ]; then echo "The main window did not appear"; pkill -f "[.]work/$run/home/[.]local/share/deepseek-harness/"; exit 1; fi
  sleep 1
done
sleep 3
echo "running: $(alive) processes, $(visible) visible window"

"$here/xclick.sh" 1262 20 "$shots/notice.png"
sleep 1
"$here/xclick.sh" 640 443 "$shots/confirmed.png"
sleep 2
marker=$(find "$home/.config" -name background-close-confirmed | wc -l)
echo "closed:  $(alive) processes, $(visible) visible windows, notice recorded: $marker"
shot closed

open_app > /dev/null 2>&1
sleep 3
echo "reopened: $(alive) processes, $(visible) visible window"
shot reopened

key ctrl+q
started=$(date +%s)
for i in $(seq 1 30); do
  [ "$(alive)" = 0 ] && break
  sleep 1
done
echo "Ctrl+Q:  $(alive) processes left after $(($(date +%s) - started)) seconds"
echo "tray problems logged: $(grep -c 'desktop tray' "$work/$run/app.log")"
if [ "$(alive)" != 0 ]; then
  pkill -f "[.]work/$run/home/[.]local/share/deepseek-harness/"
  for i in $(seq 1 10); do [ "$(alive)" = 0 ] && break; sleep 1; done
  echo "after SIGTERM: $(alive) processes left"
fi
