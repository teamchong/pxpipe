# Per-glyph resolution sweep — why Opus misreads pxpipe renders

Isolates **one** variable — pixels-per-glyph (render cell size) — to find the
root cause of Opus 4.8's read tax on dense renders. See the dated entry in
[`/FINDINGS.md`](../../../FINDINGS.md) (2026-06-16, later) for full analysis.

## Result (Opus 4.8, n=20 ids/size)

| glyph cell | rel. area | Opus exact-read |
|---|---|---|
| 5×8 (production) | 1× | 10% |
| 7×10 | 1.75× | 35% |
| 10×16 | 4× | 95% |
| 14×22 | 7.7× | 95% |
| 20×32 | 16× | 100% |

Accuracy is a monotonic function of pixels-per-glyph (knee at ~10×16 ≈ 4× area).
Per-char confusions are broad at 5×8 and vanish by 10×16 → the cause is
**resolution (glyphs-per-encoder-patch), not font shape**. Because Opus needs
~4× the glyph area to read reliably, and the 1568px ceiling locks
pixels-per-glyph to chars-per-image, pxpipe's ~74% compression inverts to
break-even on Opus. Fable reads at 5×8 — the size where imaging is profitable.

## Method / controls

- **No zoom:** reader runs with `--disallowedTools Bash` so it must read by eye
  (an earlier pass cheated by upscaling via code).
- **No downscale:** rendered at `cols=72` so even the 20×32 cell stays <1568px
  wide; Anthropic downscales anything wider, which would silently undo the size.
- **Same content** rendered at every cell size (only resolution varies).
- **Two metrics:** per-label (right id under right label) and bag-of-ids (gold
  id anywhere) — they match at every size, so it's reading, not localization.

## Reproduce

```bash
pnpm run build                                   # render imports ../../../dist
node eval/glyph-matrix/sweep/gen_sweep.mjs        # -> /tmp/sweep/*.png + golds.json
MODEL=claude-opus-4-8 TAG=opus bash eval/glyph-matrix/sweep/run_sweep.sh
python3 eval/glyph-matrix/sweep/grade_sweep.py opus
```

Needs the `claude` CLI (Max plan). `out_opus_*.txt` are the raw model
transcriptions banked from the run graded in `results-opus.txt`. The Fable arm
is blocked while Fable 5 access is unavailable.
