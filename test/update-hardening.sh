#!/bin/bash
# Test helper: the real engine on a real release, with copies of its patch table changed to stand in
# for a release that moved its code or does not start. Needs the private X display.
# Usage: test/update-hardening.sh <run name> <built app folder> <real release .zip>
set -u
project=$(readlink -f -- "$(dirname -- "$0")/..")
run=$1 app=$(readlink -f -- "$2") release=$(readlink -f -- "$3")
container=${DSH_TEST_CONTAINER:-dsh-xvfb}
work=$project/.work/$run
fails=0
cd "$project"
rm -rf "$work"
mkdir -p "$work"
version=$(node -p 'require(process.argv[1]).upstreamVersion' "$app/resources/linux-port/port-info.json")

report() { # name ok detail
  if [ "$2" = yes ]; then echo "PASS $1: $3"; else echo "FAIL $1: $3"; fails=$((fails + 1)); fi
}
engine_copy() { # name, then what to append to its patch table
  mkdir -p "$work/$1"
  cp -a "$app/resources/linux-port" "$work/$1/engine"
  printf '\n%s\n' "$2" >> "$work/$1/engine/lib/patches.mjs"
}
build() { # name [env...]: runs that engine, leaves its output in $work/$name/out
  name=$1; shift
  mkdir -p "$work/$name/staging"
  started=$(date +%s)
  test/env.sh "$run-home" env -u NODE_OPTIONS "$@" ELECTRON_RUN_AS_NODE=1 ELECTRON_NO_ASAR=1 NODE_USE_ENV_PROXY=1 timeout 200 "$app/deepseek-harness" --disable-sigusr1 "$work/$name/engine/port.mjs" \
    --zip "$release" --out "$work/$name/out" --reuse "$app" --cache "$project/.work/cache" --work-dir "$work/$name/staging" --expect-version "$version" --progress-json > "$work/$name/log" 2>&1
  code=$?
  took=$(($(date +%s) - started))
  left=$(find "$work/$name/staging" "$work/$name" -maxdepth 1 \( -name '.port-*' -o -name '*.partial' \) | wc -l)
  running=$(grep -lz DSH_LINUX_START_TEST /proc/[0-9]*/environ 2>/dev/null | wc -l)
}
skipped() { node -p 'require(process.argv[1]).skippedPatches.length' "$work/$1/out/resources/linux-port/port-info.json" 2>/dev/null; }
last_line() { grep -vE '^\{' "$work/$1/log" | tail -1 | sed "s#$project/##g" | cut -c1-200; }

# --- The start test itself ---------------------------------------------------

marker=$work/started
started=$(date +%s.%N)
test/env.sh "$run-home" env DSH_LINUX_START_TEST="$marker" timeout 60 "$app/deepseek-harness" --no-sandbox --disable-gpu > "$work/direct.log" 2>&1
code=$?
took=$(python3 -c "import time;print(round(time.time()-$started,1))")
report 'the app reports its first page and leaves' "$([ "$code" = 0 ] && [ -s "$marker" ] && echo yes || echo no)" "exit $code after ${took}s, page $(cat "$marker" 2>/dev/null)"

# --- A release that moved its code -------------------------------------------

engine_copy nothing-changed ''
touch "$work/watching"
(while [ -e "$work/watching" ]; do docker exec "$container" sh -c 'export DISPLAY=:99; for w in $(xdotool search --onlyvisible --name "" 2>/dev/null); do xdotool getwindowname $w; done' 2>/dev/null; sleep 0.1; done > "$work/windows") &
watcher=$!
build nothing-changed
rm -f "$work/watching"; wait $watcher
seen=$(sort -u "$work/windows" | grep -cvE '^$|^Openbox$')
report 'a normal update builds and starts' "$([ "$code" = 0 ] && [ "$(skipped nothing-changed)" = 0 ] && ! grep -q 'did not start' "$work/nothing-changed/log" && echo yes || echo no)" "exit $code after ${took}s, skipped $(skipped nothing-changed)"
report 'no window reached the screen' "$([ "$seen" = 0 ] && echo yes || echo no)" "$seen seen"

