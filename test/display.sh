#!/bin/sh
# Test helper: starts or stops the private X server the other helpers draw on.
# Several can run at once when each sets its own DSH_TEST_CONTAINER, DSH_TEST_DISPLAY and DSH_TEST_PORT.
# Usage: test/display.sh start|stop
container=${DSH_TEST_CONTAINER:-dsh-xvfb}
display=${DSH_TEST_DISPLAY:-99}

case "${1:-}" in
  start)
    docker run -d --name "$container" -p "127.0.0.1:$((6000 + display)):6099" alpine:3 sh -c \
      'apk add --no-cache xvfb openbox imagemagick xdotool xprop ttf-dejavu >/dev/null && (Xvfb :99 -screen 0 1400x900x24 -listen tcp -ac >/dev/null 2>&1 &) && sleep 2 && DISPLAY=:99 exec openbox' > /dev/null || exit 1
    tries=0
    until docker exec "$container" sh -c 'DISPLAY=:99 xprop -root >/dev/null 2>&1'; do
      tries=$((tries + 1))
      if [ "$tries" -gt 60 ]; then echo "The display did not start"; exit 1; fi
      sleep 1
    done
    echo "Display 127.0.0.1:$display is ready in container $container"
    ;;
  stop)
    docker rm -f "$container" > /dev/null
    ;;
  *)
    echo "Usage: test/display.sh start|stop" >&2
    exit 2
    ;;
esac
