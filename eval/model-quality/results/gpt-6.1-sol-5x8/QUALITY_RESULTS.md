# GPT 6.1 Sol — profile-aligned v2 (Spleen 5×8 control)

2026-10-31. Model `gpt-6.1-sol`, Direct Responses transport, reasoning **low**.
Runtime override (`PXPIPE_GPT_PROFILES`): Spleen **5×8**, **152 columns**, max height **1954px**, monochrome AA, reflow enabled, full native factsheet, normal image `detail` **high**.

## Results vs shipped 14px profile

| test | native text | Spleen 5×8 (152 cols) | JetBrains Mono 14px (84 cols, shipped) | N |
|---|---|---|---|---|
| arithmetic | 100/100 | **100/100** | **100/100** | 100 |
| gist | not run | **20/98** (68 `UNKNOWN`) | **96/98** (0 `UNKNOWN`) | 98 |
| state | not run | **9/18** | **18/18** | 18 |
| never-stated guards | not run | **0/16 confabulated** | **0/16 confabulated** | 16 |
| dense hex association | not run | **3/15** | **15/15** | 15 |

`gpt-6.1-sol` collapses at Spleen 5×8 / 152 columns (20/98 gist with 68 answered `UNKNOWN`, 9/18 state, 3/15 hex even with the full factsheet active), confirming that `GPT56_SOL_PROFILE` must retain native 14px JetBrains Mono at 84 columns.

## Receipts and actual cost

237 completed scored receipts, no API or grading errors. **137 new requests**; 100 native arithmetic receipts reused from the 14px `gpt-6.1-sol` run after matching model/reasoning, output-cap compatibility and exact request-content hashes. No automatic retries.

| scope | calls | input tokens | output tokens |
|---|---|---|---|
| reused native arithmetic | 100 | 5,300 | 5,411 |
| new arithmetic image | 100 | 7,000 | 7,543 |
| new gist/state/guards | 22 | 49,066 | 7,516 |
| new hex | 15 | 20,568 | 5,786 |
| **new calls total** | **137** | **76,634** | **20,845** |
| **complete scored suite, including reused receipts** | **237** | **81,934** | **26,256** |

**97,479 newly consumed input + output tokens.** Reasoning tokens (15,679 on new calls; 16,406 total) are already included in output. The provider reported 69,523 new cache-write tokens, a subset of input, and zero cache reads. These raw counts are not dollar costs or billing-equivalent tokens.

## Reproduce and validate

- [Common methodology and all-model entrypoint](../../README.md)
- [Shipped 14px profile results](../gpt-6.1-sol/QUALITY_RESULTS.md)
- [Shared source hex corpus](../../hex-source.json), deterministic seed 20260905
- [Sanitized per-call scores, hashes and usage](receipt-manifest.json) — Raw prompts/responses, local paths and full preflight snapshots are excluded from publication.
- [Machine-readable summary](summary.json)
