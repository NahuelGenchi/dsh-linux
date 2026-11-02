#!/bin/sh
# Test helper: checks which AppArmor rules the launcher and the installer accept, in a throwaway
# container. Nothing is loaded. Needs a host where apparmor_restrict_unprivileged_userns is 1.
# Usage: test/rule-check.sh <packaging dir>
packaging=$(readlink -f -- "$1")
docker run --rm -i -v "$packaging:/packaging:ro" alpine:3 sh -s <<'EOF'
failures=0
rule=/etc/apparmor.d/deepseek-harness
old='@{HOME}/.local/share/deepseek-harness/versions/*/deepseek-harness'
mkdir -p /etc/apparmor.d /package/app/resources/linux-port/packaging/icons
printf '#!/bin/sh\nexit 0\n' > /usr/local/bin/unshare
chmod 755 /usr/local/bin/unshare
cp /packaging/*.sh /package/app/resources/linux-port/packaging/
for size in 48 128 256 512; do : > "/package/app/resources/linux-port/packaging/icons/$size.png"; done
printf '#!/bin/sh\necho "started with: $*"\n' > /package/app/deepseek-harness
chmod 755 /package/app/deepseek-harness
cp /packaging/install.sh /package/install.sh
echo 1.0.0 > /package/VERSION

# check <name> <install root> <path the rule names, or nothing> <sandbox> <installer asks> <installer says narrow>
check() {
  name=$1 root=$2 path=$3 sandbox=$4 asks=$5 narrow=$6
  rm -f "$rule"
  [ -z "$path" ] || printf 'profile deepseek-harness "%s" flags=(unconfined) {\n}\n' "$path" > "$rule"
  mkdir -p /tmp/home
  said=$(HOME=/tmp/home XDG_DATA_HOME=/tmp/home/share XDG_CONFIG_HOME=/tmp/home/config DEEPSEEK_HARNESS_HOME=$root sh /package/install.sh </dev/null 2>&1)
  started=$("$root/deepseek-harness" 2>/dev/null)
  got_sandbox=on got_asks=no got_narrow=no
  case "$started" in *--no-sandbox*) got_sandbox=off ;; esac
  case "$said" in *'one-time AppArmor rule'*) got_asks=yes ;; esac
  case "$said" in *'comes from an older version'*) got_narrow=yes ;; esac
  got="sandbox $got_sandbox, asks $got_asks, narrow $got_narrow"
  if [ "$got" = "sandbox $sandbox, asks $asks, narrow $narrow" ]; then
    echo "PASS $name: $got"
  else
    echo "FAIL $name: $got, wanted sandbox $sandbox, asks $asks, narrow $narrow"
    failures=$((failures + 1))
  fi
  rm -rf "$root" /tmp/home
}

if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" != 1 ]; then
  echo "FAIL this host does not restrict user namespaces, so the checks would prove nothing"
  exit 1
fi
main=/home/u/.local/share/deepseek-harness
nested=/home/a/b/.local/share/deepseek-harness
custom=/opt/dsh
check 'default folder, narrow rule' "$main" "$main/versions/*/deepseek-harness" on no no
check 'default folder, rule from an older version' "$main" "$old" on no yes
check 'default folder, no rule' "$main" '' off yes no
check "default folder, another user's rule" "$main" '/home/v/.local/share/deepseek-harness/versions/*/deepseek-harness' off yes no
check 'nested home, narrow rule' "$nested" "$nested/versions/*/deepseek-harness" on no no
check 'nested home, rule from an older version' "$nested" "$old" off yes yes
check 'custom folder, narrow rule' "$custom" "$custom/versions/*/deepseek-harness" on no no
check 'custom folder, rule from an older version' "$custom" "$old" off yes yes
echo "$failures failed"
exit "$failures"
EOF
