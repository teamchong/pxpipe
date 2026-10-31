# GPT 6.1 Sol — profile-aligned v2

2026-10-31. Model `gpt-6.1-sol`, direct Responses transport, reasoning **low**.
Runtime profile: JetBrains Mono **14px** (9×16 cell), **84 columns**, max height
**1954px**, monochrome AA, reflow enabled, full native factsheet, normal image
detail **`high`**.

## Results

| test | native text | profile-rendered content | N |
|---|---:|---:|---:|
| arithmetic | **100/100** | **100/100** | 100 |
| gist | not run | **96/98** | 98 |
| state | not run | **18/18** | 18 |
| never-stated guards | not run | **0/16 confabulated** | 16 |
| dense hex association | not run | **15/15** | 15 |

`gpt-6.1-sol` resolves to `GPT56_SOL_PROFILE` (native 14px JetBrains Mono at 84 columns, 1954px height, `detail: high`, full native factsheet) and scored **100/100** arithmetic, **96/98** gist, **18/18** state, **0/16** guard confabulations, and **15/15** dense hex association (with the full factsheet active, as in normal runtime requests). Of the 98 answerable gist probes, 96 were answered accurately and 0 were answered UNKNOWN. It remains opt-in (`PXPIPE_MODELS=claude-fable-5,gpt-6.1-sol`) because native 14px is a legibility/quality profile rather than a universal warm-cache cost win.

## Receipts and actual cost

237 completed scored receipts, no API or grading errors. **237 new requests**, no reused receipts, no automatic retries.

| scope | calls | input tokens | output tokens |
|---|---:|---:|---:|
| native arithmetic | 100 | 5,300 | 5,411 |
| arithmetic image | 100 | 9,900 | 6,431 |
| gist/state/guards | 22 | 137,846 | 1,225 |
| hex | 15 | 38,718 | 246 |
| **complete scored suite** | **237** | **191,764** | **13,313** |

**205,077 newly consumed input + output tokens.** Reasoning tokens (3,294 total) are already included in output. The provider reported 176,453 cache-write tokens, a subset of input, and zero cache reads. These raw counts are not dollar costs or billing-equivalent tokens. Raw preflight configuration remains local-only.

## Reproduce and validate

- [Common methodology and all-model entrypoint](../../README.md)
- [Shared source hex corpus](../../hex-source.json), deterministic seed 20260905
- [Sanitized per-call scores, hashes and usage](receipt-manifest.json)
- Raw prompts/responses, local paths and full preflight snapshots are excluded from publication.
- [Machine-readable summary](summary.json)
- `QUALITY_MODEL=gpt-6.1-sol node eval/model-quality/summarize.mjs` rebuilds
  the current payloads and refuses profile/payload drift, missing provenance,
  incomplete samples or scores inconsistent with the saved raw answers.
