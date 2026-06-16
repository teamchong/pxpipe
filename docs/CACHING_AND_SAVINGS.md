# Prompt-caching alignment & honest savings math

This doc answers two questions that keep coming up:

1. **How does pxpipe stay aligned with Anthropic's prompt cache** when it rewrites
   the bulky parts of a request into images? (Rewriting the prefix normally
   *destroys* a warm cache — why doesn't that sink the whole idea?)
2. **How do we compute "savings" without counting the prompt-caching discount as
   if pxpipe earned it?** Caching is a discount Anthropic gives *both* the
   pxpipe and the no-pxpipe path. If we let it land on only our side of the
   ledger we'd be inflating the number. This explains the accounting that
   prevents that.

Source of truth in code: `src/core/baseline.ts` (the math) and
`src/core/transform.ts` (the cache-aligned splice). This doc is the prose
version of the comments there — if they ever disagree, the code wins.

---

## Part 0 — Background: how Anthropic prompt caching actually works

Everything below follows from one invariant:

> **Prompt caching is a prefix match. Any byte change anywhere in the prefix
> invalidates the cache for everything after it.**

Concretely:

- The cache key is derived from the **exact bytes** of the rendered prompt up to
  each `cache_control` breakpoint.
- Render order is **`tools` → `system` → `messages`**. A breakpoint caches
  everything rendered before it.
- A breakpoint is a `"cache_control": {"type": "ephemeral"}` marker on a content
  block. **Max 4 per request.**
- The cached prefix has to clear a **minimum size** or it silently won't cache
  (no error, just `cache_creation_input_tokens: 0`). On **Fable 5 that floor is
  2048 tokens** (pxpipe is Fable-5-only, so that's our number).
- **Pricing**, relative to the base input rate:

  | bucket | what it is | rate |
  |---|---|---:|
  | `input_tokens` | uncached input, paid in full | **1.0×** |
  | `cache_creation_input_tokens` (`cc`) | tokens written to cache this turn (5-min TTL) | **1.25×** |
  | `cache_read_input_tokens` (`cr`) | tokens served from a warm cache | **0.1×** |
  | output | the model's reply (never cached, never compressed) | 5× input on Fable 5 |

- The response `usage` block reports `input_tokens`, `cache_creation_input_tokens`,
  and `cache_read_input_tokens`. **Total prompt size = the sum of all three.**

The economics that make caching matter: a warm read is **~10×** cheaper than
paying full freight, but the *first* turn that establishes a cache entry pays a
**1.25× write premium**. So a stable prefix that's reused across turns is very
cheap after turn 1; a prefix that changes every turn is *more* expensive than
not caching at all (you pay the 1.25× write every time and never read).

That last sentence is the whole problem pxpipe has to solve.

---

## Part 1 — Cache alignment: why rewriting the prefix doesn't break caching

### 1.1 The hazard

Claude Code's request is mostly a big, **stable prefix** — system prompt, tool
docs, `<system-reminder>` blocks, older history — followed by a small,
**per-turn tail** (your new message). Claude Code marks the end of that stable
prefix with a `cache_control` breakpoint, so from turn 2 on the prefix is served
from cache at 0.1×.

pxpipe rewrites parts of that stable prefix into PNGs. The naive way to do that
would **change the cache key**: a prefix that used to be 25k text tokens is now
~2.7k image tokens with different bytes. Anthropic sees a brand-new prefix,
can't match the old cache entry, and charges `cache_create` (1.25×) on the new
content. If pxpipe re-decided every turn — text one turn, image the next — it
would pay that write premium *repeatedly* and never settle into a warm read.
That's "gate flapping," and it's a money-loser.

### 1.2 The rule: relocate the marker, never add one

pxpipe's invariant (the code calls it **Task #21**, in `transform.ts`):

> **pxpipe NEVER adds its own `cache_control` marker. It only *relocates* a
> marker the caller already set, moving it onto the LAST image block produced
> from that content.**

Why this matters:

- It **doesn't spend any of the 4-breakpoint budget.** The number and rough
  position of breakpoints is whatever Claude Code chose; pxpipe just follows the
  text→image flip with the marker so the breakpoint still sits at the *end of
  the same logical content*.
- The cache **anchors at the end of the rewritten static block**, so the
  per-turn *user* content that follows it stays *outside* the cached region and
  doesn't pollute the key. (The per-turn *system* blocks — `<env>` etc. — are
  handled separately, by keeping them out of the image entirely; see 1.3.)

### 1.3 Split static from dynamic *before* imaging

The first move is the one that makes the whole thing cache-safe. Claude Code
mixes a large **static** slab (the system prompt, agent defs, tool docs) with a
handful of **per-turn dynamic** blocks injected into the system text —
`<env>`, `<context>`, `<git_status>`, `<directoryStructure>`,
`<system-reminder>` (the `DYNAMIC_BLOCK_TAGS` list in `transform.ts`). Those
dynamic blocks carry cwd, git branch, today's date, etc., so **their bytes drift
turn-to-turn.**

`splitStaticDynamic` pulls them apart:

- the **static slab** → rendered into the image (this is the cache anchor);
- the **dynamic slab** → forwarded as cheap **text** in the `system` field, never
  imaged.

The reason is exactly the prefix invariant: if a drifting `<env>` block were
baked *into* the image, the image's bytes would change every turn and its cache
entry would die every turn. Keeping the volatile blocks out of the image is what
lets the imaged slab stay byte-identical across turns. There's even a canary —
any *unrecognized* tag-shaped block left in the static slab is surfaced as
telemetry (`unknownTags`), so a future Claude Code release that ships a new
per-turn tag can't silently get baked into the cache.

### 1.4 The cache-friendly splice

After the split, the request is laid out like this (verified against the splice
at the end of `transformRequest` in `transform.ts`):

```
system:  [ billing line ]            ┐ cheap text, NO cache_control
         [ dynamic blocks: <env>… ]  │ (the drifting per-turn slab)
         [ sysRemainder ]            ┘

messages[0] (user):
         [ image block ]            ┐ static, rendered slab
         [ image block ]            │
         [ image block ] ← cache_control   (caller's relocated marker = breakpoint)
         [End of rendered context.] ┐ static text closer for the image
         [ processed existing content ]  ← per-turn user content (incl. reminder
                                            images), NO cache_control
```

Two mechanical constraints drive this shape:

- **Images can only live in a `user` message.** Anthropic's `system` field
  accepts text blocks only — an image there returns
  `400 system.N.type: Input should be 'text'`. So pxpipe moves the imaged slab
  into the first user message; the `system` field is left holding only cheap
  text (billing line + the dynamic slab + any non-text `sysRemainder`).
- **The marker rides the last image.** Whatever block the caller had marked
  (the last static system block, a `<system-reminder>`, etc.), its `cache_control`
  is re-attached to the final image produced from that content, so the breakpoint
  lands right where the static content ends. The per-turn user content that
  follows the closer sits *after* that breakpoint, so it never pollutes the image
  cache key.

The net effect: the imaged slab is *itself* a stable, cacheable prefix. Once it's
written once, every later turn reads it back at 0.1× — exactly like the text
prefix did, but over ~9× fewer tokens.

### 1.5 The one-time "burn" and the anti-flapping gate

There's no free lunch on the **turn pxpipe first flips text→image** (or flips
back). The new image prefix has a different cache key from whatever was warm
before, so that turn pays `cache_create` (1.25×) on the image prefix instead of
`cache_read` (0.1×) on the old text prefix. The profitability gate accounts for
this with a **symmetric burn term** (`isCompressionProfitable` in
`transform.ts`):

