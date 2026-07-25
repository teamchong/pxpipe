#!/bin/bash
# Resolution control: page 0 only, same 3 needles, at both available renders.
#
#   page0.png      908x328   0.30 MP  (what the historical eval used)
#   page0_big.png  2800x1011 2.83 MP  (~3.08x linear)
#
# Same probe text, same goldens, same scoring -- the ONLY variable is pixels.
# This turns "opus-5 scored badly" into a causal statement about legibility.
#
# Only page 0 has a _big render, and no source JSON survives to re-render pages
# 1-4, so the control is necessarily limited to trials 0,1,2.
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
MODEL="${MODEL:-claude-opus-5}"
IMG="${IMG:-page0_big.png}"
PAR="${PAR:-3}"
CLAUDE="${CLAUDE:-$HOME/.claude/local/claude}"
TAG="${TAG:-${MODEL}_${IMG%.png}}"
OUT="$DIR/ctl_${TAG}"

rm -rf "$OUT"; mkdir -p "$OUT"

python3 -c "
import json
for i, g in enumerate(json.load(open('$DIR/golds.json'))):
    if g['page'] == 0:
        print(i, g['page'], g['dur'], g['gold'])
" > "$OUT/trials.txt"

run_one() {
  local i=$1 page=$2 dur=$3 gold=$4
  local ans
  # env -u ANTHROPIC_BASE_URL: bypass the pxpipe proxy, else it re-renders the
  # sub-session context and the model reads a re-render instead of the page.
  ans=$(env -u ANTHROPIC_BASE_URL "$CLAUDE" -p --model "$MODEL" "Read the image at $DIR/$IMG. Find the JSON line whose dur_ms is exactly ${dur} and report ONLY its 'id' field value (12 hex chars), nothing else. Read it visually from the image; do not use code." 2>/dev/null \
        | tr -d '[:space:]' | grep -oE '[0-9a-f]{12}' | head -1)
  if [ "$ans" = "$gold" ]; then
    printf 'HIT  trial=%s page=%s dur=%s gold=%s\n' "$i" "$page" "$dur" "$gold" > "$OUT/t$(printf %02d "$i").txt"
  else
    printf 'MISS trial=%s page=%s dur=%s gold=%s got=%s\n' "$i" "$page" "$dur" "$gold" "${ans:-EMPTY}" > "$OUT/t$(printf %02d "$i").txt"
  fi
}
export -f run_one
export CLAUDE MODEL DIR OUT IMG

cat "$OUT/trials.txt" | xargs -P "$PAR" -L 1 bash -c 'run_one "$@"' _

cat "$OUT"/t[0-9][0-9].txt > "$OUT/results.log"
hit=$(grep -c '^HIT' "$OUT/results.log" || true)
tot=$(wc -l < "$OUT/results.log" | tr -d ' ')
echo "CONTROL model=$MODEL img=$IMG hits=$hit total=$tot"
