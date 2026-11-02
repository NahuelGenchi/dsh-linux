#!/bin/sh
# Desktop integration for an install root. Safe to run again: the installer and every update call it.
# Usage: integrate.sh <install root>
set -eu
umask 022

root=$1
here=$(dirname -- "$(readlink -f -- "$0")")
data=${XDG_DATA_HOME:-$HOME/.local/share}

case "$root" in
  *'
'*)
    echo "The install folder cannot contain a line break." >&2
    exit 1
    ;;
esac
chmod go-w "$root"

install -m 755 "$here/launcher.sh" "$root/deepseek-harness"
install -m 755 "$here/uninstall.sh" "$root/uninstall.sh"
install -m 755 "$here/setup-sandbox.sh" "$root/setup-sandbox.sh"

for size in 48 128 256 512; do
  mkdir -p "$data/icons/hicolor/${size}x$size/apps"
  install -m 644 "$here/icons/$size.png" "$data/icons/hicolor/${size}x$size/apps/deepseek-harness.png"
done
# A running GNOME Shell only rescans the theme when this folder's own date changes.
touch "$data/icons/hicolor"

# Desktop Entry quoting: \ " ` $ get a backslash inside the quotes, that whole string escapes each
# backslash again, and a literal % is %%.
exec_path=$(printf '%s' "$root/deepseek-harness" | sed -e 's/[\\"`$]/\\&/g' -e 's/\\/\\\\/g' -e 's/%/%%/g')

mkdir -p "$data/applications"
cat > "$data/applications/deepseek-harness.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=DeepSeek Harness
GenericName=AI Coding Agent
Comment=Build potential. Explore intelligence.
Exec="$exec_path" %U
Icon=deepseek-harness
Terminal=false
Categories=Development;
MimeType=x-scheme-handler/dsh;
StartupWMClass=deepseek-harness
StartupNotify=true
EOF

mkdir -p "$HOME/.local/bin"
if [ ! -e "$HOME/.local/bin/deepseek-harness" ] || [ -L "$HOME/.local/bin/deepseek-harness" ]; then
  ln -sfn "$root/deepseek-harness" "$HOME/.local/bin/deepseek-harness"
fi

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$data/applications" 2>/dev/null || true
# xdg-mime fails on a home with no config folder yet.
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}"
command -v xdg-mime >/dev/null 2>&1 && xdg-mime default deepseek-harness.desktop x-scheme-handler/dsh 2>/dev/null || true
exit 0
