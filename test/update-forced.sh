#!/bin/bash
# Test helper: the server demands an update on a throwaway copy, whose answer from DeepSeek is simulated.
# First the release cannot be built: the choice must appear, going back must keep the block, keeping
# this version must open the app, and the next start must block and try again. Then a release that
# builds must go through as usual, with no choice offered. Needs the private X display.
# Usage: test/update-forced.sh <run name> <package folder> <real release .zip>
set -u
project=$(readlink -f -- "$(dirname -- "$0")/..")
run=$1 package=$(readlink -f -- "$2") release=$(readlink -f -- "$3")
port=${DSH_TEST_PORT:-39433} feed=${DSH_TEST_FEED_PORT:-39543} container=${DSH_TEST_CONTAINER:-dsh-xvfb}
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
targets() { curl -s -m 3 "127.0.0.1:$port/json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const t of JSON.parse(s||"[]"))console.log(t.url.slice(0,70))})'; }
alive() { ps -eo pid,args | grep -E "[.]work/$run/home/" | grep -v shell-snapshots | grep -vE '^ *[0-9]+ (sed|grep|cut|awk|ps) ' | awk '{print $1}'; }
xwindows() { docker exec "$container" sh -c 'export DISPLAY=:99; for w in $(xdotool search --onlyvisible --name "" 2>/dev/null); do echo "$w $(xdotool getwindowname $w)"; done' | grep -v Openbox; }
serve() { node test/mock-feed.mjs "$feed" ok "$1" "$2" >/dev/null 2>&1 & feed_pid=$!; for _ in $(seq 1 150); do curl -s -o /dev/null -m 1 "127.0.0.1:$feed/" && return; sleep 0.2; done; }
open_app() {
  (DSH_LINUX_UPDATE_FEED=http://127.0.0.1:$feed/ DSH_LINUX_ENGINE_FEED=http://127.0.0.1:1/ DEEPSEEK_API_KEY=mock-local-test DEEPSEEK_BASE_URL=http://127.0.0.1:1/anthropic \
    nohup setsid test/env.sh "$run" "$root/deepseek-harness" --remote-debugging-port="$port" --disable-gpu --ozone-platform=x11 --enable-logging=stderr > "$work/app-$1.log" 2>&1 &)
  for _ in $(seq 1 40); do targets | grep -q mandatory && return 0; sleep 1; done
  return 1
}
stop_all() {
  pids=$(alive); [ -n "$pids" ] && kill $pids 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8; do [ -z "$(alive)" ] && break; sleep 1; done
  pids=$(alive); [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  sleep 1
}
button() { cdp mandatory "(()=>{const b=[...document.querySelectorAll('button')].find(b=>/$1/i.test(b.innerText)&&b.offsetParent&&!b.disabled);if(b){b.click();return 'clicked '+b.innerText.trim()}return ''})()"; }
wait_button() { for _ in $(seq 1 "$2"); do r=$(button "$1"); case "$r" in *clicked*) return 0 ;; esac; sleep 1; done; return 1; }
# The choice carries the app's name, as only the main window does otherwise.
named() { xwindows | grep -c ' DeepSeek Harness$'; }
choice_up() { for _ in $(seq 1 "$1"); do [ "$(named)" -ge 2 ] && return 0; sleep 1; done; return 1; }
# Second button: Tab moves to it from the default, Return takes the default.
answer() { docker exec "$container" sh -c "export DISPLAY=:99; w=\$(xdotool search --onlyvisible --name 'DeepSeek Harness' | tail -1); xdotool windowactivate --sync \$w 2>/dev/null; sleep 0.4; xdotool key $1"; }

rm -rf "$work"
mkdir -p "$work"
# A package that believes the server demands an update, on a copy so the real package stays as it was.
cp -a "$package" "$work/package"
cat > "$work/simulate.mjs" <<EOF
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAsar, extractAsar } from '$project/port/lib/asar.mjs';
const archive = '$work/package/app/resources/app.asar';
const temporary = mkdtempSync('$work/asar-');
const unpacked = extractAsar(archive, temporary);
const main = join(temporary, 'lib', 'main.js');
const find = 'const body = await response.json();';
const text = readFileSync(main, 'utf8');
if (text.split(find).length !== 2) throw new Error('the policy code has moved');
writeFileSync(main, text.replace(find, 'const body = {code:40005,data:{show_content:{title:"Update to continue",detail:"Simulated"}}};'));
await createAsar(temporary, archive, (path) => unpacked.has(path));
rmSync(temporary, { recursive: true, force: true });
EOF
node "$work/simulate.mjs"
test/env.sh "$run" sh "$work/package/install.sh" </dev/null >/dev/null 2>&1

# --- A release that cannot be built ------------------------------------------

