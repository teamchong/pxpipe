# Grok 4.5 quality results

Model: `grok-4.5` through the Codex Responses provider. Image calls bypassed
pxpipe and used the production 5×8 profile.

| test | text | production image | notes |
|---|---:|---:|---|
| novel arithmetic, N=100 | 100/100 | 82/100 | pure image 83/100 |
| gist recall | 98/98 | 83/98 | no transport errors |
| state tracking | 18/18 | 13/18 | subset of the gist corpus |
| never-stated guards | 0/16 confabulated | 0/16 confabulated | lower is better |
| dense 12-char hex | 15/15 | 0/15 | all calls completed after retrying transient upstream failures |

Novel-arithmetic input usage was recovered from the provider log for the same
N=100 run: 25,400 text tokens and 27,100 production-image tokens, **+6.7%**.
The README rounds this to **+7%**. This short workload costs more as images.

Receipts:

- `../sol-profile/model-grok-4.5-novel-arithmetic-results.json`
- `../sol-profile/gist-recall-grok-4.5-results.json`
- `../sol-profile/gist-recall-grok-4.5-text-results.json`
- `../sol-profile/verbatim-hex-grok-4.5-results.json`
- `../sol-profile/verbatim-hex-grok-4.5-text-results.json`

Grok remains opt-in because arithmetic, gist, state tracking, and dense exact
recall are below the Fable bar. The completed hex rerun used an 8,192-token
output cap so mandatory reasoning could not consume the final answer budget.
