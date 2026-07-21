# Gemini 3.6 Flash quality results

Model: `google/gemini-3.6-flash` (`gemini-3.6-flash`) through the Google AI Studio bridge. The run used the standard production profile: Spleen 5×8, 152 columns, max height 1932, and the adjacent text factsheet.

| test | production image | notes |
|---|---:|---|
| novel arithmetic, N=100 | 100/100 | pure image 100/100, text 100/100 |
| gist recall | 98/98 | all 22 sessions completed |
| state tracking | 18/18 | subset of the gist corpus |
| never-stated guards | 0/16 confabulated | lower is better |
| dense 12-char hex | 15/15 | all calls completed |

Gemini 3.6 Flash achieves 100% parity with Fable 5 on reasoning and state tracking, and outperforms Fable 5 (15/15 vs 13/15) on dense verbatim hex reading off pure image pages.

Receipts:

- `model-gemini-3.6-flash-novel-arithmetic-results.json`
- `gist-recall-gemini-3.6-flash-results.json`
- `verbatim-hex-gemini-3.6-flash-results.json`
