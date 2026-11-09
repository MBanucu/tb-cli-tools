#!/usr/bin/env bash
# Start Thunderbird inside the user's graphical session and wait until the
# tb-cli-tools host answers.
#
# Why this exists:
#   * A Thunderbird started from a shell dies with that shell's process group,
#     so it runs as a transient systemd user unit instead.
#   * Startup occasionally dies with SIGSEGV inside libfontconfig (font cache,
#     independent of the profile). A single retry is enough in practice.
#   * lock/.parentlock may only be deleted when no process is alive; deleting
#     them while an instance is still shutting down invites a second instance
#     on the same profile.
#
# Overrides: TB_PROFILE, TB_UNIT, TB_BIN, TB_WAIT_STOP, TB_WAIT_READY,
#            TB_CLI_TOOLS_SOCK, DISPLAY, WAYLAND_DISPLAY, XAUTHORITY
set -euo pipefail

PROFILE="${TB_PROFILE:-$HOME/.thunderbird/b889cdom.default}"
UNIT="${TB_UNIT:-thunderbird-main}"
BIN="${TB_BIN:-thunderbird}"
WAIT_STOP="${TB_WAIT_STOP:-60}"
WAIT_READY="${TB_WAIT_READY:-40}"
RUNTIME="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
SOCK="${TB_CLI_TOOLS_SOCK:-$RUNTIME/tb-cli-tools.sock}"
export XDG_RUNTIME_DIR="$RUNTIME"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$RUNTIME/bus}"

log() { printf 'tb-launch: %s\n' "$*" >&2; }

# Matches "<path>/.thunderbird-wrapped_ --profile <dir>" and the real binary.
tb_pids() {
  pgrep -f -- "thunderbird[^ ]* .*--profile $PROFILE" 2>/dev/null || true
}

wait_stopped() {
  local end=$((SECONDS + WAIT_STOP))
  while [ "$SECONDS" -lt "$end" ]; do
    if ! systemctl --user is-active --quiet "$UNIT" && [ -z "$(tb_pids)" ]; then
      return 0
    fi
    sleep 1
  done
  [ -z "$(tb_pids)" ]
}

clean_stale() {
  local f target pid
  for f in "$PROFILE/lock" "$PROFILE/.parentlock"; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    if [ -L "$f" ]; then
      target="$(readlink "$f" || true)"
      pid="${target##*+}"
      case "$pid" in
        '' | *[!0-9]*) : ;;
        *)
          if kill -0 "$pid" 2>/dev/null; then
            log "$(basename "$f") belongs to live process $pid - leaving it alone"
            return 1
          fi
          ;;
      esac
    fi
    rm -f "$f"
    log "removed stale $(basename "$f")"
  done
  return 0
}

start() {
  local xauth="${XAUTHORITY:-}" args=()
  if [ -z "$xauth" ]; then
    xauth="$(ls -1 "$RUNTIME"/.mutter-Xwaylandauth* 2>/dev/null | head -1 || true)"
  fi
  systemctl --user reset-failed "$UNIT" >/dev/null 2>&1 || true
  args=(
    --user --unit="$UNIT"
    --setenv=HOME="$HOME"
    --setenv=XDG_RUNTIME_DIR="$RUNTIME"
    --setenv=XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
    --setenv=DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS"
    --setenv=DISPLAY="${DISPLAY:-:0}"
    --setenv=WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
  )
  if [ -n "$xauth" ]; then
    args+=(--setenv=XAUTHORITY="$xauth")
  fi
  systemd-run "${args[@]}" "$BIN" --profile "$PROFILE" >/dev/null
}

wait_ready() {
  local end=$((SECONDS + WAIT_READY))
  while [ "$SECONDS" -lt "$end" ]; do
    if ! systemctl --user is-active --quiet "$UNIT"; then
      return 1
    fi
    # A leftover socket file is not enough - require a live listener.
    if [ -S "$SOCK" ] && ss -xl 2>/dev/null | grep -qF "$SOCK"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

report_failure() {
  local result
  result="$(systemctl --user show -p Result --value "$UNIT" 2>/dev/null || true)"
  log "Thunderbird did not come up (Result=${result:-unknown})"
  journalctl --user -u "$UNIT" -n 12 --no-pager 2>/dev/null | sed 's/^/  /' >&2 || true
}

if systemctl --user is-active --quiet "$UNIT"; then
  log "already running (unit $UNIT)"
  exit 0
fi

if ! wait_stopped; then
  log "Thunderbird for $PROFILE is still running - not starting a second instance"
  exit 1
fi

clean_stale || exit 1
start
if wait_ready; then
  log "ready (unit $UNIT, socket $SOCK)"
  exit 0
fi

report_failure
clean_stale || exit 1
log "retrying once - startup crashes inside libfontconfig are transient here"
start
if wait_ready; then
  log "ready after retry (unit $UNIT, socket $SOCK)"
  exit 0
fi

report_failure
log "giving up - inspect with: journalctl --user -u $UNIT"
exit 1
