#!/bin/sh
# Test helper: installs a built package with the given window-button layout and checks that the
# title bar items stay clear of the buttons with the sidebar open, collapsed and in fullscreen.
# Usage: test/titlebar.sh <run name> <package folder> <gtk layout, such as close,minimize,maximize:>
set -u
run=$1
package=$2
layout=$3
here=$(dirname -- "$(readlink -f -- "$0")")
work=$(readlink -f -- "$here/../.work")
home=$work/$run/home
shots=$work/$run/shots
port=${DSH_TEST_PORT:-39431}
container=${DSH_TEST_CONTAINER:-dsh-xvfb}
mkdir -p "$shots"

for gtk in gtk-3.0 gtk-4.0; do
  mkdir -p "$home/.config/$gtk"
  printf '[Settings]\ngtk-decoration-layout=%s\n' "$layout" > "$home/.config/$gtk/settings.ini"
done
"$here/env.sh" "$run" sh "$package/install.sh" > /dev/null

# The placeholder key skips the welcome window.
DEEPSEEK_API_KEY=mock-local-test DEEPSEEK_BASE_URL=http://127.0.0.1:39422/anthropic \
"$here/env.sh" "$run" "$home/.local/share/deepseek-harness/deepseek-harness" \
  --remote-debugging-port=$port --disable-gpu --ozone-platform=x11 > "$work/$run/app.log" 2>&1 &
app=$!
# Wait for it to go: the next helper may use the same debugging port.
trap 'kill "$app" 2>/dev/null; wait "$app" 2>/dev/null' EXIT

page() { TARGET_MATCH=dsh-app node "$here/cdp.mjs" "$port" eval "$1"; }
shot() { docker exec "$container" sh -c 'export DISPLAY=:99; import -pause 1 -window root /tmp/shot.png'; docker cp "$container":/tmp/shot.png "$shots/$1.png" 2>&1 | grep -v Successfully; }
press() { docker exec "$container" sh -c "export DISPLAY=:99; w=\$(xdotool search --onlyvisible --name 'DeepSeek Harness' | tail -1); xdotool windowfocus \$w; xdotool key $1"; }

state() { docker exec "$container" sh -c "export DISPLAY=:99; w=\$(xdotool search --onlyvisible --name 'DeepSeek Harness' | tail -1); xdotool windowstate $1 FULLSCREEN \$w"; }

MEASURE='(() => {
  const fixed = (part) => [...document.querySelectorAll(`[class*="${part}"]`)].find((el) => getComputedStyle(el).position === "fixed");
  const area = navigator.windowControlsOverlay.getTitlebarAreaRect();
  const visible = navigator.windowControlsOverlay.visible;
  const items = { toggle: fixed("_toggle"), newSession: fixed("_newSession"), menu: document.querySelector("[data-windows-menu]") };
  const out = { visible, area: [area.left, area.right], fullscreen: document.documentElement.dataset.fullscreen ?? null };
  for (const [name, el] of Object.entries(items)) {
    if (!el) continue;
    const box = el.getBoundingClientRect();
    const clear = !visible || (box.left >= area.left && box.right <= area.right);
    out[name] = { left: Math.round(box.left), right: Math.round(box.right), clear };
  }
  return JSON.stringify(out);
})()'

tries=0
until page 'document.querySelector("[data-windows-menu]") ? "ready" : ""' 2>/dev/null | grep -q ready; do
  tries=$((tries + 1))
  if [ "$tries" -gt 60 ]; then echo "The main window did not appear"; exit 1; fi
  sleep 1
done
sleep 2

echo "layout: $layout"
echo "open:       $(page "$MEASURE")"
shot open
left=$(page 'String(Math.round(document.querySelector("[data-windows-menu]").getBoundingClientRect().left))' | tr -dc 0-9)
"$here/xclick.sh" "$((left + 20))" 20 "$shots/menu.png"
press Escape

page '[...document.querySelectorAll(`[class*="_toggle"]`)].find((el) => getComputedStyle(el).position === "fixed").click()' > /dev/null
sleep 1
echo "collapsed:  $(page "$MEASURE")"
shot collapsed
page '[...document.querySelectorAll(`[class*="_toggle"]`)].find((el) => getComputedStyle(el).position === "fixed").click()' > /dev/null
sleep 1

state --add
sleep 2
echo "fullscreen: $(page "$MEASURE")"
shot fullscreen
state --remove
sleep 2
echo "back:       $(page "$MEASURE")"
