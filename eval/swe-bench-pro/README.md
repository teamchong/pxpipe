# SWE-bench Pro pilot - pxpipe ON vs OFF

Date: 2026-06-11. Model: `claude-fable-5` via Claude Code CLI. n=1 paired
instance from SWE-bench Pro (public set, `ScaleAI/SWE-bench_Pro`), graded
with the official `SWE-bench_Pro-os` Docker harness on prebuilt
`jefzda/sweap-images` amd64 images.

Instance: `future-architect__vuls-36456cb...` (Go - implement
`searchCache` for the WordPress vulnerability cache).

## Result

| arm | resolved | API calls | image count | token-equivalent |
|---|---|---|---|---|
| pxpipe ON (47821) | 1/1 (both tests PASSED) | 19 | 2,925 | 453,944 |
| OFF (47822, compress=false) | 1/1 (both tests PASSED) | 7 | 0 | 207,840 |

- Per-request compression on the ON arm (clean number, no turn-count
  confound): each request's `count_tokens` probe of the uncompressed body
  vs what was actually sent - **would-have-sent 8.61M vs sent 3.08M raw
  tokens, -64% per request**.
- Run totals are receipts, not a savings claim: the ON run happened to
  take 2.7x the turns (19 vs 7) on this tiny task. Agentic runs are
  nondeterministic; per-request is the isolated measurement.
- Task quality: parity at n=1 - both arms produced a working
  `searchCache` and passed `TestSearchCache` + `TestRemoveInactive` under
  the official grader.

## Infra gotcha (Apple Silicon)

Pro images are amd64-only and this repo needs cgo (sqlite3). Under
colima's default qemu binfmt, `gcc` segfaults intermittently inside the
container and both arms graded 0/1 with `[build failed]`. Fix:

```bash
colima stop && colima start --vz-rosetta
```

After Rosetta, gcc works and both arms grade 1/1. If you see Go
`[build failed]` with `gcc: internal compiler error: Segmentation fault`,
it is the emulator, not the patch.

## Reproduce

```bash
# proxies: ON (47821) and OFF (47822, POST /api/compression {"enabled":false})
# generate patches per arm (Claude Code CLI against the instance prompt)
git clone --depth 1 https://github.com/scaleapi/SWE-bench_Pro-os.git
cd SWE-bench_Pro-os && python3 -m venv venv && ./venv/bin/pip install docker pandas tqdm pyarrow
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"   # colima started with --vz-rosetta
./venv/bin/python swe_bench_pro_eval.py \
  --raw_sample_path receipts/sample.jsonl --patch_path receipts/patch_on.json \
  --output_dir out_on --dockerhub_username jefzda --scripts_dir run_scripts \
  --use_local_docker --num_workers 1
```

`receipts/` has the instance, both patches, graded patch diffs, and the
official harness `_output.json` for both arms.
