# Opus 4.8 lower-density read sweep — results (answers issue #6)

Live run of `run.mjs`, 2026-07-05. `results.json` is this run. Two harness bugs
found and fixed along the way (see below), so fixes and numbers are reported together.

## Issue #6: Opus vs density

Exact-string recall on the production renderer, one run per cell:

| variant | page px | img tok | savings | Opus exact | Opus confab | gist | guard |
|---------|---------|--------:|--------:|:----------:|:-----------:|:----:|:-----:|
| `5x8` (production) | 1568×128 | 280 | 79% | 1/4 | 3 | ok | ok |
| `7x10`            | 1562×228 | 504 | 62% | 3/4 | 1 | ok | ok |
| `9x12`            | 1565×344 | 728 | 45% | **4/4** | **0** | ok | ok |

- **Answer: yes, density-dependent.** `9x12` clears the acceptance bar in
  `README.md` — 4/4 exact, 0 confabulations, byte-exact hex, gist == baseline,
  savings positive (45%), `stop_reason: end_turn`. Production `5x8` confabulates
  3/4 exact strings.
- Monotonic and stable across three runs. Candidate: an opt-in lower-density Opus
  render profile at `9x12` (~1.75× the image tokens of `5x8`); **not** a
  `DEFAULT_MODEL_BASES` change.
- n=1 per cell (harness design). An independent sweep with a TrueType mono font and
  Levenshtein-graded probes reproduces the same monotonic cliff — byte-exact recall
  at low density, collapse as density rises.

## Bugs fixed in `run.mjs` (neither involves images)

| # | Symptom before fix | Root cause | Fix |
|---|--------------------|-----------|-----|
| 1 (dominant) | every Fable answer, correct ones included, scored miss/confab (`Fable 0/4`) | reads `content[0].text`; on always-on-thinking models `content[0]` is a thinking block with empty text, answer is in a later block | select the `text` block; `max_tokens` 128 → 512 |
| 2 | refusals scored as confabulations (`5 confab`, `guard FAIL`) | `score()` ignored `stop_reason`; a refusal (HTTP 200, `stop_reason:"refusal"`, empty content) is neither the expected string nor an abstention | branch on refusal as its own state; a refused guard is safe |

Bug 2 inverts the harness's safety verdict: a refusal is the *safe* no-answer, a
confabulation the *dangerous* one. After both fixes Fable shows **0 confabulations**
at every density. Confound-free receipt for bug 1 (`verify.mjs`, benign prompt):

```
[bug2] fable, benign prose, stop=end_turn
       [0]thinking=""  [1]text="33"
       OLD content[0].text=""   FIXED text-block="33"
```

## Caveat: the guard question, not the rendering, drives Fable's refusals

The never-stated **password** guard trips Fable's `cyber` classifier at the same
rate on text and image — modality-independent, so not an imaging effect
(`verify.mjs`, n=6):

| guard context | Fable refusals |
|---------------|:--------------:|
| text          | 6/6 |
| image         | 6/6 |
| no context    | 1/6 |

Consequences: the guard is unmeasurable on Fable as written, and this is **not**
evidence that rendering exposes Fable to refusals. Suggest a non-credential
never-stated guard (e.g. "what was the reviewer's middle name?").

## Reproduce

```bash
pnpm run build
ANTHROPIC_API_KEY=sk-ant-... pnpm exec tsx eval/opus-density/run.mjs      # -> results.json
ANTHROPIC_API_KEY=sk-ant-... pnpm exec tsx eval/opus-density/verify.mjs   # bug-1 + guard receipts
```
