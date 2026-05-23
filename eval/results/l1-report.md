# L1 OCR Fidelity Report

**Generated:** 2026-05-23T01:54:01.508Z  
**Model:** opus  
**Dry run:** false  
**Blocks evaluated:** 20

## Summary (per variant)

| Variant | Mean Acc | Median Acc | Min Acc | Δ vs baseline | Image savings |
|---------|----------|-----------|---------|---------------|---------------|
| baseline | 97.91% | 98.01% | 96.25% | +0.00pp | 0.0% |
| reflow | 91.99% | 93.44% | 82.59% | -5.93pp | 0.0% |
| reflow-inimage | 98.95% | 99.07% | 96.42% | +1.04pp | 0.0% |

## Interpretation

- **baseline** is the no-reflow reference; **reflow** is the regression to fix.
- A variant **ships** if its mean accuracy is within −2pp of baseline AND its image savings are > 0%.
- `Δ vs baseline` of `reflow` quantifies the damage; the structure-aid variants should claw it back.

## Per-Block Accuracy

| Block | Chars | Role | baseline | reflow | reflow-inimage |
|-------|-------|------|------|------|------|
| 1 | 211 | user | 97.6% | 97.2% | 99.5% |
| 2 | 228 | assistant | 99.1% | 94.7% | 99.6% |
| 3 | 253 | assistant | 96.4% | 93.7% | 98.0% |
| 4 | 284 | assistant | 97.2% | 91.2% | 98.9% |
| 5 | 315 | assistant | 97.5% | 85.7% | 100.0% |
| 6 | 317 | user | 96.8% | 94.2% | 97.4% |
| 7 | 317 | assistant | 98.1% | 82.6% | 98.1% |
| 8 | 321 | assistant | 96.3% | 93.4% | 99.1% |
| 9 | 322 | assistant | 99.7% | 92.9% | 99.1% |
| 10 | 336 | user | 97.3% | 87.8% | 96.4% |
| 11 | 340 | assistant | 99.1% | 97.1% | 99.7% |
| 12 | 351 | user | 98.0% | 97.5% | 100.0% |
| 13 | 362 | assistant | 98.3% | 93.9% | 98.3% |
| 14 | 383 | user | 98.9% | 96.8% | 99.5% |
| 15 | 397 | user | 98.2% | 92.4% | 98.7% |
| 16 | 405 | user | 98.0% | 93.8% | 99.3% |
| 17 | 415 | assistant | 99.5% | 86.5% | 99.8% |
| 18 | 423 | user | 98.3% | 92.3% | 98.8% |
| 19 | 429 | assistant | 96.3% | 83.0% | 98.8% |
| 20 | 436 | assistant | 97.5% | 93.1% | 100.0% |

