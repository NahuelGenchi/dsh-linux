#!/bin/bash
# Test helper: everything around the app's life that a user never clicks: being told to stop by the
# system, odd install paths, upgrading over an old install, the sandbox rule and uninstalling.
# Needs the private X display.
# Usage: test/lifecycle.sh <run name> <package folder>
set -u
project=$(readlink -f -- "$(dirname -- "$0")/..")
run=$1 package=$2
port=${DSH_TEST_PORT:-39433} mock=${DSH_TEST_MOCK_PORT:-39533} container=${DSH_TEST_CONTAINER:-dsh-xvfb}
cd "$project"
home=$project/.work/$run/home
root=$home/.local/share/deepseek-harness
fails=0

cdp() { TARGET_MATCH=$1 timeout 8 node test/cdp.mjs "$port" eval "$2" 2>/dev/null; }
alive() { ps -eo pid,args | grep -F ".work/$run/" | grep -v shell-snapshots | grep -vE '^ *[0-9]+ (sed|grep|cut|awk|ps|tail) ' | grep -v 'test/lifecycle' | awk '{print $1}'; }
main_pid() { ps -eo pid,args | grep -E "/(current|versions/[^/]+)/deepseek-harness( |$)" | grep -F ".work/$run/" | grep -v -- '--type=' | grep -v -- '--expose-internals' | grep -v shell-snapshots | awk 'NR==1{print $1}'; }
report() { if [ "$2" = yes ]; then echo "PASS $1: $3"; else echo "FAIL $1: $3"; fails=$((fails + 1)); fi; }
stop_all() {
  pids=$(alive); [ -n "$pids" ] && kill $pids 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8; do [ -z "$(alive)" ] && break; sleep 1; done
  pids=$(alive); [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  sleep 1
}
wait_main() { for i in $(seq 1 "${1:-40}"); do cdp dsh-app 'document.querySelector("[data-windows-menu]") && !/Loading plugins/.test(document.body.innerText) ? "ready" : ""' | grep -q ready && return 0; sleep 1; done; return 1; }
open_app() { # launcher [extra env assignments...]
  launcher=$1; shift
  (env "$@" DEEPSEEK_API_KEY=mock-local-test DEEPSEEK_BASE_URL=http://127.0.0.1:$mock/anthropic \
    nohup setsid test/env.sh "$run" "$launcher" --remote-debugging-port="$port" --disable-gpu --ozone-platform=x11 --enable-logging=stderr > "$project/.work/$run.log" 2>&1 &)
}
key() { docker exec "$container" sh -c "export DISPLAY=:99; w=\$(xdotool search --onlyvisible --name 'DeepSeek Harness' | tail -1); xdotool windowfocus \$w; sleep 0.3; xdotool $1"; }
start_task() { # Leaves a long command running inside a task.
  key 'key ctrl+n'; sleep 1.5
  cdp dsh-app '(()=>{const e=document.querySelector("[contenteditable=true],textarea");e&&e.focus();return !!e})()' >/dev/null
  key "type --delay 15 'run the check'"; sleep 0.3; key 'key Return'
  for _ in $(seq 1 20); do pgrep -f '^sleep 317' >/dev/null && return 0; sleep 1; done
  return 1
}
gone_in() { for i in $(seq 1 "$1"); do [ -z "$(alive)" ] && return 0; sleep 1; done; return 1; }

rm -rf "$project/.work/$run" "$project/.work/$run.log"
MOCK_COMMAND='sleep 317' nohup setsid node test/mock-model.mjs "$mock" "$project/.work/$run.mock.log" >/dev/null 2>&1 &
mock_pid=$!
sleep 0.5

# --- Fresh home with no config folder -----------------------------------------------------------
test/env.sh "$run" sh "$package/install.sh" </dev/null >/dev/null 2>&1
report 'dsh:// handler on a fresh home' "$(test/env.sh "$run" xdg-mime query default x-scheme-handler/dsh | grep -q deepseek-harness && [ ! -e "$home/.config/mimeapps.list.new" ] && echo yes || echo no)" "$(test/env.sh "$run" xdg-mime query default x-scheme-handler/dsh)"

# --- Told to stop by the system with a task running ----------------------------------------------
mkdir -p "$home/Documents"
echo 'XDG_DOCUMENTS_DIR="$HOME/Documents"' > "$home/.config/user-dirs.dirs"
for signal in TERM HUP; do
  open_app "$root/deepseek-harness"
  wait_main; sleep 1
  started=no; start_task && started=yes
  pid=$(main_pid); kill -"$signal" "$pid"; begun=$(date +%s)
  gone_in 20 && left=0 || left=$(alive | wc -l)
  task=$(pgrep -fc '^sleep 317')
  report "SIG$signal with a task running" "$([ "$started" = yes ] && [ "$left" = 0 ] && [ "$task" = 0 ] && echo yes || echo no)" "task started: $started, gone after $(($(date +%s) - begun))s, processes left $left, tasks left $task"
  stop_all; pkill -f '^sleep 317'
done

# Logout and systemd signal every process of the session at the same moment.
open_app "$root/deepseek-harness"
wait_main; sleep 1
started=no; start_task && started=yes
pids=$(alive); kill -TERM $pids; begun=$(date +%s)
gone_in 20 && left=0 || left=$(alive | wc -l)
task=$(pgrep -fc '^sleep 317')
report 'SIGTERM to every process at once' "$([ "$started" = yes ] && [ "$left" = 0 ] && [ "$task" = 0 ] && echo yes || echo no)" "task started: $started, gone after $(($(date +%s) - begun))s, processes left $left, tasks left $task"
stop_all; pkill -f '^sleep 317'
open_app "$root/deepseek-harness"
ok=no; wait_main && ok=yes
sessions=$(cdp dsh-app 'document.body.innerText' | grep -c 'Mock title')
report 'starts again after that, with its sessions' "$([ "$ok" = yes ] && [ "$sessions" != 0 ] && echo yes || echo no)" "window ready $ok, sessions listed $sessions"
stop_all

# --- A sandbox rule that names some other install ------------------------------------------------
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] && [ -e /etc/apparmor.d/deepseek-harness ]; then
  # env.sh turns Chromium's sandbox off for test copies, so turn that back off for this one case.
  (env DEEPSEEK_API_KEY=mock-local-test DEEPSEEK_BASE_URL=http://127.0.0.1:$mock/anthropic nohup setsid test/env.sh "$run" env -u ELECTRON_DISABLE_SANDBOX "$root/deepseek-harness" --remote-debugging-port="$port" --disable-gpu --ozone-platform=x11 --enable-logging=stderr > "$project/.work/$run.log" 2>&1 &)
  ok=no; wait_main 25 && ok=yes
  report 'sandbox rule for another path' "$ok" "$(grep -m1 -o 'Running without Chromium.s sandbox\|SUID sandbox helper' "$project/.work/$run.log")"
  stop_all
else
  echo "SKIP sandbox rule for another path: this machine has no rule"
fi

# --- Upgrading over an older install -------------------------------------------------------------
version=$(cat "$package/VERSION")
mkdir -p "$root/versions/0.0.1" "$root/versions/0.0.2"; cp -a "$root/versions/$version/." "$root/versions/0.0.2/"
ln -sfn versions/0.0.2 "$root/current"
test/env.sh "$run" sh "$package/install.sh" </dev/null >/dev/null 2>&1
report 'upgrade keeps one version to go back to' "$([ "$(readlink "$root/previous")" = versions/0.0.2 ] && [ "$(ls "$root/versions" | wc -l)" = 2 ] && echo yes || echo no)" "previous: $(readlink "$root/previous"), versions: $(ls "$root/versions" | tr '\n' ' ')"
test/env.sh "$run" sh "$root/deepseek-harness" --rollback >/dev/null
report 'rollback after upgrade' "$([ "$(readlink "$root/current")" = versions/0.0.2 ] && echo yes || echo no)" "current: $(readlink "$root/current")"
ln -sfn "versions/$version" "$root/current"
rm -rf "$root/versions/0.0.2" "$root/previous"

# --- Uninstalling --------------------------------------------------------------------------------
open_app "$root/deepseek-harness"
wait_main
test/env.sh "$run" sh "$root/uninstall.sh" </dev/null >/dev/null 2>&1; refused=$?
report 'uninstall refuses while the app runs' "$([ "$refused" = 1 ] && [ -x "$root/deepseek-harness" ] && echo yes || echo no)" "exit $refused"
stop_all
ln -sfn "$root/current/resources/runtime/cli/bin/dsh" "$home/.local/bin/dsh"; : > "$home/.local/bin/.dsh-desktop-command.json"
test/env.sh "$run" sh "$root/uninstall.sh" </dev/null >/dev/null 2>&1
left=$( { [ -e "$root" ] && echo root; [ -L "$home/.local/bin/dsh" ] && echo dsh; [ -e "$home/.local/bin/.dsh-desktop-command.json" ] && echo marker; [ -L "$home/.local/bin/deepseek-harness" ] && echo link; [ -e "$home/.local/share/applications/deepseek-harness.desktop" ] && echo entry; grep -l 'dsh=deepseek-harness' "$home/.config/mimeapps.list" 2>/dev/null | sed 's/.*/mimeapps/'; } | tr '\n' ' ')
report 'uninstall leaves nothing of itself' "$([ -z "$left" ] && echo yes || echo no)" "left: ${left:-nothing}"

# --- Install paths with characters that mean something -------------------------------------------
for name in 'Ñandú 文档' 'dollar $HOME `x` 100% "q"'; do
  custom="$project/.work/$run/$name/deepseek-harness"
  test/env.sh "$run" env DEEPSEEK_HARNESS_HOME="$custom" sh "$package/install.sh" </dev/null >/dev/null 2>&1
  ok=yes
  if command -v desktop-file-validate >/dev/null; then
    desktop-file-validate "$home/.local/share/applications/deepseek-harness.desktop" 2>&1 | grep -q 'error' && ok=no
  fi
  (env DEEPSEEK_API_KEY=mock-local-test DEEPSEEK_BASE_URL=http://127.0.0.1:$mock/anthropic nohup setsid test/env.sh "$run" "$custom/deepseek-harness" --remote-debugging-port="$port" --disable-gpu --ozone-platform=x11 --enable-logging=stderr > "$project/.work/$run.log" 2>&1 &)
  wait_main 30 || ok=no
  parsed=$(python3 -I -c "
import sys,gi
gi.require_version('Gio','2.0')
from gi.repository import Gio
a=Gio.DesktopAppInfo.new_from_filename(sys.argv[1])
print(a.get_commandline() if a else 'unreadable')" "$home/.local/share/applications/deepseek-harness.desktop" 2>/dev/null)
  [ "$parsed" = unreadable ] && ok=no
  turned=no
  cdp dsh-app 'document.body.innerText' | grep -q 'Default workspace\|Choose workspace' && turned=yes
  report "install path: $name" "$([ "$ok" = yes ] && [ "$turned" = yes ] && echo yes || echo no)" "window ready $ok, workspace area shown $turned"
  stop_all
  rm -rf "$project/.work/$run/$name"
done

kill "$mock_pid" 2>/dev/null
pkill -f "[m]ock-model.mjs $mock"
echo "lifecycle: $fails failed"
[ "$fails" = 0 ]
