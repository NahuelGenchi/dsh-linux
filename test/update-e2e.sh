#!/bin/sh
# Test helper: installs a package into an isolated home, fakes an older version and drives the
# real in-app update against the live feed. Needs the private X display.
# Usage: test/update-e2e.sh <run name> <package .tar.xz> <version> <older version>
set -u
project=$(readlink -f -- "$(dirname -- "$0")/..")
run=$1 package=$2 version=$3 older=$4
port=${DSH_TEST_PORT:-$port}
container=${DSH_TEST_CONTAINER:-dsh-xvfb}
cd "$project"
root="$project/.work/$run/home/.local/share/deepseek-harness"
match="[.]work/$run/home/[.]local/share/deepseek-harness/versions/"
unpack="$project/.work/$run-unpack"
rm -rf "$project/.work/$run" "$unpack"
cdp() { TARGET_MATCH=$1 node test/cdp.mjs $port eval "$2" 2>/dev/null; }
press() { cdp "$1" "(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='$2'&&b.offsetParent);if(b){b.click();return 'clicked $2'}return 'none'})()"; echo; }
until_button() { timeout "$3" sh -c "until TARGET_MATCH=$1 node test/cdp.mjs $port eval \"[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='$2'&&b.offsetParent)\" 2>/dev/null | grep -q true; do :; done"; }

mkdir -p "$unpack"
tar -xf "$package" -C "$unpack"
test/env.sh "$run" sh "$unpack/dsh-linux-$version-x64/install.sh" </dev/null | tail -1 | sed "s#$project/##"
node test/fake-older.mjs "$root" "$version" "$older" || exit 1
nohup setsid test/env.sh "$run" "$root/deepseek-harness" --remote-debugging-port=$port --disable-gpu --ozone-platform=x11 --enable-logging=stderr > ".work/$run/app.log" 2>&1 &
timeout 25 sh -c "until curl -s 127.0.0.1:$port/json/list | grep -q page; do :; done"
until_button welcome 'Add API Key' 15; press welcome 'Add API Key'
until_button welcome 'Set up later' 6; press welcome 'Set up later'
until_button dsh-app 'Update' 40 && echo "update button shown"
press dsh-app 'Update'
started=$(date +%s)
timeout 240 sh -c "until node test/cdp.mjs $port list 2>/dev/null | grep -q update-dialog; do :; done"; echo "prepared in $(( $(date +%s) - started ))s"
press update-dialog 'Install and Restart'
timeout 60 sh -c "until [ -e '$root/previous' ]; do :; done"; echo "switched: $(readlink "$root/current"), previous: $(readlink "$root/previous")"
timeout 60 sh -c "until pgrep -f '$match$version/deepseek-harness.*--updated' >/dev/null; do :; done"; echo "relaunched: $?"
timeout 30 sh -c "until docker exec $container sh -c 'DISPLAY=:99 xdotool search --onlyvisible --name \"DeepSeek Harness\"' 2>/dev/null | grep -q .; do :; done"; echo "window: $?"
pkill -f "$match"
timeout 15 sh -c "while pgrep -f '$match' >/dev/null; do :; done"; echo "closed: $?"
