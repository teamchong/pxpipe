# GPT-6 Astra — profile-aligned v2

2026-09-05. Model `gpt-6-astra`, direct Responses transport, reasoning **low**.
Runtime profile: Spleen **5×8**, **152 columns**, max height **1932px**,
monochrome AA, reflow enabled, compact native factsheet, normal image detail
**`high`**. History native-opaque overflow uses the runtime helper too.

## Corrected results

| test | native text | profile-rendered content | N |
|---|---:|---:|---:|
| arithmetic | 100/100 | **98/100** | 100 |
| gist | not rerun | **25/98** | 98 |
| state | not rerun | **6/18** | 18 |
| never-stated guards | not rerun | **0/16 confabulated** | 16 |
| dense hex association | not run | **5/15** | 15 |

**The current GPT-6 rendering configuration has poor recall in this aligned
test. Do not use the old v1 scores to claim it is quality-validated.** Zero
guard confabulations must be read alongside the low answerable recall, not as
proof of strong comprehension. This is a rendered-content test, not a complete
proxy/agent replay; it does not independently prove the cause of the failures.
Of the 98 answerable probes, **66 were answered UNKNOWN**.

The v1 run used `detail: original`, unreflowed history, and cached legacy hex
PNGs. V2 follows the normal `high` detail decision and profile-controlled
reflow, and renders the shared source hex corpus with the normal factsheet.
These changed together, so the score differences cannot be attributed to one
setting or described as a controlled improvement/regression experiment.

No production font, geometry, reflow policy, image-detail decision or 200-image
ceiling was changed for this test. Existing production helpers were exported
and reused to eliminate separate eval decisions. A separate profile-tuning
follow-up is needed before claiming good GPT-6 compressed-history quality.

## Receipts and actual cost

237 completed scored receipts, no API or grading errors. **137 new requests**;
100 native arithmetic receipts reused only after matching model/reasoning,
output-cap compatibility and exact request-content hashes. No image receipts
were reused: their detail setting/payload changed. No automatic retries.

| scope | calls | input tokens | output tokens |
|---|---:|---:|---:|
| new arithmetic image | 100 | 7,000 | 7,508 |
| new gist/state/guards | 22 | 48,340 | 9,746 |
| new hex | 15 | 20,238 | 4,017 |
| **new calls total** | **137** | **75,578** | **21,271** |
| reused native arithmetic | 100 | 5,300 | 5,087 |
| complete scored suite, including reused receipts | 237 | 80,878 | 26,358 |

**96,849 newly consumed input + output tokens.** Reasoning tokens (16,112 on
new calls) are already included in output. The provider reported 68,467 new
cache-write tokens, a subset of input, and zero cache reads. These raw counts
are not dollar costs or billing-equivalent tokens. The initial new-input
estimate was 74,750; raw preflight configuration remains local-only.

## Reproduce and validate

- [Common methodology and all-model entrypoint](../../README.md)
- [Shared source hex corpus](../../hex-source.json), deterministic seed 20260905
- [Sanitized per-call scores, hashes and usage](receipt-manifest.json)
- Raw prompts/responses, local paths and full preflight snapshots are excluded from publication.
- [Machine-readable summary](summary.json)
- `QUALITY_MODEL=gpt-6-astra node eval/model-quality/summarize.mjs` rebuilds
  the current payloads and refuses profile/payload drift, missing provenance,
  incomplete samples or scores inconsistent with the saved raw answers.

Verification: build/version smoke passed; **1,225 regression tests passed**;
profile-alignment contract tests passed across ten model/fallback profiles,
including overrides and native-opaque history overflow. Other models' paid v2
suites have **not** been rerun. Their older receipts remain historical.
