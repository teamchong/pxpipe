# SWE-bench Lite pilot — pxpipe ON vs OFF

Date: 2026-06-10. Model: `claude-fable-5` via Claude Code CLI. n=10 paired
instances. Question: does rendering old context as images (pxpipe) hurt
end-to-end agentic task completion?

## Result

| arm | resolved | API calls | input | cache_create | cache_read | output | $-equiv |
|---|---:|---:|---:|---:|---:|---:|---:|
| pxpipe ON (port 47821) | **10/10** | 138 | 40,997 | 1,101,573 | 8,608,940 | 89,611 | **$27.27** |
| OFF (port 47822, compress=false) | 10/10 | 337 | 144,342 | 1,383,705 | 19,087,170 | 315,674 | $53.61 |

Identical resolve rate, −49% cost on identical tasks. Both arms graded with
the official `swebench==4.1.0` Docker harness (`run_evaluation`), reports:
`pxpipe-on.pxpipe_on.json`, `pxpipe-off.pxpipe_off.json`.

## Honest caveats

1. n=10, and 20 nondeterministic agentic runs. The OFF arm took ~2.4x the API
   calls — some of that is run-to-run variance in agentic turns, not
   compression. The $ delta is real for these runs but the split between
   "compression savings" and "turn-count luck" is not isolated.
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
```
