#!/bin/bash
# Test helper: the whole road of an engine fix. An installed copy whose engine cannot build the release
# gets a signed fix from a local channel and updates in the real app, and the new version carries that
# engine. With a fix signed by anyone else it must stay as it is. Uses a throwaway key, never the real
# one. Needs the private X display.
# Usage: test/engine-fix-e2e.sh <run name> <package folder> <real release .zip>
set -u
project=$(readlink -f -- "$(dirname -- "$0")/..")
run=$1 package=$(readlink -f -- "$2") release=$(readlink -f -- "$3")
port=${DSH_TEST_PORT:-39433} feed=${DSH_TEST_FEED_PORT:-39543} channel=$((${DSH_TEST_FEED_PORT:-39543} + 1)) container=${DSH_TEST_CONTAINER:-dsh-xvfb}
work=$project/.work/$run
home=$work/home
root=$home/.local/share/deepseek-harness
fails=0
cd "$project"
version=$(cat "$package/VERSION")

report() { # name ok detail
  if [ "$2" = yes ]; then echo "PASS $1: $3"; else echo "FAIL $1: $3"; fails=$((fails + 1)); fi
}
cdp() { TARGET_MATCH=$1 timeout 8 node test/cdp.mjs "$port" eval "$2" 2>/dev/null; }
press() { cdp "$1" "(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='$2'&&b.offsetParent);if(b){b.click();return 'clicked'}return 'no'})()"; }
wait_button() { for _ in $(seq 1 "$3"); do [ "$(press "$1" "$2")" = '"clicked"' ] && return 0; sleep 1; done; return 1; }
alive() { ps -eo pid,args | grep -E "[.]work/$run/home/" | grep -v shell-snapshots | grep -vE '^ *[0-9]+ (sed|grep|cut|awk|ps) ' | awk '{print $1}'; }
stop_all() {
  pids=$(alive); [ -n "$pids" ] && kill $pids 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8; do [ -z "$(alive)" ] && break; sleep 1; done
  pids=$(alive); [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  sleep 1
}
open_app() {
  (DSH_LINUX_UPDATE_FEED=http://127.0.0.1:$feed/ DSH_LINUX_ENGINE_FEED=http://127.0.0.1:$channel/ DEEPSEEK_API_KEY=mock-local-test DEEPSEEK_BASE_URL=http://127.0.0.1:1/anthropic \
    nohup setsid test/env.sh "$run" "$root/deepseek-harness" --remote-debugging-port="$port" --disable-gpu --ozone-platform=x11 --enable-logging=stderr > "$work/app.log" 2>&1 &)
  for _ in $(seq 1 40); do cdp dsh-app 'document.querySelector("[data-windows-menu]") ? "ready" : ""' | grep -q ready && return; sleep 1; done
  echo "main window never appeared"
}
message() { # seconds: waits for the dialog to say something final, and opens the details
  for _ in $(seq 1 "$1"); do
    text=$(cdp update-dialog 'document.body.innerText')
    case "$text" in *'Could not'*) cdp update-dialog "[...document.querySelectorAll('button,summary,a')].find(e=>/technical details/i.test(e.innerText))?.click()" >/dev/null; sleep 0.3; text=$(cdp update-dialog 'document.body.innerText'); return 0 ;; esac
    case "$text" in *'Restart'*) return 0 ;; esac
    sleep 1
  done
  return 1
}

rm -rf "$work"
mkdir -p "$work"
# The throwaway key, and a package that trusts it: its engine number 2 has a patch this release cannot satisfy.
keyfile=$work/test-key.pem otherkey=$work/other-key.pem
DSH_ENGINE_KEY=$keyfile node tools/engine-release.mjs key > "$work/key.txt"
DSH_ENGINE_KEY=$otherkey node tools/engine-release.mjs key > "$work/other.txt"
public=$(sed -n 's/^Public key for port\/pins.json: //p' "$work/key.txt")
set_key() { node -e 'const fs=require("fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p));j.engine=Number(process.argv[3]);j.engineFixes.publicKey=process.argv[2];fs.writeFileSync(p,JSON.stringify(j,null,2))' "$1" "$public" "$2"; }

cp -a "$package" "$work/package"
stuck=$work/package/app/resources/linux-port
set_key "$stuck/pins.json" 2
printf '\n%s\n' "APP_PATCHES['lib/main.js'][0][0] = 'code that this release does not have';" >> "$stuck/lib/patches.mjs"
test/env.sh "$run" sh "$work/package/install.sh" </dev/null >/dev/null 2>&1
node test/fake-older.mjs "$root" "$version" 0.0.1 >/dev/null 2>&1

