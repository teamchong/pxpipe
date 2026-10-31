# Grok 4.7 — profile-aligned v2

2026-10-31. Model `grok-4.7`, Responses transport, reasoning **high**.
Runtime profile: JetBrains Mono **14px** (9×16 cell), **84 columns**, max height
**512px**, monochrome AA, reflow enabled, compact native factsheet, megapixel
vision regime (`mpix`, 1000 tokens/MP).

## Results

| test | native text | profile-rendered content | N |
|---|---:|---:|---:|
| arithmetic | **100/100** | **100/100** | 100 |
| gist | not run | **98/98** | 98 |
| state | not run | **18/18** | 18 |
| never-stated guards | not run | **0/16 confabulated** | 16 |
| dense hex association | not run | **14/15** | 15 |

`grok-4.7` uses the shipped Grok native 14px profile (JetBrains Mono 14px, 84 columns, max height 512px, reflow enabled, compact native factsheet) and scored **100/100** arithmetic, **98/98** gist, **18/18** state, **0/16** guard confabulations, and **14/15** dense hex association (with the compact factsheet active, compared to 0/15 on the pure-image legacy hex stress test without factsheet). It remains opt-in (`PXPIPE_MODELS=claude-fable-5,grok-4.7` or dashboard chip) alongside Grok 4.5 / 4.6.

## Receipts and actual cost

237 completed scored receipts, no API or grading errors. **237 new requests**, no reused receipts, no automatic retries.

| scope | calls | input tokens | output tokens |
|---|---:|---:|---:|
| native arithmetic | 100 | 129,000 | 23,441 |
| arithmetic image | 100 | 136,600 | 35,046 |
| gist/state/guards | 22 | 158,425 | 35,086 |
| hex | 15 | 56,073 | 11,377 |
| **complete scored suite** | **237** | **480,098** | **104,950** |

**585,048 newly consumed input + output tokens.** Reasoning tokens (96,874 total) are already included in output. The provider reported 275,584 cached tokens, a subset of input. These raw counts are not dollar costs or billing-equivalent tokens. Raw preflight configuration remains local-only.

## Reproduce and validate

- [Common methodology and all-model entrypoint](../../README.md)
- [Shared source hex corpus](../../hex-source.json), deterministic seed 20260905
- [Sanitized per-call scores, hashes and usage](receipt-manifest.json)
- Raw prompts/responses, local paths and full preflight snapshots are excluded from publication.
- [Machine-readable summary](summary.json)
- `QUALITY_MODEL=grok-4.7 node eval/model-quality/summarize.mjs` rebuilds
  the current payloads and refuses profile/payload drift, missing provenance,
  incomplete samples or scores inconsistent with the saved raw answers.
