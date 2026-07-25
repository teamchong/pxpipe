#!/usr/bin/env bash
# Demo setup: kill old proxies, build, start BOTH proxies (background, fresh logs),
# seed two fresh /tmp working copies. Run this ONCE, then run a.sh and b.sh in two
# other terminals.
#
#   bash demo/cost-ab/setup.sh
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1   # -> repo root

# Model table + ports are shared by all six demo scripts. Sourced repo-relative
# because line 8 already cd'd to the repo root.
DEMO_NAME=cost-ab
: "${PXPIPE_DEMO_VARIANT:=[1m]}"   # this demo wants the large-context variant;
                                  # scope keys ignore [tags], so this is not a model pin
. demo/models.sh

PORT_ON="$DEMO_PORT_ON"    # pxpipe      -> b.sh (right)
PORT_OFF="$DEMO_PORT_OFF"  # passthrough -> a.sh (left, plain but logged)
LOG_ON="$HOME/.pxpipe/ab-on.jsonl"
LOG_OFF="$HOME/.pxpipe/ab-off.jsonl"
DUMP_DIR="/tmp/ab-png"   # pxpipe arm dumps every rendered PNG here for debug/inspection (wiped each run)
# Model under test. NO model names live in this file — the default and the
# shorthand matching both come from the product's own DEFAULT_MODEL_BASES, so this
# demo follows whatever is actually shipping (see demo/models.sh for why).
#   bash setup.sh                        -> the product's first default model
#   bash setup.sh opus                   -> unique substring match against that list
#   bash setup.sh <full-model-id>        -> used verbatim, no matching
#   PXPIPE_DEMO_MODEL=... bash setup.sh  -> same, via env
# The choice is ADDED to the compress scope and RECORDED, so a.sh/b.sh inherit it
# and b.sh refuses to run a model this proxy would silently pass through.
demo_resolve_model "${1:-}" || exit 1
# Compress scope entries are model BASES: the proxy strips [variant] tags (e.g. [1m])
# before matching (see src/core/applicability.ts), so a base already covers its [1m]
# form. Do NOT add [1m] here — the stripped incoming base would no longer equal this
# entry and pxpipe would quietly stop compressing.
MODELS="$(demo_scope_for "$DEMO_MODEL_BASE")"

kill_port() { local p; p=$(lsof -ti tcp:"$1" 2>/dev/null || true); [ -n "$p" ] && kill "$p" 2>/dev/null || true; }

echo "[1/4] kill old proxies ($PORT_ON, $PORT_OFF)"
kill_port "$PORT_ON"; kill_port "$PORT_OFF"; sleep 1

echo "[2/4] build"
pnpm run build >/tmp/ab-build.log 2>&1 || { echo "  build FAILED -> /tmp/ab-build.log"; exit 1; }

echo "[3/4] start proxies (background, fresh logs)"
: >"$LOG_ON"; : >"$LOG_OFF"
rm -rf "$DUMP_DIR"; mkdir -p "$DUMP_DIR"   # fresh PNG dump for the pxpipe (compress) arm; the passthrough arm renders nothing
PXPIPE_LOG="$LOG_ON"  PORT="$PORT_ON"  PXPIPE_MODELS="$MODELS" PXPIPE_DUMP_DIR="$DUMP_DIR" nohup node dist/node.js >/tmp/ab-on.log  2>&1 & disown
PXPIPE_LOG="$LOG_OFF" PORT="$PORT_OFF" PXPIPE_MODELS="$MODELS" PXPIPE_DISABLE=1            nohup node dist/node.js >/tmp/ab-off.log 2>&1 & disown
sleep 2

echo "[4/4] seed working copies"
DEMO_MODEL_ID="$DEMO_MODEL_ID" node demo/cost-ab/setup.mjs >/dev/null

# Record what we actually armed. a.sh/b.sh default to this model and refuse to run
# one the proxy would pass through uncompressed (which would look like a pxpipe
# result while measuring nothing).
demo_write_state "$DEMO_NAME" "$DEMO_MODEL_BASE" "$DEMO_MODEL_ID" "$MODELS" ""

cat <<EOF

Ready. Proxies up: pxpipe :$PORT_ON  ·  passthrough :$PORT_OFF
MODEL UNDER TEST: $DEMO_MODEL_ID   (compress scope: $MODELS)
(logs: $LOG_ON / $LOG_OFF ; stdout: /tmp/ab-on.log /tmp/ab-off.log)
Rendered PNGs (what the pxpipe model actually sees): $DUMP_DIR   (wiped + refilled each setup; passthrough arm renders none)

In a browser, open the live dashboard (updates as the run goes — no commands):
  http://localhost:$PORT_ON     # pxpipe   -> "THIS SESSION — N% fewer tokens"
  http://localhost:$PORT_OFF    # plain    -> ~0% (the passthrough control)

Then, in TWO separate terminals:
  bash demo/cost-ab/a.sh        # LEFT  = normal  (interactive — you watch it)
  bash demo/cost-ab/b.sh        # RIGHT = pxpipe   (interactive)

(Optional CLI, if you don't want the browser:
  node eval/ab/savings.mjs                          # token compression, both arms
  node eval/ab/analyze.mjs $LOG_ON $LOG_OFF )
EOF
