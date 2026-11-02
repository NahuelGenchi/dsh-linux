#!/bin/sh
# Test helper: clicks at window-relative coordinates on the private display, then saves a screenshot.
# Usage: test/xclick.sh <x> <y> <screenshot file>
docker exec "${DSH_TEST_CONTAINER:-dsh-xvfb}" sh -c "export DISPLAY=:99; w=\$(xdotool search --onlyvisible --name 'DeepSeek Harness' | tail -1); xdotool windowfocus \$w; xdotool mousemove --window \$w $1 $2 click 1; import -pause 1 -window root /tmp/shot.png"
docker cp "${DSH_TEST_CONTAINER:-dsh-xvfb}":/tmp/shot.png "$3" 2>&1 | tail -1 | grep -v Successfully
