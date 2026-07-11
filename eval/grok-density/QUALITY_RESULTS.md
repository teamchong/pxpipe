# Grok quality suite — results (2026-07-11)

**Harness split**

| Family | Eval transport |
|---|---|
| Grok | **Codex path** — Responses via Codex provider (`OPENAI_BASE_URL` / ocproxy `:8082`) |
| Fable / Opus | **Claude** CLI |

## Live fix matrix (`fix-matrix.mjs`)

Fixed fixture; production 5×8 profile unless noted. Model `grok-4.5`.

| arm | exact | confab | gist | guard | result |
|---|---:|---:|---|---|---|
| A pure image, no IDS | 2/4 | 1 | ok | ok | **FAIL** |
| B pure image + IDS | 2/4 | 2 | ok | ok | **FAIL** |
| **C IDS + text factsheet** | **4/4** | **0** | ok | ok | **PASS** |
| D 9×12 + IDS, pure image | 3/4 | 1 | ok | ok | **FAIL** |
| **E 9×12 + IDS + factsheet** | **4/4** | **0** | ok | ok | **PASS** |

Receipt: `fix-matrix-results.json` / `/tmp/grok-fix-matrix3.log`.

### Conclusion from matrix

- **Pure-image exact is not Fable-grade** on live Grok — IDS alone does not stabilize hex/port.
- **Lower density (9×12) is not enough** without factsheet (3/4).
- **Text factsheet + images is the working fix** (4/4, 0 confab) — and **production already does this** on the Grok/Responses transform (`factSheetText` on slab + history).

## Multi-seed IDs with production path (`WITH_FACTSHEET=1`)

`multi-seed-ids.mjs`, N=3, seed=20260711, random hex/camel/path/port per seed, IDS + factsheet.

| seed | exact | confab | gist | guard |
|---|---:|---:|---|---|
| seed_1 | **4/4** | 0 | ok | ok |
| seed_2 | **4/4** | 0 | ok | ok |
| seed_3 | **4/4** | 0 | ok | ok |
| **total** | **3/3 full pass** | | | |

Receipt: `multi-seed-ids-results.json` (generatedAt 2026-07-11T03:35:38Z), log `/tmp/grok-ms-fs2.log`.

Without factsheet (earlier pure-image multi-seed), seeds failed **2/4** on hex/camel confab.

## What this means for “is Grok Fable-level?”

| Claim | Status |
|---|---|
| Grok pure-image OCR matches Fable dense reading | **No** — live pure-image fails exact |
| Grok production path (image + factsheet) exact IDs | **Yes on n=3 multi-seed + matrix** — same mitigation Fable uses |
| Grok novel arithmetic N=100 | **Not finished** this session |
| Density ~6.1× | Packing math only, not quality |

## Product stance (honest)

1. **Do not sell pure-image 7/7 as the production bar** — that was a research battery; live pure-image is unstable.
2. **When Grok is enabled, production is image + factsheet** (wired in `src/core/openai.ts`). That is the fix that works, not another glyph trick.
3. **Fable still leads** on full quality suite. **Grok is opt-in only** (`DEFAULT_MODEL_BASES = claude-fable-5`) until quality matches Fable.

## How to re-run

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8082/v1   # Codex ocproxy
export OPENAI_API_KEY=…

pnpm run build
GROK_DENSITY_LIVE=1 node eval/grok-density/fix-matrix.mjs
GROK_DENSITY_LIVE=1 N=10 node eval/grok-density/multi-seed-ids.mjs          # factsheet on by default
GROK_DENSITY_LIVE=1 WITH_FACTSHEET=0 N=10 node eval/grok-density/multi-seed-ids.mjs  # pure-image research
GROK_DENSITY_LIVE=1 N=20 node eval/grok-density/novel-arithmetic.mjs
```
