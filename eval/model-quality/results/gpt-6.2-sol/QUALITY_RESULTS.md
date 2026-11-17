# GPT-6.2 Sol - profile-aligned v2 (Spleen 5x8 runtime fallback)

2026-11-17. Model `gpt-6.2-sol`, direct Responses transport, reasoning **low**.
Runtime profile: `gpt-6.2-sol` falls through `resolveGptProfile` to `GPT6_PROFILE` (`^gpt-(?:5\.6|6\.1)-sol(?:-|$)` only routes `gpt-5.6-sol` and `gpt-6.1-sol` to JetBrains Mono 14px / 84 columns): Spleen **5x8**, **152 columns**, max height **1932px**, monochrome AA, reflow enabled, compact native factsheet, `imageDetail: 'original'`, 200-page history cap with mixed responses mode.

## Results (`detail: original`)

| test | native text | profile-rendered content | N |
|---|---:|---:|---:|
| arithmetic | **100/100** | **100/100** | 100 |
| gist | not rerun | **40/98** (40 `UNKNOWN`) | 98 |
| state | not rerun | **9/18** | 18 |
| never-stated guards | not rerun | **0/16 confabulated** | 16 |
| dense hex association | not rerun | **7/15** | 15 |

On the Spleen 5x8 / 152-column fallback profile, `gpt-6.2-sol` reaches **100/100** on profile-rendered arithmetic and **0/16** never-stated guard confabulations, outperforming `gpt-6.1-sol` on the same 5x8 control (`40/98` vs `20/98` gist, `7/15` vs `0/15` pure-image hex). Dense multi-page history recall remains weak (`40/98` gist, `9/18` state), so `gpt-6.2-sol` stays unsupported without a dedicated 14px profile evaluation.

## Receipts and actual cost

237 completed scored receipts, no API or grading errors, **237 new requests** (0 reused). No automatic retries or sweeps.

| scope | calls | input tokens | output tokens |
|---|---:|---:|---:|
| native arithmetic | 100 | 5,300 | 4,292 |
| arithmetic image | 100 | 7,000 | 4,373 |
| gist/state/guards | 22 | 49,726 | 441 |
| hex | 15 | 20,238 | 345 |
| **complete scored suite** | **237** | **82,264** | **9,451** |

**91,715** newly consumed input + output tokens. Reasoning tokens (299 total) are already included in output. The provider reported 69,853 cache-write tokens, a subset of input, and 0 cache reads. These raw counts are not dollar costs or billing-equivalent tokens. Pre-flight estimated 80,840 new input tokens; raw preflight configuration remains local-only.

## Reproduce and validate

- [Common methodology and all-model entrypoint](../../../README.md)
- [Shared source hex corpus](../../hex-source.json), deterministic seed `20260905`
- [Sanitized per-call scores, hashes and usage](receipt-manifest.json) - raw prompts/responses, local paths and full preflight snapshots are excluded from publication.
- [Machine-readable summary](summary.json) - `QUALITY_MODEL=gpt-6.2-sol node eval/model-quality/summarize.mjs` rebuilds it from local `results.json` when present, checking the current payloads and refusing profile/payload drift, missing provenance, incomplete samples or scores inconsistent with the saved raw answers.
