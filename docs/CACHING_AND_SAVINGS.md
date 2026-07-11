# Prompt-Caching Alignment And Honest Savings Math

This doc answers two questions:

1. How pxpipe stays aligned with Anthropic prompt caching when it rewrites bulky context into images.
2. How pxpipe reports savings without counting the provider cache discount as a pxpipe win.

Source of truth in code: `src/core/transform.ts` for the cache-aligned rewrite and `src/core/baseline.ts` for the accounting.

---

## Anthropic Prompt Cache Basics

Anthropic prompt caching is prefix-based:

- The cache key is derived from the exact rendered prompt bytes up to each `cache_control` breakpoint.
- Render order is `tools` -> `system` -> `messages`.
- A breakpoint is a `"cache_control": {"type": "ephemeral"}` marker on a content block.
- The response usage block reports `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`.
- Total prompt tokens for the actual request are `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.

Pricing relative to base input rate:

| bucket | meaning | rate |
|---|---|---:|
| `input_tokens` | uncached input | `1.0x` |
| `cache_creation_input_tokens` (`cc`) | cache write | `1.25x` |
| `cache_read_input_tokens` (`cr`) | cache read | `0.1x` |
| output | model reply | `5x` input on Fable 5 |

A stable prefix is cheap after it is cached, but a prefix that changes every turn repeatedly pays the write premium. pxpipe's cache-alignment work exists to keep the image prefix stable.

---

## Cache-Aligned Rewrite

Claude Code sends a large stable prefix: system prompt, tool docs, reminders, and older history. It also sends a small per-turn tail: the current user message and dynamic runtime context.

pxpipe rewrites only the bulky, cacheable parts into images. The dynamic parts stay as text so they do not pollute the image cache key.

The key invariant:

> pxpipe does not add new cache-control markers. It relocates the caller's existing marker onto the last image block produced from the same logical content.

That keeps the breakpoint at the end of the rewritten stable content. The provider then caches the image prefix exactly as it would have cached the text prefix, just with fewer input tokens under that cache entry.

The transformed request shape is:

```text
system:
  billing line / dynamic context / other text-only system content

messages[0] user:
  image block
  image block
  image block + cache_control
  [End of rendered context.]
  original user content / live tail
```

Images must be placed in a user message because Anthropic does not accept images in the `system` field.

---

## Gate And One-Time Burn

The raw compression gate compares image token cost with text token cost. For Anthropic, image cost is estimated from pixel area and text cost comes from the configured chars/token estimate for the relevant bucket.

Switching modes can also burn a warm cache. If a text prefix is warm and pxpipe flips to images, the first image turn may pay a cache write. If an image prefix is warm and pxpipe flips back to text, the text path may pay the write. The symmetric burn terms model that cost:

```text
burnImageSide = priorWarmTokens      * (1.25 - 0.10)
burnTextSide  = priorWarmImageTokens * (1.25 - 0.10)

compress iff imageTokens + burnImageSide < textTokens + burnTextSide
```

This is separate from dashboard savings. The gate decides whether to transform. The dashboard reports what the transformed request actually cost against the measured text counterfactual.

---

## Savings Accounting

The cache discount is provider behavior, not pxpipe savings. To avoid counting cache as savings, both sides use the same observed cache state:

- If the actual request has `cr > 0`, the imagined text baseline is priced warm too.
- If the actual request has `cr === 0`, the imagined text baseline is priced cold too.

pxpipe does not infer a warm text baseline from wall-clock TTL alone. The text request does not actually exist, so cache warmth for that counterfactual is based only on the real request's server-reported cache read.

For each `/v1/messages` request, pxpipe records three measurements:

1. Actual upstream usage from the transformed request: `input_tokens`, `cc`, `cr`, and output.
2. `baseline_tokens`: `/count_tokens` on the original body before compression.
3. `baseline_cacheable_tokens`: `/count_tokens` on the original body truncated at the last `cache_control` marker.

The actual input cost is:

```text
actual_eff = input_tokens + cc * 1.25 + cr * 0.10
```

The text baseline first splits the measured text tokens:

```text
cacheable = min(baseline_cacheable_tokens, baseline_tokens)
coldTail  = baseline_tokens - cacheable
```

If the actual request is cold (`cr === 0`):

```text
baseline_eff = cacheable * 1.25 + coldTail
```

If the actual request is warm (`cr > 0`):

```text
reused = min(prevCacheable, cacheable)
grown  = cacheable - reused

