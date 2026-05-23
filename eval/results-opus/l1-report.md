# L1 OCR Fidelity Report

**Generated:** 2026-05-22T03:36:29.045Z  
**Model:** opus  
**Dry run:** false  
**Blocks evaluated:** 20

## Summary

| Metric | Baseline | Reflow | Delta |
|--------|----------|--------|-------|
| Mean char accuracy | 97.67% | 80.59% | -17.08pp |
| Median char accuracy | 98.49% | 87.71% | -10.77pp |
| Min char accuracy | 85.45% | 24.38% | -61.07pp |
| Macro accuracy (all chars) | 97.53% | 68.39% | -29.14pp |
| Total edit distance | 340 | 4356 | 4016 |
| Image count savings | — | 0.0% fewer images | |

## Interpretation

- **≥ −2pp accuracy delta** → reflow comprehension is acceptable (within noise)
- **< −5pp accuracy delta** → reflow OCR is materially worse; investigate before shipping
- **Image savings** → higher is better (fewer images = lower token cost per call)

## Per-Block Results

| Block | Chars | Role | Baseline PNGs | Reflow PNGs | Baseline Acc | Reflow Acc | Δ Accuracy |
|-------|-------|------|--------------|-------------|-------------|-----------|-----------|
| 1 | 211 | user | 1 | 1 | 99.5% | 97.6% | -1.9pp |
| 2 | 284 | assistant | 1 | 1 | 99.6% | 93.0% | -6.7pp |
| 3 | 317 | user | 1 | 1 | 97.4% | 96.4% | -1.0pp |
| 4 | 322 | assistant | 1 | 1 | 99.7% | 90.7% | -9.0pp |
| 5 | 340 | assistant | 1 | 1 | 95.2% | 99.1% | 3.9pp |
| 6 | 397 | user | 1 | 1 | 98.5% | 95.0% | -3.5pp |
| 7 | 415 | assistant | 1 | 1 | 99.8% | 85.5% | -14.2pp |
| 8 | 436 | assistant | 1 | 1 | 99.5% | 95.9% | -3.7pp |
| 9 | 450 | user | 1 | 1 | 98.4% | 97.1% | -1.4pp |
| 10 | 513 | assistant | 1 | 1 | 97.9% | 79.3% | -18.6pp |
| 11 | 584 | assistant | 1 | 1 | 85.4% | 81.7% | -3.8pp |
| 12 | 643 | assistant | 1 | 1 | 99.4% | 82.9% | -16.5pp |
| 13 | 700 | assistant | 1 | 1 | 98.9% | 87.7% | -11.1pp |
| 14 | 888 | assistant | 1 | 1 | 96.6% | 82.0% | -14.6pp |
| 15 | 995 | assistant | 1 | 1 | 98.8% | 83.8% | -15.0pp |
| 16 | 1059 | assistant | 1 | 1 | 97.3% | 72.6% | -24.6pp |
| 17 | 1125 | assistant | 1 | 1 | 98.9% | 47.5% | -51.4pp |
| 18 | 1175 | assistant | 1 | 1 | 97.6% | 92.1% | -5.5pp |
| 19 | 1366 | assistant | 1 | 1 | 98.1% | 24.4% | -73.7pp |
| 20 | 1581 | assistant | 1 | 1 | 96.9% | 27.5% | -69.3pp |

