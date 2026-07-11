# GPT-5.6 Sol raw image-recall pilot

Live run: **2026-07-09**

Model: **`gpt-5.6-sol`**

Endpoint: direct OpenAI-compatible Responses path, bypassing pxpipe

Image detail: **`original`**

This pilot tests raw reading of rendered terminal text. It does not include
pxpipe's verbatim fact-sheet, and it does not compare Sol directly with Fable.

## Acceptance bar

A profile clears this small fixture only if all of the following hold in one
structured response:

- 4/4 exact values: 12-character hex, camelCase field, full path, and port;
- correct rollout gist;
- correct `NOT STATED` response for an absent fact;
- zero unsupported invented values.

## Results

| profile | image | estimated image tokens | exact | confabulations | gist | guard | verdict |
|---|---:|---:|---:|---:|:---:|:---:|---|
| JetBrains Mono 10, 6×11, 126 cols | 764×1724 | 1,296 | **0/4** | **4** | pass | pass | **fail** |
| Spleen, 5×8, 152 cols | 768×1040 | 792 | **0/4** | **4** | fail | pass | **fail** |

## Paid-attempt ledger

Every paid attempt is retained, including the unscored setup failure:

| # | arm | reasoning | HTTP/result | input | output (reasoning) | latency | receipt |
|---:|---|---|---|---:|---:|---:|---|
| 1 | alpha / JetBrains 6×11 | low | incomplete: `max_output_tokens`; **not scored** | 1,748 | 512 (512) | 13,857 ms | [body](./raw/01-alpha-current_sol.response.json), [metadata](./raw/01-alpha-current_sol.receipt.json) |
| 2 | alpha / JetBrains 6×11 | none | completed; 0/4 exact, 4 confabulations | 1,748 | 52 (0) | 3,294 ms | [body](./raw/02-alpha-current_sol.response.json), [metadata](./raw/02-alpha-current_sol.receipt.json) |
| 3 | alpha / Spleen 5×8 | none | completed; 0/4 exact, 4 confabulations | 1,143 | 59 (0) | 2,429 ms | [body](./raw/03-alpha-old_shared.response.json), [metadata](./raw/03-alpha-old_shared.receipt.json) |
| 4 | alpha / JetBrains effective 9×12 | none | **not called; approval pending** | ≈2,354 projected | — | — | local hashes in [preflight](./preflight.json) |

The 5×8 line is a real paid model call. It is not an inferred result from local
rendering or from Grok's separate evaluation.

### JetBrains 6×11 response

Expected:

- `c7a1e90b4d2f`
- `retryBudgetSeconds`
- `/srv/sol-pilot/releases/alpha-07/config/runtime-map.json`
- `47831`

Returned:

- `c0ffee0913a7`
- `matrixField`
- `/srv/app/releases/alpha-07/config/runtime.yaml`
- `41702`

All four returned values were absent from the fixture, so they are counted as
confabulations rather than mere OCR substitutions. The model correctly selected
gist `B` and returned `NOT STATED` for the absent region.

Provider usage: 1,748 input tokens, 52 output tokens, zero reasoning tokens;
3,294 ms latency.

### Spleen 5×8 response

Returned:

- `7ac089b47c21`
- `fluxLimiterCeiling`
- `/srv/releases/2025-04-18/edge-router/manifest.json`
- `41820`

Again, all four values were absent from the fixture. The model also selected the
wrong gist (`A` instead of `B`), while correctly returning `NOT STATED` for the
absent region.

Provider usage: 1,143 input tokens, 59 output tokens, zero reasoning tokens;
2,429 ms latency.

## Setup attempt excluded from scoring

The first paid attempt used `reasoning: low`. It returned no answer because all
512 output tokens were hidden reasoning tokens and the response ended
`incomplete` with `max_output_tokens`. It is retained in the receipts and counts
against the four-call spending cap, but it is not evidence about recall.

Across the three paid attempts so far (one setup failure and two scored calls),
provider usage totals 4,639 input tokens and 623 output tokens.

## Interpretation

1. **Neither tested profile clears raw Sol exact recall.** The current 6×11
   profile is better on gist than the old 5×8 profile, but 0/4 exact plus four
   inventions fails the acceptance bar.
2. This is one synthetic fixture per scored profile. It proves those calls
   failed; it does not establish a population failure rate or compare Sol with
   Fable.
3. Production Responses transforms attach a verbatim fact-sheet for paths and
   identifiers. That defense may preserve covered exact strings in real pxpipe
   traffic, but it does not turn this raw-image result into a pass.
4. Local token savings are cost evidence only: approximately 73.5% for 6×11 and
   83.8% for 5×8 versus this fixture's chars/4 text estimate.

## Default-scope decision

`gpt-5.6-sol` is **off by default** after these failures, matching the policy for
GPT 5.5 and Grok: silent image rewriting requires positive reader evidence, not
only positive token savings. The exact Sol profile remains available for
explicit operator opt-in:

```bash
PXPIPE_MODELS='claude-fable-5,gpt-5.6-sol'
```

Re-enabling it by default requires a retuned paid arm to pass 4/4 exact, zero
confabulations, gist, and guard while retaining positive savings. A replicated
pass on both fixtures is preferred before silent promotion.

## Pending Sol-only retune

A larger candidate has been rendered locally but not called:

- JetBrains Mono 10 glyphs in effective 9×12 cells;
- 84 columns;
- pages 764×1928 and 764×884;
- 2,136 estimated image tokens, ≈2,354 projected total input tokens;
- ≈56.3% estimated image-vs-text savings.

It is the fourth and final possible paid attempt. Its higher input projection
requires separate approval before the call. Until then, it is local geometry,
not model evidence.

## Receipts

- Machine-readable summary: [`results.json`](./results.json)
- Preflight and image hashes: [`preflight.json`](./preflight.json)
- Byte-for-byte response bodies and request receipts: [`raw/`](./raw/)
