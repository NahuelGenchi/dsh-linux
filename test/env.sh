#!/bin/sh
# Test helper: runs a command with an isolated home on the private X display, in the same
# AppArmor context as a normal login session. Usage: test/env.sh <run name> <command...>
run=$(readlink -f -- "$(dirname -- "$0")/../.work")/$1
shift
mkdir -p "$run/home"
export HOME="$run/home" XDG_CONFIG_HOME="$run/home/.config" XDG_DATA_HOME="$run/home/.local/share" XDG_CACHE_HOME="$run/home/.cache" XDG_STATE_HOME="$run/home/.local/state"
export PATH="$HOME/.local/bin:$PATH" DISPLAY="127.0.0.1:${DSH_TEST_DISPLAY:-99}" ELECTRON_ENABLE_LOGGING=1
# A machine's AppArmor rule names its real install, not a test copy.
export ELECTRON_DISABLE_SANDBOX=1
unset WAYLAND_DISPLAY NODE_OPTIONS XDG_SESSION_TYPE
# With no address, programs find the real session's bus by themselves, and test popups reach the desktop.
export DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent
exec aa-exec -p unconfined -- "$@"