baseline_eff = reused * 0.10 + grown * 1.25 + coldTail
```

`prevCacheable` is used only after `cr > 0` proves a warm read. It refines how much of the text baseline was reused vs newly grown. If there is no completed same-session prior with the same static-prefix hash, pxpipe assumes full reuse for the text baseline: `prevCacheable = cacheable`. That is conservative for savings because it makes the text baseline cheaper.

Replay uses request start time (`ts - duration_ms`) to avoid overlapping requests refining each other's `prevCacheable` split before the earlier request had completed.

The savings number is then:

```text
savings_eff = baseline_eff - actual_eff
```

This can be negative when imaging actually costs more under the same cache state. Negative rows are not hidden or floored.

Rows without a trustworthy cacheable-prefix probe contribute zero savings rather than guessing. Uncompressed rows also contribute zero savings.

---

## Worked Examples

Assume a request whose original text baseline is `30,000` input tokens. Of those, `28,000` are before the cache-control marker, so `coldTail = 2,000`. pxpipe renders that prefix to `3,000` image tokens.

### Warm Request

The actual request reports `input_tokens = 2,000`, `cc = 1,000`, `cr = 3,000`. A prior completed row shows `prevCacheable = 27,000`.

```text
Text baseline:
  reused = min(27000, 28000) = 27000
  grown  = 28000 - 27000     = 1000
  baseline_eff = 27000*0.10 + 1000*1.25 + 2000
               = 2700 + 1250 + 2000 = 5950

Actual image request:
  actual_eff = 2000 + 1000*1.25 + 3000*0.10
             = 2000 + 1250 + 300 = 3550

Savings = 5950 - 3550 = 2400
```

The cache read discount applies to both sides. The win is that the warm image prefix is `3,000` tokens while the warm text prefix would have been `27,000` reused text tokens plus `1,000` grown text tokens.

### Cold Request

The actual request reports `input_tokens = 2,000`, `cc = 3,000`, `cr = 0`.

```text
Text baseline:
  baseline_eff = 28000*1.25 + 2000
               = 35000 + 2000 = 37000

Actual image request:
  actual_eff = 2000 + 3000*1.25
             = 2000 + 3750 = 5750

Savings = 37000 - 5750 = 31250
```

Both sides are cold. pxpipe is not credited for cache; it is credited because the cold image write is much smaller than the cold text write.

---

## Reproducing The Dashboard Math

Every row in `~/.pxpipe/events.jsonl` carries the fields needed to reproduce the input-side savings:

- `baseline_tokens`
- `baseline_cacheable_tokens`
- `input_tokens`
- `cache_create_tokens`
- `cache_read_tokens`
- `first_user_sha8`
- `system_sha8`
- `ts`
- `duration_ms`

Walk rows in completion order. For each session (`first_user_sha8`), keep the latest completed row's `baseline_cacheable_tokens`, `system_sha8`, and completion timestamp. For the current row:

1. Set `warm = cache_read_tokens > 0`.
2. If `warm` and the previous row completed before this request started and has the same `system_sha8`, use its `baseline_cacheable_tokens` as `prevCacheable`.
3. If `warm` but no usable prior exists, use this row's `cacheable` as `prevCacheable`.
4. If not `warm`, use `prevCacheable = 0`.
5. Compute `baseline_eff`, `actual_eff`, and `baseline_eff - actual_eff` with the formulas above.

The live dashboard and replay path both use `deriveBaselineWarmth`, `computeBaselineInputEff`, and `computeActualInputEff` from `src/core/baseline.ts`, so the UI and session summaries use the same math.

---

## Summary

pxpipe stays cache-aligned by replacing stable text context with stable image context and relocating the caller's existing cache marker to the end of the rewritten content. Savings are measured by comparing the real transformed request with a `/count_tokens` text counterfactual under the same observed cache state. If the actual request read cache, both sides are warm. If it did not, both sides are cold. Therefore the provider cache discount is not counted as pxpipe savings; the reported savings are only the token reduction from text to images.

---

## OpenAI / Responses Path (Codex And Friends)

Codex is supported. The wire protocol is `/v1/responses` (and, when present,
chat-completions-shaped OpenAI paths). pxpipe images the same two buckets as
on Anthropic: the static slab (system + tool docs + large stable context) and,
when the closed history prefix clears a token floor and the profitability gate,
older history.

The savings number is still "text counterfactual under the same observed cache
state minus the imaged request." OpenAI usage reports `cached_tokens` as a
subset of `input_tokens` (not a separate cache-create / cache-read pair). The
math lives in `src/core/openai-savings.ts`:

```text
actual_eff   = uncached + cached * cache_read_rate(model)
baseline_eff = actual_eff + (baseline_imaged_tokens - image_tokens)
               * (cache_read_rate(model) if cached > 0 else 1.0)
