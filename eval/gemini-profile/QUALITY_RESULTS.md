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
- `lost-in-middle-results.json`

## Production-history positional retrieval

To explore whether pxpipe could help with Lost-in-the-Middle behavior, Gemini
3.6 Flash was evaluated on a deliberately demanding archived-case lookup task
at 5%, 25%, 50%, 75%, and 95% record depth. The paired raw/pxpipe sweep used
2,000, 6,000, and 10,000 records with two generated datasets per size.

Unlike the superseded line-table pilot, this harness sends the raw request
through `transformGoogleGenerateContent` and uses its exact output. History is
wrapped and reflowed by production code, the recent six turns remain native,
and the generated histories use 6, 18, and 30 images, all within the production
32-image cap. The production factsheet covered none of the probed target fields.

The scorer separates weak acknowledgment from locating and reading the row:

| measure | raw text | pxpipe |
|---|---:|---:|
| says target exists | **29/30** | **29/30** |
| rejects matched absent key | **29/30** | **29/30** |
| localizes row (correct adjacent region) | **17/30** | **18/30** |
| recognizes row (region + status) | **13/30** | **11/30** |
| exact row (region + status + reference) | **3/30** | **3/30** |

At 50% depth alone (`N=6`), raw/pxpipe row localization was 2/6 versus
1/6, recognition was 2/6 versus 1/6, and exact retrieval was 0/6 for both.

This production-faithful run does not show a clear overall winner. Pxpipe
slightly improved row localization, raw text slightly improved semantic status
recognition, and exact retrieval tied. Both representations struggled with the
synthetic table, especially at middle depth. With only two trials per
size/depth cell, these differences are directional rather than evidence of a
Lost-in-the-Middle advantage or disadvantage.

The 14/15 dense-hex result above measures legibility on a small controlled page;
it is not a claim of general long-context retrieval. The separate 98/98 gist suite
measures natural-language semantic recall, not exact table lookup.

Full per-call responses, usage metadata, latency, depth, context size, and
expected values are retained in `lost-in-middle-results.json`.
