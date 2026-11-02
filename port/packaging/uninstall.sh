#!/bin/sh
# Removes the application. Your sessions and settings stay in ~/.dsh and ~/.config/DeepSeek Harness.
set -eu

root=$(dirname -- "$(readlink -f -- "$0")")
data=${XDG_DATA_HOME:-$HOME/.local/share}

if [ ! -d "$root/versions" ] || [ ! -L "$root/current" ]; then
  echo "$root does not look like a DeepSeek Harness install." >&2
  exit 1
fi

for exe in /proc/[0-9]*/exe; do
  case "$(readlink "$exe" 2>/dev/null)" in
    "$root"/versions/*/deepseek-harness*)
      echo "DeepSeek Harness is still running. Quit it first, with Ctrl+Q or its tray icon, then run this again." >&2
      exit 1
      ;;
  esac
done

rm -f "$data/applications/deepseek-harness.desktop"
for size in 48 128 256 512; do
  rm -f "$data/icons/hicolor/${size}x$size/apps/deepseek-harness.png"
done
touch "$data/icons/hicolor" 2>/dev/null || true
[ -L "$HOME/.local/bin/deepseek-harness" ] && rm -f "$HOME/.local/bin/deepseek-harness"
# The dsh command the app's menu installs, and the dsh:// link handler the app and install registered.
case "$(readlink "$HOME/.local/bin/dsh" 2>/dev/null)" in
  "$root"/*) rm -f "$HOME/.local/bin/dsh" "$HOME/.local/bin/.dsh-desktop-command.json" ;;
esac
mimeapps=${XDG_CONFIG_HOME:-$HOME/.config}/mimeapps.list
[ -f "$mimeapps" ] && sed -i '/^x-scheme-handler\/dsh=deepseek-harness\.desktop;\{0,1\}$/d' "$mimeapps"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$data/applications" 2>/dev/null || true
rm -rf "$root"

echo "DeepSeek Harness was removed. Your sessions and settings were kept."
if [ -e /etc/apparmor.d/deepseek-harness ]; then
  echo "To also remove the sandbox rule: sudo apparmor_parser -R /etc/apparmor.d/deepseek-harness && sudo rm /etc/apparmor.d/deepseek-harness"
fi