# The fix: the real engine, numbered 3 and signed with the throwaway key.
source=$work/fix-source
cp -a "$project/port" "$source"
set_key "$source/pins.json" 3
DSH_ENGINE_KEY=$keyfile DSH_ENGINE_SOURCE=$source node tools/engine-release.mjs pack "$work/channel" >/dev/null
report 'the release tool makes the three files' "$([ "$(ls "$work/channel" | wc -l)" = 3 ] && echo yes || echo no)" "$(ls "$work/channel" | paste -sd' ')"
DSH_ENGINE_KEY=$otherkey DSH_ENGINE_SOURCE=$source node tools/engine-release.mjs pack "$work/refused" >/dev/null 2>"$work/refused.err"
report 'the release tool refuses a key the engine does not pin' "$(grep -q 'not the key pinned' "$work/refused.err" && echo yes || echo no)" "$(grep -m1 'not the key' "$work/refused.err" | sed "s#$work/##g" | cut -c1-100)"

node test/mock-feed.mjs "$feed" ok "$release" "$version" >/dev/null 2>&1 & feed_pid=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -m 1 "127.0.0.1:$feed/" && break; sleep 0.2; done

# --- No fix yet --------------------------------------------------------------

mkdir -p "$work/empty"
(cd "$work/empty" && exec python3 -I -m http.server "$channel" --bind 127.0.0.1 >/dev/null 2>&1) & channel_pid=$!
sleep 1
open_app
wait_button dsh-app Update 30 >/dev/null
message 90
report 'with no fix, the stuck engine refuses the release' "$(printf '%s' "$text" | grep -q 'no longer applies' && echo yes || echo no)" "$(printf '%s' "$text" | grep -m1 'no longer applies' | sed "s#$project/##g" | cut -c1-130)"
report 'it stays on its version' "$([ "$(readlink "$root/current")" = versions/0.0.1 ] && echo yes || echo no)" "$(readlink "$root/current")"
stop_all
kill "$channel_pid" 2>/dev/null

# --- A fix signed by someone else --------------------------------------------

mkdir -p "$work/forged"
cp "$work/channel/"* "$work/forged/"
node -e 'const c=require("crypto"),fs=require("fs");const k=c.createPrivateKey(fs.readFileSync(process.argv[1]));fs.writeFileSync(process.argv[2]+"/engine.json.sig",c.sign(null,fs.readFileSync(process.argv[2]+"/engine.json"),k).toString("base64"))' "$otherkey" "$work/forged"
(cd "$work/forged" && exec python3 -I -m http.server "$channel" --bind 127.0.0.1 >/dev/null 2>&1) & channel_pid=$!
sleep 1
open_app
wait_button dsh-app Update 30 >/dev/null
message 90
report 'a forged fix is not used' "$(printf '%s' "$text" | grep -q 'no longer applies' && [ ! -e "$root/engines/3" ] && echo yes || echo no)" "$(tail -1 "$root/logs/engine-fix.log" | cut -c1-90)"
stop_all
kill "$channel_pid" 2>/dev/null

# --- The real fix ------------------------------------------------------------

(cd "$work/channel" && exec python3 -I -m http.server "$channel" --bind 127.0.0.1 >/dev/null 2>&1) & channel_pid=$!
sleep 1
open_app
wait_button dsh-app Update 30 >/dev/null
started=$(date +%s)
message 120
report 'the fix arrives and the update builds' "$(printf '%s' "$text" | grep -q 'Restart' && [ -e "$root/engines/3/port.mjs" ] && [ -x "$root/versions/$version/deepseek-harness" ] && echo yes || echo no)" "$(($(date +%s) - started))s, $(tail -1 "$root/logs/engine-fix.log" | cut -c1-60)"
report 'the update log shows the fixed engine ran' "$(grep -q 'is ready' "$root/logs/update-$version.log" && echo yes || echo no)" "$(grep -E '"step"' "$root/logs/update-$version.log" | tail -1 | cut -c1-70)"
press update-dialog 'Install and Restart' >/dev/null
for _ in $(seq 1 60); do [ "$(readlink "$root/current")" = "versions/$version" ] && break; sleep 1; done
sleep 8
carried=$(node -p 'require(process.argv[1]).engine' "$root/versions/$version/resources/linux-port/port-info.json" 2>/dev/null)
report 'the new version carries the fixed engine' "$([ "$carried" = 3 ] && echo yes || echo no)" "engine $carried, current $(readlink "$root/current")"
report 'the delivered copy is cleaned up' "$([ ! -e "$root/engines" ] && echo yes || echo no)" ''
for _ in $(seq 1 30); do pid=$(ps -eo pid,args | grep -E "[.]work/$run/home/[.]local/share/deepseek-harness/versions/$version/deepseek-harness .*--updated" | grep -v grep | head -1); [ -n "$pid" ] && break; sleep 1; done
report 'the new version starts' "$([ -n "$pid" ] && echo yes || echo no)" ''
stop_all
kill "$channel_pid" "$feed_pid" 2>/dev/null

rm -rf "$work"
echo "still running: $(alive | wc -l)"
[ "$fails" = 0 ] && echo 'all pass' || echo "$fails failed"
