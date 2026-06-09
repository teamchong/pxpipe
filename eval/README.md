# Reflow Eval Harness

Evaluation harness for the **reflow** image-rendering mode in pxpipe.

Reflow re-packs text densely and marks original newlines with the ↵ glyph
(U+21B5) before rendering to PNG. It reduces image count by ~30–50% on typical
Claude Code history. This harness verifies that the model still **understands**
reflowed text — telemetry measures tokens/bytes, not comprehension.

---

## Prerequisites

```bash
# Build the compiled dist/ output (required by the eval scripts)
pnpm run build

# Extract corpus from your local Claude conversations
node eval/extract-corpus.mjs
```

The corpus is written to `eval/corpus/`:
- `text-blocks.json` — text blocks for L1 OCR eval (~20 by default)
- `sessions.json`    — conversation sessions for L2 session replay (~10 by default)

---

## L0 — Unit Tests (reference only)

L0 is a vitest unit test file (`tests/render.test.ts` plus a forthcoming
`tests/reflow.test.ts` owned by the core team). It tests the `reflow` /
`dereflow` / `renderTextToPngsReflow` functions in isolation.

```bash
# Run all unit tests including L0
pnpm test
```

L0 does not require an API key and runs in CI. It verifies:
- `dereflow(reflow(t)) === minifyForRender(t)` for all `t`
- Sentinel collision fallback
- Image dimensions and chunk counts

---

## L1 — OCR Fidelity

Renders text blocks to PNG **two ways** (baseline and reflow), sends each image
set to the Anthropic API asking for verbatim transcription, then diffs the
result against the source using character-level Levenshtein edit distance.

The reflow system prompt includes: *"↵ denotes a line break"*.

### Dry run (no API key, no cost)

```bash
node eval/eval-l1-ocr.mjs --dry-run
# or via orchestrator:
node eval/run-eval.mjs --level 1 --dry-run
```

### Cost estimate only

```bash
node eval/run-eval.mjs --estimate-only
```

### Real run

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node eval/eval-l1-ocr.mjs --confirm
# or:
node eval/run-eval.mjs --level 1 --confirm
```

### Estimated cost (L1 only, 20 blocks, claude-sonnet-4-5)

| Item | Estimate |
|------|---------|
| API calls | 40 (2 per block × 20 blocks) |
| Input tokens | ~70,000–90,000 (dominated by image tiles) |
| Output tokens | ~10,000–20,000 (transcriptions) |
| **USD** | **~$0.50–$1.00** |

The actual cost depends on rendered image sizes. Most blocks produce 1–2 PNGs,
costing ~1,600 tokens per image tile at Sonnet pricing.

### Output

- `eval/results/l1-report.md` — markdown report with per-block scores
- `eval/results/l1-results.json` — raw JSON for programmatic use

### Interpreting L1 results

| Metric | Threshold | Meaning |
|--------|-----------|---------|
| Mean char accuracy delta | ≥ −2pp | Acceptable; within noise |
| Mean char accuracy delta | < −5pp | Reflow OCR materially worse |
| Macro accuracy (reflow) | ≥ 95% | High overall character fidelity |
| Image count savings | 30–50% | Expected typical range |

A negative delta means reflow is slightly less accurate. Up to −2pp is
acceptable because: (a) the reflow system prompt compensates for ↵ rendering,
(b) real accuracy is bounded by the model's vision encoder, not the sentinel.

---

## L2 — Task-level A/B Session Replay

**This is the real gate.** Extracts real conversation sessions from
`~/.claude/projects/**/*.jsonl`, renders the history both ways, asks the
model to produce the next turn in the conversation, then uses a model-judge
to score whether the reflow-history answer is as good as the baseline.

### Dry run

```bash
node eval/eval-l2-session.mjs --dry-run
# or:
node eval/run-eval.mjs --level 2 --dry-run
```

### Real run

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node eval/eval-l2-session.mjs --confirm
# or full pipeline:
node eval/run-eval.mjs --level all --confirm
```

### Estimated cost (L2 only, 10 sessions, claude-sonnet-4-5)

| Item | Estimate |
|------|---------|
| API calls | 30 (2 replay + 1 judge per session × 10) |
| Input tokens | ~200,000–400,000 (history images are large) |
| Output tokens | ~10,000–30,000 |
| **USD** | **~$1.50–$4.00** |

History rendering dominates: each session history is 2,000–8,000 chars → 1–5
images → 1,600–8,000 input tokens per image call. Use `--max-sessions` to
control scope.

### Full run cost (L1 + L2, 20 blocks + 10 sessions)

