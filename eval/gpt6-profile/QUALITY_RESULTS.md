> **Historical v1 evaluation — superseded.** These receipts used eval-only `detail: original`, unreflowed history, and legacy hex PNGs. They are not normal-profile results. Use [the shared v2 suite](../model-quality/README.md) and its fresh receipts. The launcher here now delegates to v2.

# GPT-6 Astra quality results

2026-09-05, `gpt-6-astra` through the configured direct Codex Responses upstream,
not pxpipe. Reasoning **low**, image detail **original**, text verbosity low.
Same N and table columns as the other model evaluations; no parameter sweep.

## Results

| test | text | production image | notes |
|---|---:|---:|---|
| novel arithmetic, N=100 | **100/100** | **99/100** | same seed-20260711 problems; image + compact factsheet |
| gist recall, N=98 | — | **97/98** | same 22-session corpus and deterministic rubric |
| state tracking, N=18 | — | **18/18** | subset of gist, not additional calls |
| never-stated guards, N=16 | — | **0/16** confabulated | lower is better |
| dense 12-char hex, N=15 | — | **0/15** | exception: shared legacy PNGs, pure image, not production geometry |

All 237 calls completed with receipts; no transport errors or retries. No
pure-image arithmetic arm was run, saving 100 calls while retaining N=100 in
both the native-text and production-image arms. Gist/text was not rerun.

### Profile provenance

Arithmetic/gist use the current resolved GPT-6 geometry: **Spleen 5×8, 152
columns, max height 1932px**, monochrome AA, compact bounded factsheet. The
profile settings were recorded in a local-only `preflight.json`.
This is direct rendered-content quality, not a full proxy/coding-agent eval.

Dense hex deliberately retains the same five **908×328 legacy PNGs** and 15
queries used by the older Sol harness. Their original text/raster recipe is
unavailable. They must not be described as new 152-column production renders.
PNG hashes and exact dimensions are saved in each receipt. The table therefore
keeps the same N but explicitly identifies this historical geometry exception.

### Failures and interpretation

- The arithmetic miss read **779 loose boxes as 729**, producing 1959 instead
  of 2009 despite the adjacent factsheet. Do not treat high arithmetic accuracy
  as byte-perfect reading.
- One answerable gist probe was missed; all 18 state probes and all 16
  never-stated guards passed.
- All 15 dense-hex probes failed exact matching. Keep exact identifiers/native
  escape hatches; this run does not establish safe byte-exact recall.
- These are modest fixed fixtures at reasoning low. Other historical runs can
  differ in reasoning/transport; matching N alone is not a controlled model A/B.

## Actual provider usage

| arm | calls | input tokens | output tokens | reasoning subset of output |
|---|---:|---:|---:|---:|
| arithmetic text | 100 | 5,300 | 5,087 | 515 |
| arithmetic image + factsheet | 100 | 7,000 | 7,720 | 3,173 |
| gist/state/guards combined | 22 | 131,430 | 750 | 234 |
| shared dense hex | 15 | 6,299 | 2,156 | 1,958 |
| **total** | **237** | **150,029** | **15,713** | **5,880** |

**165,742 total input + output tokens**, excluding the separate earlier RGB
experiment and local offline tests. Reasoning is already included in output;
do not add it again. The provider reported 131,364 cache-write tokens (a subset
of input) and zero cache reads. These are raw usage counts, not dollar costs or
cache-weighted billing equivalents.

Preflight estimated 148,601 input tokens, excluding message/transport framing.
The 265,216 output-token ceiling was not actual consumption. Actual output was
15,713 tokens. Short arithmetic prompts used **32.1% more input tokens** as
images (7,000 vs 5,300); this quality suite is not evidence of universal savings.

## PR scope and validation

- Added the README model-quality row in the existing format and with the same N.
- Kept the GPT-6 history-image ceiling at **200**. Raising it cannot help requests
  below the ceiling; this suite does not benchmark cap-bound long histories.
- RGB remains a rejected, separate eval-only experiment:
  [RGB screening results](../gpt6-rgb/RESULTS.md).
- Build and CLI version smoke check passed.
- Full regression suite: **79 files, 1,225 tests passed**, including eight new
  GPT-6 profile/cache-accounting checks. The earlier focused suite also passed.

## Receipts and reproduction

- Raw per-call answers and preflight configuration remain local and untracked.
- [Machine-readable summary](summary.json)
- [Harness and methodology](README.md)
- `node eval/gpt6-profile/summarize.mjs` refuses partial/error-containing runs
  and regenerates the summary without any API calls.
