# Coverage routing: heavy one-off analyses vs. light repeatable requests

This doc describes `classifyRequestWeight` (`src/core/applicability.ts`), the
C9+C10 answer to: *given a request pxpipe is already allowed to touch, should
it get today's full compression, or should pxpipe back off and respect a
cache prefix the caller has already established?*

It's the routing companion to [`TRANSFORM_INFO.md`](./TRANSFORM_INFO.md) §9
("What deliberately did NOT get built"), which at the time explicitly rejected
"smart heuristics for should I compress this." That call stands for the
*existing* per-block gates (`minReminderChars`, `minToolResultChars`,
`isCompressionProfitable`, `bumpPassthrough`) — those are simple, predictable,
and stay untouched. C9+C10 is a narrower, additive question one layer up:
*before* any block-level gate runs, is this whole request a "heavy" one-off or
a "light" repeatable turn? Recording that distinction here so the next
contributor sees it as a conscious, scoped exception, not a relitigation.

- `src/core/applicability.ts` — `classifyRequestWeight`, thresholds, types
- `tests/applicability-routing.test.ts` — the decision table below, exercised
- `src/core/measurement.ts` — `countCacheControlMarkers` (the marker-count input)

---

## 1. Status: additive, shadow-only in the live path

`classifyRequestWeight` is a pure, read-only function. Like
`shouldTransformAnthropicMessages` in the same file, it is not allowed to make
the live routing decision yet. `src/core/proxy.ts` calls it only when
`PXPIPE_ROUTING_SHADOW=1`, then persists the result as
`routing_shadow_*` telemetry in JSONL. The proxy still runs the same
transform/upstream path it would have run with the flag off. Turning the
classifier into an actual router is a separate, flag-gated change and must be
justified by telemetry first.

---

## 2. The question: heavy or light?

| | Heavy | Light |
|---|---|---|
| Typical shape | Large, one-off document / analysis | Small, one of many turns in an ongoing session |
| Chance the exact prefix repeats | Low | High — caller already treats it as reusable |
| Right move today | Full compression (current unconditional behavior) | Don't re-render; respect the caller's own `cache_control` breakpoints |

"Heavy" is not a value judgment — it's "this content probably won't be asked
for again in this shape, so there's no cache prefix worth protecting; image
it." "Light" is "this content is part of an established, repeatable
back-and-forth; the caller (e.g. Claude Code itself) is already placing its
own `cache_control` breakpoints across turns, and pxpipe re-rendering it would
just bust a prefix that was about to be reused via Anthropic's own prompt
cache."

---

## 3. Why only PRE-transform signals

`TransformInfo` (`src/core/transform.ts`) carries the richest signal about a
request's shape — `staticChars`/`dynamicChars`, `systemSha8`/`firstUserSha8`
(session/thread fingerprints), `cachePrefixSha8`/`cachePrefixBytes`. All of it
is **computed by the transform itself**. A router that gates *whether to
transform* can't depend on output the transform hasn't produced yet.

So `classifyRequestWeight` only uses signals available cheaply, before any
transform work happens:

- **`bodyBytes`** — size of the incoming request body. Cheap proxy for
  `origChars`; no parsing required.
- **`existingCacheControlMarkers`** — count of `cache_control` markers already
  present in the *incoming* body, from `countCacheControlMarkers` in
  `measurement.ts`. A caller that already places its own breakpoints is
  signalling this session expects prefix reuse across turns — it costs one
  cheap JSON walk, no transform.
- **`messageCount`** — `messages.length`. Cheap proxy for "established
  multi-turn session" vs. "cold first shot"; just an array length, no block
  parsing.

None of these require rendering, splitting, or any of the expensive parts of
the pipeline — they're all available the moment the body is parsed as JSON.

---

## 4. Decision table

Evaluated top to bottom; first match wins. `bodyBytes`, `messageCount`, and
`existingCacheControlMarkers` are each optional (`null`/`undefined` = signal
not supplied by the caller).