```
burnImageSide = priorWarmTokens      × (CACHE_CREATE_RATE − CACHE_READ_RATE)   // = ×1.15
burnTextSide  = priorWarmImageTokens × (CACHE_CREATE_RATE − CACHE_READ_RATE)

compress iff   imageTokens + burnImageSide  <  textTokens + burnTextSide
```

> ⚠️ **Implementation note:** the burn term is applied **undivided** — it is *not*
> divided by the horizon. (A JSDoc line on `PxpipeOptions.priorWarmTokens` writes
> `… / N`, but every call site — `evalCompressionProfitability`,
> `isCompressionProfitable`, `isCompressionProfitableAmortized` — computes
> `priorWarmTokens × (CACHE_CREATE_RATE − CACHE_READ_RATE)` with no division. The
> code, not that comment, is authoritative.)

The two knobs are what keep the gate from flapping:

- `priorWarmTokens` — tokens the *un-rewritten* (text) prefix would have read
  warm. Charged to the **image** side (flipping to image burns the warm text
  cache, so it discourages compressing while text is warm).
- `priorWarmImageTokens` — tokens the *image* prefix is holding warm. Charged to
  the **text** side (flipping back to text burns the warm image cache).

Without the symmetric term the gate ping-pongs: per-turn cost favors flipping,
the flip forces a fresh `cache_create`, and the next turn flips back — paying the
write premium twice. The burn pins the session in its current mode unless the
per-turn delta genuinely exceeds the flip cost. Cold-start safe: both default to
0, which disables the burn entirely (correct for turn 1 of a fresh conversation).

### 1.6 Where the horizon *does* divide: the history-collapse gate

Separately, the **history-collapse** call site uses
`isCompressionProfitableAmortized`, which is where `historyAmortizationHorizon`
(`N`) earns its keep. It compares *expected lifetime cost* over `N` turns —
worst-case-warm for the image (one `cache_create`, then `cache_read` for turns
2..N) against best-case-warm for the text (`cache_read` every turn):

