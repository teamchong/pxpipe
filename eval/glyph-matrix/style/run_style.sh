#!/bin/bash
# Constant-cost style A/B reader. Same method as ../sweep/run_sweep.sh:
# real claude CLI, --disallowedTools Bash so it must read by eye (no upscaling).
D=/tmp/style
# No default: a stale default silently measures a model nobody asked for. TAG
# follows MODEL so output files can't be labelled for a model that never ran.
: "${MODEL:?MODEL is not set — refusing to guess. e.g. MODEL=claude-opus-5 ./run_style.sh}"
export MODEL; export TAG="${TAG:-$MODEL}"; PMAX="${PMAX:-4}"
export STYLES="${STYLES:-prod onebit color grid cgrid}"
rm -f $D/HALT
run_one() {
  k=$1; i=$2; f=/tmp/style/${k}_${i}.png; out=/tmp/style/out_${TAG}_${k}_${i}.txt
  [ -e /tmp/style/HALT ] && return 0
  [ -s "$out" ] && return 0
  local P="Read the image at $f. It shows JSON lines; exactly five have a \"label\" field A-E. Transcribe the 12-char hex id from each labeled line. Read visually; do NOT run code/tools to crop or zoom. Reply with five lines 'A: <hex>'..'E: <hex>' only; best-guess unreadable chars rather than refusing."
  tmp=$(mktemp)
  printf '%s' "$P" | env -u ANTHROPIC_BASE_URL ~/.claude/local/claude -p --model "$MODEL" --disallowedTools Bash > "$tmp" 2>/dev/null
  if grep -qiE "hit your (session|usage) limit" "$tmp"; then rm -f "$tmp"; touch /tmp/style/HALT; echo HALT >&2; return 1; fi
  if [ ! -s "$tmp" ]; then rm -f "$tmp"; return 1; fi
  mv "$tmp" "$out"
}
export -f run_one
for k in $STYLES; do for i in $(seq 0 $((PMAX-1))); do echo "$k $i"; done; done \
  | xargs -P 2 -n 2 bash -c 'run_one "$@"' _
[ -e $D/HALT ] && { echo HALTED-ON-LIMIT; exit 1; }
echo "DONE tag=$TAG"
