> **Historical v1 evaluation — superseded.** These receipts used eval-only `detail: original`, unreflowed history, and legacy hex PNGs. They are not normal-profile results. Use [the shared v2 suite](../model-quality/README.md) and its fresh receipts. The launcher here now delegates to v2.

# GPT-6 Astra fixed-N quality evaluation

Uses the same table sample sizes: arithmetic 100, gist 98, state 18,
never-stated guards 16, dense hex 15. State is a subset of gist.

## Reproduce

Build `dist/` from the checkout first. Then:

```sh
# Offline: prepare all requests and report estimated input/output ceilings.
node eval/gpt6-profile/run.mjs

# Paid: direct Responses upstream using existing OPENAI_BASE_URL/OPENAI_API_KEY.
GPT6_LIVE=1 node eval/gpt6-profile/run.mjs

# Refuses incomplete/error-containing runs; aggregates usage once per call.
node eval/gpt6-profile/summarize.mjs
```

The live runner has three workers and a 120s per-call timeout. It stops starting
new calls after an API/grading error, saves incremental receipts, and skips
recorded calls on resume. There are no automatic retries, parameter sweeps, or
LLM grading calls. Archive `results.json` to deliberately start a fresh run.
The profile/request fingerprint must match before any resumed calls are sent.

## Method and provenance

- **Arithmetic:** the same 100 seed-20260711 novel-number problems, prompts, and
  exact `ANSWER: <number>` rubric as `../sol-profile/novel-arithmetic.mjs`.
  Retains paired native text and production-image-plus-factsheet arms. Omits
  the optional pure-image arm to save 100 calls without reducing N.
- **Gist/state/guards:** the same committed transcripts, probes, prompts, and
  deterministic rubric as `../sol-profile/gist-recall.mjs`. One call per session
  returns all its answers: 22 calls, 98 answerable probes and 16 unknowns.
  The six `work3` sessions supply the 18 state probes. Never-stated scores are
  confabulations (lower is better), not successes. Malformed answer arrays are
  errors and cannot be silently published as completed samples.
- **Arithmetic/gist images:** resolved GPT-6 production geometry, Spleen 5×8,
  152 columns, maximum height 1932, monochrome AA, compact bounded factsheet.
  This tests rendered content directly, not the full proxy history planner,
  cache behavior, or end-to-end coding-agent performance.
- **Dense hex exception:** exactly the shared `../verbatim-15/page0..4.png`
  and `golds.json` used by the older Sol harness, same 15 queries and rubric.
  These are legacy **908×328** PNGs, pure image with no factsheet. Their original
  source/raster recipe is unavailable; they are **not** newly rendered at the
  GPT-6 152-column profile. Keeping them unchanged preserves this fixture
  comparison rather than replacing it with an easier newly generated corpus.
- All calls use model `gpt-6-astra`, `detail: original`, reasoning **low**
  (GPT-6 rejects `none`), and low text verbosity. Arithmetic/hex output caps are
  1024; gist caps are 2048. Older model runs can differ in reasoning and transport;
  matching N does not make every historical run a fully controlled A/B test.

`preflight.json` records the complete resolved profile and estimated budget.
`results.json` stores per-request input hashes, fixture provenance, raw answers,
scores, timing and actual provider usage. `summary.json` aggregates them without
double-counting the shared gist/state/guard calls or reasoning tokens (which
are already included in output tokens).

The 200-image ceiling remains unchanged. These quality fixtures do not test
whether long sessions hit that ceiling; raising it cannot improve requests that
are already below it. RGB overprint was separately rejected:
[RGB screening](../gpt6-rgb/RESULTS.md).

Raw `results.json` and `preflight.json` are local-only and git-ignored; only the historical numeric `summary.json` is published.
