# Reflow Eval — Combined Summary Report

**Generated:** 2026-05-22T03:18:39.382Z  
**Model:** claude-sonnet-4-5  
**Levels run:** L1, L2

## Overview

### L1: OCR Fidelity

| | Baseline | Reflow | Δ |
|--|---------|--------|---|
| Mean char accuracy | 97.73% | 80.64% | -17.09pp |
| Macro accuracy | 97.18% | 75.65% | -21.54pp |
| Image savings | — | 0.0% | |

Full L1 report: [l1-report.md](l1-report.md)


### L2: Session Replay

| | Value |
|--|------|
| Mean judge score | 51.0% |
| Pass rate (≥ 0.75) | 30.0% |
| Image savings | 50.0% |

Full L2 report: [l2-report.md](l2-report.md)


## Shipping Gate

Reflow is **safe to ship** if ALL of the following hold:

- [ ] L1 mean accuracy delta ≥ −2pp  (reflow OCR not materially worse)
- [ ] L1 macro accuracy ≥ 95%         (overall character fidelity high)
- [ ] L2 mean judge score ≥ 0.80      (task comprehension preserved)
- [ ] L2 pass rate ≥ 80%              (failures are rare outliers)

If any gate fails, investigate the failing sessions/blocks before shipping.

## How to Interpret

See [README.md](README.md) for full guidance on running and interpreting each level.

