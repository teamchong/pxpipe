# Model render profiles

The endpoint is a wire protocol, not a rendering profile. Claude, GPT, and Grok
can all arrive on `/v1/responses`; pxpipe resolves geometry and vision billing
from the model id.

A gateway may prefix that wire path with one routing segment and may qualify the
model id with vendor segments. Both are recognized: `/compat/chat/completions`
and `/grok/v1/responses` are read as the OpenAI shapes they are (one leading
path segment is stripped), and the profile lookup tries the full id then its
bare final segment, so `moonshotai/kimi-k3` and
`workers-ai/@cf/moonshotai/kimi-k3` both resolve the same as `kimi-k3` — vendor
segments pick an upstream, not a
geometry. Prefix recognition does not move routing — a provider-prefixed path
still forwards to the passthrough upstream.

| model rule | default | cell | columns | max height | evidence |
|---|:---:|---|---:|---:|---|
| `claude-*` / `anthropic-*` | yes | Spleen 5×8 | 312 | 728 px | established Claude suites |
| `gpt-5.6-sol*` | opt-in | JetBrains Mono 14px, 9×16 | 84 | 1954 px | 7/8 exact, 0 inventions, gist and guard pass |
| `grok-*` | opt-in | JetBrains Mono 14px, 9×16 | 84 | 512 px | 100/100 arith, 97/98 gist, 17/18 state; hex 0/15 |
| other GPT/o-series | opt-in | Spleen 5×8 | 152 | 1932 px | conservative fallback |

Every production path adds IDS rows to the image and an adjacent text factsheet
for precision-critical strings. Recent and open protocol state remains native.
Those guards reduce exact-string risk; they do not make image reading byte-safe.

## Savings vs. cost

Native 14px is a legibility/quality profile, **not a cost win** on warm-cache
traffic. Images do cache — a turn whose image prefix is already cached saves a
little (dashboard: ~1,700 tokens on a measured Claude turn) — but images are
large, so each time the prefix changes and the provider re-writes it, one
`cache_create` costs several times the text it replaced. One measured turn sent
43,444 tokens versus 8,964 as text (−34,480), erasing ~20 warm turns of savings,
i.e. net-negative. That is why the 14px profiles ship opt-in for
legibility/quality; read cost off the dashboard's cache-aware number, and let the
profitability gate skip transforms whose amortized create cost it predicts will
lose.

Sol and Grok remain opt-in because their broader image-reading results do not
match Claude. Enable them explicitly with `PXPIPE_MODELS`, for example:

```bash
PXPIPE_MODELS=claude-fable-5,gpt-5.6-sol
```

`gpt-5.6-terra` and other siblings do not inherit the Sol profile or allowlist.

Evidence: [Sol results](../eval/sol-profile/RESULTS.md),
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

## Unmeasured families

An id that names a family pxpipe HAS measured, but does not match any of that
family's profiles — an unmeasured Gemini or Grok sibling — is refused by
`isMisresolvedModelId`, and the request passes through as text. Such an id would
otherwise fall through to `DEFAULT_GPT_PROFILE` and be gated with OpenAI's tile
math, i.e. priced with the wrong provider's formula.

An id that names no known family at all (anything reached through a gateway's
OpenAI-compatible route — Kimi K3 on Cloudflare is the example this repo has
run) is NOT refused. It resolves to
`DEFAULT_GPT_PROFILE` and is gated with OpenAI's tile math as an approximation.
`PXPIPE_MODELS` is the only gate: listing such a model is the operator asserting
it is worth imaging. Two consequences worth stating plainly:

- The savings figure is an approximation, not a measurement. If tile math
  overstates the model's real image cost, the gate declines transforms that
  would have paid off; if it understates, you take a small loss.
- Nothing checks that the model can accept images at all. A text-only model
  will reject an imaged request outright — a 400 on the first compressed call,
  not a silent degradation.

To replace the approximation with real numbers, declare the geometry and vision
cost yourself:

```bash
PXPIPE_MODELS=claude-fable-5,kimi-k3
PXPIPE_GPT_PROFILES='{"kimi-k3":{"vision":{"regime":"mpix","tokensPerMegapixel":1000},"stripCols":152,"maxHeightPx":1932}}'
```

The `tokensPerMegapixel` above is a **placeholder, not a measurement** — read
the real image-token rule off your provider's billing docs, or measure it by
sending one known-size image and reading the reported input tokens. A wrong
number here does not corrupt output; it corrupts the profitability gate and the
dashboard's savings figure, which is worse, because both will look confident.

Declaring a cost says nothing about whether the model can *read* dense imaged
text. Verify that separately before trusting a compressed session — see
[eval/](../eval) for the harnesses used on the shipped profiles.
