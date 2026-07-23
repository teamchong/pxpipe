# Model render profiles

The endpoint is a wire protocol, not a rendering profile. Claude, GPT, and Grok
can all arrive on `/v1/responses`; pxpipe resolves geometry and vision billing
from the model id.

| model rule | default | cell | columns | max height | evidence |
|---|:---:|---|---:|---:|---|
| `claude-fable-5*` | yes | Spleen 5×8 | 312 | 728 px | established Claude suites |
| `claude-*opus*` | opt-in | JetBrains Mono 14px, 9×16 | 86 | 728 px | blind sweep: 8/8 exact, 0 confabulations, 33% savings |
| `gpt-5.6-sol*` | opt-in | JetBrains Mono 14px, 9×16 | 84 | 1954 px | 7/8 exact, 0 inventions, gist and guard pass, 42% savings |
| `grok-*` | opt-in | Spleen 5×8 | 152 | 512 px | 82/100 arithmetic; 83/98 gist |
| other GPT/o-series | opt-in | Spleen 5×8 | 152 | 1932 px | conservative fallback |

Every production path adds IDS rows to the image and an adjacent text factsheet
for precision-critical strings. Recent and open protocol state remains native.
Those guards reduce exact-string risk; they do not make image reading byte-safe.

Sol and Grok remain opt-in because their broader image-reading results do not
match Fable. Enable them explicitly with `PXPIPE_MODELS`, for example:

```bash
PXPIPE_MODELS=claude-fable-5,gpt-5.6-sol
```

`gpt-5.6-terra` and other siblings do not inherit the Sol profile or allowlist.

Evidence: [Opus results](../eval/opus-density/RESULTS.md),
[Sol results](../eval/sol-profile/RESULTS.md),
[Grok results](../eval/grok-density/QUALITY_RESULTS.md).

## Overrides

`PXPIPE_GPT_PROFILES` is a JSON map from model-id prefix to a partial profile.
The longest prefix wins. Supported render fields are `font`, `cellWBonus`,
`cellHBonus`, `aa`, `grid`, `gridCols`, `colorCycle`, `markerScale`, and
`markerRed`; geometry fields are `stripCols` and `maxHeightPx`.

```bash
PXPIPE_GPT_PROFILES='{"gpt-5.6-sol":{"stripCols":120}}'
```

The profitability gate uses the same resolved profile as the renderer, so a
style or geometry override cannot leave cost prediction on stale dimensions.
