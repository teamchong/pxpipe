#!/bin/bash
# 25 verbatim hex-recall trials, parallelism 3
cd /tmp/verb25
python3 -c "
import json
for i, g in enumerate(json.load(open('golds.json'))):
    print(i, g['page'], g['dur'], g['gold'])
" > trials.txt
run_one() {
  local i=$1 page=$2 dur=$3 gold=$4
  local ans
  ans=$(~/.claude/local/claude -p --model claude-fable-5 "Read the image at /tmp/verb25/page${page}.png. Find the JSON line whose dur_ms is exactly ${dur} and report ONLY its 'id' field value (12 hex chars), nothing else. Read it visually from the image; do not use code." 2>/dev/null | tr -d '[:space:]' | grep -oE '[0-9a-f]{12}' | head -1)
  if [ "$ans" = "$gold" ]; then
    echo "HIT  trial=$i page=$page dur=$dur gold=$gold"
  else
    echo "MISS trial=$i page=$page dur=$dur gold=$gold got=${ans:-EMPTY}"
  fi
}
export -f run_one
cat trials.txt | xargs -P 3 -L 1 bash -c 'run_one "$@"' _
echo "=== done ==="
