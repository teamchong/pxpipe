# Gemini 4 Neon — profile-aligned v2

2026-11-18. Model `gemini-4-neon`, Antigravity CLI (`agy -p`, `AGY_CLI=1`) transport, reasoning **xhigh** (`AGY_EFFORT=xhigh`).
Runtime profile: Spleen **5×8**, **312 columns**, max height **728px**, monochrome AA, reflow enabled, compact native factsheet, flat vision regime (`flat`, 1120 default / 1078 exact at 1568×728), 96-page history cap with mixed responses mode.

## Results

| test | native text | profile-rendered content | N |
|---|---:|---:|---:|
| arithmetic | **100/100** | **100/100** | 100 |
| gist | not run | **95/98** | 98 |
| state | not run | **18/18** | 18 |
| never-stated guards | not run | **0/16 confabulated** | 16 |
| dense hex association | not run | **15/15** | 15 |

`gemini-4-neon` resolves to `GEMINI_PROFILE` (Spleen 5×8, 312 columns, 728px max height, compact native factsheet, 96-page history cap) and scored **100/100** arithmetic (both native text and profile-rendered image), **95/98** gist, **18/18** state, **0/16** guard confabulations, and **15/15** dense hex association (with the compact factsheet active, as in normal runtime requests). Of the 98 answerable gist probes, 95 were answered accurately and **0** were answered `UNKNOWN`; all 3 misses were numeric `RETRY BUDGET` probes in `gist-work2` (`gist-work2-1`: `2400 ms` vs gold `1330`; `gist-work2-2`: `3750ms` vs gold `4570`; `gist-work2-4`: `1850ms` vs gold `9120`), where lowercase `Nms` durations fall below the factsheet's 6-digit number threshold and were misread from the 5×8 transcript image.

### No-factsheet ablation (pure image)

Re-running the 15 dense-hex trials on `gemini-4-neon` (`xhigh` via `agy -p`) at the same 312-column Spleen 5×8 geometry with the compact factsheet stripped and factsheet instructions omitted scored **14/15** (`hex-1` gold `a4982c9c67d5` read as `34982c9c67d5`, a single-glyph `a` vs `3` substitution on the leading character). `gemini-4-neon` stays on `GEMINI_PROFILE` with `factSheetFormat: 'compact'`.

## Receipts and actual cost

237 completed scored receipts, no API or grading errors in the final saved dataset. **237 new requests**, no reused receipts, no automatic retries.

| scope | calls | input tokens | output tokens |
|---|---:|---:|---:|
| native arithmetic | 100 | 901,782 | 41,926 |
| arithmetic image | 100 | 1,957,013 | 135,368 |
| gist/state/guards | 22 | 612,449 | 293,806 |
| hex | 15 | 328,428 | 116,378 |
| **complete scored suite** | **237** | **3,799,672** | **587,478** |

**4,387,150 newly consumed input + output tokens.** Reasoning tokens (563,243 total) are already included in output. The CLI reported 1,203,044 cached read tokens, already included in input. Because calls ran through the `agy -p` CLI agent harness (which includes the CLI system prompt, tool declarations, and `read_file` tool-call turns to inspect rendered PNGs), these raw counts include agent-loop overhead and are not dollar costs or billing-equivalent tokens. Raw preflight configuration remains local-only.

## Reproduce and validate

- [Common methodology and all-model entrypoint](../../README.md)
- [Shared source hex corpus](../../hex-source.json), deterministic seed 20260905
- [Sanitized per-call scores, hashes and usage](receipt-manifest.json)
- Raw prompts/responses, local paths and full preflight snapshots are excluded from publication.
- [Machine-readable summary](summary.json)
- `QUALITY_MODEL=gemini-4-neon node eval/model-quality/summarize.mjs` rebuilds
  the current payloads and refuses profile/payload drift, missing provenance,
  incomplete samples or scores inconsistent with the saved raw answers.
