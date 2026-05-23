# Packed-reflow legibility experiments

Baseline measurement (Opus 4.7, 20 blocks, 5×8 cell, 1-bit atlas):
- **no-reflow baseline:** 97.64% mean / 98.10% median / 87.75% min
- **packed reflow, ↵ fully inline (production at 050b306):** 90.91% mean / 94.20% median / **59.65% min** (Δ = −6.73pp)

Worst blocks at production:
- Block 2 (228 char bash code fence) → 59.6%
- Block 5 (315 char markdown options list) → 79.4%

Common shape: content uses blank lines as semantic dividers (code fences, list items, section breaks).

## Attempt #1 — break the visual row on ↵↵, keep single ↵ inline

**Hypothesis:** the ↵ glyph reads as a regular character in dense text, so the model loses the
section-divider signal that blank lines were carrying in the source. Promoting ↵↵ to a
hard row break restores the section visually without giving up dense packing of prose.

**Change:** 6 lines in `src/core/render.ts::wrapLines` — track `lastWasSentinel`, on the
second consecutive ↵ end the current visual row and consume the second sentinel.

**Tests:** 315/315 green, build clean.

**Result:** _(pending — running)_

**Result:** 94.93% mean (Δ = −2.93pp), savings 0% — recovered ~4pp vs production, did NOT close the gap.

Per-block: catastrophic blocks gone (no block below 86%). Remaining damage is broad — 6 of 20 blocks drop 5-11pp. Failing blocks all have many `\n` per char (markdown lists, code with internal newlines). The ↵↵→row-break fix only helps content with blank-line separators; list-shaped content (`- a\n- b\n- c`) still has many inline ↵ glyphs.

**Verdict:** improvement is real but not shippable. Reverted in working tree.

---

## Attempt #2 — render the instruction *inside* the image

**Hypothesis:** when the OCR instruction sits in the `system` field and
the text sits in `user.content[].image`, the model is doing cross-modal
binding to figure out what the image is *for*. Co-rendering the
instruction into the same PNG, separated from the content by a clear
delimiter band, makes it a single-modal task.

**Change:** added a `reflow-inimage` variant to `eval/eval-L1-ocr.mjs`.
Same packed reflow as `reflow`, but the prompt body has the OCR
instruction as a header band rendered into the PNG with `===…===`
delimiters, and the API `system` field is dropped (the user message is
just `Transcribe.` plus the image).

**Result (Opus 4.7, 20 blocks, 7×10 cell):**
- `baseline` (text-only):           **97.91%** mean / 96.25% min
- `reflow` (separate `system`):     91.99% mean / 82.59% min   (Δ = −5.93pp)
- **`reflow-inimage`:**             **98.95%** mean / 96.42% min (Δ = **+1.04pp**)

Per-block: `reflow-inimage` wins on **every one of 20 blocks** vs `reflow`,
and beats baseline on **17 of 20 blocks**. Three blocks hit 100%. The
−5.93pp reflow regression that cell-pitch + section-break could only
partially recover disappears entirely.

**Verdict:** decisive at the OCR layer. The mechanism (single-modal vs
cross-modal task framing) is consistent with the per-block scatter
collapsing — no fluky outliers, just a uniform shift up. The production
lift depends on whether the same effect carries from OCR (transcription)
to comprehension (tool-use, code reasoning), which the L2 session-replay
eval can answer with the same wiring.
