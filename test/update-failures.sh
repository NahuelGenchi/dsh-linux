#!/bin/bash
# Test helper: drives the in-app update against a local feed that fails in each way a real one can.
# Every case must end in the app's normal "could not" message, with nothing left behind and the
# engine gone. Needs the private X display.
# Usage: test/update-failures.sh <run name> <package folder> <real release .zip>
set -u
project=$(readlink -f -- "$(dirname -- "$0")/..")
run=$1 package=$2 release=$3
port=${DSH_TEST_PORT:-39433} feed=${DSH_TEST_FEED_PORT:-39543} container=${DSH_TEST_CONTAINER:-dsh-xvfb}
cd "$project"
home=$project/.work/$run/home
root=$home/.local/share/deepseek-harness
version=$(cat "$package/VERSION")
blob=$project/.work/$run/blob.zip
fails=0

cdp() { TARGET_MATCH=$1 timeout 8 node test/cdp.mjs "$port" eval "$2" 2>/dev/null; }
press() { cdp "$1" "(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='$2'&&b.offsetParent);if(b){b.click();return 'clicked'}return 'no'})()"; }
alive() { ps -eo pid,args | grep -E "[.]work/$run/home/" | grep -v shell-snapshots | grep -vE '^ *[0-9]+ (sed|grep|cut|awk|ps) ' | awk '{print $1}'; }
stop_all() {
  pids=$(alive); [ -n "$pids" ] && kill $pids 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8; do [ -z "$(alive)" ] && break; sleep 1; done
  pids=$(alive); [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  [ -n "${feed_pid:-}" ] && kill "$feed_pid" 2>/dev/null
  chmod -R u+w "$root/staging" 2>/dev/null
  rm -rf "$root/staging"
  sleep 1
}
serve() { # A large release takes the feed a few seconds to hash before it answers.
  node test/mock-feed.mjs "$feed" "$@" >/dev/null 2>&1 & feed_pid=$!
  for _ in $(seq 1 150); do curl -s -o /dev/null -m 1 "127.0.0.1:$feed/" && return; sleep 0.2; done
}
opens=0
open_app() { # Each start keeps its own log, so a failed one can be read afterwards.
  opens=$((opens + 1))
  (DSH_LINUX_UPDATE_FEED=http://127.0.0.1:$feed/ DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS=5000 DEEPSEEK_API_KEY=mock-local-test DEEPSEEK_BASE_URL=http://127.0.0.1:1/anthropic \
    nohup setsid test/env.sh "$run" "$root/deepseek-harness" --remote-debugging-port="$port" --disable-gpu --ozone-platform=x11 --enable-logging=stderr > "$project/.work/$run/app-$opens.log" 2>&1 &)
  for _ in $(seq 1 40); do cdp dsh-app 'document.querySelector("[data-windows-menu]") ? "ready" : ""' | grep -q ready && return; sleep 1; done
  echo "main window never appeared: $(alive | wc -l) processes, $(curl -s -m 3 "127.0.0.1:$port/json/list" | grep -c '"url"') pages, log .work/$run/app-$opens.log"
}
wait_button() { for _ in $(seq 1 "$3"); do [ "$(press "$1" "$2")" = '"clicked"' ] && return 0; sleep 1; done; return 1; }
dialog() { cdp update-dialog 'document.body.innerText'; }
wait_message() { # pattern seconds: the reason sits behind "View technical details" once the download has failed.
  for _ in $(seq 1 "$2"); do
    text=$(dialog)
    case "$text" in *'Could not'*) cdp update-dialog "[...document.querySelectorAll('button,summary,a')].find(e=>/technical details/i.test(e.innerText))?.click()" >/dev/null; sleep 0.5; text=$(dialog) ;; esac
    case "$text" in *$1*) return 0 ;; esac
    sleep 1
  done
  return 1
}
report() { # name ok detail
  if [ "$2" = yes ]; then echo "PASS $1: $3"; else echo "FAIL $1: $3"; fails=$((fails + 1)); fi
}
leftovers() { find "$root/staging" "$root/versions" -maxdepth 1 \( -name '.port-*' -o -name '*.partial' \) 2>/dev/null | wc -l; }
download_case() { # name setup-mode expected-text [pre-command]
  serve "$2" "$blob"
  open_app
  [ -n "${4:-}" ] && eval "$4"
  wait_button dsh-app Update 30 >/dev/null
  started=$(date +%s)
  if wait_message "$3" 45; then
    report "$1" "$([ "$(leftovers)" = 0 ] && echo yes || echo no)" "$(($(date +%s) - started))s, left behind $(leftovers), message: $(printf '%s' "$text" | sed "s#$project/##g" | cut -c1-260)"
  else
    report "$1" no "no message after 45s, dialog: $(printf '%s' "$(dialog)" | cut -c1-120)"
  fi
  stop_all
}

