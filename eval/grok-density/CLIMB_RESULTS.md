# Grok climb — densest packing that matches the Opus bar
Live binary-search climb on `grok-4.5`, 2026-07-09.
Goal: **4/4 exact, 0 confab, gist ok, guard ok**, densest packing first.
Image savings use measured Grok billing (~1000 tok/MPix), not the GPT tile model.

## Result
Best so far: `spleen5x8_aa_d4_c84` at **~30%** savings.

```json
{
  "stripCols": 84,
  "maxHeightPx": 1932,
  "style": {
    "cellWBonus": 4,
    "cellHBonus": 4,
    "aa": true,
    "grid": false,
    "colorCycle": false
  },
  "font": "spleen5x8"
}
```

## Ladder (Spleen 5x8, AA)
| id | exact | confab | save | dims |
|----|------:|-------:|-----:|------|
| `spleen5x8_aa_d0_c152` | 0/4 | 4 | ~76% | 768x360 |
| `spleen5x8_aa_d2_c108` | 2/4 | 2 | ~70% | 764x458 |
| `spleen5x8_aa_d3_c95` | 2/4 | 2 | ~37% | 768x954 |
| `spleen5x8_aa_d4_c84` | 4/4 | 0 | ~30% | 764x1064 |

## Notes
- Production packing (d0) confabulates exact IDs.
- d2/d3 improve but still confab hex/port.
- d4 (cell bonus 4/4, stripCols 84) clears Opus bar at ~30% real savings.
- Font/atlas swaps are eval-only; production still ships Spleen 5x8.
