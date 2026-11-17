# GPT-6.2 Astra - profile-aligned v2, `original` detail

2026-11-17. Model `gpt-6.2-astra`, direct Responses transport, reasoning **low**.
Runtime profile: Spleen **5x8**, **152 columns**, max height **1932px**, monochrome AA, reflow enabled, compact native factsheet, `imageDetail: 'original'` (`GPT6_PROFILE`), 200-page history cap with mixed responses mode.

## Results (`detail: original`)

| test | native text | profile-rendered content | N |
|---|---:|---:|---:|
| arithmetic | **100/100** | **98/100** | 100 |
| gist | not rerun | **24/98** (40 `UNKNOWN`) | 98 |
| state | not rerun | **6/18** | 18 |
| never-stated guards | not rerun | **3/16 confabulated** | 16 |
| dense hex association | not rerun | **7/15** | 15 |

`gpt-6.2-astra` improves dense 12-char pure-image hex recall over `gpt-6-astra` (`7/15` vs `2/15`) and hits `98/100` on profile-rendered arithmetic (both misses misread `7` as `2` inside unindexed 3-digit counts: `771 -> 721` on `arithmetic-image-64` and `779 -> 729` on `arithmetic-image-91`). However, multi-page Spleen 5x8 history collapses to `24/98` gist recall (`6/18` state tracking) and invents plausible wrong values on 3 of 16 never-stated guards (`gist-work-3`, `gist-work2-3`, `gist-work2-4`), keeping `gpt-6.2-astra` unsupported for imaged history.

## Receipts and actual cost

237 completed scored receipts, no API or grading errors, **237 new requests** (0 reused). No automatic retries or sweeps.

| scope | calls | input tokens | output tokens |
|---|---:|---:|---:|
| native arithmetic | 100 | 5,300 | 4,322 |
| arithmetic image | 100 | 7,000 | 4,367 |
| gist/state/guards | 22 | 49,726 | 3,541 |
| hex | 15 | 20,238 | 1,356 |
| **complete scored suite** | **237** | **82,264** | **13,586** |

**95,850** newly consumed input + output tokens. Reasoning tokens (4,255 total) are already included in output. The provider reported 69,853 cache-write tokens, a subset of input, and 0 cache reads. These raw counts are not dollar costs or billing-equivalent tokens. Pre-flight estimated 80,840 new input tokens; raw preflight configuration remains local-only.

## Reproduce and validate

- [Common methodology and all-model entrypoint](../../../README.md)
- [Shared source hex corpus](../../hex-source.json), deterministic seed `20260905`
- [Sanitized per-call scores, hashes and usage](receipt-manifest.json) - raw prompts/responses, local paths and full preflight snapshots are excluded from publication.
- [Machine-readable summary](summary.json) - `QUALITY_MODEL=gpt-6.2-astra node eval/model-quality/summarize.mjs` rebuilds it from local `results.json` when present, checking the current payloads and refusing profile/payload drift, missing provenance, incomplete samples or scores inconsistent with the saved raw answers.
