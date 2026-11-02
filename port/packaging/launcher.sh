#!/bin/sh
# DeepSeek Harness launcher. Updates only move the "current" link, so this path stays valid.
self=$(readlink -f -- "$0")
root=$(dirname -- "$self")

if [ "${1:-}" = "--rollback" ]; then
  if [ ! -d "$root/previous/" ]; then
    echo "There is no previous version to return to." >&2
    exit 1
  fi
  target=$(readlink "$root/previous")
  ln -sfn "$target" "$root/.current.new" && mv -Tf "$root/.current.new" "$root/current"
  echo "DeepSeek Harness now starts $(basename -- "$target")."
  exit 0
fi

app="$root/current/deepseek-harness"
if [ ! -x "$app" ]; then
  echo "DeepSeek Harness is not installed correctly: $app is missing." >&2
  exit 1
fi

# Chromium's sandbox needs user namespaces. Ubuntu 23.10+ only grants them to programs
# with an AppArmor rule, which needs root once (setup-sandbox.sh).
userns_usable() {
  [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" = 1 ] || return 1
  [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 1)" != 0 ] || return 1
  # Containers and hardened systems can block them with no setting to read, and Chromium then dies at start.
  ! command -v unshare >/dev/null 2>&1 || unshare --user true 2>/dev/null || return 1
  [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ] || return 0
  # The rule only helps if it names this install. setup-sandbox.sh writes this exact path.
  grep -qF "\"$root/versions/*/deepseek-harness\"" /etc/apparmor.d/deepseek-harness 2>/dev/null && return 0
  # Older versions wrote the @{HOME} form, which covers the default folder.
  case "$root" in
    /home/*/*/.local/share/deepseek-harness) return 1 ;;
    /home/*/.local/share/deepseek-harness) grep -qF '"@{HOME}/.local/share/deepseek-harness/versions/*/deepseek-harness"' /etc/apparmor.d/deepseek-harness 2>/dev/null ;;
    *) return 1 ;;
  esac
}

if ! userns_usable; then
  set -- --no-sandbox "$@"
  message="Running without Chromium's sandbox. To turn it on, run: sudo sh \"$root/setup-sandbox.sh\""
  echo "DeepSeek Harness: $message" >&2
  # Remembered per version, and only once the desktop has really shown it.
  version=$(basename -- "$(readlink "$root/current")")
  if [ "$(cat "$root/.sandbox-notice" 2>/dev/null)" != "$version" ] && command -v notify-send >/dev/null 2>&1 \
    && notify-send -i deepseek-harness "DeepSeek Harness" "$message" 2>/dev/null; then
    printf '%s\n' "$version" > "$root/.sandbox-notice"
  fi
fi
if [ -n "${ELECTRON_DISABLE_SANDBOX:-}" ]; then
  echo "DeepSeek Harness: ELECTRON_DISABLE_SANDBOX is set, so Chromium's sandbox is off." >&2
fi

export CHROME_DESKTOP=deepseek-harness.desktop
exec "$app" "$@"
