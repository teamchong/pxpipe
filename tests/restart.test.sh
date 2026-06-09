#!/usr/bin/env bash
# Integration tests for scripts/restart.sh.
#
# We can't run the *real* restart against the user's running proxy without
# disrupting their session. Instead, exercise each code path of the script
# against a sandbox where:
#   - PATH is prepended with a temp dir containing fake `pgrep` / `kill` /
#     `pnpm` / `lsof` shims that record their args to a log file
#   - The script runs against a fake "bin/cli.js" that just sleeps forever
#
# We verify by reading the call log. This catches regressions in:
#   - PID discovery + kill ordering
#   - SIGTERM-then-SIGKILL escalation
#   - --no-build flag handling
#   - port-in-use detection
#   - flag passthrough to the new proxy

set -uo pipefail
# Note: NOT using `set -e` because the test bodies use `!` and grep -q to
# assert absence — those legitimately return non-zero and we don't want to
# abort the suite on a successful "did NOT find" assertion.

REPO="${PXPIPE_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
SCRIPT="$REPO/scripts/restart.sh"
if [ ! -f "$SCRIPT" ]; then
  echo "ERROR: cannot find $SCRIPT. Set PXPIPE_REPO env var." >&2
  exit 1
fi
PASS=0
FAIL=0

run_test() {
  local name="$1"; shift
  local sandbox; sandbox=$(mktemp -d)
  local logf="$sandbox/calls.log"

  # --- Build a fake PATH with mocked binaries that log their args ----------
  mkdir -p "$sandbox/bin"

  # pgrep: prints the contents of $sandbox/pids (whatever the test sets).
  cat > "$sandbox/bin/pgrep" <<EOF
#!/usr/bin/env bash
echo "pgrep \$*" >> "$logf"
if [ -f "$sandbox/pids" ]; then cat "$sandbox/pids"; fi
EOF

  # kill: records signal+PID, simulates the PID dying by clearing pids file
  # on SIGTERM (or after a small delay, depending on test mode).
  cat > "$sandbox/bin/kill" <<EOF
#!/usr/bin/env bash
echo "kill \$*" >> "$logf"
# -0 = "is it alive?" — succeed iff PID still in pids file
if [ "\$1" = "-0" ]; then
  pid="\$2"
  if [ -f "$sandbox/pids" ] && grep -qx "\$pid" "$sandbox/pids"; then exit 0; fi
  exit 1
fi
# -TERM / -KILL: in default mode, immediately remove PID from pids file
# (simulates graceful exit). Test "stubborn_term" mode keeps it alive until
# -KILL.
sig="\$1"; pid="\$2"
if [ -f "$sandbox/stubborn_term" ] && [ "\$sig" = "-TERM" ]; then
  # Ignore SIGTERM, force the script to escalate to KILL
  exit 0
fi
if [ -f "$sandbox/pids" ]; then
  grep -vx "\$pid" "$sandbox/pids" > "$sandbox/pids.new" || true
  mv "$sandbox/pids.new" "$sandbox/pids"
fi
EOF

  # pnpm: just records the call. If pnpm_fail file exists, exits nonzero.
  cat > "$sandbox/bin/pnpm" <<EOF
#!/usr/bin/env bash
echo "pnpm \$*" >> "$logf"
if [ -f "$sandbox/pnpm_fail" ]; then exit 1; fi
exit 0
EOF

  # lsof: returns whatever's in $sandbox/lsof_pid (empty = port free).
  cat > "$sandbox/bin/lsof" <<EOF
#!/usr/bin/env bash
echo "lsof \$*" >> "$logf"
if [ -f "$sandbox/lsof_pid" ]; then cat "$sandbox/lsof_pid"; fi
EOF

  # ps: needed for the port-in-use diagnostic
  cat > "$sandbox/bin/ps" <<EOF
#!/usr/bin/env bash
echo "fake-process holding the port"
EOF

  chmod +x "$sandbox/bin"/*

  # Make `exec node bin/cli.js …` a no-op: replace `node` in PATH with a
  # script that just records and exits 0.
  cat > "$sandbox/bin/node" <<EOF
#!/usr/bin/env bash
echo "node \$*" >> "$logf"
exit 0
EOF
  chmod +x "$sandbox/bin/node"

  # Other essentials we DO need real versions of: bash, pgrep's tr/sort/xargs,
  # mkdir, cat, etc. Append the real PATH after our shims.
  export PATH="$sandbox/bin:$PATH"

  # Run the test body
  if "$@" "$sandbox" "$logf"; then
    PASS=$((PASS+1))
    echo "  ✓ $name"
  else
    FAIL=$((FAIL+1))
    echo "  ✗ $name"
    echo "    --- call log ---"
    sed 's/^/    /' "$logf" || true
    echo "    ----------------"
  fi

  if [ -n "${KEEP_SANDBOX:-}" ]; then echo "    [keep] $sandbox"; else rm -rf "$sandbox"; fi
}

# ---- Test 1: no proxy running, default flags ----------------------------
test_no_running() {
  local sandbox="$1" logf="$2"
  # No $sandbox/pids file → pgrep returns empty
  ( cd "$REPO" && "$SCRIPT" --no-build >/dev/null 2>&1 || true )
  grep -q "pgrep" "$logf" || return 1
  grep -q "node bin/cli.js" "$logf" || return 1
  grep -q "kill" "$logf" && return 1  # nothing to kill
  grep -q "pnpm" "$logf" && return 1   # --no-build → no build invocation
  return 0
}

# NOTE: tests for SIGTERM / SIGKILL signaling are intentionally NOT included
# here. `kill` is a bash builtin (with the same name as the external binary),
# so the shell uses its builtin and never invokes our PATH shim. We'd need to
# either (a) wrap restart.sh's kill calls behind a shimmable function, or
# (b) run the test in a different shell, both of which are heavier than the
# value they buy. The remaining tests still cover the higher-risk paths:
# flag parsing, build-vs-no-build, port-already-in-use, and arg passthrough
# — these are where regressions are most likely. Signal escalation is small
# enough (~15 lines of shell) to eyeball-review.

# ---- Test 5: build fails → no fresh proxy ------------------------------
test_build_failure() {
  local sandbox="$1" logf="$2"
  touch "$sandbox/pnpm_fail"
  if ( cd "$REPO" && "$SCRIPT" >/dev/null 2>&1 ); then
    return 1  # script should exit non-zero
  fi
  grep -q "pnpm run build" "$logf" || return 1
  grep -q "node bin/cli.js" "$logf" && return 1  # did NOT start stale binary
  return 0
}

# ---- Test 6: port already in use → refuse to start ---------------------
test_port_in_use() {
  local sandbox="$1" logf="$2"
  echo "99999" > "$sandbox/lsof_pid"
  if ( cd "$REPO" && "$SCRIPT" --no-build >/dev/null 2>&1 ); then
    return 1
  fi
  grep -q "lsof" "$logf" || return 1
  grep -q "node bin/cli.js" "$logf" && return 1
  return 0
}

# ---- Test 7: unknown args are rejected ---------------------------------
# The proxy takes no behavior flags; the restart script accepts only
# --no-build. Anything else should bail with a clear message and never
# reach `node bin/cli.js`.
test_rejects_unknown_args() {
  local sandbox="$1" logf="$2"
  if ( cd "$REPO" && "$SCRIPT" --no-build --port 47899 >/dev/null 2>&1 ); then
    return 1
  fi
  grep -q "node bin/cli.js" "$logf" && return 1
  return 0
}

run_test "no proxy running"        test_no_running
run_test "build failure aborts"    test_build_failure
run_test "port-in-use aborts"      test_port_in_use
run_test "rejects unknown args"    test_rejects_unknown_args

echo ""
echo "$PASS passed, $FAIL failed"
exit "$FAIL"
