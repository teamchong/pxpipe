#!/usr/bin/env bash
# LEFT column = normal (through the PASSTHROUGH proxy, default :47823). Launches an
# INTERACTIVE Claude session with the task prompt already submitted — you watch
# it work in the real CLI. Run `bash demo/cost-ab/setup.sh` first.
set -uo pipefail

DIR=/tmp/pp-demo-left
[ -d "$DIR" ] || { echo "no $DIR — run: bash demo/cost-ab/setup.sh"; exit 1; }

# `claude` is usually a shell alias (not on PATH); resolve the real binary.
CB="${CLAUDE_BIN:-}"
if [ -z "$CB" ]; then
  if command -v claude >/dev/null 2>&1; then CB="$(command -v claude)"
  elif [ -x "$HOME/.claude/local/claude" ]; then CB="$HOME/.claude/local/claude"
  else echo "claude not found — set CLAUDE_BIN=/path/to/claude"; exit 1; fi
fi

PROMPT='This project has a failing test suite. Read SPEC.md and the source, then fix src/pricing.js so it follows SPEC.md exactly and the test suite (node --test) passes. Run the tests to confirm.'

# Model (resolution rules: demo/models.sh — no model name is hardcoded there or
# here). Defaults to whatever setup.sh armed, which is what keeps this column
# comparable to b.sh — an A/B across two different models measures nothing.
#   ./a.sh              → the model setup.sh armed (same as b.sh)
#   ./a.sh opus         → unique substring match against the shipping model list
#   ./a.sh claude-...   → any full id, verbatim   (also: PXPIPE_DEMO_MODEL=... ./a.sh)
# No scope check here: this column deliberately runs through the PXPIPE_DISABLE=1
# passthrough proxy, so compress scope is irrelevant to it by design.
DEMO_NAME=cost-ab
: "${PXPIPE_DEMO_VARIANT:=[1m]}"   # large-context variant; scope keys ignore [tags]
. "$(dirname "$0")/../models.sh"
demo_resolve_column_model "$DEMO_NAME" "${1:-}" || exit 1
if [ -n "${DEMO_STATE_MODEL_ID:-}" ] && [ "$DEMO_MODEL_ID" != "$DEMO_STATE_MODEL_ID" ]; then
  echo "WARNING: this column is $DEMO_MODEL_ID but setup.sh armed $DEMO_STATE_MODEL_ID —" >&2
  echo "         a.sh and b.sh must run the SAME model or the comparison is meaningless." >&2
fi

echo "LEFT = normal (passthrough :$DEMO_PORT_OFF), model=$DEMO_MODEL_ID. Launching interactive Claude with the task..."
# Run in $DIR via a subshell so your terminal stays in the original dir afterward.
( cd "$DIR" && exec env ANTHROPIC_BASE_URL="http://127.0.0.1:$DEMO_PORT_OFF" \
  "$CB" "$PROMPT" --model "$DEMO_MODEL_ID" --setting-sources project --strict-mcp-config --no-chrome --dangerously-skip-permissions )
