# QW09/QW10 offline profile grid — gpt-5.6

Generated 2026-07-10 with `pnpm exec tsx eval/qw-crosscli-2026-07-10/profile-grid/run.ts`.
This directory is self-contained eval evidence and makes no production change.

## Method

- Deterministic 155,289-codepoint corpus (`corpus.txt`, SHA recorded in `results.json`),
  720 numbered lines containing the pinned SHA, UUID, critical negation, Polish text,
  and JSON-like syntax.
- Grid: `stripCols ∈ {144,148,152,156,160}` × `maxHeightPx ∈
  {1916,1920,1924,1928,1932,1936}`.
- Actual renderer output dimensions and SHA-256 of every PNG were recorded. Image
  tokens use pxpipe's actual `gpt-5.6` patch-cost function.
- The normal per-page character limit was intentionally lifted so height, rather
  than that independent budget, is the variable under test.
- Tesseract is not installed. `rendererCoverageProxy` and
  `exactIdentifierCoverageProxy` mean zero atlas drops; they are **not OCR claims**.

## Boundary findings

- 152 columns produces exactly 768 px width; 156 and 160 produce 788/808 px and
  fail the shortest-side-floor safety proxy. They need live readability proof.
- Requested heights 1928 and 1932 both render full pages at 1928 px because rows
  are 8 px high with padding. Likewise 1920 and 1924 both render at 1920 px.
- Moving from actual height 1920 to 1928 crosses a 32 px patch row (60 → 61).
- Every one of 30 cells had zero atlas drops, including the exact-identifier probe.

## Pareto recommendation (offline only)

For the measured corpus, the non-dominated safe-width candidates are:

| Candidate | Images | Image tokens | Role |
|---|---:|---:|---|
| `144 × 1920` (or requested `maxHeightPx=1924`, same raster) | 7 | 8,326 | minimum tokens |
| `144 × 1936` | 6 | 8,372 | minimum request image count, +46 tokens |

The current-width comparator `152 × 1920` is 7 images / 8,688 tokens; `152 × 1928`
is 6 / 8,784. Thus offline token math favors 144 columns, but narrower wrapping may
affect model comprehension and the 1936 height is beyond the current 1932 setting.

**Do not enable either candidate from this evidence.** Run live end-to-end canaries
for exact identifier recall, authority/negation, and tool-call correctness first.
If the canaries tie, prefer `144 × 1936` when request image count is the constraint,
otherwise `144 × 1920` for minimum measured tokens. Profiles of other models remain
untouched by this eval.

