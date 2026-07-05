# Opus 4.8 lower-density / larger-cell read sweep

**Question (issue #6):** the known Opus misread rate on pxpipe images was measured
at the production **5×8** cell density. If the same text is rendered *less dense*
(bigger cells → fewer chars/page → more pages), does Opus 4.8 read exact strings
reliably enough to be worth enabling — and at what token cost?

This harness answers that with a measurement, **not** a default change. It does
not touch production code or the model allowlist. Fable 5 stays the only default
reader unless the numbers below clear the acceptance bar.

## What it does

For each render **variant** (cell size) it renders one synthetic "session"
transcript to PNG(s) via the production renderer, then asks each **model** a
fixed battery of questions against the image and scores the answers.

- **Variants** (cell = 5+wBonus × 8+hBonus px, all via `RenderStyle`):
  - `5x8` — production density (`{cellWBonus:0, cellHBonus:0}`)
  - `7x10` — `{cellWBonus:2, cellHBonus:2}`
  - `9x12` — `{cellWBonus:4, cellHBonus:4}`
  Each variant keeps the ≤1568×728 page cap, so images stay in Anthropic's
  linear-billing window (no server-side downscale) and page count rises as
  density drops.
- **Models:** `claude-opus-4-8`, `claude-fable-5` (both high-res tier).
- **Tasks** (each answer committed before ground truth is revealed):
  1. exact 12-char hex recall
  2. camelCase identifier recall
  3. file path / CLI flag / number recall
  4. gist recall (a decision / value / state that survives lossy reads)
  5. never-stated-fact guard — the correct answer is "not stated / UNKNOWN"

## Metrics (per model × variant)

- exact-match accuracy (tasks 1–3)
- **confabulation count** — a confident *wrong* exact string (the dangerous mode)
- abstain / "not safe to quote" count
- gist accuracy (task 4) and false-answer rate on the guard (task 5)
- image tokens (28-px patch count), text-baseline tokens, and savings %
- rough wall-clock latency

## Acceptance — do NOT claim "Opus works" unless, for a variant:

- gist recall == the text baseline (or within a pre-declared tolerance), AND
- every exact-identifier question is either answered correctly OR abstains /
  refers to the factsheet — **zero silent wrong exact strings** on the protected
  exact tasks, AND
- token savings stay positive on token-dense Claude-Code-like content.

Only a variant that clears all three is a candidate for an opt-in Opus render
profile. Enabling Opus in `DEFAULT_MODEL_BASES` is explicitly out of scope until
then.

## Run

```bash
# Dry run — renders every variant and prints the token/savings accounting.
# No API key needed; no model is called.
pnpm exec tsx eval/opus-density/run.mjs

# Full run — also calls the models and scores the battery.
ANTHROPIC_API_KEY=sk-ant-... pnpm exec tsx eval/opus-density/run.mjs
```

Results are written to `eval/opus-density/results.json`. This directory holds no
committed results yet — it is the harness only; fill it in on a machine with API
access.