**~$2.00–$5.00 USD** with claude-sonnet-4-5.

Use `--model claude-haiku-4-5` to reduce cost by ~4× at some accuracy trade-off.

### Output

- `eval/results/l2-report.md` — markdown report with per-session judge scores
- `eval/results/l2-results.json` — raw JSON
- `eval/results/summary.md` — combined summary with shipping gate checklist

### Interpreting L2 results

| Metric | Threshold | Action |
|--------|-----------|--------|
| Mean judge score | ≥ 0.80 | ✅ Ship reflow |
| Mean judge score | 0.65–0.79 | ⚠️ Investigate failing sessions |
| Mean judge score | < 0.65 | ❌ Do not ship reflow |
| Pass rate (≥ 0.75) | ≥ 80% | ✅ Consistent quality |
| Pass rate | 60–79% | ⚠️ Some sessions fail |
| Pass rate | < 60% | ❌ Widespread comprehension loss |

The judge uses this scoring rubric:
- **1.0** — semantically equivalent to baseline
- **0.8** — mostly equivalent, minor differences
- **0.6** — partially equivalent, some content missing
- **0.4** — substantially worse
- **0.2** — mostly unrelated
- **0.0** — completely wrong

---

## Full Pipeline

```bash
# 1. Build dist/
pnpm run build

# 2. Extract corpus (writes eval/corpus/)
node eval/extract-corpus.mjs --max-blocks 20 --max-sessions 10

# 3. Cost estimate
node eval/run-eval.mjs --estimate-only

# 4. Dry run (verify end-to-end without spend)
node eval/run-eval.mjs --dry-run

# 5. Real run (requires API key + explicit --confirm)
export ANTHROPIC_API_KEY=sk-ant-...
node eval/run-eval.mjs --confirm

# 6. View results
cat eval/results/summary.md
```

---

## Options Reference

### `extract-corpus.mjs`

| Flag | Default | Description |
|------|---------|-------------|
| `--max-blocks N` | 20 | Max text blocks for L1 |
| `--max-sessions N` | 10 | Max sessions for L2 |
| `--out-dir DIR` | eval/corpus | Output directory |
| `--projects-dir DIR` | `~/.claude/projects` | Claude projects directory |
| `--verbose` | false | Verbose progress |

### `eval-l1-ocr.mjs` / `eval-l2-session.mjs` / `run-eval.mjs`

| Flag | Default | Description |
|------|---------|-------------|
| `--dry-run` | false | No API calls; fake scores |
| `--confirm` | false | Required for real API spend |
| `--max-blocks N` | 20 | L1 block count |
| `--max-sessions N` | 10 | L2 session count |
| `--model NAME` | claude-sonnet-4-5 | Replay + transcription model |
| `--judge-model NAME` | (same as model) | L2 judge model |
| `--corpus-dir DIR` | eval/corpus | Corpus input directory |
| `--out-dir DIR` | eval/results | Results output directory |
| `--estimate-only` | false | Print cost estimate and exit |
| `--skip-extract` | false | Skip corpus extraction step |
| `--level 1\|2\|all` | all | Which levels to run (run-eval only) |
| `--verbose` | false | Verbose per-block/session output |

---

## File Layout

```
eval/
├── README.md                 ← this file
├── extract-corpus.mjs        ← corpus extraction from ~/.claude/projects
├── eval-l1-ocr.mjs           ← L1 OCR fidelity eval
├── eval-l2-session.mjs       ← L2 session replay eval
├── run-eval.mjs              ← top-level orchestrator
├── lib/
│   ├── anthropic-client.mjs  ← minimal Anthropic API client (fetch-based)
│   ├── cost.mjs              ← token/USD cost estimator
│   ├── diff.mjs              ← Levenshtein + character accuracy scorer
│   └── render-bridge.mjs     ← imports render functions from dist/
├── corpus/                   ← generated by extract-corpus.mjs
│   ├── text-blocks.json
│   └── sessions.json
└── results/                  ← generated by eval runs
    ├── l1-report.md
    ├── l1-results.json
    ├── l2-report.md
    ├── l2-results.json
    └── summary.md
```

---

## Notes

- The eval imports from `dist/core/render.js`. Run `pnpm run build` first.
- No extra npm packages are required. The Anthropic client uses Node's built-in `fetch`.
- Dry-run mode simulates ~3% OCR error rate to produce non-trivial diff scores.
- The corpus extractor gracefully falls back to a synthetic corpus when
  `~/.claude/projects` is empty or absent.
- `.claude/` is globally gitignored — corpus and results are in `eval/` and
  should be added to `.gitignore` if you don't want to commit them.
