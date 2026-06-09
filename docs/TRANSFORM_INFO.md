# How pxpipe compresses Claude Code requests

This doc explains what the proxy actually does on the wire, why each piece is
shaped the way it is, and which invariants future contributors must not break.
The canonical source is `src/core/transform.ts`; everything here points back at
it.

## 1. Why this proxy exists

Claude Code sends a large, mostly-static prefix on every single turn: the
CLAUDE.md project rules, the agent / subagent definitions, the tool catalogue
with full input schemas, and a long list of internal "skill" reminders. On
Opus-class models that prefix runs ~68K input tokens. The model never *needs*
to re-read that text in token form — Anthropic prompt-caches it, and image
blocks OCR cleanly at small font sizes. So pxpipe pulls the static prefix
out of the JSON body, renders it as one or more grayscale PNG image blocks,
and pins a single `cache_control` breakpoint on the last image. Anthropic
charges roughly `ceil(W*H/750)` tokens per image; our renderer caps each image
at 1466×1568, so each tile costs ~3066 tokens regardless of how much text it
carries. A 68K-token static slab collapses to ~3.5K image tokens on the first
turn and to a cache-read (billed at 0.10×) on every subsequent turn. The
trade is real text tokens for a few image tokens we cache once.

## 2. The static / dynamic split

Claude Code does not send one monolithic system prompt. It stitches a handful
of *per-turn* dynamic blocks into the otherwise-stable text. The list lives in
`DYNAMIC_BLOCK_TAGS` (`src/core/transform.ts:154`):

```
env                    ← cwd, git status, platform, today's date
context                ← directory listings, file pastes
git_status             ← branch / staged / untracked files
directoryStructure     ← ls-tree of the workspace
system-reminder        ← skill catalogue + miscellaneous hints
```

Everything outside those tags — CLAUDE.md, agent definitions, the tool docs
Claude Code inlines — is *static*: byte-identical from turn to turn for the
lifetime of a session over the same project.

`splitStaticDynamic` (`src/core/transform.ts:162`) walks the system text with a
non-greedy regex (`<tag ...?>...</tag>`, earliest close wins) and partitions
it into two strings:

- `staticText` — what we render to PNG
- `dynamicText` — the concatenation of every dynamic block, kept as plain text

