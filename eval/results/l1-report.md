# L1 OCR Fidelity Report

**Generated:** 2026-05-23T00:34:20.890Z  
**Model:** opus  
**Dry run:** false  
**Blocks evaluated:** 20

## Summary (per variant)

| Variant | Mean Acc | Median Acc | Min Acc | Δ vs baseline | Image savings |
|---------|----------|-----------|---------|---------------|---------------|
| baseline | 97.64% | 98.10% | 87.75% | +0.00pp | 0.0% |
| reflow | 90.91% | 94.20% | 59.65% | -6.73pp | 0.0% |

## Interpretation

- **baseline** is the no-reflow reference; **reflow** is the regression to fix.
- A variant **ships** if its mean accuracy is within −2pp of baseline AND its image savings are > 0%.
- `Δ vs baseline` of `reflow` quantifies the damage; the structure-aid variants should claw it back.

## Per-Block Accuracy

| Block | Chars | Role | baseline | reflow |
|-------|-------|------|------|------|
| 1 | 211 | user | 99.5% | 97.2% |
| 2 | 228 | assistant | 99.6% | 59.6% |
| 3 | 253 | assistant | 87.7% | 96.8% |
| 4 | 284 | assistant | 96.8% | 96.1% |
| 5 | 315 | assistant | 97.5% | 79.4% |
| 6 | 317 | user | 96.8% | 92.1% |
| 7 | 317 | assistant | 98.1% | 91.1% |
| 8 | 321 | assistant | 97.5% | 89.8% |
| 9 | 322 | assistant | 99.4% | 88.5% |
| 10 | 336 | user | 97.0% | 94.7% |
| 11 | 340 | assistant | 99.1% | 97.4% |
| 12 | 351 | user | 98.0% | 96.0% |
| 13 | 362 | assistant | 98.3% | 94.2% |
| 14 | 383 | user | 98.9% | 98.1% |
| 15 | 397 | user | 98.2% | 95.0% |
| 16 | 405 | user | 97.8% | 92.8% |
| 17 | 415 | assistant | 99.8% | 84.8% |
| 18 | 423 | user | 98.3% | 93.5% |
| 19 | 429 | assistant | 97.0% | 85.1% |
| 20 | 436 | assistant | 97.5% | 95.9% |

