#!/bin/sh
# Installs DeepSeek Harness for the current user. Run again to reinstall or replace a version.
set -eu
umask 022

here=$(dirname -- "$(readlink -f -- "$0")")
version=$(cat "$here/VERSION")
root=${DEEPSEEK_HARNESS_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/deepseek-harness}

# VERSION becomes a folder name that gets removed and replaced below.
case "$version" in
  ''|.|..|*[!0-9A-Za-z.+-]*)
    echo "This package has an invalid VERSION file." >&2
    exit 1
    ;;
esac

missing=$(ldd "$here/app/deepseek-harness" 2>/dev/null | awk '/not found/ {print $1}' | tr '\n' ' ')
# Chromium loads this one while starting, so ldd cannot see it, and dies with no message without it.
libraries=$(ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null || true)
if [ -n "$libraries" ] && ! printf '%s' "$libraries" | grep -q 'libX11-xcb\.so\.1'; then
  missing="$missing libX11-xcb.so.1"
fi
if [ -n "$missing" ]; then
  echo "Your system is missing libraries DeepSeek Harness needs: $missing" >&2
  if command -v apt-get >/dev/null 2>&1; then
    # Ubuntu 24.04 and Debian 13 renamed this package, and the old name no longer installs.
    alsa=libasound2
    apt-cache show libasound2t64 >/dev/null 2>&1 && alsa=libasound2t64
    echo "To install them: sudo apt install libgtk-3-0 libnss3 $alsa libgbm1 libxss1 libx11-xcb1" >&2
  elif command -v dnf >/dev/null 2>&1; then
    echo "To install them: sudo dnf install gtk3 nss alsa-lib mesa-libgbm libXScrnSaver libX11-xcb" >&2
  else
    echo "Install them with your system's package manager." >&2
  fi
  exit 1
fi

echo "Installing DeepSeek Harness $version into $root"
mkdir -p "$root/versions"
rm -rf "$root/versions/$version.partial"
cp -a "$here/app" "$root/versions/$version.partial"
# Electron's Node mode cannot open an archive under a non-ASCII path, and the app's backend depends on it.
if readlink -f -- "$root" | LC_ALL=C grep -q '[^ -~]'; then
  partial=$root/versions/$version.partial
  ELECTRON_RUN_AS_NODE=1 ELECTRON_NO_ASAR=1 "$partial/deepseek-harness" --disable-sigusr1 "$partial/resources/linux-port/lib/expand-asar.mjs" "$partial/resources/app.asar"
fi
# The rule in setup-sandbox.sh trusts these files, and a tar unpacked under umask 002 leaves them group-writable.
chmod -R go-w "$root/versions/$version.partial"
chmod go-w "$root" "$root/versions"
old=$(readlink "$root/current" 2>/dev/null || true)
rm -rf "$root/versions/$version"
mv "$root/versions/$version.partial" "$root/versions/$version"
ln -sfn "versions/$version" "$root/.current.new"
mv -Tf "$root/.current.new" "$root/current"
# Same as an in-app update: keep this version and the one to roll back to, and nothing else.
if [ -n "$old" ] && [ "$old" != "versions/$version" ] && [ -d "$root/$old" ]; then
  ln -sfn "$old" "$root/.previous.new"
  mv -Tf "$root/.previous.new" "$root/previous"
fi
keep=$(readlink "$root/previous" 2>/dev/null || true)
for dir in "$root"/versions/*; do
  case "versions/${dir##*/}" in
    "versions/$version" | "$keep") ;;
    *) rm -rf "$dir" ;;
  esac
done
sh "$root/current/resources/linux-port/packaging/integrate.sh" "$root"

needs_rule=false
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
  # Any rule that names a different path, like a second install's, does not cover this one.
  # Older versions wrote the @{HOME} form, which covers the default folder.
  actual=$(readlink -f -- "$root")
  needs_rule=true
  grep -qF "\"$actual/versions/*/deepseek-harness\"" /etc/apparmor.d/deepseek-harness 2>/dev/null && needs_rule=false
  case "$actual" in
    /home/*/*/.local/share/deepseek-harness) ;;
    /home/*/.local/share/deepseek-harness)
      grep -qF '"@{HOME}/.local/share/deepseek-harness/versions/*/deepseek-harness"' /etc/apparmor.d/deepseek-harness 2>/dev/null && needs_rule=false
      ;;
  esac
fi
if $needs_rule; then
  echo
  echo "This system needs a one-time AppArmor rule so the app can use Chromium's sandbox."
  answer=n
  if [ -t 0 ]; then
    printf "Install it now? It asks for your password. [Y/n] "
    read -r answer || answer=n
    [ -n "$answer" ] || answer=y
  fi
  case "$answer" in
    [Yy]*) sudo sh "$root/setup-sandbox.sh" ;;
    *) echo "Skipped. The app still runs, without that sandbox. To add it later: sudo sh \"$root/setup-sandbox.sh\"" ;;
  esac
fi

if grep -q '@{HOME}' /etc/apparmor.d/deepseek-harness 2>/dev/null; then
  echo
  echo "Your sandbox rule comes from an older version and covers every user on this machine. To narrow it: sudo sh \"$root/setup-sandbox.sh\""
fi

if ! command -v bwrap >/dev/null 2>&1; then
  echo
  echo "Tip: install the bubblewrap package. The agent's sandbox then also hides local services such as systemd and Docker from the commands it runs."
fi

command -v xdg-open >/dev/null 2>&1 || echo "Note: without the xdg-utils package, links and sign-in cannot open your browser."
echo
echo "Done. Open DeepSeek Harness from your app menu, or run: $root/deepseek-harness"