| # | Condition | Tier | Reason |
|---|---|---|---|
| 1 | `bodyBytes >= HEAVY_BODY_BYTES_THRESHOLD` (200,000) | `heavy` | `large_body` |
| 2 | `existingCacheControlMarkers > 0` **and** (`bodyBytes` unknown **or** `bodyBytes <= LIGHT_BODY_BYTES_THRESHOLD` (32,000)) | `light` | `stable_prefix_established` |
| 3 | `bodyBytes <= LIGHT_BODY_BYTES_THRESHOLD` **and** `messageCount >= LIGHT_MIN_MESSAGE_COUNT` (2) | `light` | `small_repeated_turn` |
| 4 | *(none of the above)* | `heavy` | `insufficient_signal` |

Notes on the ordering:

- **Rule 1 is checked first and is unconditional.** A body at or above the
  heavy threshold routes `heavy` even if it also happens to carry
  `cache_control` markers — at that size, the one-request compression win
  dominates any hypothetical cache reuse, and per the recon brief, a jump that
  large is typically a one-off document dump, not a steady-state turn.
- **Rule 2 (markers) is the strongest "light" signal** — a caller managing
  its own breakpoints is a direct statement of intent to reuse this prefix,
  so it doesn't need `messageCount` corroboration. It still respects the size
  ceiling: a marker on a merely-not-huge-enough-for-rule-1 body isn't treated
  as light (falls through to rule 3, then to the rule-4 default).
- **Rule 3 (turn count) is the fallback "light" signal** when no marker count
  was supplied — a small body deep into a multi-turn conversation
  (`messageCount >= 2`) reads as repeatable even without explicit marker
  information.
- **Rule 4 is the conservative default: `heavy`.** Absent or ambiguous
  signals (including "no signals supplied at all") fall back to the *same
  outcome as today's unconditional behavior* — full compression — so a
  caller that doesn't populate the new optional fields sees no change at all.

---

## 5. Thresholds

Exported from `src/core/applicability.ts` for callers and tests — not magic
numbers buried in the function body:

| Constant | Value | Rationale |
|---|---|---|
| `HEAVY_BODY_BYTES_THRESHOLD` | `200_000` bytes | ~50k tokens at the gate's own `CHARS_PER_TOKEN = 4` (transform.ts) — well past a single document dump / large one-off analysis. |
| `LIGHT_BODY_BYTES_THRESHOLD` | `32_000` bytes | ~8k tokens — cheap enough that re-rendering it is not worth disturbing an established cache prefix. |
| `LIGHT_MIN_MESSAGE_COUNT` | `2` | At least one prior turn exists — an established back-and-forth, not a cold first shot. |

These are independent of (not derived from) `minCompressChars`/
`minReminderChars`/`minToolResultChars` in `transform.ts` — those gate
individual *blocks* post-transform; these gate the *whole request* pre-transform,
and operate in raw body bytes rather than per-block text chars, so reusing the
same constants across the two layers would be a coincidence, not a shared
invariant.

---

## 6. Example

```ts
import { classifyRequestWeight } from './src/core/applicability.js';

// A one-off 500 KB codebase dump on a fresh conversation → heavy.
classifyRequestWeight({ bodyBytes: 500_000, messageCount: 1 });
// => { tier: 'heavy', reason: 'large_body' }

// Turn 6 of an ongoing Claude Code session, small body, caller already
// placed its own cache_control breakpoint on the system block → light.
classifyRequestWeight({ bodyBytes: 3_000, messageCount: 6, existingCacheControlMarkers: 1 });
// => { tier: 'light', reason: 'stable_prefix_established' }
```

---

## 7. What this is not

- **Not a replacement for the existing block-level gates.** `minReminderChars`,
  `minToolResultChars`, `isCompressionProfitable`, and friends in
  `transform.ts` are unchanged and still the mechanism that decides whether an
  individual block gets imaged once a request is in the `heavy` pipeline.
- **Not a live router yet** (see §1) — it is wired only as opt-in shadow
  telemetry. Live routing behavior is unchanged until a follow-up task uses
  the recorded data to justify a guarded behavior flag.
- **Not based on `TransformInfo` output fields** (see §3) — deliberately, since
  those don't exist until after the decision this function makes.
