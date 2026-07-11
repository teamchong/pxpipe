# Grok quality suite (Codex / Responses path)

**Harness split (this repo):**

| Family | How we call the model for evals |
|---|---|
| **Grok** (`grok-4.5`, …) | **Codex path** — OpenAI-compatible **Responses** via the same provider Codex uses (`OPENAI_BASE_URL`, typically ocproxy `http://127.0.0.1:8082/v1`) |
| **Fable / Opus** | **Claude** — `claude` CLI / `eval/lib/cci.py` (Anthropic Messages) |

Grok harnesses do **not** use the Claude CLI. They POST images to `/v1/responses` the same way Codex’s `model_provider` does. Do **not** point them at pxpipe (`:47821`); measure raw image reading.

## Production recipe under test

```text
Spleen 5×8 · cols 152 · maxH 512 · { aa: true, grid: false } · appendIdsBlock
```

## Env (Codex / ocproxy)

```bash
# Same stack Codex uses for Grok (see ~/.codex/config.toml model_provider=ocproxy)
export OPENAI_BASE_URL=http://127.0.0.1:8082/v1   # or your Codex provider base
export OPENAI_API_KEY=…                             # forwarded by ocproxy / provider
export GROK_DENSITY_MODEL=grok-4.5
```

## 1. Multi-seed pure-image IDs

Random hex / camel / path / port per seed; scores exact 4/4 + gist + guard.

```bash
pnpm run build
GROK_DENSITY_LIVE=1 N=10 node eval/grok-density/multi-seed-ids.mjs
# fuller
GROK_DENSITY_LIVE=1 N=20 node eval/grok-density/multi-seed-ids.mjs
```

Writes `multi-seed-ids-results.json`.

## 2. Novel arithmetic (text vs image)

Fresh random-number word problems (not GSM8K). Image arm sees **only** the PNG.
Same math idea as `eval/gsm8k/` for Fable, but Grok is scored over **Responses**, not Claude.

```bash
pnpm run build
GROK_DENSITY_LIVE=1 N=20 node eval/grok-density/novel-arithmetic.mjs
# Fable-comparable N
GROK_DENSITY_LIVE=1 N=100 CONCURRENCY=2 node eval/grok-density/novel-arithmetic.mjs
```

Writes `novel-arithmetic-results.json`.

## 3. Shipped short/bulk smoke

```bash
GROK_DENSITY_LIVE=1 node eval/grok-density/five-by-eight-shipped.mjs
```

## Why not `codex exec` for every probe?

Codex interactive/`exec` is the agent shell. These evals need **controlled vision
inputs** (fixed PNGs + fixed questions) and cheap parallel scoring. Hitting the
**same Responses base URL Codex uses** is the right layer: same model, same
provider, no agent loop noise. Fable keeps using Claude because its quality
receipts were collected that way.

## Acceptance (same spirit as opus-density / Fable)

- Multi-seed IDs: high rate of **4/4 exact, 0 confab, gist ok, guard ok**
- Novel arithmetic: image accuracy near text baseline on N≥20 (target N=100)
