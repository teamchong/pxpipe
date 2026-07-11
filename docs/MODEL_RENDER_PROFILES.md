# Model render profiles

The OpenAI-shaped endpoints are a wire protocol, not a rendering profile.
Claude, GPT, and Grok requests can all arrive on `/v1/responses`; pxpipe selects
geometry, glyph atlas, style, and vision billing from the exact `model` id.

## Built-in profiles

| model rule | default enabled | font / cell | columns | max height | style | evidence |
|---|:---:|---|---:|---:|---|---|
| `claude-*` / `*anthropic*` | Fable only | Spleen + Unifont, 5×8 | 312 | 728 px | grayscale AA | Anthropic 1568-edge / ~1.15 MP no-resize measurements |
| `gpt-5.6-sol` | **no; opt-in** | JetBrains Mono 10 + Unifont fallback, 6×11 | 126 | 1932 px | grayscale AA | operational geometry; raw recall pilot failed 0/4 exact and is being retuned |
| `grok-*` | **no; opt-in** | Spleen + Unifont, 5×8 | 152 | 512 px | AA white + IDS + text factsheet | opt-in: pure-image not Fable-level; factsheet path works for exact IDs |
| other GPT/o-series | no unless configured | Spleen + Unifont, 5×8 | 152 | 1932 px | grayscale AA | conservative fallback / existing OpenAI geometry |

`gpt-5.6-sol` is intentionally exact and opt-in. The events log also contains
`gpt-5.6-terra`; Terra does not inherit Sol's allowlist or visual profile.

The GPT 5.6 Sol font choice is a separate local raster profile. It preserves
the provider-safe strip width and has a larger cell than the shared 5×8
fallback, but the first paid raw-image pilot did **not** validate it.

## Sol evidence boundary (2026-07-09)

Two production rows for the exact `gpt-5.6-sol` id reported 39,985 effective
input/cache-read tokens, 14,152 image tokens, a 52,072-token baseline, 18
images, and approximately 73% estimated savings. A comparison run with the old
shared profile reported 8,568 image tokens against the same baseline. These
numbers establish that real Sol traffic reaches the Responses path and that the
new geometry costs more while retaining positive estimated savings. They do
**not** establish recall, task quality, or causality.

The separate paid raw-image pilot supplies the model-reading evidence:

| profile | exact | confabulations | gist | guard | result |
|---|---:|---:|:---:|:---:|---|
| JetBrains 6×11 / 126 cols | 0/4 | 4 | pass | pass | fail |
| Spleen 5×8 / 152 cols | 0/4 | 4 | fail | pass | fail |

The test is one scored synthetic fixture per profile. It proves that both calls
failed the stated acceptance bar, not a broad Sol-vs-Fable ranking. Production
also sends a verbatim fact-sheet beside images, so covered exact identifiers
have a text fallback even though raw image recall failed. A locally rendered
9×12 / 84-column Sol-only retune remains untested until its final paid call is
approved.

Receipt: [`eval/sol-profile/RESULTS.md`](../eval/sol-profile/RESULTS.md).

### Sol default-scope decision

Sol is **off by default** under the same safety rule used for GPT 5.5:
a model that silently invents exact values from imaged context is not a safe
transparent default. The profile code stays available so operators can opt in
explicitly and so the 9×12 candidate can be evaluated without changing any
other model:

```bash
PXPIPE_MODELS='claude-fable-5,gpt-5.6-sol'
```

Re-enabling Sol by default requires a paid profile arm to clear 4/4 exact, zero
confabulations, gist, and guard while retaining positive savings. Ideally the
pass should replicate on both deterministic fixtures; the current n=1 failures
are enough to reject these profiles, not enough to estimate a general error
rate.

## IDS block (all models)

Every imaged path (Claude slab/history/tool_result, GPT slab/history, Grok)
appends a short in-image **IDS** block so hex/camel/path/port sit on their own
rows. This is the pure-image hex aid validated on Grok (7/7 4/4); other families
get it as defense in depth alongside the text fact-sheet. Toggle off on the GPT
history path with `gptHistory.idsBlock: false` if needed.

## Why Grok is opt-in

Grok packing (5×8 white + IDS) plus the **text factsheet** clears exact-ID
probes on the Codex path (live matrix + multi-seed 3/3). Pure-image alone
does **not** — hex/port confabulate. The full Fable suite (novel arithmetic
N=100, gist/state) is not complete for Grok. Until that bar is met, Grok stays
**opt-in**: `PXPIPE_MODELS=claude-fable-5,grok-4.5` or the dashboard chip.

Evidence:
[`QUALITY_RESULTS.md`](../eval/grok-density/QUALITY_RESULTS.md),
[`VISUAL_5X8_SOLUTION.md`](../eval/grok-density/VISUAL_5X8_SOLUTION.md).

## Overrides

`PXPIPE_GPT_PROFILES` is a JSON map from model-id prefix to a partial profile.
The longest prefix wins. Supported render fields are `font`, `cellWBonus`,
`cellHBonus`, `aa`, `grid`, `gridCols`, `colorCycle`, `markerScale`, and
`markerRed`; geometry fields are `stripCols` and `maxHeightPx`.

```bash
PXPIPE_GPT_PROFILES='{
  "gpt-5.6-sol": {
    "stripCols": 120,
    "style": { "grid": true, "gridCols": 4 }
  }
}'
```

The profitability gate derives pixel width, row capacity, pagination, and image
cost from the same resolved profile used by slab and history rendering. A style
override therefore cannot silently leave the gate on 5×8 geometry.
