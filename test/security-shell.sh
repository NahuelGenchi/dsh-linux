#!/bin/sh
# Test helper: attacks the packaging scripts with awkward paths and modes. Everything happens in a
# scratch folder and a throwaway container: nothing here is installed and no rule is loaded.
# Usage: test/security-shell.sh <packaging dir> <scratch dir>
set -u
packaging=$(readlink -f -- "$1")
scratch=$(readlink -m -- "$2")
image=alpine:3
container=${DSH_SEC_CONTAINER:-dsh-sec-shell}
failures=0
rm -rf "$scratch"
mkdir -p "$scratch"

report() { # report <SAFE when status is 0> <name> [detail]
  if [ "$1" = 0 ]; then state='SAFE  '; else state=UNSAFE; failures=$((failures + 1)); fi
  printf '%s  %s%s\n' "$state" "$2" "${3:+  ($3)}"
}

# A package with the real scripts and a stand-in program.
fake_package() { # fake_package <folder> <version>
  mkdir -p "$1/app/resources/linux-port/packaging/icons"
  cp "$packaging"/*.sh "$1/app/resources/linux-port/packaging/"
  for size in 48 128 256 512; do : > "$1/app/resources/linux-port/packaging/icons/$size.png"; done
  printf '#!/bin/sh\n' > "$1/app/deepseek-harness"
  chmod 755 "$1/app/deepseek-harness"
  cp "$packaging/install.sh" "$1/install.sh"
  printf '%s\n' "$2" > "$1/VERSION"
}

in_home() { # in_home <home> <command...>
  home=$1
  shift
  env -i HOME="$home" PATH="$PATH" XDG_DATA_HOME="$home/share" XDG_CONFIG_HOME="$home/config" "$@"
}

# --- .desktop quoting --------------------------------------------------------

home=$scratch/desktop
mkdir -p "$home/here/icons"
cp "$packaging"/*.sh "$home/here/"
for size in 48 128 256 512; do : > "$home/here/icons/$size.png"; done
desktop=$home/share/applications/deepseek-harness.desktop
# Each of these characters has a special meaning in an Exec line, and the quote can add arguments.
root="$home/odd \$HOME \`id\` \\ \" --evil \" end"
mkdir -p "$root"
in_home "$home" sh "$home/here/integrate.sh" "$root" >/dev/null 2>&1
marker=$scratch/desktop-argv
# The launcher is replaced with one that records how it was really started.
printf '#!/bin/sh\nprintf "%%s\\n" "$0" "$@" > "%s"\n' "$marker" > "$root/deepseek-harness"
chmod 755 "$root/deepseek-harness"
if command -v gio >/dev/null 2>&1; then
  in_home "$home" gio launch "$desktop" >/dev/null 2>&1
  sleep 1
  if [ -e "$marker" ] && [ "$(sed -n 1p "$marker")" = "$root/deepseek-harness" ] && [ "$(wc -l < "$marker")" = 1 ]; then status=0; else status=1; fi
  report $status '.desktop entry runs exactly that path, with no extra arguments' "$( [ -e "$marker" ] && wc -l < "$marker" || echo not started) lines of argv"
fi
# GLib cannot load an entry whose program path holds a %, so this one can only be checked by the validator.
root="$home/odd %f \$HOME \`id\` \\ \" end"
mkdir -p "$root"
in_home "$home" sh "$home/here/integrate.sh" "$root" >/dev/null 2>&1
if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$desktop" >/dev/null 2>&1
  report $? '.desktop entry with a % in the path is still valid'
fi
newline_root="$home/line
Exec=evil"
mkdir -p "$newline_root"
rm -f "$desktop"
in_home "$home" sh "$home/here/integrate.sh" "$newline_root" >/dev/null 2>&1
if [ -e "$desktop" ] && grep -q '^Exec=evil' "$desktop"; then status=1; else status=0; fi
report $status 'a line break in the path cannot add lines to the entry'

# --- install.sh --------------------------------------------------------------

home=$scratch/install
mkdir -p "$home"
fake_package "$home/package" 1.0.0
chmod -R a+w "$home/package"
(umask 000; in_home "$home" sh "$home/package/install.sh" </dev/null >/dev/null 2>&1)
root=$home/share/deepseek-harness
count=$(find "$root" -not -type l -perm /022 2>/dev/null | wc -l)
[ "$count" = 0 ]
report $? 'install under umask 000 from a loose package leaves nothing writable by others' "$count writable"

home=$scratch/version
mkdir -p "$home/share/deepseek-harness" "$home/share/keep"
: > "$home/share/keep/precious"
fake_package "$home/package" ../../keep
in_home "$home" sh "$home/package/install.sh" </dev/null >/dev/null 2>&1
[ -e "$home/share/keep/precious" ]
report $? 'a VERSION file of ../../keep cannot delete folders outside the install'

# --- uninstall.sh ------------------------------------------------------------

in_home "$scratch/install" sh "$scratch/install/share/deepseek-harness/uninstall.sh" >/dev/null 2>&1
[ ! -e "$scratch/install/share/deepseek-harness" ]
report $? 'uninstall.sh still removes a real install'

home=$scratch/uninstall
mkdir -p "$home/versions"
: > "$home/precious"
cp "$packaging/uninstall.sh" "$home/uninstall.sh"
in_home "$home" sh "$home/uninstall.sh" >/dev/null 2>&1
[ -e "$home/precious" ]
report $? 'uninstall.sh copied to another folder does not delete that folder'

# --- The sandbox rule and the launcher, as root in a throwaway container ------

cat > "$scratch/inside.sh" <<'EOF'
#!/bin/sh
# Runs as root in the container, with fake apparmor_parser and notify-send on PATH.
mkdir -p /fake /etc/apparmor.d
cat > /fake/apparmor_parser <<'X'
#!/bin/sh
echo "$*" >> /tmp/parser.log
X
cat > /fake/notify-send <<'X'
#!/bin/sh
echo shown >> /tmp/notify.log
[ ! -e /tmp/notify-broken ]
X
chmod 755 /fake/*
export PATH=/fake:$PATH
copy=/tmp/here/setup-sandbox.sh
rule=/etc/apparmor.d/deepseek-harness

result() { printf 'RESULT %s %s\n' "$1" "$2"; }

setup() { rm -f "$rule"; mkdir -p "$1"; chmod 755 "$1"; sh "$copy" "$1" >/dev/null 2>&1; }

setup /home/alice/.local/share/deepseek-harness
if grep -q '@{HOME}' "$rule" 2>/dev/null; then result 1 'the rule never names every home folder'; else result 0 'the rule never names every home folder'; fi
grep -qF '"/home/alice/.local/share/deepseek-harness/versions/*/deepseek-harness"' "$rule" 2>/dev/null
result $? 'the rule names this one install'

evil='/tmp/x" flags=(complain) { } profile evil "/tmp/y'
setup "$evil"
if [ -e "$rule" ] && grep -q 'profile evil' "$rule"; then result 1 'a quote in the path cannot add a rule'; else result 0 'a quote in the path cannot add a rule'; fi
setup '/tmp/glob*'
if [ -e "$rule" ]; then result 1 'a wildcard in the path cannot widen the rule'; else result 0 'a wildcard in the path cannot widen the rule'; fi
setup '/tmp/@{HOME}'
if [ -e "$rule" ]; then result 1 'a variable in the path cannot widen the rule'; else result 0 'a variable in the path cannot widen the rule'; fi

rm -f "$rule"; mkdir -p /tmp/open; chmod 775 /tmp/open; sh "$copy" /tmp/open >/dev/null 2>&1
if [ -e "$rule" ]; then result 1 'a folder others can write to gets no rule'; else result 0 'a folder others can write to gets no rule'; fi

setup '/tmp/with space/app'
grep -qF '"/tmp/with space/app/versions/*/deepseek-harness"' "$rule" 2>/dev/null
result $? 'a space in the path still works'
cp "$rule" /out/rule-with-space && chmod 644 /out/rule-with-space

setup /home/alice/.local/share/deepseek-harness
: > /tmp/parser.log
sh "$copy" --remove >/dev/null 2>&1
if [ ! -e "$rule" ] && grep -q -- '-R' /tmp/parser.log; then result 0 'removing the rule also unloads it'; else result 1 'removing the rule also unloads it'; fi

# The installer points out a rule from an older version.
package=/tmp/package
mkdir -p "$package/app/resources/linux-port/packaging/icons"
cp /tmp/here/*.sh "$package/app/resources/linux-port/packaging/"
for size in 48 128 256 512; do : > "$package/app/resources/linux-port/packaging/icons/$size.png"; done
printf '#!/bin/sh\n' > "$package/app/deepseek-harness"
chmod 755 "$package/app/deepseek-harness"
cp /tmp/here/install.sh "$package/install.sh"
echo 1.0.0 > "$package/VERSION"
printf 'profile deepseek-harness "@{HOME}/x" {}\n' > "$rule"
HOME=/tmp/installer sh "$package/install.sh" </dev/null 2>&1 | grep -q 'older version'
result $? 'the installer asks to narrow a rule from an older version'

# The launcher, on a machine that restricts user namespaces and has no rule.
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]; then
  root=/tmp/install
  mkdir -p "$root/versions/1.0.0" "$root/versions/2.0.0"
  for v in 1.0.0 2.0.0; do printf '#!/bin/sh\nprintf "%%s\\n" "$@" > /tmp/app-args\n' > "$root/versions/$v/deepseek-harness"; chmod 755 "$root/versions/$v/deepseek-harness"; done
  ln -sfn versions/1.0.0 "$root/current"
  cp /tmp/here/launcher.sh "$root/deepseek-harness"
  rm -f "$rule" /tmp/notify.log
  : > /tmp/notify-broken
  sh "$root/deepseek-harness" 2>/tmp/stderr1
  grep -q -- '--no-sandbox' /tmp/app-args && grep -q 'without Chromium' /tmp/stderr1
  result $? 'the fallback warns on stderr'
  rm -f /tmp/notify-broken
  sh "$root/deepseek-harness" 2>/dev/null
  if [ "$(wc -l < /tmp/notify.log)" = 2 ]; then result 0 'a notice the desktop failed to show is tried again'; else result 1 'a notice the desktop failed to show is tried again'; fi
  before=$(wc -l < /tmp/notify.log)
  sh "$root/deepseek-harness" 2>/dev/null
  if [ "$(wc -l < /tmp/notify.log)" = "$before" ]; then result 0 'a notice already shown is not repeated'; else result 1 'a notice already shown is not repeated'; fi
  ln -sfn versions/2.0.0 "$root/current"
  sh "$root/deepseek-harness" 2>/dev/null
  if [ "$(wc -l < /tmp/notify.log)" = "$((before + 1))" ]; then result 0 'each new version shows the notice again'; else result 1 'each new version shows the notice again'; fi
  ELECTRON_DISABLE_SANDBOX=1 sh "$root/deepseek-harness" 2>/tmp/stderr2
  grep -q ELECTRON_DISABLE_SANDBOX /tmp/stderr2
  result $? 'ELECTRON_DISABLE_SANDBOX does not pass silently'
else
  printf 'RESULT 0 launcher cases skipped: this kernel does not restrict user namespaces\n'
fi
EOF

docker rm -f "$container" >/dev/null 2>&1
docker run --rm --name "$container" --network none \
  -v "$packaging:/tmp/here:ro" -v "$scratch/inside.sh:/tmp/inside.sh:ro" -v "$scratch:/out" \
  "$image" sh /tmp/inside.sh > "$scratch/inside.out" 2>&1
while IFS= read -r line; do
  case "$line" in
    RESULT\ *)
      rest=${line#RESULT }
      report "${rest%% *}" "${rest#* }"
      ;;
  esac
done < "$scratch/inside.out"

# A syntax check by the real parser. It only reads the file: nothing is loaded into the kernel.
if [ -x /usr/sbin/apparmor_parser ] && [ -e "$scratch/rule-with-space" ]; then
  /usr/sbin/apparmor_parser --skip-kernel-load --skip-cache --skip-read-cache "$scratch/rule-with-space" >/dev/null 2>"$scratch/parser.err"
  report $? 'the real AppArmor parser accepts the generated rule' "$(head -1 "$scratch/parser.err" | cut -c1-80)"
fi

echo "$failures unsafe"
[ "$failures" = 0 ]
