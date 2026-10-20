# DeepSeek V4.1 Flash 1017 quality results

Model: `@cf/deepseek-ai/deepseek-v4.1-flash-1017` (`deepseek-v4.1-flash-1017`) through Cloudflare Workers AI (via a local OpenAI-compatible gateway). Evaluated on a JetBrains Mono 14px, 84-col, maxH 768 pilot profile (`PXPIPE_GPT_PROFILES` in `deepseek-client.mjs`, adjacent bounded factsheet) — no runtime pxpipe profile is shipped because DeepSeek V4.1 Flash's 98% native prompt-cache discount ($0.006 cached vs $0.30 uncached input) and 14px density (~2× vs ~5× on 5×8) leave negligible dollar savings — plus the Spleen 5×8 dense-hex baseline (`eval/verbatim-15`) and the 14px hex fixture (`eval/glm-profile/14px-fixture`).

DeepSeek V4.1 Flash is a reasoning model: completion tokens are spent on `reasoning_content` before `content`. Workers AI enforces a hard 32-image ceiling per request (`Invalid data for image - reason too many images in request (max 32)`), so the 14px evaluation recipe uses `maxHeightPx: 768` (764×760 px pages, staying within the 768 px no-resize square while keeping all 22 gist/state sessions at ≤26 images).

## Benchmark Summary

| Geometry | Arithmetic (N=100) | Gist (N=98) | State (N=18) | Never-Stated (N=16) | Verbatim Hex (N=15) |
|---|---:|---:|---:|---:|---:|
| **JetBrains Mono 14px (84 cols, maxH 768, pilot)** | **100/100** (pure 100, text 100) | **98/98** | **18/18** | **0/16** | **8/15** (14px fixture) |
| **Spleen 5×8 (312 cols, `eval/verbatim-15`)** | — | — | — | — | 0/15 |

## Arithmetic (N=100, novel numbers)

| arm | correct | notes |
|---|---:|---|
| text | 100/100 | no images |
| pure image | 100/100 | JetBrains Mono 14px, 84 cols, no factsheet |
| production (factsheet) | 100/100 | JetBrains Mono 14px, 84 cols + bounded factsheet |

Novel random-number word problems, seed 20260711. All 100 problems passed in every arm on the first pass.

## Gist recall (N=98 answerable, 18 state, 16 never-stated)

- **Answerable: 98/98 (100%).** All 22 sessions (`work` s0–s9, `work2` s0–s5, `work3` s0–s5) completed at 8–26 images per session (84 cols, maxH 768) and scored 100%.
- **State (`work3`): 18/18 (100%).** Every final state value and transition count across all six state-tracking sessions matched gold.
- **Never-stated guards: 0/16 confabulated.** Answered `UNKNOWN` on every unanswerable probe.

## Verbatim hex (15 trials)

- **Spleen 5×8 (`eval/verbatim-15`, 312 cols)**: **0/15.** 5×8 bitmap glyphs are too small/dense for DeepSeek V4.1 Flash's vision encoder; trials either exhaust the completion budget reasoning over illegible glyphs or confabulate hex strings.
- **JetBrains Mono 14px (`eval/glm-profile/14px-fixture`, 84 cols)**: **8/15.** Six misses are single-glyph confusions or transpositions (`c9c947f680ec→c9c947f80ceb`, `ffe21785b09d→fffe21785b09`, `5a7373d4187f→5a7373d4a187`, `44ea8c7aeedd→4ea8c7aeeedd`, `b8fce698f971→bbfce698f971`, `4a8164556b99→4b8164556b99`) and one trial (`dur_ms=8071`, `92abade01aad`) emitted no final answer before stream end.

## Receipts

- `novel-arithmetic-results.json`
- `gist-recall-results.json`
- `verbatim-hex-results.json` (Spleen 5×8 baseline)
- `verbatim-hex-14px-results.json` (JetBrains Mono 14px fixture)
