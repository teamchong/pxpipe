# How pxpipe sizes a rendered image — rules, reasons, and history

This documents *why* a pxpipe PNG has the dimensions it does. It exists because
the sizing looks arbitrary until you know what was tried and rejected. If you're
tempted to "make it square" or "shrink to the text," read the history first —
both were considered, and one was built and reverted.

## TL;DR — current behavior

A rendered page is a **fixed-width, variable-height** image. It is **never
squared** and **never shrunk horizontally to fit short lines**.

- **Width is constant**, set only by the column count, not by content:
  `width = 2·PAD_X + cols·CELL_W` → `8 + 313·5 = 1573px` at the defaults.
- **Height grows to fit the lines on the page**, capped, then pages:
  `height = 2·PAD_Y + nLines·CELL_H` → `8 + 8·nLines`.
- **Vertical cap → paging**: `maxLines = floor((MAX_HEIGHT_PX − 2·PAD_Y) / CELL_H)`
  `= floor(1560/8) = 195` lines. Overflow goes to the next image, it does not
  grow the canvas. A *full* page is `1573 × 1568` (near-square by coincidence at
  313 cols); a *partial* page (small tool_result, last page) is wide-and-short,
  e.g. `1573 × 160`.

Source of truth: `renderChunkToPng` in `src/core/render.ts` (the `width` /
`height` lines), constants `PAD_X=PAD_Y=4`, `CELL_W=5`, `CELL_H=8` (the "5×8
cell"), `DEFAULT_COLS=313`, `MAX_HEIGHT_PX=1568`, `READABLE_CHARS_PER_IMAGE=50000`.

## The cell

Each character occupies a **5px wide × 8px tall** cell (`ATLAS_CELL_W=5`,
`ATLAS_CELL_H=8` in `src/core/atlas.ts`). The atlas is a prebaked glyph sheet;
text is rendered white-on-black then inverted to black-on-white. The cell was
**7×10 originally** and shrunk to 5×8 — smaller cell, same legibility on the
target model, more chars per pixel.

## Why full width, not shrink-to-content

`shrinkColsToContent` (`src/core/render.ts`) still exists but is a **no-op** — it
returns `cols` unchanged. Its docstring records the policy:

> *Always render at full canvas width — no shrink-to-content. Maximum chars per
> page = maximum image-token savings on dense content, and the unused canvas
> tail is just whitespace (cheap to encode).*

The reasoning:

1. **The only content pxpipe images is dense content** (it passes a
   profitability gate; sparse/short-line content is left as text). After
   `reflow` packs that content into full-width rows, the longest line is already
   ~`cols`, so there is *nothing left to shrink*. Width-shrink only helps
   short-line content — which never reaches the renderer.
2. **Simplicity + prediction parity.** The cost gate has to predict image tokens
   before rendering. A fixed width makes prediction trivial and exact; a
   content-dependent width forced the gate to re-derive the canvas size (see the
   "hoist width-shrink before gate" commit below) for no real-world gain.

## Why not "square with max width"

Anthropic bills images by **pixel area** (≈ `w·h/750`), not by the longest edge.
So a square is not cheaper than a wide-short image of the same area — what
minimizes cost is the *tightest bounding box around the text*, and for dense
reflowed content that box is exactly "full width × just enough rows," which is
what we render. Squaring would usually *increase* area (pad height or drop
columns) for no benefit. Aspect ratio is a non-goal; **chars-per-pixel** is the
goal, achieved by filling every row to `cols` and paging vertically.

## Two render paths

- **tool_result / history images**: single-column, paged at the 195-line cap.
- **system-slab image**: kept on a path that *can* use multi-column packing
  (`shrinkWidth=false`), but multi-col is **disabled by default** (`multiCol: 1`)
  because at 313 cols a single column already holds ~50k chars/page and
  multi-col adds OCR column-ordering risk without meaningful savings.

So in practice everything is single-column full-width today; the multi-col code
is retained for backward compat.

## Billing model (and an unresolved gap)

- **Anthropic's documented formula**: `tokens ≈ (w·h) / 750`.
- **The gate's constant**: `src/core/transform.ts` anchors per-image cost on an
  *empirical* figure (~2500 tok for a 508×1559 canvas, i.e. claiming the doc
  formula underpredicts billing by ~2.4×). That measurement is from an earlier
  cell/column regime.
- **A fresh regression** on production `~/.pxpipe/events.jsonl` (2-var OLS,
  `tokens ≈ a·text_chars + b·image_pixels`, N≈1.5k cold-miss events) gives
  **~907 pixels/token** and **~1.8 chars/token** for text — i.e. *much* closer
  to the doc's 750 than to the gate's stale ~312 px/tok.

These disagree by ~3×. The gate is therefore likely **pessimistic** about image
cost on current traffic (it may pass up profitable compressions). Re-grounding
`TOKENS_PER_IMAGE` from a fresh regression is an open task — the data is in the
event log (`image_pixels` next to `input_tokens + cache_create_tokens` on
cold-miss rows). Don't trust any single hardcoded image-cost constant without
re-checking it against the log.

## How sizing decisions are/were measured

- **L1 OCR eval** (`eval/eval-l1-ocr.mjs`): per-character read accuracy across
  render styles (cell size, reflow on/off, instruction placement, grayscale).
  This is what gated reflow and the in-image instruction banner.
- **L2 session eval** (`eval/eval-l2-session.mjs`): comprehension over whole
  imaged sessions.
- **events.jsonl regression**: the real per-pixel/per-char billing fit above.
- **glyph-matrix** (`eval/glyph-matrix/`, PAUSED): a per-character confusion
  matrix across render styles, to find a zero-cost style that lowers read error
  so the gate can compress harder at the same fidelity. Paused because the
  reader model (Fable 5) is offline.

## History (oldest → newest)

The sizing converged through measured iteration, not a single design. Key commits:

| date | commit | change | why |
|---|---|---|---|
| 2026-05-21 | `38e852a` | add **R3 reflow** (recover line-end dead margin, ~29% glyph fill → dense) | rows were mostly empty; pack them |
| 2026-05-22 | `fbf32bb` | **pack reflow across newlines** + grayscale atlas + build **L1/L2 eval harness** | measure read fidelity of the packing |
| 2026-05-22 | `ea68340` | **in-image instruction banner** variant | L1 eval: **+1.04pp** char accuracy vs baseline |
| 2026-05-22 | `dca7807` | pack header prose to full row width, drop spurious ↵ markers | tidy reflow output |
| 2026-05-22 | `a9b0996` | docs: cell is now **5×8** (was 7×10) | denser cell |
| 2026-05-23 | `1afaa6c` | content-aware image cost + **width-shrinking** (WIP) | *tried* shrink-to-content |
| 2026-05-23 | `414f4bf` | hoist width-shrink before the cost gate so prediction matches render | make shrink predictable |
| 2026-05-25 | `3c8716c` | **full-canvas single-column rendering, 50k chars/page** — `shrinkColsToContent` becomes a **no-op** | shrink gave no gain on dense content; full width packs more |
| 2026-05-25 | `bb8e0d8` | **page** dense tool/history images | enforce the 195-line cap, split overflow |
| 2026-05-26 | `28bc65c` | reduce dense page size | tuning |
| 2026-06-09 | `cdfc99d` | drop Opus, **Fable-5 only**; dense render on bare 5×8 cell | Opus misread ~7% of renders |

The arc: **reflow** to stop wasting rows → **eval harness** to prove the packing
is still readable → **width-shrink** experiment → **reverted** to full-canvas
two days later because dense content already fills the width → **paging** for the
height cap → **model scope narrowed** to the reader that hits 100% on the cell.

## If you want to change the sizing

1. Add a style variant to the L1 OCR eval and measure char accuracy first.
2. Check the cost side against `events.jsonl` (don't trust the hardcoded
   per-image constant — see the gap above).
3. Remember the gate must be able to *predict* the size cheaply; content-dependent
   geometry is what got width-shrink reverted.