The reason for the split is the cache. `cache_control: ephemeral` only saves
tokens if the bytes it covers are identical across turns. If we baked the
`<env>` block (which contains today's date) into the image, the PNG bytes
would change every day at midnight UTC and the cache hit rate would silently
collapse. By splitting first and rendering only the static slab, the image
bytes stay frozen even as cwd, git branch, or the wall clock drift.

The dynamic tail is kept as text and forwarded to the model so it still sees
cwd / git status / today's date — just outside the cache anchor.

## 3. What the final request looks like

Default placement is `'user'` (`src/core/transform.ts:67`). The transform
rewrites the first user message to look like this:

```
messages[firstUserIdx].content = [
  { type: 'text', text: '<intro>' },              ← static, frames the OCR
  { type: 'image', source: {...} },               ← static, no cache_control
  { type: 'image', source: {...} },               ← static, no cache_control
  { type: 'image', source: {...}, cache_control:  ← static, LAST image holds
      { type: 'ephemeral', ttl: '1h' } },           the one cache breakpoint
  { type: 'text', text: '[End of rendered context.]' },
  ...originalUserContent,                         ← per-turn (incl. compressed
]                                                   reminders + tool_results,
                                                    NO cache_control on any)
```

The `system` field carries:

- the `x-anthropic-billing-header:` line that Claude Code injects (stripped
  off the static text by `stripBillingLine` because it rotates per-turn — see
  `src/core/transform.ts:315`)
- the dynamic tail (`<env>...</env>`, `<git_status>...</git_status>`, etc.)
- any non-text blocks that lived in the original `system` field

Why not put the images in `system`? Anthropic's API rejects them outright with
`400 system.N.type: Input should be 'text'`. The `system` field accepts text
blocks only. Images have to ride on a user message.

A `placement: 'system'` mode exists (kept for symmetry with the legacy Python
proxy and for the `--placement system` flag) but it's strictly worse and you
should not use it. It's there because the original Python proxy supported
both modes and we wanted a clean port before deciding which one to keep.

## 4. The cache_control budget (the one invariant that matters)

Anthropic allows **four** `cache_control` breakpoints per request. Claude Code
already uses three of them on its own content:

1. One on the last `tools[]` entry
2. One on the `system` field
3. One inside `messages[]`, typically with `ttl='1h'`

That leaves us exactly **one** breakpoint. We spend it on the last image
block in the first user message.

Anthropic enforces two ordering rules that together pin our choice of `ttl`:

- Breakpoints are processed in the order `tools → system → messages`, and
  within `messages` in array order.
- Within that processing order, **`ttl='1h'` must NOT appear after
  `ttl='5m'`**. The API returns 400 if it does.

`cache_control` defaults to `ttl='5m'` if you leave the field off. Our
breakpoint lands inside `messages[firstUserIdx]`, *before* Claude Code's own
`ttl='1h'` breakpoint further down the message list. If we let our image
default to `ttl='5m'`, that 5m breakpoint would land before the 1h one and the
request would 400 at runtime. So `makeImageBlock` (`src/core/transform.ts:334`)
always stamps `ttl='1h'` on the cache anchor. This is verified by the
"uses ttl='1h' on the image cache_control" test in `tests/render.test.ts`.

This is the single most important invariant in the codebase. The string
`ttl: '1h'` is load-bearing. Do not "clean up" the comments above
`makeImageBlock`; they exist so the next person who tries to drop the field
or change it to `5m` reads the reason first.

## 5. Per-message compressions (no cache_control)

The static slab covers most of the wire savings, but two recurring sources of
text live in user messages and miss the cache anchor. The transform compresses
those too, but **without** attaching `cache_control` — we already spent our
one breakpoint, and these blocks are per-turn anyway.

### 5a. Reminder compression

Claude Code re-injects long `<system-reminder>...</system-reminder>` blocks
into the *first user message* every turn. The skill catalogue is the worst
offender (multiple KB of reusable-skill names and descriptions every single
turn). These reminders are text inside `messages[]`, not inside the system
prompt, so they do not hit the system+tools image cache.

`compressReminders` (default `true`, threshold `minReminderChars=1000`) walks
the first user message's content array, finds every text block that starts
with `<system-reminder>` and is at least 1000 chars, and replaces it with
image blocks. Short reminders are left alone — below the threshold the image
overhead would dominate. The replacement images carry **no `cache_control`**;
they're per-turn savings on raw token cost, not cache reuse.

Test coverage: "compresses long `<system-reminder>` blocks in the first user
message" and "leaves short `<system-reminder>` blocks alone (below
minReminderChars)" in `tests/render.test.ts`.

### 5b. Tool_result compression

Tool output (Bash stdout/stderr, file reads, Write confirmations) accumulates
across the session. Once a tool result is produced its bytes are static —
turn N+1 ships the same `tool_result` block as turn N, plus one more. Over a
long session this compounds into tens of KB of text re-sent every turn.

`compressToolResults` (default `true`, threshold `minToolResultChars=2000`)
walks **all** user messages (not just the first), finds every `tool_result`
block with content ≥ 2000 chars, and replaces the content with image blocks.
The block's `content` may be either a string or an array of TextBlock /
ImageBlock; the transform handles both shapes (see `src/core/transform.ts:573`
onwards).

One mandatory exception: **skip `is_error: true` tool_results**. Anthropic
rejects images nested inside an `is_error` tool_result. Test:
"leaves is_error tool_results untouched (Anthropic forbids images there)" in
`tests/render.test.ts`.

Like reminder images, tool_result images carry no `cache_control`.

## 6. Determinism and fingerprints

Identical input must produce byte-identical PNG output. Without that property,
two consecutive turns with the same static slab would render to different
image bytes and the cache hit rate would be 0%. This is a hard invariant:

- No `Math.random` on the render path.
- No timestamps in PNG metadata.
- No locale-dependent string handling (no `toLocaleString`, etc.).
- Glyph atlas is generated at *build* time (`scripts/gen-atlas.ts` →
  `src/core/atlas.ts`) so runtime never touches the font file.

The locked-in test is "renders identical input to byte-identical output
(determinism = cacheability)" in `tests/render.test.ts:271`. If you change
anything on the render path, that test must continue to pass.

The transform also emits three SHA-256-prefixed (first 8 hex chars, 32 bits —
collision-safe for the request volume a single proxy instance sees)
fingerprints. They live on the `TransformInfo` struct and get persisted to the
JSONL event log so `pxpipe stats` can analyze them:

- **`systemSha8`** — hash of the exact text that goes into the image (static
  slab + folded tool docs, joined with `\n\n`). If this value repeats across
  turns, the cache_control breakpoint *should* be hitting upstream.
  Mismatched `systemSha8` between turns is the signal that prompt drift is
  killing your cache hit rate; check `pxpipe stats` for the
  `system_sha8 reuse rate` line.
- **`claudeMdSha8`** — hash of just the CLAUDE.md section, if detectable by
  the heuristic in `extractClaudeMdSlab` (`src/core/transform.ts:231`). Lets
  you bucket requests by project even when `cwd` isn't reported in the env
  block.
- **`firstUserSha8`** — hash of the first user message text, capped at 4 KiB
  to keep long pastes from dominating. Rough thread/session id, since the
  wire protocol doesn't include one.

None of these fingerprints carry raw text — they're privacy-safe to log.

## 7. The unknown-tag canary

`DYNAMIC_BLOCK_TAGS` is a hard-coded list. Claude Code is free to ship a new
per-turn dynamic tag at any time (a future `<recent_files>...`,
`<todo_list>...`, whatever). If that happens and we don't update the list,
the new tag's content will be silently baked into the cached image bytes.
Every turn, the dynamic content of that tag would differ, so the image bytes
would differ, and the cache hit rate would collapse — before anyone noticed.

The canary lives in `splitStaticDynamic` (`src/core/transform.ts:187`). After
splitting, it sweeps the *static* slab for any other tag-shaped opening
(`<foo>...</foo>` with `foo` under 64 chars, alphanumeric / dot / dash /
underscore) and emits the tag names on `info.unknownStaticTags`. Both the
Node host (`src/node.ts:367`) and the Worker (`src/worker.ts:74`) log a
warning to stderr / Workers Logs when this array is non-empty. `pxpipe
stats` also tallies these tag names across the JSONL log.

`<types>` is a *static* tag used inside Claude Code's built-in tool docs
(it was tripping the canary on 93% of real requests). Commit `167ce3d`
added a second list, `KNOWN_STATIC_TAGS`, alongside `DYNAMIC_BLOCK_TAGS`:

```typescript
const KNOWN_STATIC_TAGS = ['types'] as const;
```

The canary now excludes both lists. A tag is reported on
`info.unknownStaticTags` only when it appears in NEITHER set — i.e. it's
genuinely new. When you see a fresh entry, decide whether it's per-turn
(extend `DYNAMIC_BLOCK_TAGS`) or static-but-tag-shaped (extend
`KNOWN_STATIC_TAGS`). The warn-log line in `src/node.ts` names both
options.

## 8. The savings math

Source of truth for the formula is `src/dashboard.ts` (`effectiveCost`,
`baselineCost`). It was originally ported from a Python reference
implementation; that reference has been removed now that live
validation passed.

**Per-call effective input cost** — what the call actually billed for:

```
effective = input_tokens
          + cache_creation_input_tokens * 1.25
          + cache_read_input_tokens     * 0.10
```

The `1.25` and `0.10` multipliers match Anthropic's published cache pricing
for Opus: writing to the cache costs 1.25× the per-token input rate; reading
from the cache costs 0.10×.

**Per-call baseline cost** — what the *same* call would have billed if we had
NOT compressed:

```
text_tokens_we_removed = origChars / 4              # ~4 chars per token, rough
image_tokens_we_added  = imageCount * 3066          # 1466*1568 ≈ 3066 tokens
extra_text_baseline    = max(0, text_tokens_we_removed - image_tokens_we_added)

# cache_create dominates the first turn; bias the baseline toward 1.25 in
# that regime. Otherwise assume a fully warm cache (0.10).
cache_total = cache_create + cache_read
baseline_rate = cache_create > 0
              ? (cache_create / cache_total) * 1.25 + (1 - cache_create / cache_total) * 0.10
              : 0.10

baseline = effective + extra_text_baseline * baseline_rate
saved    = baseline - effective
```

The dashboard's "tokens saved" and "$ saved" cards (and
`pxpipe stats` for the offline aggregate) both surface these numbers.
The $ figure in `src/dashboard.ts` uses a fixed per-Mtok input rate — note
Fable 5 (the current supported model) bills $10/M input, so re-check the
constant if you care about the dollar card.