```
accept the collapse iff   I × (CC + CR×(N−1))  <  T × CR × N
                          where CC = 1.25, CR = 0.10
```

So `N` scales the *main* image-vs-text comparison (e.g. `N=1` ⇒ collapse almost
never wins, `N=10` ⇒ collapse wins when `I < 0.47·T`), while the burn term above
is added on top, undivided. The framing is "assume this prefix gets reused `N`
more times; decide once; eat the loss if the session ends early" — the same logic
as JIT tiered compilation deciding whether to optimize a hot path. Falls back to
the cold per-turn gate when `N ≤ 1`.

> **Takeaway for Part 1:** pxpipe doesn't fight the cache — it rebuilds an
> *equivalent, smaller* cacheable prefix and moves the existing breakpoint to the
> end of it. The cache keeps working; it just covers fewer tokens.

---

## Part 2 — Savings math: how the cache discount is kept *out* of "savings"

### 2.1 The trap we're avoiding

The cache discount is something Anthropic would give **either path**. If you had
*not* run pxpipe, your text prefix would still cache and still read at 0.1× from
turn 2 on. So if we measured pxpipe's savings as "full-price text vs.
cache-discounted image," we'd be crediting pxpipe with a discount the no-pxpipe
path also gets. That double-counts caching as if pxpipe earned it.

The fix is to **apply identical cache pricing to both sides of the same
request**, so the discount cancels in the subtraction and only the *token
reduction* survives as savings.

### 2.2 The measurement (both sides, same request, same moment)

For every `/v1/messages` POST, the proxy does three things in parallel
(`proxy.ts`):

1. **Forward the real (compressed) request** and read its actual `usage` block:
   `input_tokens`, `cc`, `cr`. This is what pxpipe *actually cost*.
2. **`count_tokens` probe on the ORIGINAL, pre-compression body** → `baseline`.
   This is the counterfactual: "what would the request have been if pxpipe were
   off?" `count_tokens` is free and runs concurrently, so it adds no billed cost
   and ~no latency.
3. **`count_tokens` probe on the original body truncated at the last
   `cache_control` marker** → `baselineCacheable`. This is the size of the prefix
   that *would have cached* on the unproxied path.

All three land in the same row of `~/.pxpipe/events.jsonl`, so there's **no
turn-count or run-to-run confound** — both arms are the same request at the same
instant.

### 2.3 The proxied (actual) side — `computeActualInputEff`

```ts
actual_eff = input_tokens
           + cc × 1.25      // CACHE_CREATE_RATE
           + cr × 0.10      // CACHE_READ_RATE
```

Straight from the billed usage block. No modeling — these are the numbers
Anthropic actually charged.

### 2.4 The counterfactual side — `computeBaselineInputEff`

This is the subtle part. We have to reconstruct what the **unproxied** request
would have been billed *against an unproxied cache that had been built up
turn-by-turn the same way*. We infer its cache class from the proxied request's
observed `cc`/`cr`:

```
cacheable = min(baselineCacheable, baseline)   // the would-have-cached prefix
coldTail  = baseline − cacheable               // always-cold tail (both paths)
```

Then split `cacheable` into create/read/cold buckets by the turn's cache class:

| case | condition | `ccU` (created) | `crU` (read warm) |
|---|---|---|---|
| **warm turn** | `cr > 0` | `min(cc, cacheable)` | `cacheable − ccU` |
| **cold start** | `cr == 0, cc > 0` | `cacheable` | `0` |
| **no caching** | `cc == 0, cr == 0` | `0` | `0` (whole body at 1.0×) |

```
baseline_eff = ccU × 1.25
             + crU × 0.10
             + (cacheable − ccU − crU) × 1.0   // any cacheable remainder, cold
             + coldTail × 1.0
```

The key modeling assumption (warm case): the proxied path's `cc` bucket is
**approximately the new per-turn tail** — the user-typed content this turn, which
pxpipe **does not compress**. That same tail exists byte-for-byte on the
unproxied path, so the unproxied path pays *roughly the same absolute `cc`* at
1.25×, and reads the rest of its (larger) cacheable prefix at 0.10×.

> **Why this rewrite was necessary.** An earlier, naive baseline collapsed the
> whole counterfactual into one cache weight (`cr>0 ? 0.1 : cc>0 ? 1.25 : 1.0`).
> On any warm turn with mixed `cc`/`cr` it attributed 100% of the unproxied
> prefix to `cr × 0.1`, making the unproxied path look 12.5× too cheap and pxpipe
> look like it *lost money*. The 7-event May-2026 regression went from −9,786
> "saved" tokens (pre-fix) to +19,452 (post-fix). Don't revert to a single-weight
> baseline.

