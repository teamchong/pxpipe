# Grok: image-only vs image+factsheet (production contract)

Live run of `factsheet-vs-image.mjs`, 2026-07-09. Model: `grok-4.5`.
Fixture: same precision-critical synthetic session as the density harness
(hex / camelCase / path / port / gist / guard).

## Question

One candidate kept **5×8** packing and relied on an image + factsheet contract.
Does that combination clear this fixture's exact bar? How does it compare with
the lower-density pure-image profile?

## Results

| arm | exact | confab | gist | guard | save≈ | notes |
|-----|------:|-------:|:----:|:-----:|------:|-------|
| `5x8_image_only` | **0/4** | **4** | ok | ok | 76% | confabulates every ID |
| `5x8_image_plus_factsheet` | **4/4** | **0** | ok | ok | **70%** | factsheet candidate |
| `5x8_grid_plus_factsheet` | 4/4 | 0 | ok | ok | 70% | style no worse with sheet |
| `5x8_color_plus_factsheet` | 4/4 | 0 | ok | ok | 70% | style no worse with sheet |
| `d4_c84_image_only` | 4/4 | 0 | ok | ok | **30%** | pure-image Opus bar, half the density win |

### Image-only confabulations (5×8)

- hex `a3f9c1e0b7d2` → `5c5e4e0b9d2`
- camel `tokenLedgerShard` → `tokenEdgeShard`
- path `src/core/anthropic-vision.ts` → `pro/core/anthropic-client.ts`
- port `47821` → `97821`

Factsheet extraction already includes all four probes plus `--max-visual-tokens`
from the same fixture. The Responses transform attaches that sheet next to slab
and history images (`src/core/openai.ts`).

## Verdict

1. **Grok stays opt-in only** (not in `DEFAULT_MODEL_BASES`). Same bar as Opus:
   not good enough as a silent pxpipe default.
2. The factsheet rescues the four token shapes in this fixture, but n=1 cannot
   prove extractor coverage for real sessions.
3. The built-in opt-in profile therefore uses the independently measured
   effective **9×12 / 84-column** arm (4/4, zero confab) and keeps the factsheet
   as defense in depth. This is more conservative than 5×8 + factsheet.
4. Style knobs (grid, colorCycle) at 5×8 do not replace either larger cells or
   the factsheet for exact recall.

Enable with `PXPIPE_MODELS=...,grok-4.5` or the dashboard Grok chip.

## How to re-run

```bash
pnpm run build
GROK_DENSITY_LIVE=1 node eval/grok-density/factsheet-vs-image.mjs
```

Receipt: `eval/grok-density/factsheet-vs-image-results.json`.