**Important framing**: do not quote 65–73% as a benchmark. That number is
the architectural ceiling — the steady-state savings on a long session over
the same codebase where the image cache is warm and the cumulative
tool_result history is large. A short session with no warm cache may save
much less. The first turn always pays cache-creation cost; cache-read
amortization kicks in from turn 2 onwards. Cite the per-session number that
`pxpipe stats` reports, not the headline.

## 9. What deliberately did NOT get built

(From HANDOFF.md principle #7. These were considered during the original
session and rejected for stated reasons. The point of recording them is so
the next contributor doesn't relitigate the same decisions.)

- **Compression of user message content.** User text is volatile (different
  every turn) so it would cache-miss anyway. Image overhead would dominate.
- **Per-conversation render caching.** `cache_control` already gives us this
  upstream; adding a second layer in the proxy is duplicate work and
  invalidation is harder than it sounds.
- **Smart heuristics for "should I compress this".** The current rules
  (`minReminderChars`, `minToolResultChars`, fixed `DYNAMIC_BLOCK_TAGS`) are
  simple, predictable, and correct. Heuristics that try to be cleverer
  ("only compress if X and Y and not Z") trade predictability for marginal
  wins and make the failure modes harder to debug.
- **Streaming the request body to the renderer.** The transform is fast
  enough that fully buffering the body is fine. Streaming would force a
  rewrite of the splitter and the cache-control placement logic for no
  measured latency win.

## 10. Wiring (one-paragraph map)

`src/core/transform.ts` is the transform itself — the runtime-agnostic
function that takes a request body and returns the rewritten body plus
`TransformInfo` telemetry. `src/core/proxy.ts` is the runtime-agnostic
request handler that calls the transform, forwards the rewritten request to
the Anthropic API, tees the response body to extract usage tokens, and fires
the `onRequest` callback. `src/node.ts` is the Node `http` server entrypoint
— it parses CLI flags / env vars, instantiates a `FileTracker` (JSONL log
writer with size-based rotation), and also serves the dashboard at `/` plus
the JSON / PNG endpoints (`/proxy-stats`, `/proxy-recent`,
`/proxy-latest-png`). `src/worker.ts` is the Cloudflare Worker entrypoint —
same proxy logic, `JsonLogTracker` writes to Workers Logs via `console.log`
(Logpush picks it up for R2/S3 export). `src/core/tracker.ts` defines the
`TrackEvent` shape that lands in JSONL and the `toTrackEvent` normalizer that
strips heavy fields (the `firstImagePng` byte buffer) before persistence.
`src/dashboard.ts` aggregates events in memory for the Node live view (capped
ring buffer, ~50 most recent calls). `src/stats.ts` is the offline aggregator
that powers `pxpipe stats`; it streams the JSONL file line-by-line so
100 MB logs don't blow the heap. Tests live in `tests/` and pin the
invariants — byte-output determinism most of all (see section 6).
