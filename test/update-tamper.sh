#!/bin/sh
# Test helper: drives the real in-app update against a local feed that lies. The SHA-512 always
# matches, as it would if the download host were taken over. Needs the private X display.
# Usage: test/update-tamper.sh <run name> <package folder> <real release .zip>
# Case one is a release with one changed file. Case two is the real release labelled 9.9.9.
set -u
project=$(readlink -f -- "$(dirname -- "$0")/..")
run=$1 package=$(readlink -f -- "$2") release=$(readlink -f -- "$3")
port=${DSH_TEST_PORT:-39433}
feed_port=${DSH_TEST_FEED_PORT:-39533}
cd "$project"
home="$project/.work/$run/home"
root="$home/.local/share/deepseek-harness"
match="[.]work/$run/home/[.]local/share/deepseek-harness/"
feed="$project/.work/$run/feed"

cdp() { TARGET_MATCH=$1 node test/cdp.mjs "$port" eval "$2" 2>/dev/null; }
stop_app() {
  pkill -f "$match"
  timeout 15 sh -c "while pgrep -f '$match' >/dev/null; do :; done"
}

[ -d "$root/current/" ] || test/env.sh "$run" sh "$package/install.sh" </dev/null >/dev/null
before=$(readlink "$root/current")
mkdir -p "$feed"
python3 -I -m http.server "$feed_port" --bind 127.0.0.1 --directory "$feed" >/dev/null 2>&1 &
server=$!

try_case() { # try_case <name> <zip>
  rm -rf "$root/versions/9.9.9" "$root/versions/9.9.9.partial" "$root/staging" "$root/logs" "$feed/r.zip"
  ln "$2" "$feed/r.zip" 2>/dev/null || cp "$2" "$feed/r.zip"
  printf 'version: 9.9.9\nfiles:\n  - url: r.zip\n    sha512: %s\n    size: %s\n' \
    "$(openssl dgst -sha512 -binary "$2" | base64 -w0)" "$(stat -c %s "$2")" > "$feed/nightly-mac.yml"
  DSH_LINUX_UPDATE_FEED="http://127.0.0.1:$feed_port/" DEEPSEEK_API_KEY=mock-local-test DEEPSEEK_BASE_URL=http://127.0.0.1:1/anthropic \
    nohup setsid test/env.sh "$run" "$root/deepseek-harness" --remote-debugging-port="$port" --disable-gpu --ozone-platform=x11 > "$project/.work/$run/app.log" 2>&1 &
  timeout 40 sh -c "until node test/cdp.mjs $port list 2>/dev/null | grep -q dsh-app; do :; done"
  timeout 40 sh -c "until TARGET_MATCH=dsh-app node test/cdp.mjs $port eval \"[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='Update'&&b.offsetParent)\" 2>/dev/null | grep -q true; do :; done"
  cdp dsh-app "(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Update'&&b.offsetParent);if(b){b.click();return 'clicked'}return 'none'})()" >/dev/null
  log="$root/logs/update-9.9.9.log"
  timeout 240 sh -c "until [ -x '$root/versions/9.9.9/deepseek-harness' ] || grep -qE '^Error: ' '$log' 2>/dev/null; do sleep 1; done"
  sleep 1
  if [ -x "$root/versions/9.9.9/deepseek-harness" ]; then
    outcome='ACCEPTED: prepared as the next version'
  else
    outcome="REFUSED: $(grep -E '^Error: ' "$log" | head -1 | cut -c8-120)"
  fi
  stop_app
  printf '%s: %s; current stays %s\n' "$1" "$outcome" "$( [ "$(readlink "$root/current")" = "$before" ] && echo yes || echo no)"
}

tampered="$project/.work/$run/tampered.zip"
cp "$release" "$tampered"
python3 -I - "$tampered" <<'EOF'
import sys, warnings, zipfile
warnings.simplefilter('ignore')
with zipfile.ZipFile(sys.argv[1], 'a') as archive:
    name = next(n for n in archive.namelist() if n.endswith('.app/Contents/Resources/app-update.yml'))
    archive.writestr(name, archive.read(name) + b'# changed by an attacker\n')
EOF

try_case 'changed file, matching SHA-512' "$tampered"
if [ -e "$root/versions/9.9.9/resources/app-update.yml" ]; then
  grep -c 'changed by an attacker' "$root/versions/9.9.9/resources/app-update.yml" | sed 's/^/  attacker text in the prepared build: /'
fi
try_case 'real release labelled 9.9.9' "$release"
kill "$server" 2>/dev/null
rm -rf "$tampered" "$feed" "$root/versions/9.9.9" "$root/versions/9.9.9.partial"
