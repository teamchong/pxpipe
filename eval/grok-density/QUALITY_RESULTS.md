# Grok 4.5 quality results

Model: `grok-4.5` through the Codex Responses provider. Image calls bypassed
pxpipe (`OPENAI_BASE_URL` upstream, port 47821 rejected) and used the **live
production profile** resolved by `resolveGptProfile('grok-4.5')`.

## Current shipped profile — native 14px / 84 cols / maxH 512 (2026-07-23)

Recipe locked in each receipt: `font=jetbrains-mono-14`, `cols=84`, `maxH=512`,
factsheet on, IDS on arithmetic.

| test | text | production image | notes |
|---|---:|---:|---|
| novel arithmetic, N=100 | 100/100 | **100/100** | pure image also 100/100 |
| gist recall | — | **97/98** | no transport errors |
| state tracking | — | **17/18** | subset of the gist corpus |
| never-stated guards | — | **0/16** confabulated | lower is better |
| dense 12-char hex | — | **0/15** (0/12 completed; 3 fetch errors) | still byte-unsafe |

This is a large lift vs the prior 5×8 suite (82/100 arithmetic, 83/98 gist,
13/18 state). Dense hex remains 0. Grok stays opt-in: hex and the native-size
exact ladder (best 4/8 at 14px) are still below the Fable bar.

Receipts (recipe field must show `jetbrains-mono-14` / 84):

- `../sol-profile/model-grok-4.5-novel-arithmetic-results.json`
- `../sol-profile/gist-recall-grok-4.5-results.json`
- `../sol-profile/verbatim-hex-grok-4.5-results.json`
- native size ladder: [native-sweep/RESULTS.md](native-sweep/RESULTS.md)

## Prior 5×8 suite (historical; superseded)

Earlier receipts used Spleen 5×8 / 152 cols / maxH 512 and scored 82/100
arithmetic, 83/98 gist, 13/18 state, 0/16 confab, 0/15 hex. Do not present those
as the current profile.
