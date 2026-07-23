# Grok 4.5 native JetBrains Mono 8–16px blind sweep

Date: 2026-07-23. Model: `grok-4.5` via direct Responses (`OPENAI_BASE_URL`
upstream `:8082`, pxpipe port 47821 rejected by the client).

## Protocol (same spirit as Opus / Sol native sweeps)

1. Fresh crypto-random 8-token fixture (`gen-fixture.mjs`) → `fixture.txt` /
   `truth.json` / `questions.json`. Targets never printed during the live ask.
2. Render ladder at **Grok geometry**: short-side ≤768px, `maxHeightPx=512`
   (production Grok page height). Per-rung cols = `floor((768 − 8) / cellW)`.
3. Fonts: production `spleen-5x8` control + genuine JB Mono 8…16px atlases
   (zero cell padding). Atlas swap → rebuild → `render-one.mjs` per rung.
4. Live ask (`ask.mjs`) locks `answers-<label>.json` before scoring.
5. `score-all.mjs` reveals truth. **Clean** = 8/8 exact and 0 confabulations.
   Sweet spot = densest clean rung.

Grok image tokens use the measured `1000 tok/MPix` formula
(`GROK_TOKENS_PER_MEGAPIXEL` in `src/core/openai.ts`).

## Results

| font | native cell | cols | pages | savings | exact | confab | abstain |
|---|---|---:|---:|---:|---:|---:|---:|
| spleen-5×8 (shipped) | 5×8 | 152 | 1 | 85% | 0/8 | 3 | 5 |
| 8px | 5×10 | 152 | 2 | 82% | 0/8 | **8** | 0 |
| 9px | 6×10 | 126 | 2 | 78% | 0/8 | 3 | 5 |
| 10px | 6×11 | 126 | 2 | 76% | 0/8 | 5 | 3 |
| 11px | 7×12 | 108 | 2 | 69% | 1/8 | 7 | 0 |
| 12px | 8×13 | 95 | 3 | 62% | 3/8 | 5 | 0 |
| 13px | 8×14 | 95 | 3 | 59% | 1/8 | 7 | 0 |
| 14px | 9×16 | 84 | 4 | 48% | **4/8** | 4 | 0 |
| 15px | 9×17 | 84 | 4 | 45% | **4/8** | 4 | 0 |
| 16px | 10×17 | 76 | 4 | 38% | **4/8** | 4 | 0 |

**CLEAN rungs: none. SWEET SPOT: none.**

Best exact counts plateau at **4/8** from 14–16px; every larger native rung
still silent-confabulates half the precision tokens. The shipped spleen 5×8
control is worse on exact (0/8) but abstains more often (5/8) instead of
guessing.

## Decision

Do **not** change the Grok production profile off spleen 5×8 / 152 cols / 512px
on the strength of this ladder. Unlike Opus (clean at 14px) and Sol (usable at
14px with 0 inventions on its pilot), Grok does not clear an all-exact / 0-confab
bar at any native JB Mono size under Grok page geometry.

Grok stays opt-in. The existing quality matrix cells (arithmetic 82/100, gist
83/98, state 13/18, never-stated 0/16, dense hex 0/15) remain the shipped-profile
evidence; this sweep is the native-size negative result.

## Reproduce

```bash
# atlases already built under eval/opus-density/native-sweep/atlases (symlinked)
node eval/grok-density/native-sweep/gen-fixture.mjs   # fresh truth (optional)
node eval/grok-density/native-sweep/render-ladder.mjs # swaps atlas*, rebuilds, restores
OPENAI_BASE_URL=http://127.0.0.1:8082/v1 OPENAI_API_KEY=… \
  bash eval/grok-density/native-sweep/_ask_all.sh     # locks answers-*.json
node eval/grok-density/native-sweep/score-all.mjs
```

Receipts: `cost-*.json`, `answers-*.json`, `score.json`, `render-table.json`,
PNG pages `*-pN.png`, `truth.json`.
