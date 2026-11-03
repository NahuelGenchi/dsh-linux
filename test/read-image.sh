#!/bin/bash
# Test helper: an agent turn in the real app that reads images with the read_image tool, then quits.
# Reading an image is what used to kill the app's background process, so this checks that it stays up.
# Needs the private X display, and Python with Pillow to draw the images.
# Usage: test/read-image.sh <run name> <package folder>
set -u
project=$(readlink -f -- "$(dirname -- "$0")/..")
run=$1 package=$2
port=${DSH_TEST_PORT:-39433} mock=${DSH_TEST_MOCK_PORT:-39533} container=${DSH_TEST_CONTAINER:-dsh-xvfb}
cd "$project"
home=$project/.work/$run/home
root=$home/.local/share/deepseek-harness
images=$project/.work/$run/images
log=$project/.work/$run.mock.log
fails=0

cdp() { TARGET_MATCH=$1 timeout 8 node test/cdp.mjs "$port" eval "$2" 2>/dev/null; }
alive() { ps -eo pid,args | grep -F ".work/$run/" | grep -v shell-snapshots | grep -vE '^ *[0-9]+ (sed|grep|cut|awk|ps|tail) ' | grep -v 'test/read-image' | awk '{print $1}'; }
report() { if [ "$2" = yes ]; then echo "PASS $1: $3"; else echo "FAIL $1: $3"; fails=$((fails + 1)); fi; }
key() { docker exec "$container" sh -c "export DISPLAY=:99; w=\$(xdotool search --onlyvisible --name 'DeepSeek Harness' | tail -1); xdotool windowfocus \$w; sleep 0.3; xdotool $1"; }
wait_main() { for _ in $(seq 1 40); do cdp dsh-app 'document.querySelector("[data-windows-menu]") && !/Loading plugins/.test(document.body.innerText) ? "ready" : ""' | grep -q ready && return 0; sleep 1; done; return 1; }

rm -rf "$project/.work/$run" "$project/.work/$run.log" "$log"
mkdir -p "$images"
python3 -I - "$images" <<'EOF'
import sys
from PIL import Image
folder = sys.argv[1]
noise = Image.effect_noise((640, 480), 80).convert('RGB')
noise.save(f'{folder}/plain.png')
noise.convert('RGBA').save(f'{folder}/alpha.png')
noise.save(f'{folder}/photo.jpg', quality=90, exif=Image.Exif())
noise.save(f'{folder}/picture.webp')
noise.convert('P').save(f'{folder}/still.gif')
noise.convert('P').save(f'{folder}/moving.gif', save_all=True, append_images=[noise.rotate(90).convert('P')], duration=100)
Image.effect_noise((600, 400), 60).resize((6000, 4000)).convert('RGB').save(f'{folder}/large.jpg', quality=80)
Image.new('P', (32, 24)).save(f'{folder}/tiny.png')
EOF
list=$(find "$images" -type f | sort | tr '\n' ':')
count=$(find "$images" -type f | wc -l)

MOCK_IMAGES=$list nohup setsid node test/mock-model.mjs "$mock" "$log" >/dev/null 2>&1 &
mock_pid=$!
sleep 0.5

test/env.sh "$run" sh "$package/install.sh" </dev/null >/dev/null 2>&1
mkdir -p "$home/Documents"
echo 'XDG_DOCUMENTS_DIR="$HOME/Documents"' > "$home/.config/user-dirs.dirs"
(env DEEPSEEK_API_KEY=mock-local-test DEEPSEEK_BASE_URL=http://127.0.0.1:$mock/anthropic \
  nohup setsid test/env.sh "$run" "$root/deepseek-harness" --remote-debugging-port="$port" --disable-gpu --ozone-platform=x11 --enable-logging=stderr > "$project/.work/$run.log" 2>&1 &)
ready=no; wait_main && ready=yes
report 'main window' "$ready" "ready $ready"
sleep 1

key 'key ctrl+n'; sleep 1.5
cdp dsh-app '(()=>{const e=document.querySelector("[contenteditable=true],textarea");e&&e.focus();return !!e})()' >/dev/null
key "type --delay 15 'run the check'"; sleep 0.3; key 'key Return'

answered=no
for _ in $(seq 1 60); do grep -q 'tool_result' "$log" 2>/dev/null && { answered=yes; break; }; sleep 1; done
sleep 3

summary=$(python3 -I - "$log" <<'EOF'
import json, sys
results = []
for line in open(sys.argv[1]):
    entry = json.loads(line)
    if entry.get('results'):
        results = entry['results']
images = errors = 0
first = ''
for result in results:
    parts = result.get('content')
    parts = parts if isinstance(parts, list) else [{'type': 'text', 'text': str(parts)}]
    if any(part.get('type') == 'image' for part in parts):
        images += 1
    if result.get('is_error'):
        errors += 1
        first = first or str(parts[0].get('text', ''))[:120]
print(f'{images} {errors} {first}')
EOF
)
read -r read_images read_errors first_error <<<"$summary"
report "every image reached the model" "$([ "$answered" = yes ] && [ "$read_images" = "$count" ] && [ "$read_errors" = 0 ] && echo yes || echo no)" "$read_images of $count read, $read_errors errors ${first_error:-}"

crashes=$(ls "$home/.config/DeepSeek Harness/logs" 2>/dev/null | grep -c '^crash-')
host=$(ps -eo pid,args | grep -F ".work/$run/" | grep -c -- '--expose-internals')
report 'no crash, background process still up' "$([ "$crashes" = 0 ] && [ "$host" != 0 ] && echo yes || echo no)" "crash reports $crashes, background processes $host"

second=no
if cdp dsh-app 'document.body.innerText' | grep -q 'Mock turn finished'; then second=yes; fi
report 'the turn finished in the window' "$second" "finished $second"

key 'key ctrl+q'; sleep 3
left=$(alive | wc -l)
report 'Ctrl+Q after reading images' "$([ "$left" = 0 ] && echo yes || echo no)" "$left processes left after 3s"

pids=$(alive); [ -n "$pids" ] && kill -9 $pids 2>/dev/null
kill "$mock_pid" 2>/dev/null
pkill -f "[m]ock-model.mjs $mock"
echo "read-image: $fails failed"
[ "$fails" = 0 ]
