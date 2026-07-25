#!/usr/bin/env bash
# RIGHT column = pxpipe (through the compress proxy, default :47824). Reads the SAME huge context.
# pxpipe images the bulky filler but keeps the small needle as text, so it carries
# a smaller active context and should read the needle perfectly. Run
# `bash demo/effective-context/setup.sh` first.
set -uo pipefail

DIR=/tmp/pp-ec-right
[ -d "$DIR/context" ] || { echo "no $DIR — run: bash demo/effective-context/setup.sh"; exit 1; }

# `claude` is usually a shell alias (not on PATH); resolve the real binary.
CB="${CLAUDE_BIN:-}"
if [ -z "$CB" ]; then
  if command -v claude >/dev/null 2>&1; then CB="$(command -v claude)"
  elif [ -x "$HOME/.claude/local/claude" ]; then CB="$HOME/.claude/local/claude"
  else echo "claude not found — set CLAUDE_BIN=/path/to/claude"; exit 1; fi
fi

PROMPT='context/ has needle.txt plus filler-NNN.txt files. Using the Read tool on each file individually (do NOT use grep, bash, find, or any search tool — I need every file actually read into your context): FIRST read needle.txt, THEN read every filler-NNN.txt in numerical order starting at filler-000 (numbering starts at 000, not 001). As you read, COUNT the lines that contain the exact token "AUDIT-ZX9". Only after reading ALL files, answer using only what you read: (1) the final ledger balance of account ZX-9 from needle.txt, (2) how many lines contained "AUDIT-ZX9", and (3) their sum. Reply as: balance=<n>, count=<m>, final=<n+m>. HARD REQUIREMENT: your FINAL message must end with exactly that one line — do not stop, summarize, or ask a question without emitting it.'

# Model (alias table: demo/models.sh). Defaults to whatever setup.sh armed, so the
# usual flow is `setup.sh opus` once and then a bare `b.sh` here:
#   ./b.sh              → the model setup.sh armed
#   ./b.sh opus         → unique substring match against the shipping model list
#   ./b.sh claude-...   → any full id, verbatim   (also: PXPIPE_DEMO_MODEL=... ./b.sh)
# This is the GATE column, so it hard-fails when the proxy's compress scope does not
# cover the model: pxpipe would pass it through uncompressed and the run would look
# like a pxpipe result while measuring nothing.
DEMO_NAME=effective-context
: "${PXPIPE_DEMO_VARIANT:=[1m]}"   # large-context variant; scope keys ignore [tags]
. "$(dirname "$0")/../models.sh"
demo_resolve_column_model "$DEMO_NAME" "${1:-}" || exit 1
demo_require_scope "$DEMO_NAME" "$DEMO_MODEL_BASE" || exit 1

echo "RIGHT = pxpipe (:$DEMO_PORT_ON), model=$DEMO_MODEL_ID. Launching interactive Claude with the needle task..."
# Run in $DIR via a subshell so your terminal stays in the original dir afterward.
( cd "$DIR" && exec env ANTHROPIC_BASE_URL="http://127.0.0.1:$DEMO_PORT_ON" \
  "$CB" "$PROMPT" --model "$DEMO_MODEL_ID" --setting-sources project --strict-mcp-config --dangerously-skip-permissions )
