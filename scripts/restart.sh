#!/usr/bin/env bash
# Restart the local pxpipe proxy.
#
# What this does, in order:
#   1. Discover every running pxpipe proxy via `pgrep -f "node.*bin/cli.js"`
#      (or, on Windows/Git Bash where pgrep doesn't exist, via a PowerShell
#      CIM query) and list them. If multiple are running (orphans from a
#      prior crashed session), kill all of them — there's no "right" oldest
#      in a graceful restart, we want a clean slate.
#   2. Send SIGTERM (`taskkill` on Windows — see note below). The proxy's
#      SIGTERM handler flushes the JSONL tracker and exits. Poll up to 5s
#      for clean exit.
#   3. Anything still alive after 5s gets SIGKILL (`taskkill //F` on
#      Windows) with a warning.
#   4. Rebuild (`pnpm run build`) unless --no-build is passed. Build errors
#      abort the restart so we never start a stale binary.
#   5. Check the target port is actually free via `lsof` (or `netstat` on
#      Windows, where `lsof` isn't available); if not, name the process
#      holding it (with a hint for the user — common cause: another tool, or
#      step 3 didn't fully release).
#   6. Start a fresh proxy via `exec node bin/cli.js "$@"` so Ctrl-C reaches
#      Node directly.
#
# Windows note: this script runs fine under Git Bash, but Node on Windows
# has no real SIGTERM — step 2's "graceful" kill is best-effort there
# (`taskkill` without //F asks nicely, but the proxy may not get a chance to
# flush its tracker before exiting). Step 3's hard kill still works reliably.
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

# --- Detect Windows (Git Bash / MSYS / Cygwin) for tool fallbacks. ---------
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;;
  *) IS_WINDOWS=0 ;;
esac

# --- OS-dependent helpers ---------------------------------------------------
# Each prefers the real POSIX tool when present (so the pgrep/lsof/kill
# shims used by tests/restart.test.sh keep driving this same code path
# unchanged, even when tested on a real Windows host) and falls back to a
# Windows-native equivalent only when the POSIX tool is genuinely absent.
if command -v pgrep >/dev/null 2>&1; then
  USE_POSIX_PROCTOOLS=1
else
  USE_POSIX_PROCTOOLS=0
fi

# Print PIDs (one per line, whitespace-separated is fine) of running proxies.
find_proxy_pids() {
  if [ "$USE_POSIX_PROCTOOLS" -eq 1 ]; then
    pgrep -f 'node.*bin/[c]li\.js' 2>/dev/null || true
    return
  fi
  if [ "$IS_WINDOWS" -eq 1 ] && command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command \
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'bin[\\\\/]cli\.js' } | Select-Object -ExpandProperty ProcessId" \
      2>/dev/null | tr -d '\r' || true
    return
  fi
  true
}

# Is $1 still alive?
pid_alive() {
  local pid="$1"
  if [ "$USE_POSIX_PROCTOOLS" -eq 1 ]; then
    kill -0 "$pid" 2>/dev/null
    return
  fi
  tasklist //FI "PID eq $pid" 2>/dev/null | grep -q "$pid"
}

# Graceful stop (SIGTERM on POSIX; best-effort taskkill on Windows).
terminate_pid() {
  local pid="$1"
  if [ "$USE_POSIX_PROCTOOLS" -eq 1 ]; then
    kill -TERM "$pid" 2>/dev/null || true
    return
  fi
  taskkill //PID "$pid" >/dev/null 2>&1 || true
}

# Hard stop (SIGKILL on POSIX; forced taskkill on Windows).
kill_pid_hard() {
  local pid="$1"
  if [ "$USE_POSIX_PROCTOOLS" -eq 1 ]; then
    kill -KILL "$pid" 2>/dev/null || true
    return
  fi
  taskkill //F //PID "$pid" >/dev/null 2>&1 || true
}

# --- Parse our own flags out of "$@". --no-build only — pxpipe takes none. ----
DO_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build)
      DO_BUILD=0
      ;;
    *)
      echo "[restart] unknown argument: $arg" >&2
      echo "[restart] this script only accepts --no-build (pxpipe takes no flags)" >&2
      exit 2
      ;;
  esac
done

# --- Figure out which port the new proxy will bind. PORT env var or 47821.
TARGET_PORT="${PORT:-47821}"

# --- 1. Discover running proxies ------------------------------------------
# `[c]li.js` keeps pgrep from matching itself if anyone pipes us through grep.
PIDS_RAW=$(find_proxy_pids)
if [ -n "$PIDS_RAW" ]; then
  # Convert to space-separated list, sorted numerically for stable output.
  PIDS=$(echo "$PIDS_RAW" | tr '\n' ' ' | xargs -n1 | sort -n | tr '\n' ' ')
  echo "[restart] found running pxpipe proxy PID(s): $PIDS"

  # --- 2. Graceful stop for all of them ---
  for pid in $PIDS; do
    if pid_alive "$pid"; then
      echo "[restart] stopping $pid (graceful — tracker flushes on shutdown)"
      terminate_pid "$pid"
    fi
  done

  # Poll up to 5s for graceful exit.
  for _ in $(seq 1 50); do
    STILL=$(find_proxy_pids)
    [ -z "$STILL" ] && break
    sleep 0.1
  done

  # --- 3. Escalate to a hard kill only if still alive ---
  STILL=$(find_proxy_pids)
  if [ -n "$STILL" ]; then
    echo "[restart] WARNING: PID(s) still alive after 5s, escalating to a hard kill: $STILL"
    for pid in $STILL; do
      kill_pid_hard "$pid"
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
# `lsof` is preinstalled on macOS and most Linux distros. On Windows/Git Bash
# (no lsof) we fall back to `netstat -ano`. If neither is available, we skip
# the check rather than failing — the new proxy will surface the same
# EADDRINUSE error via Node's listen() callback.
HOLDER=""
if command -v lsof >/dev/null 2>&1; then
  HOLDER=$(lsof -nP -iTCP:"$TARGET_PORT" -sTCP:LISTEN -t 2>/dev/null || true)
elif [ "$IS_WINDOWS" -eq 1 ] && command -v netstat >/dev/null 2>&1; then
  # netstat -ano lines look like:
  #   TCP    0.0.0.0:47821          0.0.0.0:0              LISTENING       1234
  # PID is the last field, local address (with port) is the second field.
  HOLDER=$(netstat -ano -p TCP 2>/dev/null \
    | grep "LISTENING" \
    | awk -v port=":$TARGET_PORT" '$2 ~ port"$" {print $NF}' \
    | head -n1 || true)
fi
if [ -n "$HOLDER" ]; then
  if [ "$IS_WINDOWS" -eq 1 ] && ! command -v lsof >/dev/null 2>&1; then
    HOLDER_CMD=$(tasklist //FI "PID eq $HOLDER" 2>/dev/null | tail -n1 || echo "?")
  else
    HOLDER_CMD=$(ps -o command= -p "$HOLDER" 2>/dev/null || echo "?")
  fi
  echo "[restart] ERROR: port $TARGET_PORT is still held by PID $HOLDER:" >&2
  echo "    $HOLDER_CMD" >&2
  echo "  Hint: if that's a pxpipe proxy our graceful stop should have cleared," >&2
  echo "  it may have been started outside this repo. Free the port and rerun." >&2
  exit 1
fi

# --- 6. Start fresh in the foreground. exec so Ctrl-C goes straight to Node.
echo "[restart] starting fresh proxy on :$TARGET_PORT (Ctrl-C to stop)"
exec node bin/cli.js
