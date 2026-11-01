# GPT-6 Astra — profile-aligned v2, `original` detail

2026-10-31. Model `gpt-6-astra`, direct Responses transport, reasoning **low**.
Runtime profile: Spleen **5×8**, **152 columns**, max height **1932px**,
monochrome AA, reflow enabled, compact native factsheet, normal image detail
**`original`**. History native-opaque overflow uses the runtime helper too.

## Results (`detail: original`)

| test | native text | profile-rendered content | N |
|---|---:|---:|---:|
| arithmetic | 100/100 | **97/100** | 100 |
| gist | not rerun | **26/98** | 98 |
| state | not rerun | **7/18** | 18 |
| never-stated guards | not rerun | **0/16 confabulated** | 16 |
| dense hex association | not run | **2/15** | 15 |

**`gpt-6-astra` remains poor at dense Spleen 5×8 / 152-column geometry even under `detail: original`.**
Switching `imageDetail` from `high` (25/98 gist, 6/18 state, 5/15 hex) to `original` (26/98 gist, 7/18 state, 2/15 hex) did not recover dense-history recall: of the 98 answerable probes, **61 were answered UNKNOWN**.
Zero guard confabulations must be read alongside the low answerable recall, not as proof of strong comprehension.
The separately measured [N=2 matched pilot](../../pilots/HEX_RESULTS.md) compares `original`, `high`, and native text on identical prompts.

## Receipts and actual cost

237 completed scored receipts, no API or grading errors. **137 new requests**;
100 native arithmetic receipts reused only after matching model/reasoning,
output-cap compatibility and exact request-content hashes. No image receipts
were reused. No automatic retries.

| scope | calls | input tokens | output tokens |
|---|---:|---:|---:|
| new arithmetic image | 100 | 7,000 | 7,441 |
| new gist/state/guards | 22 | 48,340 | 9,256 |
| new hex | 15 | 20,238 | 4,795 |
| **new calls total** | **137** | **75,578** | **21,492** |
| reused native arithmetic | 100 | 5,300 | 5,087 |
| complete scored suite, including reused receipts | 237 | 80,878 | 26,579 |

**97,070 newly consumed input + output tokens.** Reasoning tokens (16,258 on
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
