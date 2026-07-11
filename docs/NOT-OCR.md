# Not OCR: how models read renders, and why that changed with Fable 5

Two objections come up repeatedly:

1. "It read the whole page fine, then recalled one hash wrong. Is the
   render broken?"
2. "People cite DeepSeek-OCR to say optical context compression does not
   hold up in practice. Why does this repo claim otherwise?"

Both trace back to the same two facts: model vision is not OCR, and
reading ability jumped a full model generation between that discourse and
the default reader here. Receipts for every number below live in
[`FINDINGS.md`](../FINDINGS.md) and [`eval/`](../eval/).

## How a vision-language model reads an image

An OCR engine (Tesseract-style) segments the image into glyphs, classifies
each glyph against a symbol set, and emits characters with per-character
confidence. It can localize a failure and answer "unreadable".

A VLM has none of those stages:

1. The image is cut into a fixed grid of patches.
2. Each patch is projected into one continuous embedding. This is why
   image token cost is a function of pixel dimensions, not of how much
   text is inside: tokens = patches. Dense text therefore carries more
   information per token, which is the entire margin this proxy runs on.
3. The language model attends over those patch embeddings the same way it
   attends over text tokens. "Reading" is the decoder reconstructing what
   the embeddings suggest, blended with its language prior.

No character is ever materialized as a discrete symbol anywhere in that
stack. There is no per-glyph confidence, so there is nothing to fail
loudly on. The model cannot report "that pixel cluster was ambiguous" any
more than you can report which photoreceptor misfired when you misread a
word.

## What that mechanism predicts (and what was measured)

Every failure signature in this repo's evals follows from "the prior fills
the gap":

- **Prose survives density; identifiers corrupt.** The language prior
  repairs low-entropy text (you also read "jumbled wrods" fine) and has
  zero signal on a hex string. Measured: gist recall 98/98 per arm; exact
  12-char hex 13/15 on Fable 5 vs 0/15 on Opus 4.8, same dense pages.
- **Misses are plausible, never garbled.** The Opus semantic-needle run
  (FINDINGS.md Appendix B) hit 6/15, and every hit was a round number a
  prior would guess; misses drifted to other plausible round numbers. The
  one field failure in weeks of daily use was a confidently wrong name,
  not an error.
- **Accuracy falls smoothly with pixels-per-glyph.** No readable/unreadable
  cliff, exactly what a lossy feature map predicts and what the resolution
  sweep measured (Opus 4.8, n=20 ids/size):

  | glyph cell | rel. area | exact read |
  |---|---:|---:|
  | 5×8 (production) | 1x | 10% |
  | 7×10 | 1.75x | 35% |
  | 10×16 | 4x | 95% |
  | 20×32 | 16x | 100% |

- **Blind reads miss where glyphs collide.** The
  [legibility audit](LEGIBILITY-AUDIT-2026-07-01.md) topped out at 63% on
  dense identifiers, with every miss predicted by a glyph-confusability
  matrix (0/8, e/4 class confusions).
- **Symbolic encodings are a dead end.** "Render hashes as QR codes or
  braille" requires exactly the discrete decoding step this stack does not
  have. Barcodes need a decoder; there is only a prior.

## The capacity bound (why rendering tricks are parked)

Accuracy monotonic in pixels-per-glyph, plus the API resample ceiling
(larger pages are downscaled before the encoder sees them), means any
density above the encoder's transcription capacity carries a guaranteed
error floor. Errors can be relocated onto prior-repairable content,
detected and re-fetched, or paid for. They cannot be eliminated by font,
color, or layout at the same density. The proposal-by-proposal breakdown
(patch-grid alignment, RGB multiplexing, QR encoding, chromatic fringing)
is in FINDINGS.md, 2026-07-05 entry.

## DeepSeek-OCR: what it proved, and what it could not

DeepSeek-OCR ("Contexts Optical Compression", October 2025) trained a
dedicated optical encoder (~380M) with a ~3B decoder and reported ~97%
decoding precision below 10x compression, degrading toward ~60% near 20x.

Read carefully, that paper is evidence **for** the channel: text-as-pixels
carries at high fidelity when the reader can read. What it could not show
is a stock production model doing the reading, because in October 2025
none could. The skepticism it spawned ("optical compression does not work
in practice") was a correct observation about that generation of
general-purpose models, applied past its expiry date.

This repo measured the expiry. Same harnesses, both models:

| measurement | Opus 4.8 | Fable 5 |
|---|---:|---:|
| novel arithmetic over imaged context (N=100) | 93% | 100% |
| verbatim 12-char hex, dense render (n=15) | 0/15 | 13/15 |
| 5×8 production glyph cell | 10% exact; needs ~4x area for 95% | reads it (the 13/15 row) |
| status in pxpipe | opt-in (misreads ~7% of renders) | default reader |

One vendor generation moved the readable-density knee ~4x in glyph area.
That is the whole story behind objection 2: the capability crossed the
profitability threshold after the discourse formed, and pxpipe simply
ships on the far side of it. It is also why Opus stays opt-in and why the
README reports per-model numbers instead of one blended claim.

## The forward bet

Computer use already ships models reading screenshots to operate
software, so text-from-pixels is a first-party, supported use of the
channel. pxpipe runs the same channel at far higher text density than a
UI screenshot, and the capacity bound above is the cost of that density.

The trajectory that made this possible is the one being ridden now. On
each model release, one sweep re-run reports where the new knee sits
(~20 cheap calls):

    MODEL=<id> TAG=<tag> bash eval/glyph-matrix/sweep/run_sweep.sh

A model that reads 5×8 cells near 100% means density, and the savings with
it, rise for free. A provider that ships native optical context
compression supersedes this repo, which would be a fine outcome. Either
way the constraint improves without another line of rendering code here.
