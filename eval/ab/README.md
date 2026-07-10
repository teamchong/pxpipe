# A/B Test Harness for pxpipe Quick Wins (QW01–QW10)

Comprehensive evaluation framework for systematic per-QW testing of pxpipe features.

## Overview

- **14 variants** (A0, A1, B01–B10 + B-all)
- **≥3 runs** per variant in fresh child processes
- **Environment flag API**: `PXPIPE_QWxx` (`1`/`true` = ON, else OFF)
- **QW07 cache control**: cold (clean per run) vs warm (reuse across runs)
- **Shipping gates**: exact-ID, OCR fidelity, tool-call schema
- **Dry-run support**: full pipeline on stub (no LLM calls)

## Variant Matrix

| Variant | QW Status | Notes |
|---------|-----------|-------|
| **A0-bypass** | — | `PXPIPE_DISABLE=1` (passthrough, no proxy) |
| **A1-baseline** | All OFF | Baseline (all QWxx=0) |
| **B01–B05, B08–B10** | Single ON | Individual QW isolation |
| **B06** | QW02+QW06 ON | Per debata werdykt (exception) |
| **B07-cold** | QW07 ON | Cache cleaned before each run |
| **B07-warm** | QW07 ON | Cache reused across 3 runs (warm) |
| **B-all-on** | All ON | All QW01–QW10 enabled |

## CLI Contract

### Main Orchestrator
```bash
node eval/run-eval-ab.mjs [--dry-run] [--confirm] [--corpus-frozen] [options]
```

**Flags:**
- `--dry-run` — Stub eval (no API calls, mock results)
- `--confirm` — Confirm real API spend (required for live runs)
- `--corpus-frozen` — Use frozen corpus (`eval/corpus-frozen/`) instead of extracting
- `--variants V1,V2,…` — Run only specific variants (comma-separated names)
- `--runs N` — Repetitions per variant (default: 3)
- `--max-blocks N` — Limit blocks to evaluate (default: 0 = all)
- `--model NAME` — Anthropic model (default: `claude-sonnet-4-5`)
- `--verbose` — Verbose logging

**Examples:**
```bash
# Dry run (no cost)
node eval/run-eval-ab.mjs --dry-run --corpus-frozen

# Real run (requires --confirm, uses frozen corpus)
node eval/run-eval-ab.mjs --confirm --corpus-frozen --runs 3

# Test specific variants only
node eval/run-eval-ab.mjs --dry-run --variants A1-baseline,B07-qw07-cold
```

### Steps

1. **Step 1: Corpus extraction** — Extracts or uses frozen corpus
2. **Step 2: A/B variants** — Spawns runner for all variants
3. **Step 3: Shipping gates** — Applies pass/fail criteria

### Runner (Lower-level)
```bash
node eval/ab/runner.mjs [--dry-run] [--corpus-frozen] [options]
```

Spawns `eval-l1-ocr.mjs` as child process for each variant × run combination.
Environment variables (from `variants.mjs`) are passed to each child process.

### Gates (Lower-level)
```bash
node eval/ab/gates.mjs [--results-file FILE] [--self-test] [--verbose]
```

Reads `eval/ab/results/ab-combined.json` and applies shipping gates.
Output: `eval/ab/results/ab-gates-verdict.json`

**Flags:**
- `--results-file FILE` — Path to ab-combined.json (default: eval/ab/results/ab-combined.json)
- `--self-test` — Run validation against synthetic fixtures (eval/ab/fixtures/); exit 0 on pass, 1 on fail
- `--verbose` — Detailed gate evaluation logs

## Environment Variable API

QW flags are read from process.env at **render time** (src/core/qw-flags.ts):

| Variable | Values | Default |
|----------|--------|---------|
| `PXPIPE_QW01` | `'1'`, `'true'` | `false` |
| `PXPIPE_QW02` | `'1'`, `'true'` | `false` |
| … | … | … |
| `PXPIPE_QW10` | `'1'`, `'true'` | `false` |

Case-insensitive; invalid values → warning + false (non-blocking).

**Special markers (runner only):**
- `_CACHE_MODE: 'cold'` — Clean `eval/ab/.cache/` before each run
- `_CACHE_MODE: 'warm'` — Reuse cache across runs (default for QW07-warm)

## Output Structure

```
eval/ab/results/
  A0-bypass-run.json         # per-variant results (3 runs)
  A0-bypass-gates.json       # per-variant gate verdict
  A1-baseline-run.json
  A1-baseline-gates.json
  B01-qw01-run.json
  …
  ab-combined.json           # all results aggregated
  ab-gates-verdict.json      # final gate summary
```

**Result file structure:**
```json
{
  "variant": "B01-qw01",
  "numRuns": 3,
  "dryRun": false,
  "timestamp": "2026-07-10T12:00:00.000Z",
  "runs": [
    {
      "variant": "B01-qw01",
      "runIndex": 0,
      "baselineAgg": { "meanAccuracy": 0.94, "macroAccuracy": 0.95 },
      "reflowAgg": { "meanAccuracy": 0.93, "macroAccuracy": 0.94 },
      "imageSavingsPct": 32.1,
      "status": "ok"
    },
    …
  ]
}
```

