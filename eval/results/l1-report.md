# L1 OCR Fidelity Report

**Generated:** 2026-05-22T03:04:19.079Z  
**Model:** claude-sonnet-4-5  
**Dry run:** false  
**Blocks evaluated:** 20

## Summary

| Metric | Baseline | Reflow | Delta |
|--------|----------|--------|-------|
| Mean char accuracy | 97.73% | 80.64% | -17.09pp |
| Median char accuracy | 98.58% | 83.71% | -14.87pp |
| Min char accuracy | 92.20% | 63.59% | -28.60pp |
| Macro accuracy (all chars) | 97.18% | 75.65% | -21.54pp |
| Total edit distance | 388 | 3356 | 2968 |
| Image count savings | — | 0.0% fewer images | |

## Interpretation

- **≥ −2pp accuracy delta** → reflow comprehension is acceptable (within noise)
- **< −5pp accuracy delta** → reflow OCR is materially worse; investigate before shipping
- **Image savings** → higher is better (fewer images = lower token cost per call)

## Per-Block Results

| Block | Chars | Role | Baseline PNGs | Reflow PNGs | Baseline Acc | Reflow Acc | Δ Accuracy |
|-------|-------|------|--------------|-------------|-------------|-----------|-----------|
| 1 | 211 | user | 1 | 1 | 95.3% | 98.1% | 2.8pp |
| 2 | 284 | assistant | 1 | 1 | 96.2% | 91.2% | -5.0pp |
| 3 | 317 | user | 1 | 1 | 97.4% | 92.9% | -4.5pp |
| 4 | 322 | assistant | 1 | 1 | 99.7% | 85.9% | -13.8pp |
| 5 | 340 | assistant | 1 | 1 | 99.1% | 95.6% | -3.5pp |
| 6 | 397 | user | 1 | 1 | 97.7% | 93.5% | -4.2pp |
| 7 | 415 | assistant | 1 | 1 | 100.0% | 77.8% | -22.2pp |
| 8 | 436 | assistant | 1 | 1 | 99.8% | 91.1% | -8.7pp |
| 9 | 450 | user | 1 | 1 | 96.2% | 86.0% | -10.2pp |
| 10 | 513 | assistant | 1 | 1 | 98.8% | 72.1% | -26.7pp |
| 11 | 584 | assistant | 1 | 1 | 99.7% | 67.3% | -32.4pp |
| 12 | 643 | assistant | 1 | 1 | 99.7% | 84.9% | -14.8pp |
| 13 | 700 | assistant | 1 | 1 | 99.4% | 83.7% | -15.7pp |
| 14 | 888 | assistant | 1 | 1 | 95.2% | 72.6% | -22.5pp |
| 15 | 995 | assistant | 1 | 1 | 98.5% | 72.2% | -26.3pp |
| 16 | 1059 | assistant | 1 | 1 | 98.6% | 75.7% | -22.9pp |
| 17 | 1125 | assistant | 1 | 1 | 97.6% | 65.6% | -32.0pp |
| 18 | 1175 | assistant | 1 | 1 | 100.0% | 68.9% | -31.1pp |
| 19 | 1366 | assistant | 1 | 1 | 92.2% | 73.8% | -18.4pp |
| 20 | 1581 | assistant | 1 | 1 | 93.6% | 63.6% | -30.0pp |