```

`cache_read_rate` is model-based on the shared Responses path (Claude 0.1,
gpt-5 0.1, Grok 0.25). The provider cache discount is applied to both sides, so
it is never counted as a pxpipe win.

### What actually drives savings

Savings track **how much uncached bulk the client still re-sends as text**, not
the product name and not the path alone.

| Client shape | What the proxy sees each turn | Typical result |
|---|---|---|
| Claude Code on `/anthropic/messages` | Large system + tools + history re-sent as text; Anthropic cache markers on a stable prefix | High savings once imaged (~60–70% on dense traffic) |
| Codex / OpenAI Responses with a warm prompt cache | Most of the prompt already `cached_tokens`; only the static slab and rare history collapses are imageable | Low % when history does not collapse; the % is honest |
| Same Responses path, history collapse fires | Closed prefix large enough and profitable → many history images | Meaningful savings (measured gpt-5 collapsed warm rows ~40%) |
| OpenAI client that re-sends the full transcript as plain text every turn (classic chat-completions style, cold or no useful cache) | Large uncached bulk every request | Same class of win as Claude Code: the gate has real text to beat |

Measured on local `/v1/responses` rows (same endpoint, different models):

| Family | Cached share of input | History collapse | Computed saved |
|---|---:|---|---:|
| claude (Codex → Opus) | ~98% | was blocked by a row-count gate bug; should collapse after the ↵ fix | was ~1% slab-only; re-measure on live Codex |
| grok | high on warm multi-turn | **collapsed** after ↵ gate fix | ~**35%** on collapsed Responses rows (n=35 post-fix); fixture image+factsheet ~70% |
| gpt-5 | ~73% | often | ~34% overall; ~42% on collapsed warm rows |

Render profiles are selected by exact model id, not by the shared Responses
path. Opt-in `gpt-5.6-sol` uses 126 columns with a 6×11 JetBrains Mono atlas;
Claude uses 312 columns with the 5×8 Spleen atlas. Grok remains **opt-in** and
uses **5×8** / 152 columns at maxHeight 512 with white AA (**no grid**) plus an
in-image IDS block and the text factsheet (exact IDs). Pure-image alone is not
Fable-level on live multi-seed. See
[eval/grok-density/QUALITY_RESULTS.md](../eval/grok-density/QUALITY_RESULTS.md).

Those profile and savings numbers are not recall evidence. The Sol raw-image
pilot separately tested both 6×11/126 and old 5×8/152: each scored 0/4 exact
with four confabulations, and 5×8 also missed gist. Sol is therefore off by
default; production's fact-sheet remains an important exact-token fallback for
operators who explicitly opt in. The locally rendered Sol 9×12 retune remains
untested. See
[`eval/sol-profile/RESULTS.md`](../eval/sol-profile/RESULTS.md).

So "Codex shows 1% on Opus" is not "Codex unsupported." It is "this session's
prompt was already ~98% cached text, history collapse did not fire, and only
the static slab was imaged." The same Codex path saves tens of percent when
history collapse fires (gpt-5 above) or when the client re-sends uncached bulk.

### Dashboard columns

On OpenAI-shaped rows the dashboard fills **As text / Sent / Saved** only when
the request was compressed and both `image_tokens` and `baseline_imaged_tokens`
were recorded. Uncompressed rows (gate said `not_profitable`, model not
allowlisted, etc.) correctly show `—`. Path selects the accounting shape
(OpenAI vs Anthropic usage fields); model id selects rates and render profile.

### Practical reading of a low Saved %

1. Check `path`. `/anthropic/messages` and `/v1/responses` are different
   clients even when the model id is `claude-opus-4-8`.
2. Check `cached_tokens / input_tokens`. Near 100% means there is little left
   for imaging to beat under honest same-cache accounting.
3. Check `history_reason`. `collapsed` is where large Codex/OpenAI savings
   come from; `not_profitable` / `below_min_tokens` / `prefix_too_short` mean
   only the slab (or nothing) was imaged.
4. Do not compare a Claude Code session's 70% to a warm Codex session's 1%
   as a regression. Different wire, different uncached bulk.