head -c 2000000 /dev/urandom > "$work/blob.zip"
serve "$work/blob.zip" 99.0.0
open_app first
report 'the app opens blocked' "$(targets | grep -q mandatory && echo yes || echo no)" "$(targets | paste -sd' ' | cut -c1-120)"
wait_button 'download|update' 30 && ok=yes || ok=no
report 'the update starts from the block' "$ok" "$r"
if choice_up 60; then shown=yes; else shown=no; fi
report 'a failed build offers the choice' "$shown" "$(named) windows carry the app's name"
sleep 1
docker exec "$container" sh -c 'export DISPLAY=:99; import -window root /tmp/choice.png' 2>/dev/null
docker cp "$container":/tmp/choice.png "$work/choice.png" 2>/dev/null
report 'the block stays up behind it' "$(targets | grep -q mandatory && echo yes || echo no)" "$(cdp mandatory 'document.body.innerText' | cut -c1-110)"

answer 'Tab Return'
for _ in $(seq 1 10); do [ "$(named)" -le 1 ] && break; sleep 1; done
report 'the dialog closes on an answer' "$([ "$(named)" -le 1 ] && echo yes || echo no)" "$(named) windows carry the app's name"
report 'going back keeps the block' "$(targets | grep -q mandatory && echo yes || echo no)" "$(cdp mandatory 'document.body.innerText' | cut -c1-110)"

wait_button 'retry|download|update' 20 && ok=yes || ok=no
report 'the block can try again' "$ok" "$r"
choice_up 60 && shown=yes || shown=no
report 'trying again offers the choice again' "$shown" ''
answer Return
for _ in $(seq 1 10); do targets | grep -q mandatory || break; sleep 1; done
report 'keeping this version lifts the block' "$(targets | grep -q mandatory && echo no || echo yes)" "$(targets | paste -sd' ' | cut -c1-100)"
# A real mouse click on the main window: the block was a native modal, so only this shows it has let go.
home_page() { cdp dsh-app://app 'document.body.innerText'; }
for _ in $(seq 1 40); do home_page | grep -q 'Choose workspace' && ! home_page | grep -q 'Loading plugins' && break; sleep 1; done
spot=$(cdp dsh-app://app '(()=>{const e=[...document.querySelectorAll("button,a,[role=button]")].find(e=>e.innerText.trim().startsWith("Plugins"));if(!e)return "";const r=e.getBoundingClientRect();return Math.round(r.x+r.width/2)+" "+Math.round(r.y+r.height/2)})()' | tr -d '"')
was=$(home_page)
# shellcheck disable=SC2086
test/xclick.sh $spot "$work/click.png"
sleep 2
now=$(home_page)
report 'the main window takes real clicks' "$([ -n "$spot" ] && [ "$was" != "$now" ] && echo yes || echo no)" "clicked Plugins at $spot, the page changed: $([ "$was" != "$now" ] && echo yes || echo no)"
report 'the failed release left nothing built' "$([ "$(find "$root/staging" "$root/versions" -maxdepth 1 \( -name '.port-*' -o -name '*.partial' \) 2>/dev/null | wc -l)" = 0 ] && [ ! -e "$root/versions/99.0.0" ] && echo yes || echo no)" "current: $(readlink "$root/current")"
stop_all

open_app second
report 'the next start asks again' "$(targets | grep -q mandatory && echo yes || echo no)" ''
stop_all
kill "$feed_pid" 2>/dev/null

# --- A release that builds ---------------------------------------------------

node test/fake-older.mjs "$root" "$version" 0.0.1 >/dev/null || echo 'could not make the version older'
serve "$release" "$version"
open_app third
wait_button 'download|update' 30 && ok=yes || ok=no
report 'a forced update that can be built starts' "$ok" "$r"
ready=no
for i in $(seq 1 120); do
  buttons=$(cdp mandatory '[...document.querySelectorAll("button")].filter(b=>b.offsetParent&&!b.disabled).map(b=>b.innerText.trim()).join("|")')
  case "$buttons" in *ontinue*|*nstall*|*estart*) ready=yes; break ;; esac
  sleep 1
done
report 'it gets ready without the choice' "$([ "$ready" = yes ] && [ -e "$root/versions/$version" ] && [ "$(named)" -le 1 ] && echo yes || echo no)" "after ${i}s, buttons: $buttons, $(named) windows carry the app's name"
wait_button 'continue|install|restart' 10 >/dev/null
sleep 2
wait_button 'continue|install|restart' 5 >/dev/null
for _ in $(seq 1 40); do [ "$(readlink "$root/current")" = "versions/$version" ] && break; sleep 1; done
report 'it installs and switches as usual' "$([ "$(readlink "$root/current")" = "versions/$version" ] && echo yes || echo no)" "current: $(readlink "$root/current")"
stop_all
kill "$feed_pid" 2>/dev/null

cp "$work/choice.png" "$project/.work/$run-choice.png" 2>/dev/null
rm -rf "$work"
echo "still running: $(alive | wc -l)"
[ "$fails" = 0 ] && echo 'all pass' || echo "$fails failed"
