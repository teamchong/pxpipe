# Qwen 3.8 quality results

Model: `workers-ai/@cf/qwen/qwen3.8-27b` (`qwen 3.8`) through Cloudflare Workers AI (via a local gateway).

## Benchmark Summary

| Geometry | Arithmetic (N=100) | Gist (N=98) | State (N=18) | Never-Stated (N=16) | Dense Hex (N=15) | Paired Pilot (8 facts) |
|---|---:|---:|---:|---:|---:|---:|
| **Spleen 5×8 (152 cols)** | 98/100 | 72/98 | 11/18 | **0/16** | 0/15 | 0/8 exact (unreadable / confabulated) |
| **JetBrains Mono 14px (84 cols)** | — | — | — | — | **11/15** | **8/8 exact (100%)**, 2/2 gist, 2/2 guard |

## Paired Pilot (Alpha / Beta)

Evaluated against the paired synthetic terminal pilot (Alpha & Beta sessions with 4 exact-fact extractions + 1 gist + 1 unstated guard each):

| Profile | Fixture | Exact Facts (4) | Gist | Guard (NOT STATED) | Notes |
|---|---|---:|:---:|:---:|---|
| Spleen 5×8 (152 cols) | Alpha | 0/4 | fail | fail | Raw output empty; font unreadable |
| Spleen 5×8 (152 cols) | Beta | 0/4 | pass | pass | Confabulated `path` and `port` |
| **JetBrains Mono 14px (84 cols)** | Alpha | **4/4** | **pass** | **pass** | `fingerprint`, `camelCase`, `path`, `port` exact |
| **JetBrains Mono 14px (84 cols)** | Beta | **4/4** | **pass** | **pass** | `fingerprint`, `camelCase`, `path`, `port` exact |

## Verbatim Hex (15 trials)

- **Spleen 5×8 (152 cols)**: 0/15 exact matches. 5×8 bitmap glyphs are too dense for Qwen 3.8's vision encoder.
- **JetBrains Mono 14px (84 cols)**: **11/15** exact 12-char hex matches (vs Sol 7/8, Grok 4/8).

## Receipts

- `novel-arithmetic-results.json`
- `gist-recall-results.json`
- `verbatim-hex-results.json` (Spleen 5×8 baseline)
- `verbatim-hex-14px-results.json` (JetBrains Mono 14px pilot)
