#!/bin/sh
# Builds the installable package from a macOS release.
# Usage: ./build-package.sh <App.app/Contents folder or release .zip>
set -eu
umask 022

project=$(dirname -- "$(readlink -f -- "$0")")
source=${1:?Give the macOS release: a .zip or an App.app/Contents folder}
work="$project/.work"
mkdir -p "$work/build" "$project/dist"

if [ -d "$source" ]; then from="--source"; else from="--zip"; fi
node "$project/port/port.mjs" "$from" "$source" --out "$work/build/app" --cache "$work/cache" --work-dir "$work" --pty-docker --all-patches

version=$(node -p 'require(process.argv[1]).upstreamVersion' "$work/build/app/resources/linux-port/port-info.json")
name="dsh-linux-$version-x64"
package="$work/build/$name"
rm -rf "$package"
mkdir -p "$package"
mv "$work/build/app" "$package/app"
cp "$project/port/packaging/install.sh" "$package/install.sh"
cp "$project/port/packaging/NOTICE.md" "$package/NOTICE.md"
chmod 755 "$package/install.sh"
printf '%s\n' "$version" > "$package/VERSION"
chmod -R go-w "$package"
# Files of one type sit side by side, so xz finds more repeats, and owner names stay out of the archive.
# XZ_OPT='-T8 -6' gives a much faster build of a slightly larger package.
export XZ_OPT="${XZ_OPT:--T4 --x86 --lzma2=preset=9e}"
(cd "$work/build" && { find "$name" -type d | LC_ALL=C sort; find "$name" ! -type d -printf '%f\t%p\n' | sed -E -e 's/^(lib)?python[^\t]*\t/python\t/' -e 's/^[^\t]*\.([^.\t]*)\t/\1\t/' | LC_ALL=C sort -s -t "$(printf '\t')" -k1,1 -k2,2 | cut -f2-; }) > "$package.files"
tar -C "$work/build" --owner=0 --group=0 --numeric-owner --no-recursion -T "$package.files" -I xz -cf "$project/dist/$name.tar.xz"
rm -f "$package.files"
(cd "$project/dist" && sha256sum "$name.tar.xz" > "$name.tar.xz.sha256")
echo "Package: $project/dist/$name.tar.xz"
