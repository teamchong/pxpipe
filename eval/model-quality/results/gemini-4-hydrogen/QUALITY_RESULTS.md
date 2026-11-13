# Gemini 4 Hydrogen — profile-aligned v2

2026-11-13. Model `gemini-4-hydrogen`, Antigravity CLI (`agy -p`, `AGY_CLI=1`) transport, reasoning **xhigh** (`AGY_EFFORT=xhigh`).
Runtime profile: Spleen **5×8**, **312 columns**, max height **728px**, monochrome AA, reflow enabled, compact native factsheet, flat vision regime (`flat`, 1120 default / 1078 exact at 1568×728), 96-page history cap with mixed responses mode.

## Results

| test | native text | profile-rendered content | N |
|---|---:|---:|---:|
| arithmetic | **100/100** | **100/100** | 100 |
| gist | not run | **95/98** | 98 |
| state | not run | **18/18** | 18 |
| never-stated guards | not run | **0/16 confabulated** | 16 |
| dense hex association | not run | **15/15** | 15 |

`gemini-4-hydrogen` resolves to `GEMINI_PROFILE` (Spleen 5×8, 312 columns, 728px max height, compact native factsheet, 96-page history cap) and scored **100/100** arithmetic (both native text and profile-rendered image), **95/98** gist, **18/18** state, **0/16** guard confabulations, and **15/15** dense hex association (with the compact factsheet active, as in normal runtime requests). Of the 98 answerable gist probes, 95 were answered accurately and **0** were answered `UNKNOWN`; all 3 misses were numeric `RETRY BUDGET` probes in `gist-work2` (`gist-work2-1`, `gist-work2-2`, `gist-work2-4`), which returned other numbers from the transcript rather than the retry budget.

## Receipts and actual cost

237 completed scored receipts, no API or grading errors in the final saved dataset. **237 new requests**, no reused receipts, no automatic retries. (An initial run completed 218/237 calls before `gist-work2-4` hit the default 2m CLI print timeout under `xhigh`; raising the `agy -p` timeout to 300s completed the remaining 19 calls without retries.)

| scope | calls | input tokens | output tokens |
|---|---:|---:|---:|
| native arithmetic | 100 | 915,052 | 45,494 |
| arithmetic image | 100 | 1,987,964 | 143,025 |
| gist/state/guards | 22 | 620,438 | 295,423 |
| hex | 15 | 333,826 | 139,082 |
| **complete scored suite** | **237** | **3,857,280** | **623,024** |

**4,480,304 newly consumed input + output tokens.** Reasoning tokens (596,766 total) are already included in output. The CLI reported 1,351,199 cached read tokens, already included in input. Because calls ran through the `agy -p` CLI agent harness (which includes the CLI system prompt, tool declarations, and `read_file` tool-call turns to inspect rendered PNGs), these raw counts include agent-loop overhead and are not dollar costs or billing-equivalent tokens. Raw preflight configuration remains local-only.

## Reproduce and validate

- [Common methodology and all-model entrypoint](../../README.md)
- [Shared source hex corpus](../../hex-source.json), deterministic seed 20260905
- [Sanitized per-call scores, hashes and usage](receipt-manifest.json)
- Raw prompts/responses, local paths and full preflight snapshots are excluded from publication.
- [Machine-readable summary](summary.json)
- `QUALITY_MODEL=gemini-4-hydrogen node eval/model-quality/summarize.mjs` rebuilds
  the current payloads and refuses profile/payload drift, missing provenance,
  incomplete samples or scores inconsistent with the saved raw answers.
