# GPT-5.6 Sol render-profile pilot

This directory contains raw image-reading benchmarks for the exact
`gpt-5.6-sol` model. The original pilot compared:

- `old_shared`: Spleen/Unifont grayscale AA, 5×8 cell, 152 columns;
- `current_sol`: the production-resolved JetBrains Mono 10/Unifont grayscale AA,
  6×11 cell, 126 columns.

The opt-in profile now uses native JetBrains Mono 14px, 9×16, at 84 columns. A
2026-07-23 raw-image pilot scored 3/4 exact on alpha and 4/4 on beta; both passed
gist and guard, and neither produced an unsupported value. The alpha miss was a
truncation (`retryBudgetSeconds` to `retryBudgetSec`), so this proves useful
image context rather than byte-perfect OCR. Sol remains off by default.
JetBrains Mono 12 RGB-overprint work and its
negative channel-separation result are kept as research; see [`QUALITY_RESULTS.md`](./QUALITY_RESULTS.md) and
[`RGB_SEPARATION_RESULTS.md`](./RGB_SEPARATION_RESULTS.md).

A native 11–15px sweep selected 14px for the opt-in profile. Native 11px scored
3/8 exact, 13px scored 2/8, and 12px invented a port. Native 14px scored 7/8
with no inventions at 42.0% estimated savings. See [`RESULTS.md`](./RESULTS.md).

## Rejected 13px follow-up (2026-07-23)

A genuine JetBrains Mono 13px atlas rasterized to an 8×14 cell. At 84 columns,
each fixture rendered as `680×1954` plus `680×1324`, costing an estimated 2,288
image tokens. It regressed to 1/4 exact on both fixtures, with three
confabulations each; beta also missed gist. The 13px candidate was rejected and
the 13px candidate was rejected. Full scoring is in
`results-jbmono13.json`.

## Native 12px/8×13 comparison pilot (2026-07-23)

| fixture | exact | confabulations | gist | guard | estimated image tokens | savings vs text |
|---|---:|---:|:---:|:---:|---:|---:|
| alpha | **4/4** | **0** | pass | pass | 2,112 | 56.8% |
| beta | **3/4** | **1** | pass | pass | 2,112 | 56.7% |

The beta miss was the port: expected `18082`, returned `41825`. The paired alpha
5×8 control scored 0/4 with four confabulations. Full response bodies, usage,
latency, and scoring are retained in `results.json` and `raw/`.

## Production-profile benchmark results (2026-07-17)

The production 5×8 Spleen profile was evaluated through the direct Responses
upstream, not pxpipe:

| test | text | production image | notes |
|---|---:|---:|---|
| novel arithmetic, N=100 | 100/100 | **98/100** | pure image 96/100 |
| gist recall | not measured | **83/98** | no transport errors |
| state tracking | not measured | **17/18** | no transport errors |
| never-stated guards | not measured | **4/16 confabulated** | no transport errors |
| dense 12-character hex | not run | **0/15** | all calls completed |

Matched arithmetic usage was 5,300 text input tokens versus 7,000 production-
image input tokens, a **32.1% increase**. See
[`QUALITY_RESULTS.md`](./QUALITY_RESULTS.md) for the rejected RGB research arms
and receipt names.

## Initial profile-selection pilot (2026-07-09)

The earlier pilot produced:

| arm | paid/scored | exact | confabulations | gist | guard | status |
|---|:---:|---:|---:|:---:|:---:|---|
| JetBrains 6×11 / 126 cols | yes | **0/4** | **4** | pass | pass | fail |
| Spleen 5×8 / 152 cols | yes | **0/4** | **4** | fail | pass | fail |
| JetBrains Mono 12px, native 8×13 / 84 cols | yes | **7/8 across two fixtures** | **1** | pass | pass | fails strict bar |

There was also one paid setup attempt for 6×11 that returned no answer because
all 512 output tokens were hidden reasoning tokens. It counts toward spending
but is excluded from recall scoring. Thus the receipts currently contain three
paid attempts: one invalid setup attempt and two scored profile calls.

Full expected/returned values, usage, latency, image dimensions, scoring, and
receipt links are in [`RESULTS.md`](./RESULTS.md).

**Policy decision:** Sol is now off by default. Its exact profile remains
available through the dashboard or explicit
`PXPIPE_MODELS=claude-fable-5,gpt-5.6-sol`. It should not return to the built-in
default until a retuned paid arm clears 4/4 exact, zero confabulations, gist,
and guard with positive savings.

## Design

