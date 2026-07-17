# GPT-5.6 Sol quality results

Model: `gpt-5.6-sol` through the Codex Responses provider. Image calls bypassed
pxpipe.

## Production 5×8 profile

Production uses Spleen 5×8, 152 columns, max height 1932, monochrome AA, and the
adjacent text factsheet.

| test | text | production image | notes |
|---|---:|---:|---|
| novel arithmetic, N=100 | 100/100 | 98/100 | pure image 96/100 |
| gist recall | not measured | 83/98 | no transport errors |
| state tracking | not measured | 17/18 | no transport errors |
| never-stated guards | not measured | 4/16 confabulated | no transport errors |
| dense 12-char hex | not run in this harness | 0/15 | all calls completed |

Matched arithmetic usage was 5,300 text input tokens and 7,000 production-image
input tokens, **+32.1%**. The README rounds this to **+32%**. Short prompts are
not a compression win, even when the model reads them.

The 2026-07-15 run used the direct Responses upstream, not pxpipe. Two text-arm
calls initially received HTTP 503 overload responses and were retried individually;
the final receipt contains 100 completed calls for every arm and no errors.

## RGB-overprint research (rejected for production)

The alternating RGB profile scored 58/98 gist, 11/18 state, and 10/16 guard
confabulations. Full red→green→blue passes were worse at 36/98 gist and 5/18
state. Red→blue→green per-row ordering scored 55/98 gist, 10/18 state, and 8/16
guard confabulations.

The controlled separation diagnostic found every extracted color channel was
healthy at 11/12 exact, while the combined overprint scored 0/12 for each color,
including when Sol was asked to focus on only one channel. The eval-only canvas
renderer and receipts remain for research; no RGB code or font atlas ships in
the production runtime.


## Decision

Sol remains opt-in. Its arithmetic result is strong, but gist, state tracking,
abstention, and dense exact recall do not match Fable. Sibling `gpt-5.6-*`
models do not inherit Sol's profile or allowlist.

Receipts:

- `novel-arithmetic-spleen5x8-results.json`
- `gist-recall-results.json`
- `verbatim-hex-results.json`
- `novel-arithmetic-jbmono12-rgb-results.json` (rejected RGB arithmetic arm)
- `gist-recall-jbmono12-rgb-rbg-results.json` (rejected red→blue→green arm)
- `rgb-separation-diagnostic-results.json` (controlled channel diagnostic)
