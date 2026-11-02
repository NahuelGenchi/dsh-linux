#!/bin/sh
# One-time root step for Ubuntu 23.10 and newer: lets DeepSeek Harness use Chromium's sandbox.
# The rule grants user namespaces to this one install and nothing else.
# Usage: sudo sh setup-sandbox.sh [install folder]
#        sudo sh setup-sandbox.sh --remove
set -eu

here=$(dirname -- "$(readlink -f -- "$0")")
root=$here
[ $# -eq 0 ] || [ "$1" = --remove ] || root=$(readlink -f -- "$1")
profile=/etc/apparmor.d/deepseek-harness

if [ "$(id -u)" != 0 ]; then
  echo "Run this with sudo: sudo sh \"$0\"" >&2
  exit 1
fi
if ! command -v apparmor_parser >/dev/null 2>&1; then
  echo "AppArmor is not installed here, so no rule is needed."
  exit 0
fi

if [ "${1:-}" = --remove ]; then
  if [ -e "$profile" ]; then
    apparmor_parser -R "$profile" 2>/dev/null || true
    rm -f "$profile"
  fi
  echo "Sandbox rule removed."
  exit 0
fi

# The path goes inside an AppArmor rule, where these characters mean something.
case "$root" in
  /*) ;;
  *)
    echo "The install folder must be an absolute path: $root" >&2
    exit 1
    ;;
esac
case "$root" in
  *'"'*|*'\'*|*'*'*|*'?'*|*'['*|*']'*|*'{'*|*'}'*|*'^'*|*'$'*|*'@'*|*'#'*|*','*|*'
'*|*/../*|*/..)
    echo "An AppArmor rule cannot safely name this folder: $root" >&2
    exit 1
    ;;
esac
# Only this exact install, never @{HOME}: that would let every user on the machine claim the rule.
if [ -n "$(find "$root" -maxdepth 0 -perm /022)" ]; then
  echo "Others can write to $root, so it cannot be trusted with this rule. Fix it with: chmod go-w \"$root\"" >&2
  exit 1
fi
path="$root/versions/*/deepseek-harness"

cat > "$profile" <<EOF
abi <abi/4.0>,
include <tunables/global>

profile deepseek-harness "$path" flags=(unconfined) {
  userns,

  include if exists <local/deepseek-harness>
}
EOF
apparmor_parser -r "$profile"
echo "Sandbox rule installed. Restart DeepSeek Harness to use it."
