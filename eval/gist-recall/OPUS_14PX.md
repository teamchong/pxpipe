# Opus gist-recall — image arm at Opus's own 14px profile

Date: 2026-07-23. Model under test: `claude-opus-4-8`.

## Why this run exists

The gist-recall corpus was originally rendered at `claude-fable-5`'s production
density (`5x8`, ~180 cols). Measuring Opus against a fable-shaped render is the
wrong comparison — pxpipe ships Opus at native 14px (`9x16`, 782px pages,
`jetbrains-mono-14`), so the corpus was **re-rendered at Opus's real production
profile** and the image arm re-run. Each model is now scored at its own shipped
density, matching how fable's matrix cells are scored at fable's `5x8`.

## Provenance / config (receipts)

- Render: model-driven via `renderTextToImages({ model: 'claude-opus-4-8' })`
  → `CLAUDE_OPUS_PROFILE` (`jetbrains-mono-14`, `stripCols 86`, `maxHeightPx 1954`),
  producing **782px pages** (confirmed: 86 cols × 9px + pad ≈ 782, 14px cell).
- Each work dir carries `render.meta.json` recording `{model, font, stripCols,
  pageWidthPx}`; `run*.py` **preflight-aborts before any API call** if the
  corpus manifest model ≠ the model under test (guards silent profile/model
  mismatch).
- Model reached via **upstream (`:8082`), pxpipe-bypassed** — so pxpipe's own
  text→image rendering does not contaminate the arms; the model still gets the
  images. Concurrency 3, `CCI_READY_TIMEOUT=120`, `CCI_TIMEOUT=210`.
- Raw results: `work/results.opus-14px.jsonl`, `work2/…`, `work3/…`.

## Results (image arm, Opus @ 14px)

| tier | gist (answerable) | never-stated confab |
| --- | ---: | ---: |
| 1 (gist)          | 30/50 | 5/10 |
| 2 (recall+filler) | 17/30 | 2/6  |
| 3 (state)         | 12/18 | 0/0  |
| **total**         | **59/98** | **7/16** |

State tracking (tier 3, answerable): **12/18**.

By probe type (all tiers, image arm):

| type | score |
| --- | ---: |
| name         | 15/16 |
| numeric      | 11/16 |
| decision     | 10/16 |
| path         | 10/16 |
| final        | 5/6   |
| count        | 5/6   |
| first        | 2/6   |
| negation     | 1/16  |
| unanswerable | 9/16 (→ 7/16 confab) |

## Reading

Even at Opus's own 14px profile, recall on this dense multi-page history is
weak: **59/98 gist** (many decision/path probes answered with deflections like
"the answer is visible in image #N" rather than the fact), **negation is nearly
absent (1/16)**, and the never-stated guard confabulates **7/16**. The 14px
profile did **not** rescue recall on this corpus versus the earlier 5×8 read
(30/50 tier-1 either way) — this is a genuine model-quality finding, not a
render artifact.
