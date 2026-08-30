# GLM 5.3 Flash quality results

Model: `@cf/zai-org/glm-5.3-flash` through Cloudflare Workers AI (via a local
OpenAI-compatible gateway). Evaluated on the default GPT fallback profile
(Spleen 5×8, 152 cols, maxH 1932) — GLM has no measured pxpipe profile — plus a
JetBrains Mono 14px pilot, because the 5×8 baseline turned out illegible to it.

GLM is a reasoning model: completion tokens are spent on `reasoning_content`
before `content`. Where reasoning exhausted the completion cap the model emits
no answer at all, so receipt rows distinguish "no answer produced" (empty) from
"wrong id/value". Re-runs of exhausted cells used a 16,384 completion cap; two
state sessions still exhaust 16,384 without emitting content and score 0.

## Benchmark Summary

| Geometry | Arithmetic (N=100) | Gist (N=98) | State (N=18) | Never-Stated (N=16) | Dense Hex (N=15) |
|---|---:|---:|---:|---:|---:|
| **Spleen 5×8 (152 cols)** | 36/100 (pure 39, text 100) | 57/98 | 6/18 | **0/16** | 0/15 |
| **JetBrains Mono 14px (84 cols)** | — | — | — | — | **10/15** |

## Arithmetic (N=100, novel numbers)

| arm | correct | notes |
|---|---:|---|
| text | 100/100 | no images |
| pure image | 39/100 | digit misreads (5↔8, 5↔3) at 5×8 |
| production (factsheet) | 36/100 | the bounded factsheet slightly hurts GLM here |

Novel random-number word problems, seed 20260711 — same generator as the other
model suites. Eighteen arm cells that failed with HTTP 429 rate limiting during
the concurrent run were re-run sequentially with the retrying client and merged
(`patched` field in the receipt); all other cells are from the single pass.

## Gist recall (N=98 answerable, 18 state, 16 never-stated)

- **Answerable: 57/98.** Sessions render 6-8 pages of transcript at 152 cols;
  one call per session answers all probes as a JSON array.
- **State (work3): 6/18.** Weakest area; two of six sessions (s1, s2) exhaust
  the 16,384 completion cap reasoning in circles and emit no content (0/3 each).
- **Never-stated guards: 0/16 confabulated.** GLM answered UNKNOWN on every
  unanswerable probe — the best guard behavior in the matrix.

Eight sessions that returned zero content at the default 8,192 completion cap
were re-run at 16,384; recovered sessions are scored from those answers.

## Verbatim hex (15 trials)

- **Spleen 5×8 (152 cols)**: 0/15. Failure modes: confident wrong ids
  (single-glyph confabs on adjacent ids), digit misreads on `dur_ms`, and
  no-answer reasoning loops (5 trials at the 4,096 cap; re-run at 16,384 still
  0/15 with wrong ids and loops).
- **JetBrains Mono 14px (84 cols)**: **10/15.** Every miss is a single-glyph
  confabulation, the same failure class as Fable 5's 13/15:
  `c5d68855f46d→c5d08855f46d`, `92abade01aad→92ababde01ad`,
  `93c3ced96dac→93c3ed96dac`, `f152ae9bfb8f→f152ae9bf8f8`,
  `8145b5a0fd46→1845b5a0fd46`. An earlier pilot pass at the 4,096 cap scored
  12/15; the kept receipt is the 16,384-cap run.

### 14px pilot fixture provenance

The committed `eval/verbatim-15` pages have no committed text source, so the
pilot re-renders the same corpus at the native geometry:

1. `decode-verbatim-pages.mjs` recovers the page text by matching each 5×8 cell
   against per-char reference masks rendered by this repo's renderer; recovery
   is verified by re-deriving all 15 golds from the decoded text (15/15).
2. `build-14px-fixture.mjs` re-renders the recovered records verbatim (no field
   rewriting) at JetBrains Mono 14px, 84 cols, maxH 512. Records are 93-96
   chars, so each wraps to two lines; pagination keeps a record's lines
   together (14 pages, 764x488).
3. `verbatim-hex-14px.mjs` runs the 15 probes against the 14px fixture.

## Receipts

- `novel-arithmetic-results.json` (3 arms, 429-patched)
- `gist-recall-results.json`
- `verbatim-hex-results.json` (Spleen 5×8 baseline)
- `verbatim-hex-14px-results.json` (JetBrains Mono 14px pilot)
- `14px-fixture/` (decoded sources, pages, golds, provenance)
