#!/bin/bash
# Repaired verbatim hex-recall harness (N=15, 3 needles x 5 dense-JSON pages).
#
# Fixes vs the original run.sh, which is unrunnable as committed:
#   1. Original does `cd /tmp/verb25` -- that dir no longer exists. The goldens
#      and PNGs are preserved here in the repo, so read from $DIR instead.
#   2. Original hardcodes `--model claude-fable-5`, so it cannot A/B anything.
#      MODEL is now a parameter.
#   3. Original has every `xargs -P 3` worker echo to the same stdout with no
#      locking. Parallel writes interleaved and shredded lines in results.log
#      (trial=11 was destroyed outright). Each worker now writes its own file.
#   4. Never clobbers the historical results.log; output goes to out_$MODEL/.
#
# The probe prompt is byte-identical to the original so scores stay comparable.
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
MODEL="${MODEL:-claude-opus-5}"
PAR="${PAR:-3}"
CLAUDE="${CLAUDE:-$HOME/.claude/local/claude}"
OUT="${OUT:-$DIR/out_${MODEL}}"

rm -rf "$OUT"; mkdir -p "$OUT"

python3 -c "
import json
for i, g in enumerate(json.load(open('$DIR/golds.json'))):
    print(i, g['page'], g['dur'], g['gold'])
" > "$OUT/trials.txt"

run_one() {
  local i=$1 page=$2 dur=$3 gold=$4
  local ans
  # env -u ANTHROPIC_BASE_URL: the eval MUST bypass the pxpipe proxy. Left in,
  # the proxy images the sub-session's whole context -- the model then reads a
  # re-render of the page instead of the page, and every model scores ~0/15.
  # Same guard as eval/gist-recall/run.py:11.
  ans=$(env -u ANTHROPIC_BASE_URL "$CLAUDE" -p --model "$MODEL" "Read the image at $DIR/page${page}.png. Find the JSON line whose dur_ms is exactly ${dur} and report ONLY its 'id' field value (12 hex chars), nothing else. Read it visually from the image; do not use code." 2>/dev/null \
        | tr -d '[:space:]' | grep -oE '[0-9a-f]{12}' | head -1)
  if [ "$ans" = "$gold" ]; then
    printf 'HIT  trial=%s page=%s dur=%s gold=%s\n' "$i" "$page" "$dur" "$gold" > "$OUT/t$(printf %02d "$i").txt"
  else
    printf 'MISS trial=%s page=%s dur=%s gold=%s got=%s\n' "$i" "$page" "$dur" "$gold" "${ans:-EMPTY}" > "$OUT/t$(printf %02d "$i").txt"
  fi
}
export -f run_one
export CLAUDE MODEL DIR OUT

cat "$OUT/trials.txt" | xargs -P "$PAR" -L 1 bash -c 'run_one "$@"' _

# A killed/failed worker leaves no t##.txt at all. Without an explicit
# completeness check the partial run is indistinguishable from a finished one:
# results.log just comes out short, and `total` silently shrinks to match. That
# is how out_claude-opus-4-8/ (9 of 15 trials, no results.log, run died before
# the concat below) got recorded in the README as a flat "0/15". Never infer the
# denominator from whatever happened to survive -- pin it to trials.txt.
exp=$(wc -l < "$OUT/trials.txt" | tr -d ' ')
missing=()
while read -r i _rest; do
  f="$OUT/t$(printf %02d "$i").txt"
  [ -s "$f" ] || missing+=("$i")
done < "$OUT/trials.txt"

# Always materialize results.log, even when short, so a dead run leaves a
# readable artifact instead of a bare pile of t##.txt that looks complete.
cat "$OUT"/t[0-9][0-9].txt > "$OUT/results.log" 2>/dev/null || true
hit=$(grep -c '^HIT' "$OUT/results.log" || true)
got=$(grep -cE '^(HIT|MISS)' "$OUT/results.log" || true)

if [ "${#missing[@]}" -ne 0 ]; then
  printf 'INCOMPLETE model=%s ran=%s expected=%s missing_trials=%s\n' \
    "$MODEL" "$got" "$exp" "$(IFS=,; echo "${missing[*]}")" | tee -a "$OUT/results.log" >&2
  echo "SCORE model=$MODEL hits=$hit total=$got expected=$exp INCOMPLETE -- do NOT report as /$exp" | tee -a "$OUT/results.log"
  exit 1
fi

echo "SCORE model=$MODEL hits=$hit total=$got expected=$exp" | tee -a "$OUT/results.log"
