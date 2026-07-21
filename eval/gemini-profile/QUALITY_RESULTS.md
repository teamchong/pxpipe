# Gemini 3.6 Flash quality results

Model: `google/gemini-3.6-flash` (`gemini-3.6-flash`) through the Google AI Studio bridge. These receipts use the shipped Spleen 5×8, 312-column, 728px profile and adjacent text factsheet.

| test | production image | notes |
|---|---:|---|
| novel arithmetic, N=100 | 100/100 | pure image 100/100, text 100/100 |
| gist recall | 98/98 | all 22 sessions completed |
| state tracking | 18/18 | subset of the gist corpus |
| never-stated guards | 0/16 confabulated | lower is better |
| dense 12-char hex | 14/15 | all calls completed |

At the shipped 312×728 geometry, Gemini 3.6 Flash matched the recorded Fable 5 reasoning, state-tracking, and guard scores and scored 14/15 versus Fable's 13/15 on dense verbatim reading.

Receipts:

- `novel-arithmetic-results.json`
- `gist-recall-results.json`
- `verbatim-hex-results.json`