### 2.5 Savings = the difference (caching already cancelled)

```
savings_eff (input) = baseline_eff − actual_eff
```

Output tokens are **excluded from both sides** — they're identical on the two
paths (pxpipe never touches the response) and accumulate in their own dashboard
bucket. For the **dollar** headline, both sides are converted with the same
Fable 5 list ratios — `input ×1.0, cache_write ×1.25, cache_read ×0.1,
output ×5` — and since those weights are applied identically on both arms, the
caching discount and the output cost both cancel out of the *difference*. What's
left is purely the text→image token reduction.

### 2.6 Worked example (a warm turn)

Say a mid-session turn looks like this:

- Original body: **30,000 tokens**, of which **28,000** are the cacheable prefix
  (`baseline = 30000`, `baselineCacheable = 28000`), so `coldTail = 2000`.
- pxpipe images that prefix down to ~3,000 image tokens. The real response bills
  `input_tokens = 2000`, `cc = 1000`, `cr = 3000`.

**Counterfactual (unproxied), warm case** (`cr > 0`):

```
cacheable = 28000,  coldTail = 2000
ccU = min(cc, cacheable) = min(1000, 28000) = 1000
crU = 28000 − 1000 = 27000
baseline_eff = 1000×1.25 + 27000×0.10 + 0×1.0 + 2000×1.0
             = 1250 + 2700 + 0 + 2000
             = 5,950 token-equivalents
```

**Proxied (actual):**

```
actual_eff = 2000 + 1000×1.25 + 3000×0.10
           = 2000 + 1250 + 300
           = 3,550 token-equivalents
```

**Savings this turn:** `5950 − 3550 = 2,400` token-equivalents (~40%).

Notice the `cc` term is **1,250 on both sides** — the same new tail, the same
1.25× write, it cancels in the subtraction and contributes nothing to savings.
And the cache *discount* applies to both: the unproxied path reads 27,000 text
tokens at 0.1× (= 2,700), the proxied path reads 3,000 image tokens at 0.1×
(= 300). Caching helped both arms; the win is that the proxied arm has **9× fewer
tokens sitting under that same discount**. That — not the cache discount — is
what pxpipe is credited with.

---

## Part 3 — Reproduce it yourself

Every row in `~/.pxpipe/events.jsonl` carries both arms of the same request.
**The JSONL uses shortened key names** (mapped from the Anthropic usage block in
`tracker.ts` → `toTrackEvent`):

- `baseline_tokens` — `count_tokens` on the original body (full counterfactual)
- `baseline_cacheable_tokens` — `count_tokens` truncated at the last
  `cache_control` marker (omitted/`0` if the body had no markers)
- the billed `input_tokens`, `cache_create_tokens` (← Anthropic's
  `cache_creation_input_tokens`), and `cache_read_tokens` (← Anthropic's
  `cache_read_input_tokens`) from the real response. (A 1-hour cache tier, if
  ever used, splits out as `cache_create_5m_tokens` / `cache_create_1h_tokens`.)

Feed those four numbers per row through `computeBaselineInputEff` and
`computeActualInputEff` (both exported from `src/core/baseline.ts`), sum the
differences, convert with the list ratios above, and you've re-derived the
headline. The proxy, the live dashboard, and the JSONL replay all call the **same
two functions** so the three views can't drift.

### Edge cases worth knowing

- **No `cache_control` markers in the body** → `cacheable = 0`, so the entire
  baseline is billed cold at 1.0× on both sides. (This is also what happens when
  the cacheable-prefix probe fails; see the `partial`/`unmeasured` status flags
  in `transform.ts` so a failed probe is recorded rather than silently treated as
  `cacheable = 0`, which would bias savings downward.)
- **Body below the 2048-token cacheable floor** → `cc == 0 && cr == 0`; the
  marker is ignored by Anthropic and both paths pay the whole body at 1.0×.
- **Output is never in this math.** It's identical on both arms and lives in its
  own accumulator.

---

## One-paragraph summary

pxpipe stays cache-aligned by rebuilding an *equivalent but smaller* cacheable
prefix out of images and **relocating** the caller's existing `cache_control`
marker onto the last image — it never adds a marker of its own, so the cache
breakpoint still sits at the end of the same logical content and the per-turn
tail stays outside the cached region. The one-time `cache_create` "burn" on the
flip turn is charged to whichever side would force it, which pins the gate
against mode-flapping; the history-collapse gate separately weighs image-vs-text
cost over an expected reuse horizon. Savings are then measured by pricing
**both** the real request and a
`count_tokens` counterfactual of the original body with the **same** cache rates
(create 1.25×, read 0.1×) at the **same moment** — so the caching discount
appears identically on both sides and cancels in the difference. What remains as
"savings" is only the token reduction from turning dense text into images, never
the prompt-caching discount itself.
