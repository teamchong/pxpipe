# Grok native JetBrains Mono size sweep

Blind 8–16px ladder (+ shipped spleen-5×8 control) for `grok-4.5`.

Geometry matches production Grok constraints: short-side ≤768px, `maxH=512`.
Per-rung cols = `floor((768−8)/cellW)`. Image tokens use `GROK_TOKENS_PER_MEGAPIXEL`
(1000 tok/MPix). Protocol mirrors Opus/Sol native sweeps: crypto-random fixture,
atlas swap → rebuild → render, live ask locks answers before truth is scored.

```bash
node eval/grok-density/native-sweep/gen-fixture.mjs
node eval/grok-density/native-sweep/render-ladder.mjs
OPENAI_BASE_URL=http://127.0.0.1:8082/v1 OPENAI_API_KEY=… \
  bash eval/grok-density/native-sweep/_ask_all.sh
node eval/grok-density/native-sweep/score-all.mjs
```

**Result:** no clean rung. Best exact is 4/8 at 14/15/16px; production opt-in
profile uses **14px / 84 cols / maxH 512** (densest of the 4/8 plateau). See
[RESULTS.md](RESULTS.md).