engine_copy optional-moved "APP_PATCHES['lib/main.js'].find(([find]) => String(find.source ?? find).includes('setApplicationMenu'))[0] = 'code that this release does not have';
APP_PATCHES['lib/main.js'].find(([find]) => String(find).includes('backgroundNoticeBody: \"Running'))[0] = 'nor this';"
build optional-moved
report 'optional patches that moved do not stop an update' "$([ "$code" = 0 ] && [ "$(skipped optional-moved)" = 2 ] && [ "$left" = 0 ] && echo yes || echo no)" "exit $code, skipped $(skipped optional-moved), left behind $left"
report 'the log names them' "$(grep -c 'Going on without an optional patch' "$work/optional-moved/log" | grep -q '^2$' && echo yes || echo no)" "$(grep -m1 'Going on without' "$work/optional-moved/log" | cut -c1-120)"
report 'that build starts' "$(! grep -q 'did not start' "$work/optional-moved/log" && [ -x "$work/optional-moved/out/deepseek-harness" ] && echo yes || echo no)" ''

engine_copy required-moved "APP_PATCHES['lib/main.js'].find(([find]) => String(find).includes('--expose-internals'))[0] = 'code that this release does not have';"
build required-moved
report 'a safety patch that moved stops the update' "$([ "$code" = 1 ] && [ "$left" = 0 ] && [ ! -e "$work/required-moved/out" ] && echo yes || echo no)" "exit $code, left behind $left, message: $(last_line required-moved)"

engine_copy file-gone "APP_PATCHES['dsh/node_modules/@deepseek-ai/gone/lib/index.js'] = [['anything', 'else']];"
build file-gone
report 'a required patch on a file that is gone stops the update' "$([ "$code" = 1 ] && [ "$left" = 0 ] && echo yes || echo no)" "exit $code, message: $(last_line file-gone)"

# --- A release that does not start -------------------------------------------

engine_copy dies "APP_PATCHES['lib/main.js'].push(['const MANDATORY_IPC = {', 'process.exit(7);\nconst MANDATORY_IPC = {']);"
build dies
report 'a build that dies at start is refused' "$([ "$code" = 1 ] && [ "$left" = 0 ] && [ "$running" = 0 ] && [ ! -e "$work/dies/out" ] && grep -q 'did not start' "$work/dies/log" && echo yes || echo no)" "exit $code, left behind $left, still running $running, message: $(last_line dies)"

engine_copy throws "APP_PATCHES['lib/main.js'].push(['const MANDATORY_IPC = {', 'throw new Error(\"broken on Linux\");\nconst MANDATORY_IPC = {']);"
build throws
report 'a build that throws at start is refused' "$([ "$code" = 1 ] && [ "$left" = 0 ] && [ "$running" = 0 ] && [ ! -e "$work/throws/out" ] && echo yes || echo no)" "exit $code after ${took}s, still running $running, message: $(last_line throws)"

engine_copy hangs "APP_PATCHES['lib/main.js'].push(['const MANDATORY_IPC = {', 'await new Promise(() => {});\nconst MANDATORY_IPC = {']);"
build hangs
report 'a build that hangs at start is refused' "$([ "$code" = 1 ] && [ "$left" = 0 ] && [ "$running" = 0 ] && [ ! -e "$work/hangs/out" ] && echo yes || echo no)" "exit $code after ${took}s, still running $running, message: $(last_line hangs)"

# With no display at all neither version can start, which says nothing about the new one.
engine_copy no-display ''
build no-display DISPLAY=
report 'no display says nothing about the build' "$([ "$code" = 0 ] && grep -q 'does not pass this test here either' "$work/no-display/log" && echo yes || echo no)" "exit $code, $(grep -c 'did not start' "$work/no-display/log") notes"

rm -rf "$work" "$project/.work/$run-home"
echo "still running: $(grep -lz DSH_LINUX_START_TEST /proc/[0-9]*/environ 2>/dev/null | wc -l)"
[ "$fails" = 0 ] && echo 'all pass' || echo "$fails failed"
