#!/bin/sh
# Downloads the latest package, checks its hash and runs its installer, for the current user only.
#   curl -fsSL https://raw.githubusercontent.com/NahuelGenchi/dsh-linux/main/get.sh | sh
set -eu
umask 022

release=https://github.com/NahuelGenchi/dsh-linux/releases/latest/download
asset=dsh-linux-x64.tar.xz

fail() {
  printf 'dsh-linux: %s\n' "$1" >&2
  exit 1
}

[ "$(uname -s)" = Linux ] || fail 'this package is for Linux.'
[ "$(uname -m)" = x86_64 ] || fail "this package is for x86-64 only, and this machine is $(uname -m)."
command -v tar >/dev/null 2>&1 || fail 'unpacking needs tar. Install it, then run this again.'
command -v xz >/dev/null 2>&1 || fail 'unpacking needs xz. Install xz-utils (or xz on Fedora), then run this again.'
command -v sha256sum >/dev/null 2>&1 || fail 'checking the download needs sha256sum. Install coreutils, then run this again.'

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fL --proto '=https' --tlsv1.2 --progress-bar -o "$1" "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q --show-progress --https-only -O "$1" "$2"; }
else
  fail 'downloading needs curl or wget. Install one, then run this again.'
fi

# Not /tmp, which is often a small RAM disk: the package unpacks to about 1 GB.
parent=${XDG_CACHE_HOME:-$HOME/.cache}
mkdir -p "$parent"
work=$(mktemp -d "$parent/dsh-linux-install.XXXXXX")
trap 'rm -rf "$work"' EXIT
trap 'exit 1' HUP INT TERM

printf 'Downloading dsh-linux, about 230 MB.\n'
fetch "$work/$asset" "$release/$asset" || fail 'the download failed. Nothing was installed.'
fetch "$work/$asset.sha256" "$release/$asset.sha256" || fail 'the hash file could not be downloaded. Nothing was installed.'
(cd "$work" && sha256sum -c --quiet "$asset.sha256") || fail 'the download does not match its hash. Nothing was installed.'

tar -xf "$work/$asset" -C "$work"
set -- "$work"/dsh-linux-*-x64/install.sh
[ -f "$1" ] || fail 'the package has no installer. Nothing was installed.'

# This script arrives through a pipe, so the installer's one question has to go to the terminal.
if (exec </dev/tty) 2>/dev/null; then
  sh "$1" </dev/tty
else
  sh "$1" </dev/null
fi