Two fixed-seed synthetic terminal fixtures each contain one labelled value for:

1. a 12-character hexadecimal fingerprint;
2. a camelCase runtime field;
3. a full path;
4. a port;
5. a rollout gist (scored as an A/B/C choice);
6. one deliberately unstated fact, which must produce `NOT STATED`.

Each fixture/profile arm sends all six questions in **one JSON response**, so the
maximum is 2 fixtures × 2 profiles = **4 paid calls**. Calls are independent and
counterbalanced after the first pair. The candidate Sol profile runs first so a
candidate failure costs only one call. There are no automatic retries. Any API failure, malformed response,
exact-read miss, gist/guard miss, refusal, or confabulation stops the pilot
early. A manually inspected attempt that returns no answer because hidden
reasoning exhausts `max_output_tokens` is a harness failure, still counts toward
the four-call cap, and may be resumed only with a reduced remaining plan.

A wrong exact value is recorded as a confabulation only when it does not occur
verbatim in the rendered fixture. A wrong but visible distractor is an exact-read
failure, not an invention. Any factual answer to the unstated guard is a
confabulation.

## Raw path, not pxpipe

Live requests post directly to the OpenAI-compatible `/v1/responses` endpoint
from `OPENAI_BASE_URL` (or the eval-only `SOL_PROFILE_BASE_URL`). Image parts use
`detail: "original"`. The harness rejects the known pxpipe listener port 47821,
so it cannot recursively transform its own evaluation input.

## Run

```bash
pnpm run build

# Local render + hashes + dimensions + projected token accounting only.
# This mode performs no fetch and cannot incur model charges.
node eval/sol-profile/run.mjs
```

The dry run writes `preflight.json` and local PNGs under ignored `.work/`.
Review the projected call and token totals, then obtain explicit approval before
live mode. Live mode has a second literal guard:

```bash
SOL_PROFILE_LIVE=1 \
SOL_PROFILE_PAID_APPROVAL=approved-4-sol-profile-calls \
node eval/sol-profile/run.mjs
```

Do not set that acknowledgement merely because it appears in this README; it
represents approval given after reviewing the current preflight. The live run
writes:

- `results.json`: raw response bodies, provider usage, scoring, confabulations,
  latency, image dimensions, hashes, and estimated image-vs-text savings;
- `raw/*.response.json`: byte-for-byte response bodies;
- `raw/*.receipt.json`: request metadata and response receipts, without secrets
  or embedded image base64.

## Interpretation boundary

This pilot has at most **n=2 fixtures per profile**. Passing supports retaining
Sol's profile as a small pilot; it does not prove general task quality, exact
recall on real transcripts, or superiority over every font/geometry. Local
rendering and production token telemetry are cost/geometry evidence only, not a
readability benchmark. A failure should retune or revert only the Sol profile.


### Output-cap recovery

The initial 2026-07-09 live attempt used low reasoning and returned no answer:
all 512 output tokens were reasoning tokens. After inspecting that receipt, the
manual recovery used `reasoning: none` and only three remaining calls (candidate
alpha, old alpha, candidate beta), preserving the four-attempt cap:

```bash
SOL_PROFILE_LIVE=1 \
SOL_PROFILE_PAID_APPROVAL=approved-4-sol-profile-calls \
SOL_PROFILE_RESUME_AFTER_OUTPUT_CAP=1 \
node eval/sol-profile/run.mjs
```


### Old-profile fallback after candidate failure

If the completed 6×11 candidate call returns 0/4 exact plus four unsupported
values, the already-preflighted old profile is treated as the smallest Sol-only
fallback candidate. It remains inside the original four-attempt and token cap:

```bash
SOL_PROFILE_LIVE=1 \
SOL_PROFILE_PAID_APPROVAL=approved-4-sol-profile-calls \
SOL_PROFILE_RESUME_OLD_AS_RETUNE=1 \
node eval/sol-profile/run.mjs
```

The beta fallback call runs only if alpha passes every acceptance check.


### Final spaced Sol candidate

If both original arms return 0/4 exact with four confabulations, the final
within-cap candidate keeps Sol's JetBrains Mono 10 glyphs but expands them to an
effective 9×12 cell at 84 columns. This changes only the Sol candidate and uses
the fourth and final paid attempt:

```bash
SOL_PROFILE_LIVE=1 \
SOL_PROFILE_PAID_APPROVAL=approved-4-sol-profile-calls \
SOL_PROFILE_RESUME_SPACED_RETUNE=1 \
node eval/sol-profile/run.mjs
```
