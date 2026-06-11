# SWE-bench Pro - pxpipe ON vs OFF

## Expansion to 19 pairs + navidrome replication (2026-06-11)

Same setup as the 10-pair bench below (Fable 5, dedicated bench proxies
ON 47823 / OFF 47824, official `SWE-bench_Pro-os` Docker harness on
prebuilt `jefzda/sweap-images`). Two follow-ups:

**1. Navidrome replication x3.** The single ON-arm loss from the first
bench was re-run 3 times on a dedicated ON proxy (47825). All three
replications produced a byte-identical patch (different from the
original failing one) and **all three resolved**. The original split was
run-to-run agentic variance, not compression damage.

**2. +10 new pairs** (fresh instances, same repos pool, round-robin).
`protonmail__webclients` dropped again (checkout failed both arms);
9 pairs completed:

| batch | instances | ON | OFF |
|---|---|---|---|
| 1 | qutebrowser, NodeBB, flipt, openlibrary, navidrome | 5/5 | 5/5 |
| 2 | teleport, element-web | 1/2 | 1/2 |
| 3 | ansible, tutanota | 1/2 | 1/2 |

- **Verdicts agree 9/9** on the new pairs - including both fails
  (element-web, tutanota failed both arms; element-web's patches were
  byte-identical across arms).
- Combined Pro totals: **ON 14/19, OFF 15/19**, verdict agreement 18/19,
  and the single disagreement (navidrome) re-resolved 3/3 on replication.
- Bench-proxy log over the whole Pro bench: ON 316 requests,
  **-59.9% per-request** (count_tokens probe vs sent, no turn-count
  confound), 2,274 images; OFF 576 requests, passthrough (±0).
- Receipts: `bench20/` (all six `eval_results`, instance list,
  navidrome replication verdicts + patch).

---

## 10-pair bench (2026-06-11)

Model: `claude-fable-5` via Claude Code CLI. 10 paired instances from
SWE-bench Pro (public set, `ScaleAI/SWE-bench_Pro`), run on dedicated
bench proxies (ON 47823 compressing, OFF 47824 passthrough - separate
event logs, no operator contamination), graded with the official
`SWE-bench_Pro-os` Docker harness on prebuilt `jefzda/sweap-images`
amd64 images (colima + Rosetta).

One pair (`protonmail__webclients`) failed `git checkout` on both arms
and dropped out; 9 pairs completed.

| arm | resolved | API calls | compressed | images | request size vs own uncompressed body |
|---|---|---|---|---|---|
| pxpipe ON | 6/9 | 136 | 117 | 987 | **-61%** |
| OFF | 7/9 | 152 | 0 | 0 | ±0 |

- The -61% is per-request: each body's free `count_tokens` probe vs what
  was actually sent (no turn-count confound).
- Verdicts agree on 8/9 instances (element-web and tutanota failed both
  arms). The single split is `navidrome` (ON fail, OFF pass) - at n=9,
  a 1-task delta is within run-to-run noise for nondeterministic agentic
  runs, but it is the first measured task ON lost; logged honestly here.
- Token-equivalents from the bench event logs: ON 1.60M vs OFF 2.78M
  (-43%) - carries turn-count variance, quote the -61% per-request
  number instead.
- Receipts: `bench/` (both `eval_results`, both prediction sets,
  per-instance run summary, instance list).

---

## Single-pair pilot (2026-06-11, earlier the same day)

Date: 2026-06-11. Model: `claude-fable-5` via Claude Code CLI. n=1 paired
instance from SWE-bench Pro (public set, `ScaleAI/SWE-bench_Pro`), graded
with the official `SWE-bench_Pro-os` Docker harness on prebuilt
`jefzda/sweap-images` amd64 images.

Instance: `future-architect__vuls-36456cb...` (Go - implement
`searchCache` for the WordPress vulnerability cache).

## Result

| arm | resolved | API calls | image count | token-equivalent |
|---|---|---|---|---|
| pxpipe ON (47821) | 1/1 (both tests PASSED) | 10 | 45 | 116,690 |
| OFF (47822, compress=false) | 1/1 (both tests PASSED) | 7 | 0 | 207,840 |

- Per-request compression on the ON arm (clean number, no turn-count
  confound): each request's `count_tokens` probe of the uncompressed body
  vs what was actually sent - **would-have-sent 614,753 vs sent 210,443
  raw tokens, -66% per request**.
- Task quality: parity at n=1 - both arms produced a working
  `searchCache` and passed `TestSearchCache` + `TestRemoveInactive` under
  the official grader.

### Verifying the ON arm actually went through pxpipe

The ON proxy (47821) is shared with the operator's own Claude Code
session, so the event window was contaminated; arm rows were separated by
session shape (operator rows carry 320 images / ~315k cache reads; arm
rows are a fresh session with 4-7 images, and bracket exactly the 100s
run duration recorded in `run.log`). Direct proof compression engaged:
both arms sent the identical first request (`input_tokens=1927`) - OFF
wrote a 62,836-token text slab, ON wrote 22,097 text tokens + 4 rendered
images, and every arm row after the warm-up logs `compressed=true`.

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
