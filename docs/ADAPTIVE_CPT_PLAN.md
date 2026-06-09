# Adaptive chars-per-token plan (Task #18)

Status: **plan locked, not implemented**. This doc captures the data analysis
and the chosen design so a future session (or rollback reader) can re-derive
the same plan without re-running the telemetry queries.

## 1. The problem

`isCompressionProfitable` in `src/core/transform.ts` decides whether a text
block buys more tokens than the image that would replace it. The math is
`textTokens = textLen / CHARS_PER_TOKEN` vs `imageTokens = imageCount × 2500`.
Today `CHARS_PER_TOKEN` is a hand-tuned constant per content shape:

```ts
CHARS_PER_TOKEN        = 4    // default fallback
SLAB_CHARS_PER_TOKEN   = 2.5  // static slab (JSON-dense system text)
HISTORY_CHARS_PER_TOKEN= 2.5  // history-rendered text
```

The 2.5 came from `count_tokens` baselines on the system slab body
(N=354 events, body cpt median 1.17, p95 2.5, MAX 2.62). 2.5 was picked as
a conservative upper bound so the gate never accidentally rejects a profitable
slab compression.

Empirical re-measurement (`grep baseline_tokens events.jsonl`, N=1148) shows
**this constant is wrong for ~everything except the system slab**:

```
big group sys=3714e01d  N=87 slab-only turns
  baseline_tokens ≈ 0.667 × outgoing_text_chars + 19,888
  marginal cpt = 1/0.667 = 1.50 chars/token
  intercept ≈ 19,888 tokens (matches static_chars=27,198 at cpt=1.37)
```

For *tool_result-heavy* turns the marginal cpt is higher (1.6–2.9 across
smaller systems), and for reminder text we have no clean single-bucket sample
yet. The current 2.5 default **under-counts the real token cost of every
non-slab compression by ~40 %**, biasing the gate toward passthrough exactly
where compression would actually win.

The fix: stop using one global constant. Bucket text by *block role* and
maintain a separate cpt per bucket, learned from production telemetry.

## 2. The block-role taxonomy

Six buckets, mapped to existing gate call sites:

| Bucket               | Source                                                                 | Gate call site                          |
|----------------------|------------------------------------------------------------------------|-----------------------------------------|
| `static_slab`        | `staticText` from `splitStaticDynamic(sysBody)`                        | line ~1411 (slab break-even)            |
| `reminder`           | `<system-reminder>…</system-reminder>` blocks in first user message    | line ~1523 (per-block reminder gate)    |
| `tool_result_json`   | `tool_result` content classified `'structured'` by `classifyContent`   | line ~1591 / 1638 (per-block TR gate)   |
| `tool_result_log`    | `tool_result` content classified `'log'`                               | same gate                               |
| `tool_result_prose`  | `tool_result` content classified `'other'`                             | same gate                               |
| `history`            | `messages[]` text collapsed by `collapseHistory`                       | line ~1716 (history pre-render gate)    |

The `classifyContent` heuristic already exists at `transform.ts:1031`. We just
need to wire it into the gate call sites and into telemetry attribution.

## 3. How the cpt gets learned

### 3a. Per-event char attribution (Phase 1 — telemetry)

Add to `TrackEvent` (in `src/core/tracker.ts`) a new optional field:

```ts
bucket_chars?: {
  static_slab?: number;       // length of staticText
  reminder?: number;          // Σ reminder block .text.length, pre-compression
  tool_result_json?: number;  // Σ tool_result text where classifyContent='structured'
  tool_result_log?: number;   // Σ tool_result text where classifyContent='log'
  tool_result_prose?: number; // Σ tool_result text where classifyContent='other'
  history?: number;           // chars folded into history image (Variant C)
};
```

These sums are taken **pre-compression** (before any block decides to render).
The sum across buckets equals `origChars` minus the dynamic-slab text (which
is never compressed). This makes the bucket counts the natural regressors for
`baseline_tokens`.

`transformRequest` already touches every block during its gate loop. We
accumulate into a `bucketChars` object alongside the existing `info` counters
and emit it on every event, *whether or not* the block was actually compressed.
That way passthrough events also contribute samples.

### 3b. Per-block-type regression (Phase 2 — the gate update)

For a single `system_sha8`, with N≥20 cold-miss events bearing `baseline_tokens`,
fit an ordinary least-squares model:

```
baseline_tokens ≈ Σ_b (chars_b / cpt_b) + image_cost
                = Σ_b α_b · chars_b + β · image_pixels
```

where `α_b = 1 / cpt_b` is the per-bucket marginal token rate and
`β ≈ 4/750 ≈ 0.00533` is the area-proportional image rate (fixed from
Anthropic's published formula; we don't fit it).

Subtract the image cost first to get a pure text regression:

```
text_tokens_observed := baseline_tokens − β · image_pixels
text_tokens_observed ≈ α_slab·c_slab + α_rem·c_rem + α_trj·c_trj + α_trl·c_trl + α_trp·c_trp + α_hist·c_hist
```

