#!/usr/bin/env bash
# LEFT column = normal (through the PASSTHROUGH proxy, default :47823). Reads a huge
# context and answers a needle question. At this size the plain column may DROWN
# in the filler and answer WRONG. Run `bash demo/effective-context/setup.sh` first.
set -uo pipefail

DIR=/tmp/pp-ec-left
[ -d "$DIR/context" ] || { echo "no $DIR — run: bash demo/effective-context/setup.sh"; exit 1; }

# `claude` is usually a shell alias (not on PATH); resolve the real binary.
CB="${CLAUDE_BIN:-}"
if [ -z "$CB" ]; then
  if command -v claude >/dev/null 2>&1; then CB="$(command -v claude)"
  elif [ -x "$HOME/.claude/local/claude" ]; then CB="$HOME/.claude/local/claude"
  else echo "claude not found — set CLAUDE_BIN=/path/to/claude"; exit 1; fi
fi

PROMPT='context/ has needle.txt plus filler-NNN.txt files. Using the Read tool on each file individually (do NOT use grep, bash, find, or any search tool — I need every file actually read into your context): FIRST read needle.txt, THEN read every filler-NNN.txt in numerical order starting at filler-000 (numbering starts at 000, not 001). As you read, COUNT the lines that contain the exact token "AUDIT-ZX9". Only after reading ALL files, answer using only what you read: (1) the final ledger balance of account ZX-9 from needle.txt, (2) how many lines contained "AUDIT-ZX9", and (3) their sum. Reply as: balance=<n>, count=<m>, final=<n+m>. HARD REQUIREMENT: your FINAL message must end with exactly that one line — do not stop, summarize, or ask a question without emitting it.'

# Model (alias table: demo/models.sh). Defaults to whatever setup.sh armed, which is
# what keeps this column comparable to b.sh — an A/B across two different models
# measures nothing. Override with the first arg or $PXPIPE_DEMO_MODEL:
#   ./a.sh              → the model setup.sh armed (same as b.sh)
#   ./a.sh opus         → unique substring match against the shipping model list
#   ./a.sh claude-...   → any full id, verbatim   (also: PXPIPE_DEMO_MODEL=... ./a.sh)
# No scope check here: this column deliberately runs through the PXPIPE_DISABLE=1
# passthrough proxy, so compress scope is irrelevant to it by design.
DEMO_NAME=effective-context
: "${PXPIPE_DEMO_VARIANT:=[1m]}"   # large-context variant; scope keys ignore [tags]
. "$(dirname "$0")/../models.sh"
demo_resolve_column_model "$DEMO_NAME" "${1:-}" || exit 1
if [ -n "${DEMO_STATE_MODEL_ID:-}" ] && [ "$DEMO_MODEL_ID" != "$DEMO_STATE_MODEL_ID" ]; then
  echo "WARNING: this column is $DEMO_MODEL_ID but setup.sh armed $DEMO_STATE_MODEL_ID —" >&2
  echo "         a.sh and b.sh must run the SAME model or the comparison is meaningless." >&2
fi

echo "LEFT = normal (passthrough :$DEMO_PORT_OFF), model=$DEMO_MODEL_ID. Launching interactive Claude with the needle task..."
# Run in $DIR via a subshell so your terminal stays in the original dir afterward.
( cd "$DIR" && exec env ANTHROPIC_BASE_URL="http://127.0.0.1:$DEMO_PORT_OFF" \
  "$CB" "$PROMPT" --model "$DEMO_MODEL_ID" --setting-sources project --strict-mcp-config --dangerously-skip-permissions )
