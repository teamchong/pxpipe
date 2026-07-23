# GPT-5.6 Sol raw image-recall pilot

## Native font-size sweep (2026-07-23)

All candidates used genuinely rasterized JetBrains Mono glyphs with zero cell
bonuses, 84 columns, and a 1954px page cap.

| font | native cell | alpha exact/confab | beta exact/confab | gist alpha/beta | guard alpha/beta | savings alpha/beta | decision |
|---|---|---:|---:|:---:|:---:|---:|---|
| 11px | 7×12 | 2/4, 2 | 1/4, 3 | pass/fail | pass/pass | 65.8%/65.7% | reject |
| 12px | 8×13 | 4/4, 0 | 3/4, 1 | pass/pass | pass/pass | 56.8%/56.7% | reject: invented port |
| 13px | 8×14 | 1/4, 3 | 1/4, 3 | pass/fail | pass/pass | 53.2%/53.1% | reject |
| **14px** | **9×16** | **3/4, 0** | **4/4, 0** | **pass/pass** | **pass/pass** | **42.0%/42.0%** | **use for opt-in profile** |
| 15px | 9×17 | not called | not called | — | — | 38.6%/38.5% | dry-run only; below 40% floor |

This table is the complete native Sol sweep: every tested size from 11px through
15px is shown, including the 15px preflight that was not sent to the model.
There are no Sol results for native 8–10px or 16px. The earlier 10px/6×11 pilot
used a different 126-column geometry and is documented separately below, so it
is not presented as part of this controlled 84-column sweep.

Failure details by native size:

| font | alpha misses | beta misses |
|---|---|---|
| 11px | path changed `releases`→`release`; port `47831`→`41837` | fingerprint reordered; `maxVisualTokens`→`AvisuaTokens`; path punctuation/extension changed |
| 12px | none | port `18082`→`41825` (unsupported value) |
| 13px | fingerprint, camelCase, and path changed | fingerprint, path, and port changed |
| 14px | `retryBudgetSeconds` truncated to visible-looking `retryBudgetSec` | none |
| 15px | not called | not called |

The 14px miss truncated `retryBudgetSeconds` to `retryBudgetSec`; beta passed
4/4. It did not achieve perfect exact recall, but unlike 12px it produced no
unsupported values while preserving gist and guard results on both fixtures.
The opt-in Sol profile therefore uses native 14px. Raw 11px and 14px results are in
`results-jbmono11.json` and `results-jbmono14.json`; the 15px geometry is in
`preflight-jbmono15.json`.

## Rejected native 13px follow-up (2026-07-23)

JetBrains Mono 13px rasterized to an 8×14 cell. Both fixtures used `680×1954`
and `680×1324` pages, estimated at 2,288 image tokens per call.

| fixture | exact | confabulations | gist | guard | verdict |
|---|---:|---:|:---:|:---:|---|
| alpha | **1/4** | **3** | pass | pass | **fail** |
| beta | **1/4** | **3** | fail | pass | **fail** |

The 13px profile regressed from the 12px profile's 7/8 aggregate exact result,
so it was rejected. Complete scoring and provider
usage are in `results-jbmono13.json`, with raw bodies and receipts under the
`raw/jbmono13-*` names.

## Native 12px/8×13 comparison (2026-07-23)

JetBrains Mono 12px was tested at 84 columns with
`680×1945` and `680×1100` pages per fixture.

| fixture | exact | confabulations | gist | guard | estimated image tokens | verdict |
|---|---:|---:|:---:|:---:|---:|---|
| alpha | **4/4** | **0** | pass | pass | 2,112 | pass |
| beta | **3/4** | **1** | pass | pass | 2,112 | **fail** |

Beta returned port `41825` instead of `18082`. Provider input usage was 2,728
tokens for alpha and 2,726 for beta. The paired alpha Spleen 5×8 control scored
0/4 exact with four confabulations. The production candidate therefore improved
substantially over the control but did not clear the strict two-fixture bar.

Raw follow-up receipts are `raw/01-alpha-current_sol.*`,
`raw/02-alpha-old_shared.*`, and `raw/03-beta-current_sol.*`; complete scoring is
in `results.json`.

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
