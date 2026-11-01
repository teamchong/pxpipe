# Grok 4.7 — profile-aligned v2 (Spleen 5×8 control)

2026-10-31. Model `grok-4.7`, Responses transport, reasoning **high**.
Runtime override (`PXPIPE_GPT_PROFILES`): Spleen **5×8**, **152 columns**, max height **512px**, monochrome AA, reflow enabled, compact native factsheet, megapixel vision regime (`mpix`, 1000 tokens/MP).

## Results vs shipped 14px profile

| test | native text | Spleen 5×8 (152 cols) | JetBrains Mono 14px (84 cols, shipped) | N |
|---|---|---|---|---|
| arithmetic | 100/100 | **85/100** | **100/100** | 100 |
| gist | not run | **14/98** (61 `UNKNOWN`) | **98/98** (0 `UNKNOWN`) | 98 |
| state | not run | **5/18** | **18/18** | 18 |
| never-stated guards | not run | **0/16 confabulated** | **0/16 confabulated** | 16 |
| dense hex association | not run | **0/15** | **14/15** | 15 |

`grok-4.7` cannot read Spleen 5×8 at 152 columns (85/100 arithmetic, 14/98 gist with 61 answered `UNKNOWN`, 5/18 state, 0/15 hex even with the compact factsheet active), confirming that Grok models must retain the native 14px JetBrains Mono at 84 columns profile.

## Receipts and actual cost

237 completed scored receipts, no grading errors. **137 new requests**; 100 native arithmetic receipts reused from the 14px `grok-4.7` run after matching model/reasoning, output-cap compatibility and exact request-content hashes.

| scope | calls | input tokens | output tokens |
|---|---|---|---|
| reused native arithmetic | 100 | 129,000 | 23,441 |
| new arithmetic image | 100 | 134,200 | 40,911 |
| new gist/state/guards | 22 | 74,325 | 128,222 |
| new hex | 15 | 39,093 | 20,611 |
| **new calls total** | **137** | **247,618** | **189,744** |
| **complete scored suite, including reused receipts** | **237** | **376,618** | **213,185** |

**437,362 newly consumed input + output tokens.** Reasoning tokens (185,655 on new calls; 205,046 total) are already included in output. The provider reported 187,264 cached tokens on new calls (302,464 total), a subset of input. These raw counts are not dollar costs or billing-equivalent tokens.

## Reproduce and validate

- [Common methodology and all-model entrypoint](../../README.md)
- [Shipped 14px profile results](../grok-4.7/QUALITY_RESULTS.md)
- [Shared source hex corpus](../../hex-source.json), deterministic seed 20260905
- [Sanitized per-call scores, hashes and usage](receipt-manifest.json) — Raw prompts/responses, local paths and full preflight snapshots are excluded from publication.
- [Machine-readable summary](summary.json)
