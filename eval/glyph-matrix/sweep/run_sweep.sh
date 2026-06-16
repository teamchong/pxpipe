#!/bin/bash
D=/tmp/sweep; export MODEL="${MODEL:-claude-opus-4-8}"; export TAG="${TAG:-opus}"; PMAX="${PMAX:-4}"
export SIZES="${SIZES:-s0 s1 s2 s3 s4}"
rm -f $D/HALT
run_one() {
  k=$1; i=$2; f=/tmp/sweep/${k}_${i}.png; out=/tmp/sweep/out_${TAG}_${k}_${i}.txt
  [ -e /tmp/sweep/HALT ] && return 0
  [ -s "$out" ] && return 0
  local P="Read the image at $f. It shows JSON lines; exactly five have a \"label\" field A-E. Transcribe the 12-char hex id from each labeled line. Read visually; do NOT run code/tools to crop or zoom. Reply with five lines 'A: <hex>'..'E: <hex>' only; best-guess unreadable chars rather than refusing."
  tmp=$(mktemp)
  printf '%s' "$P" | env -u ANTHROPIC_BASE_URL ~/.claude/local/claude -p --model "$MODEL" --disallowedTools Bash > "$tmp" 2>/dev/null
  if grep -qiE "hit your (session|usage) limit" "$tmp"; then rm -f "$tmp"; touch /tmp/sweep/HALT; echo HALT >&2; return 1; fi
  if [ ! -s "$tmp" ]; then rm -f "$tmp"; return 1; fi
  mv "$tmp" "$out"
}
export -f run_one
for k in $SIZES; do for i in $(seq 0 $((PMAX-1))); do echo "$k $i"; done; done \
  | xargs -P 2 -n 2 bash -c 'run_one "$@"' _
[ -e $D/HALT ] && { echo HALTED-ON-LIMIT; exit 1; }
echo "DONE tag=$TAG"
