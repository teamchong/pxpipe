# Gemini 4 Carbon - profile-aligned v2

2026-11-15. Model `gemini-4-carbon`, Google AI Studio `generateContent` transport, provider-default reasoning.
Runtime profile: Spleen **5x8**, **312 columns**, max height **728px**, monochrome AA, reflow enabled, compact native factsheet, flat vision regime (`flat`, 1120 default / 1078 exact at 1568x728), 96-page history cap with mixed responses mode.

## Results

| test | native text | profile-rendered content | N |
|---|---:|---:|---:|
| arithmetic | **100/100** | **100/100** | 100 |
| gist | not run | **96/98** | 98 |
| state | not run | **18/18** | 18 |
| never-stated guards | not run | **0/16 confabulated** | 16 |
| dense hex association | not run | **15/15** | 15 |

`gemini-4-carbon` resolves to `GEMINI_PROFILE` (Spleen 5x8, 312 columns, 728px max height, compact native factsheet, 96-page history cap) and scored **100/100** arithmetic (both native text and profile-rendered image), **96/98** gist, **18/18** state, **0/16** guard confabulations, and **15/15** dense hex association (with the compact factsheet active, as in normal runtime requests). Both gist misses were numeric `RETRY BUDGET` probes in `gist-work2` (`gist-work2-1`: `3600ms` vs gold `1330`; `gist-work2-2`: `2700ms` vs gold `4570`), where lowercase `Nms` durations are not indexed by the factsheet and were misread from the 5x8 transcript image.

### No-factsheet ablation (pure image)

Re-running the 22 gist/state/guard sessions and 15 dense-hex trials on `gemini-4-carbon` at the same 312-column Spleen 5x8 geometry with the compact factsheet stripped kept **96/98** gist (same two `RETRY BUDGET` probes), **18/18** state, and **0/16** guard confabulations, but dropped dense 12-char hex from **15/15** to **14/15** (`hex-1` gold `34982c9c67d5` read as `34982c9c67d6`, a single-pixel `5` vs `6` substitution on the trailing glyph; confirmed both with the standard prompt and with a pure-image prompt that omits factsheet instructions). `gemini-4-carbon` stays on `GEMINI_PROFILE` with `factSheetFormat: 'compact'`.

## Receipts and actual cost

237 completed scored receipts, no API or grading errors in the final saved dataset. **237 new requests**, no reused receipts.

| scope | calls | input tokens | output tokens |
|---|---:|---:|---:|
| native arithmetic | 100 | 8,300 | 16,725 |
| arithmetic image | 100 | 106,300 | 19,969 |
| gist/state/guards | 22 | 52,060 | 31,719 |
| hex | 15 | 33,744 | 3,945 |
| **complete scored suite** | **237** | **200,404** | **72,358** |

**272,762 newly consumed input + output tokens.** Reasoning tokens (54,483 total) are already included in output. The provider reported 0 cached tokens. These raw counts are not dollar costs or billing-equivalent tokens. Raw preflight configuration remains local-only.

## Reproduce and validate

- [Common methodology and all-model entrypoint](../../README.md)
- [Shared source hex corpus](../../hex-source.json), deterministic seed 20260905
- [Sanitized per-call scores, hashes and usage](receipt-manifest.json)
- Raw prompts/responses, local paths and full preflight snapshots are excluded from publication.
- [Machine-readable summary](summary.json)
- `QUALITY_MODEL=gemini-4-carbon node eval/model-quality/summarize.mjs` rebuilds
  the current payloads and refuses profile/payload drift, missing provenance,
  incomplete samples or scores inconsistent with the saved raw answers.
