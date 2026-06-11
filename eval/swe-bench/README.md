# SWE-bench Lite pilot — pxpipe ON vs OFF

Date: 2026-06-10. Model: `claude-fable-5` via Claude Code CLI. n=10 paired
instances. Question: does rendering old context as images (pxpipe) hurt
end-to-end agentic task completion?

## Result

| | pxpipe ON | OFF |
|---|---:|---:|
| resolved (official `swebench==4.1.0` Docker harness) | **10/10** | 10/10 |
| request size vs own uncompressed body | **−65%** | ±0 |

The −65%: the proxy probes `count_tokens` on every original body before
compressing — each request measured against its own counterfactual, no
turn-count confound. Pilot window: 85,804,350 would-have-sent vs 29,942,152
sent (226 requests, 215 compressed, incl. a few stray probes). Grading
reports: `pxpipe-on.pxpipe_on.json`, `pxpipe-off.pxpipe_off.json`.

Run totals — receipts only, don't divide across arms (independent agentic
runs; OFF happened to take 2.4x the turns):

| arm | resolved | API calls | input | cache_create | cache_read | output | $-equiv |
|---|---:|---:|---:|---:|---:|---:|---:|
| pxpipe ON (port 47821) | **10/10** | 138 | 40,997 | 1,101,573 | 8,608,940 | 89,611 | $27.27 |
| OFF (port 47822, compress=false) | 10/10 | 337 | 144,342 | 1,383,705 | 19,087,170 | 315,674 | $53.61 |

## Honest caveats

1. The −49% total gap above mixes compression with turn-count variance —
   agentic runs are nondeterministic, and the OFF run took more turns. That is
   why the headline compression number is the per-request 65%, not the run
   totals. Per-call costs across arms are roughly equal, which is expected:
   different trajectories have different turn depths and cache patterns, so
   cross-arm per-call math is meaningless in both directions.
2. SWE-bench Lite skews easy; 10/10 both arms means this pilot measures
   **parity**, not superiority. A discriminating sample would need harder
   instances or more of them.
3. Dollar figures are token-equivalents computed from the proxy's own
   `events.jsonl` at Fable 5 list rates (input $10/M, cache-write 1.25x,
   cache-read 0.1x, output 5x input). Both arms ran through a proxy (ON
   compressing, OFF forced `compress: false`), so measurement overhead is
   identical.

## Instances

django-14999, sympy-16503, matplotlib-23913, scikit-learn-13497,
pytest-dev-5221, astropy-6938, sphinx-doc-7975, psf-requests-2674,
pylint-dev-5859, pydata-xarray-3364 — picked to spread across repos, shorter
problem statements preferred.

## Reproduce

```bash
# 1. Two proxies: ON (47821) and OFF (47822, POST /api/compression {"enabled":false})
# 2. Generate patches (Claude Code CLI, MAX plan; ~$30-40 API-equivalent)
./venv/bin/python run_pilot.py          # writes preds_on.json / preds_off.json

# 3. Grade (Docker required; colima works: colima start --cpu 6 --memory 10)
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
./venv/bin/python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Lite --split test \
  --predictions_path preds_on.json --max_workers 3 --run_id pxpipe_on --cache_level env
# same for preds_off.json with --run_id pxpipe_off

# 4. Per-request compression (the 65%): each row in the proxy event log carries
#    baseline_tokens (count_tokens probe of the uncompressed body) next to what
#    was actually sent — sum both over the pilot window and compare.
python3 - <<'EOF'
import json, os
path = os.path.expanduser('~/.pxpipe/events.jsonl')
rows = [json.loads(l) for l in open(path)][15139:]   # offset from log_offsets_start.txt
sent = base = 0
for d in rows:
    if d.get('path') != '/v1/messages' or not d.get('baseline_tokens'): continue
    b = d['baseline_tokens']
    s = (d.get('input_tokens') or 0) + (d.get('cache_create_tokens') or 0) + (d.get('cache_read_tokens') or 0)
    base += b; sent += s
print(f'would-have-sent {base:,} vs sent {sent:,} -> {100*(1-sent/base):.0f}% smaller')
EOF
```
