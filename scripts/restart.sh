#!/usr/bin/env bash
# Restart the local pxpipe proxy.
#
# What this does, in order:
#   1. Discover every running pxpipe proxy via `pgrep -f "node.*bin/cli.js"`
#      and list them. If multiple are running (orphans from a prior crashed
#      session), kill all of them — there's no "right" oldest in a graceful
#      restart, we want a clean slate.
#   2. Send SIGTERM. The proxy's SIGTERM handler flushes the JSONL tracker
#      and exits. Poll up to 5s for clean exit.
#   3. Anything still alive after 5s gets SIGKILL with a warning.
#   4. Rebuild (`pnpm run build`) unless --no-build is passed. Build errors
#      abort the restart so we never start a stale binary.
#   5. Check the target port is actually free; if not, name the process
#      holding it (with a hint for the user — common cause: another tool, or
#      step 3 didn't fully release).
#   6. Start a fresh proxy via `exec node bin/cli.js "$@"` so Ctrl-C reaches
#      Node directly.
#
# Flags:
#   --no-build    Skip the rebuild step. Use when you know dist/ is fresh.
#
# Examples:
#   pnpm run restart
#   pnpm run restart -- --no-build
#   PORT=47899 pnpm run restart

set -euo pipefail

cd "$(dirname "$0")/.."

# --- Parse our own flags out of "$@". --no-build only — pxpipe takes none. ----
DO_BUILD=1
DETACH=0
for arg in "$@"; do
  case "$arg" in
    --no-build)
      DO_BUILD=0
      ;;
    --detach)
      DETACH=1
      ;;
    *)
      echo "[restart] unknown argument: $arg" >&2
      echo "[restart] this script only accepts --no-build/--detach (pxpipe takes no flags)" >&2
      exit 2
      ;;
  esac
done

# --- Figure out which port the new proxy will bind. PORT env var or 47821.
TARGET_PORT="${PORT:-47821}"

# --- 1. Discover running proxies ------------------------------------------
# `[c]li.js` keeps pgrep from matching itself if anyone pipes us through grep.
#
# `cli.js warp -- <cmd>` matches that pattern too, and warp is not a proxy we
# may restart: it owns a child process (often the Claude Code session running
# this very script). SIGTERM to warp takes the child with it, so the restart
# would kill the caller. Serving proxies only.
#
# NOTE: the filter is a function, not an inline `case` inside `$(...)`. bash 3.2
# (still the default /bin/bash on macOS) mis-parses a `case` pattern's closing
# `)` as the end of the command substitution, giving:
#     syntax error near unexpected token `;;'
list_serving_pids() {
  local p args
  pgrep -f 'node.*bin/[c]li\.js' 2>/dev/null | while read -r p; do
    args=$(ps -o args= -p "$p" 2>/dev/null)
    case "$args" in
      *"cli.js warp"*) ;;
      *) echo "$p" ;;
    esac
  done
}
PIDS_RAW=$(list_serving_pids || true)
if [ -n "$PIDS_RAW" ]; then
  # Convert to space-separated list, sorted numerically for stable output.
  PIDS=$(echo "$PIDS_RAW" | tr '\n' ' ' | xargs -n1 | sort -n | tr '\n' ' ')
  echo "[restart] found running pxpipe proxy PID(s): $PIDS"

  # --- 2. SIGTERM all of them ---
  for pid in $PIDS; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "[restart] SIGTERM $pid (graceful — tracker flushes on shutdown)"
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done

  # Poll up to 5s for graceful exit.
  for _ in $(seq 1 50); do
    STILL=$(list_serving_pids || true)
    [ -z "$STILL" ] && break
    sleep 0.1
  done

  # --- 3. Escalate to SIGKILL only if still alive ---
  STILL=$(list_serving_pids || true)
  if [ -n "$STILL" ]; then
    echo "[restart] WARNING: PID(s) still alive after 5s, escalating to SIGKILL: $STILL"
    for pid in $STILL; do
      kill -KILL "$pid" 2>/dev/null || true
    done
    sleep 0.3
  fi
else
  echo "[restart] no running proxy found"
fi

# --- 4. Rebuild (skippable) ----------------------------------------------
if [ "$DO_BUILD" -eq 1 ]; then
  echo "[restart] rebuilding…"
  if ! pnpm run build; then
    echo "[restart] ERROR: build failed. Not starting a stale binary." >&2
    exit 1
  fi
else
  echo "[restart] --no-build: skipping rebuild (assuming dist/ is fresh)"
fi

# --- 5. Sanity-check the target port is free -----------------------------
# `lsof` is preinstalled on macOS and most Linux distros. If it isn't, we
# skip the check rather than failing — the new proxy will surface the same
# EADDRINUSE error via Node's listen() callback.
if command -v lsof >/dev/null 2>&1; then
  HOLDER=$(lsof -nP -iTCP:"$TARGET_PORT" -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$HOLDER" ]; then
    HOLDER_CMD=$(ps -o command= -p "$HOLDER" 2>/dev/null || echo "?")
    echo "[restart] ERROR: port $TARGET_PORT is still held by PID $HOLDER:" >&2
    echo "    $HOLDER_CMD" >&2
    echo "  Hint: if that's a pxpipe proxy our SIGTERM should have cleared," >&2
    echo "  it may have been started outside this repo. Free the port and rerun." >&2
    exit 1
  fi
fi

# --- 6. Start fresh in the foreground. exec so Ctrl-C goes straight to Node.
if [ "$DETACH" -eq 1 ]; then
  # Survive the calling shell: non-interactive callers (CI, agent tool calls,
  # `ssh host cmd`) get SIGHUP'd on exit, which would take the proxy with them.
  LOG="${TMPDIR:-/tmp}/pxpipe-proxy.log"
  echo "[restart] starting detached proxy on :$TARGET_PORT (log: $LOG)"
  nohup node bin/cli.js >>"$LOG" 2>&1 &
  NEW_PID=$!
  disown "$NEW_PID" 2>/dev/null || true
  # Confirm it actually bound the port instead of dying on startup.
  for _ in $(seq 1 100); do
    if ! kill -0 "$NEW_PID" 2>/dev/null; then
      echo "[restart] ERROR: proxy exited during startup. Last log lines:" >&2
      tail -20 "$LOG" >&2
      exit 1
    fi
    if lsof -nP -iTCP:"$TARGET_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$NEW_PID"; then
      echo "[restart] proxy PID $NEW_PID listening on :$TARGET_PORT"
      exit 0
    fi
    sleep 0.1
  done
  echo "[restart] ERROR: PID $NEW_PID never bound :$TARGET_PORT within 10s" >&2
  tail -20 "$LOG" >&2
  exit 1
fi

echo "[restart] starting fresh proxy on :$TARGET_PORT (Ctrl-C to stop)"
exec node bin/cli.js