**Gate verdict structure:**
```json
{
  "timestamp": "…",
  "dryRun": false,
  "summary": {
    "totalVariants": 14,
    "passCount": 12,
    "failCount": 2
  },
  "passing": ["A0-bypass", "A1-baseline", …],
  "failing": ["B05-qw05", …],
  "allGates": [
    {
      "variantName": "B01-qw01",
      "pass": true,
      "gates": {
        "exactId": { "pass": true, "reason": "…" },
        "ocrFidelity": { "pass": true, "reason": "…" },
        "toolCallSchema": { "pass": true, "reason": "…" }
      }
    },
    …
  ]
}
```

## Shipping Gates (Updated Implementation)

Three gates applied to each variant:

### (a) Exact-ID / Negations
- **Logic:** variant must achieve 100% identity match OR deterministic negation
- **Data source:** `result.exactId.pass` (boolean) + `result.exactId.negationMatch` (boolean)
- **Verdict:** PASS if (pass=true AND negationMatch=false) OR (pass=true AND negationMatch=true); otherwise FAIL
- **Non-blocking:** Gate passes if `exactId` field is absent (data not yet collected in L1)

### (b) OCR Fidelity
- **Logic:** variant.reflowAgg.meanAccuracy ≥ (baseline.meanAccuracy - 0.02)
- **Data source:** `result.reflowAgg.meanAccuracy` (per-variant) vs A1-baseline aggregate (baselineAgg)
- **Threshold:** −2pp tolerance (delta must be ≥ −2pp to pass)
- **Verdict:** PASS if within threshold; FAIL if below threshold by >2pp
- **Non-blocking:** Gate passes if baselineAgg is absent or reflowAgg field missing (A1-baseline reference or variant data not available)

### (c) Tool-call Schema
- **Logic:** variant must have native tool-call structure valid
- **Data source:** `result.toolCallSchema.nativeCorrect` (boolean)
- **Verdict:** PASS if nativeCorrect=true; FAIL if false
- **Non-blocking:** Gate passes if `toolCallSchema` field is absent (data not yet collected in L1)

**Gate verdict:** ALL three gates must pass for variant to ship. Non-blocking gates on absent data default to PASS.

### Self-Test

```bash
node eval/ab/gates.mjs --self-test --verbose
```

Loads synthetic fixtures from `eval/ab/fixtures/` and validates gate logic:
- **pass-case.json** — All gates pass (A1-baseline, B01-qw01)
- **fail-case-exact-id.json** — Exact-ID gate fails (B02-qw02 mismatch)
- **fail-case-ocr-regression.json** — OCR gate fails (B03-qw03 > −2pp regression)

Exit: 0 on all fixtures pass, 1 on any fixture fail.

## Dry-Run Testing

```bash
node eval/run-eval-ab.mjs --dry-run --corpus-frozen --runs 1
```

- **No API calls** — All LLM scores are mocked
- **No cost** — Safe for testing harness logic
- **Full pipeline** — All steps (extract, runner, gates) execute

Mock results per run: `meanAccuracy: 0.945`, `macroAccuracy: 0.955`, `imageSavingsPct: 35.2`

## Design Notes

### Isolation
- Each run is a **fresh child process** with isolated environment
- QW07 cache management via `_CACHE_MODE` marker + `eval/ab/.cache/` directory

### Extensibility
- Variants defined in `eval/ab/variants.mjs` (data-driven)
- Gates logic in `eval/ab/gates.mjs` (stub implementations)
- Runner in `eval/ab/runner.mjs` (orchestrator for child processes)

### Convergence with run-eval.mjs
- `run-eval-ab.mjs` wraps the A/B harness; can run alongside L0/L1/L2
- Frozen corpus (`eval/corpus-frozen/`) avoids extraction overhead in repeated runs
- Long-term: A/B results feed into broader eval dashboard

## Known Limitations (W2b Snapshot)

1. ~~**Data gap (runner.mjs)**~~ **CLOSED:** runner.mjs now parses the child's `l1-results.json` and surfaces `baselineAgg`, `reflowAgg` (prefers `reflow-inimage`, falls back to `reflow`; see `l1ReflowVariant`) and `imageSavingsPct` into each per-run result in ab-combined.json. Raw L1 outputs are archived as `<variant>-run<N>-l1.json` / `-l1-report.md` so runs don't overwrite each other. Gate (b) OCR fidelity now runs on real L1 data. Zero-cost pipeline check: `node eval/ab/runner.mjs --l1-dry-run ...` (child gets `--dry-run`: full render+plumbing, simulated scores, no API spend — accuracy numbers are then meaningless; only real `--confirm` runs are decision-grade).
2. **Exact-ID & tool-call schema:** No L1 implementation yet — `exactId`/`toolCallSchema` fields are still absent from per-run results (they come from the L2 session eval, not L1 OCR). Gates (a)/(c) remain non-blocking (pass on absent fields).
3. **Dry-run:** A0-bypass mock produces only `{ baselineAgg, reflowAgg, imageSavingsPct }`. A1-baseline reference missing, so gate (b) evaluates as non-blocking PASS.

## Next Steps (Future)

- **Runner data integration** — Surface L1 scores into ab-combined.json (runner.mjs fix)
- **Exact-ID implementation** — Add exact-ID validation to L1 harness
- **Tool-call schema validation** — Add native tool-call verification to L1
- **Results dashboard** — Aggregate 14 variants, render heatmap (QW vs metric)
- **Threshold tuning** — Calibrate OCR fidelity gates based on observed variance
