#!/usr/bin/env bash
# Effective-context demo setup: generate the big context, kill old proxies, build,
# start BOTH proxies (background, fresh logs), seed two fresh /tmp working copies.
# Run this ONCE, then run a.sh and b.sh in two other terminals.
#
#   bash demo/effective-context/setup.sh
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1   # -> repo root

# Model table + ports are shared by all six demo scripts. Sourced repo-relative
# because line 8 already cd'd to the repo root.
DEMO_NAME=effective-context
: "${PXPIPE_DEMO_VARIANT:=[1m]}"   # this demo floods the context, so it wants the
                                  # large-context variant; scope keys ignore [tags]
. demo/models.sh

PORT_ON="$DEMO_PORT_ON"    # pxpipe      -> b.sh (right)
PORT_OFF="$DEMO_PORT_OFF"  # passthrough -> a.sh (left, plain but logged)
LOG_ON="$HOME/.pxpipe/ec-on.jsonl"
LOG_OFF="$HOME/.pxpipe/ec-off.jsonl"
DUMP_DIR="/tmp/ec-png"   # pxpipe arm dumps every rendered PNG here for debug/inspection (wiped each run)
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
EC="demo/effective-context"

kill_port() { local p; p=$(lsof -ti tcp:"$1" 2>/dev/null || true); [ -n "$p" ] && kill "$p" 2>/dev/null || true; }

echo "[1/5] kill old proxies ($PORT_ON, $PORT_OFF)"
kill_port "$PORT_ON"; kill_port "$PORT_OFF"; sleep 1

echo "[2/5] build"
pnpm run build >/tmp/ec-build.log 2>&1 || { echo "  build FAILED -> /tmp/ec-build.log"; exit 1; }

echo "[3/5] generate context (flood + needle)"
ANSWER=$(node "$EC/generate.mjs" | tee /tmp/ec-gen.log | sed -n 's/^--- expected answer (ground truth): \(.*\) ---$/\1/p')

echo "[4/5] start proxies (background, fresh logs)"
: >"$LOG_ON"; : >"$LOG_OFF"
rm -rf "$DUMP_DIR"; mkdir -p "$DUMP_DIR"   # fresh PNG dump for the pxpipe (compress) arm; the passthrough arm renders nothing
PXPIPE_LOG="$LOG_ON"  PORT="$PORT_ON"  PXPIPE_MODELS="$MODELS" PXPIPE_DUMP_DIR="$DUMP_DIR" nohup node dist/node.js >/tmp/ec-on.log  2>&1 & disown
PXPIPE_LOG="$LOG_OFF" PORT="$PORT_OFF" PXPIPE_MODELS="$MODELS" PXPIPE_DISABLE=1            nohup node dist/node.js >/tmp/ec-off.log 2>&1 & disown
sleep 2

echo "[5/5] seed two read-only working copies (context/ only)"
rm -rf /tmp/pp-ec-left /tmp/pp-ec-right
mkdir -p /tmp/pp-ec-left /tmp/pp-ec-right
cp -R "$EC/context" /tmp/pp-ec-left/context
cp -R "$EC/context" /tmp/pp-ec-right/context

# Record what we actually armed. a.sh/b.sh default to this model and refuse to run
# one the proxy would pass through uncompressed (which would look like a pxpipe
# result while measuring nothing).
demo_write_state "$DEMO_NAME" "$DEMO_MODEL_BASE" "$DEMO_MODEL_ID" "$MODELS" "$ANSWER"

cat <<EOF

Ready. Proxies up: pxpipe :$PORT_ON  ·  passthrough :$PORT_OFF
MODEL UNDER TEST: $DEMO_MODEL_ID   (compress scope: $MODELS)
GROUND-TRUTH ANSWER: ${ANSWER:-see /tmp/ec-gen.log}   <- both columns should reply with exactly this
Rendered PNGs (what the pxpipe model actually sees): $DUMP_DIR   (wiped + refilled each setup; passthrough arm renders none)

In a browser, open the live dashboard (context/token reduction, updates as it reads):
  http://localhost:$PORT_ON     # pxpipe   -> "THIS SESSION — N% fewer tokens"
  http://localhost:$PORT_OFF    # plain    -> ~0% (the passthrough control)

Then, in TWO separate terminals:
  bash $EC/a.sh        # LEFT  = normal  (may DROWN in filler -> wrong integer)
  bash $EC/b.sh        # RIGHT = pxpipe  (images filler, keeps needle as text -> ${ANSWER:-right})

The win is CAPABILITY, not cost: watch each column's final integer. To redo, re-run
this setup (fresh context, fresh logs, fresh copies), then a.sh / b.sh.
EOF