rm -rf "$project/.work/$run"
mkdir -p "$project/.work/$run"
head -c 2000000 /dev/urandom > "$blob"
test/env.sh "$run" sh "$package/install.sh" </dev/null >/dev/null 2>&1
node test/fake-older.mjs "$root" "$version" 0.0.1 >/dev/null

# The download will not write through a planted link, so a read-only folder stands in for a failed
# write here, with the real dialog. test/updater-unit.mjs covers a real ENOSPC.
readonly_staging='mkdir -p "$root/staging"; chmod 555 "$root/staging"'
download_case 'download cannot write' ok 'EACCES' "$readonly_staging"
download_case 'download stalls' stall 'stopped receiving'
download_case 'connection cut' cut 'Could not'
download_case 'wrong hash' badhash 'failed verification'
download_case 'release is not a real archive' ok 'central directory'

# The update check itself: a feed that answers nothing must not leave the check waiting forever.
serve stallfeed
open_app
sleep 7
started=$(date +%s)
test/xclick.sh 68 20 /dev/null >/dev/null 2>&1; sleep 0.8
docker exec "$container" sh -c 'DISPLAY=:99 xdotool mousemove 195 143 click 1'
if wait_message 'Could not' 20; then report 'feed never answers' yes "$(($(date +%s) - started))s, message: $(printf '%s' "$text" | cut -c1-160)"
else report 'feed never answers' no "no message after 20s: $(printf '%s' "$(dialog)" | cut -c1-120)"; fi
stop_all

# A release the engine accepts, so it is still working when the app quits. The feed must name its
# real version, because the engine compares the two.
serve ok "$release" "$version"
open_app
wait_button dsh-app Update 30 >/dev/null
for _ in $(seq 1 450); do pgrep -f '[l]inux-port/port[.]mjs.*--out .*[.]work/'"$run"'/' >/dev/null && break; sleep 0.2; done
engine=$(pgrep -f '[l]inux-port/port[.]mjs.*--out .*[.]work/'"$run"'/' | wc -l)
quit_app() {
  docker exec "$container" sh -c "export DISPLAY=:99; w=\$(xdotool search --onlyvisible --name 'DeepSeek Harness' | tail -1); xdotool windowfocus \$w; sleep 0.3; xdotool key ctrl+q"
  sleep 1
  press update-dialog Quit >/dev/null; press dsh-app Quit >/dev/null
  for i in $(seq 1 40); do [ -z "$(alive)" ] && break; sleep 1; done
}
quit_app
report 'quit while preparing an update' "$([ "$engine" -ge 1 ] && [ -z "$(alive)" ] && [ "$(leftovers)" = 0 ] && echo yes || echo no)" "engine was running: $engine, gone after ${i}s, left behind $(leftovers)"
stop_all

# A dialog holds the keyboard while it is open, so the way out is to dismiss it and then quit.
serve ok "$blob"
open_app
wait_button dsh-app Update 30 >/dev/null
wait_message 'central directory' 45 && failed=yes
press update-dialog OK >/dev/null
sleep 1
quit_app
report 'quit after a failed update' "$([ "${failed:-no}" = yes ] && [ -z "$(alive)" ] && echo yes || echo no)" "message shown: ${failed:-no}, gone after ${i}s, processes left: $(alive | wc -l)"
stop_all

# The same once the update is ready, when the user closes the dialog instead of restarting.
rm -rf "$root/versions/$version"
serve ok "$release" "$version"
open_app
wait_button dsh-app Update 30 >/dev/null
for _ in $(seq 1 120); do [ -n "$(cdp update-dialog "[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='Install and Restart'&&b.offsetParent)||''" | grep true)" ] && ready=yes && break; sleep 1; done
cdp update-dialog 'window.close()' >/dev/null
sleep 1
quit_app
report 'quit after closing a ready update' "$([ "${ready:-no}" = yes ] && [ -z "$(alive)" ] && echo yes || echo no)" "ready: ${ready:-no}, gone after ${i}s, processes left: $(alive | wc -l)"
stop_all

echo "update failures: $fails failed"
[ "$fails" = 0 ]
