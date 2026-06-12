# Glyph confusion matrix + render-style A/B (Task #7) — PLANNED, paused for usage budget

**Status:** paused 2026-06-12 at 05:45am · resume after weekly limit reset (Jun 18 ~5:59pm Toronto)
**Working state:** `~/glyphmx-paused/` (canonical backup, 330 files, 21MB) · scratch `/tmp/glyphmx` · resume via `run.sh` (limit-aware, skips banked trials)
**Detailed handoff:** `HANDOFF.md` (repo root)

## What this measures

Per-character confusion matrix for 12-char hex IDs read back through the
pixelpipe render path, across render-style arms — the precision-tier
failure mode that gist-recall (98/98) structurally cannot surface and
needle-haystack only bracketed (~87% exact-match on worst-case hex at
prod style).

- **40 trials/arm × 5 arms** (prod 500px baseline + style A/B first pass: onebit, color, grid, + winner expansion to 30 later)
- Each trial: 1 page, ~222 image tokens, 40 dense JSON lines, 5 labeled 12-char hex IDs (LCG-seeded, seed 20260612) + 8-hex distractors
- Reader: `claude-fable-5` only (production gate model), direct API route
- Grading: exact-hit rate per trial (12/12 chars), per-char confusion matrix, pooled misses; hard-fails on empty/poisoned output graded as misses

## Banked so far

- 2/40 prod-arm trials valid (`out_prod_0.txt`, `out_prod_1.txt` in `~/glyphmx-paused/`), not poisoned; run halted on session limit (`HALTED-ON-LIMIT` in `run.log`)
- All 120 rendered pages for the first pass are pre-rendered and backed up — resume only spends read calls, not render work

## Why it's not in README yet

README rule for this repo: measured numbers + n only, no marketing tone.
This experiment ships to README **after** the matrix completes — as
"at render style X, content carries at ~N× fewer input tokens with
measured per-character read error E% on worst-case zero-redundancy
content." Until then it lives here so the plan is public without an
unearned headline.

## Decision criteria (when trials finish)

1. Per-arm exact-hit rate (5 labels vs golds), per-char confusion on misses, which hex glyph pairs confuse (0↔8, e↔4, e↔8, f/t suspects).
2. If any zero-cost style beats prod meaningfully (and prod ≈ known ~87%), recommend flipping default in `src/core/render.ts` (e.g. `DENSE_RENDER_STYLE` gains `colorCycle:true`) — token-cost-neutral, but re-run harness to confirm before changing defaults.
3. Update README verbatim row + FINDINGS.md dated entry; copy receipts (`golds.json`, outs, `grade.py`) into `eval/glyph-matrix/` and commit.

## Related field evidence

See FINDINGS.md "Update (2026-06-12) — field observation": an n=1
in-the-wild session captured 7/10 exact / ~3.3% per-char misreads on the
same confusion classes (0→8, e→4/8), 2 of 3 misses silent. Anecdotal,
non-reproducible — motivation only; this harness is what produces the
publishable numbers.