Six unknowns, no intercept (because at zero chars we owe zero text tokens).
Hand-rolled Gauss-Jordan inversion on a 6×6 symmetric `XᵀX` is ~80 LOC of
dependency-free TypeScript; fine for the Node side. **No fit runs in the
Workers code path** — Workers always uses the baked default table.

Outputs `cpt_b = 1/α_b` for each bucket. If `α_b ≤ 0` (anti-correlated or
noise-dominated), fall back to the baked default for that bucket only.

### 3c. State file

Persist learned cpts at `~/.pxpipe/cpt-state.jsonl`, one line per
`system_sha8`:

```json
{
  "system_sha8": "3714e01d",
  "updated_at": "2026-05-21T00:00:00Z",
  "n_events": 87,
  "cpt": {
    "static_slab": 1.50,
    "reminder": null,            // null = insufficient data, use default
    "tool_result_json": null,
    "tool_result_log": null,
    "tool_result_prose": null,
    "history": null
  }
}
```

The CLI refresh task (existing `dashboard.ts` cold-miss path is the natural
hook) re-runs the regression whenever a new event for that system lands.
Reader caches the file mtime per-process.

### 3d. Gate wiring

`isCompressionProfitable` grows an optional `bucket` argument:

```ts
isCompressionProfitable(
  textOrLen: string | number,
  cols: number,
  imageCountCap: number | undefined,
  numCols = 1,
  charsPerToken: number = CHARS_PER_TOKEN,
  bucket?: BlockBucket,        // NEW
): boolean
```

When `bucket` is provided AND a learned cpt exists for `(system_sha8, bucket)`,
use that. Otherwise fall back to the explicit `charsPerToken` (call sites
already pass `SLAB_CHARS_PER_TOKEN` and `HISTORY_CHARS_PER_TOKEN` correctly).
This keeps the signature backward-compatible and the Workers path untouched.

The `system_sha8` is computed once per request in `transformRequest`
(`info.systemSha8`) and is available before any gate fires.

## 4. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Buckets are correlated (reminder & tool_result_prose grow together) → unstable slopes | Min N=20 per system before activating; refresh slope only when condition number of `XᵀX` < 100; fall back to default otherwise |
| Outlier event poisons the slope (raw OLS, no robust regression) | Drop events with `\|residual\| > 3·stdev` after a pilot fit; ship as warning in dashboard. User chose raw slopes accepting this risk |
| Workers can't read sidecar → divergent behavior between node and worker runtimes | Spec'd: Workers always uses baked defaults. Dashboard surfaces which path is in use |
| Bucket attribution drift if `classifyContent` rules change | `classifyContent` heuristic is already exported and unit-tested; any change requires re-fit (cleared by version-stamping the state file) |
| New `system_sha8` (fresh project) has zero samples | Falls through to baked default 2.5 / 4; same behavior as today |

## 5. Acceptance criteria

1. New telemetry fields are emitted on **every** request, including
   passthrough events, and the existing dashboard read path is unbroken.
2. With N=20 cold-miss events for a single `system_sha8`, the regression
   produces a per-bucket cpt table; OR explicitly falls back if the fit is
   degenerate (and logs the reason).
3. The gate fires per-block-type cpt when one exists, and the dashboard
   surfaces a "cpt source" line per request: `default` | `learned`.
4. A regression test in `tests/proxy-usage.test.ts` plays the existing 87
   slab-only events through the new pipeline and recovers cpt ≈ 1.50 ± 0.05
   for `static_slab`.
5. `npm run typecheck && npm run test && npm run build` all stay green.

## 6. Phasing

**Phase 1 (ship first, ~half day):**
- Add `bucket_chars` to `TrackEvent` and `Info`.
- Thread bucket attribution through the gate loop in `transformRequest`.
- Update `tracker.ts` to serialize the field.
- Update `sessions.ts` and `dashboard.ts` to pass the field through
  unchanged (no display yet — just don't drop it).
- Tests: assert bucket sums == `origChars − dynamicChars` on a known fixture.

Phase 1 ships **without changing gate behavior**. Data starts accumulating.

**Phase 2 (~1 day, after a few days of Phase 1 data):**
- Add `src/cpt-store.ts` (node-only, fs-touching).
- Add 6×6 OLS in `src/cpt-fit.ts` (pure TS, no deps).
- Wire `bucket` argument into `isCompressionProfitable` and all call sites.
- Add "cpt source" line to dashboard.
- Regression test against captured events.

The split is real: Phase 1 collects the data we need to *validate* Phase 2's
fit before the gate changes behavior. If Phase 1 surfaces a surprise (e.g.,
reminder cpt comes back near 4, matching the default — meaning we left
nothing on the table), Phase 2 might shrink in scope.

## 7. Out of scope

- Changing the image cost formula (β stays at 4/750).
- Adapting cpt for assistant-prose blocks (those are billed in *output*
  tokens, not input; the gate doesn't touch them).
- Cross-session cpt sharing (each `system_sha8` is independent — projects
  drift apart over time and a shared cpt would be wrong for outliers).
- Online learning / streaming regression. We re-fit from the full sample on
  every refresh; sample sizes are small enough (≤1000 events) that this is
  cheap.
