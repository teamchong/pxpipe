# Grok 4.6 quality results

Model: `grok-4.6` through the Codex Responses provider, `reasoning.effort=high`.
Image calls bypassed pxpipe (`OPENAI_BASE_URL` upstream, port 47821 rejected)
and used the **live production profile** resolved by `resolveGptProfile('grok-4.6')`.

## Native 14px / 84 cols / maxH 512, reasoning high (2026-08-13)

Recipe locked in each receipt: `font=jetbrains-mono-14`, `cols=84`, `maxH=512`,
factsheet on, `reasoningEffort=high`.

| test | text | production image | notes |
|---|---:|---:|---|
| novel arithmetic, N=100 | 100/100 | **100/100** | pure image also 100/100 |
| gist recall | — | **97/98** | work3 s4 final `BATCH_WINDOW_MS` 4000 vs gold 4800 |
| state tracking | — | **17/18** | same miss as gist |
| never-stated guards | — | **0/16** confabulated | lower is better |
| dense 12-char hex | — | **0/15** | all 15 completed; still byte-unsafe |

Same scores as `grok-4.5` on this corpus. Dense hex remains 0.

Receipts:

- `novel-arithmetic-grok-4.6-results.json`
- `gist-recall-grok-4.6-results.json`
- `verbatim-hex-grok-4.6-results.json`

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8082/v1
export OPENAI_API_KEY=…
GROK_QUALITY_LIVE=1 N=100 node eval/grok-profile/novel-arithmetic.mjs
GROK_QUALITY_LIVE=1 node eval/grok-profile/gist-recall.mjs
GROK_QUALITY_LIVE=1 node eval/grok-profile/verbatim-hex.mjs
```
