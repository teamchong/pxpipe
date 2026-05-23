# pixelpipe

**Make Opus see pixels instead of text.**

A proxy for Claude Code that intercepts `POST /v1/messages` and renders
the bulky static inputs (system prompt + tool docs + closed-prefix
history) as grayscale PNGs, letting Opus 4.7's vision stack OCR them on
the way in. The hypothesis: pixels are a denser encoding for the same
information.

> **Status:** research / experimental. Pixelpipe demonstrably ships
> fewer input tokens on cold-miss requests (measured by Anthropic's own
> `count_tokens` endpoint). Whether that translates into a real
> end-to-end dollar saving on a multi-turn session depends on cache
> behavior, output / thinking tokens, and break-even math we are still
> measuring. We don't currently make a "$ saved" claim.

**Opus 4.7 only.** Pre-4.7 vision wasn't accurate enough on dense
monospace glyphs — OCR errors would corrupt the prompt before the model
read it. Opus 4.7's vision stack ([released 2026-04-16](https://www.anthropic.com/news/claude-opus-4-7))
bumps the long-edge image cap from 1568 px to 2576 px (3.3× more pixels)
and reports document-OCR benchmark gains large enough ([DocVQA 87→94%,
ChartQA 80→88%](https://www.anthropic.com/news/claude-opus-4-7)) to make
this trade safe. Pixelpipe still renders at 1568×1568 — the *model's*
OCR fidelity is what changed, not the renderer.

The inputs we touch today:

- **`system` field** — Claude Code's base system prompt + `CLAUDE.md`
  project instructions + every loaded **skill**'s SKILL.md + agent
  definitions. Identical every turn, ~tens of KB on its own.
- **`tools` field** — every built-in tool schema (Bash, Read, Edit,
  Grep, Task, …) plus every **MCP server**'s tool definitions. Each
  MCP server you wire up (Gmail, Calendar, Drive, custom servers) adds
  its full tool list here. This is usually the biggest single bucket.
- **closed-prefix `tool_use` / `tool_result` history** — turns past the
  4-breakpoint cache cliff that can't cache anymore, collapsed into one
  synthetic prepended `user` message + PNG.
- **large `tool_result` blocks** in the live tail (long file reads, big
  bash outputs, MCP responses) that pass a per-block break-even check.
- **large `<system-reminder>` blocks** inside user messages — Claude
  Code injects these for things like task-tracker state, file-state
  hints, and skill discovery; they grow with session length.

The current implementation renders flat text into monospace PNGs, which
is the cheapest shape to validate the hypothesis on. The same idea
generalizes to richer encodings — HTML system prompts with semantic
hierarchy, tool docs as call graphs, file trees as tree renderings,
conversation history as designed timelines, tables as actual tables.
Concatenating text is how 2024-era prompt engineering works; designing a
visual surface is what context-as-UI looks like.

On one measured cold-miss request in `events.jsonl`, Anthropic's
`count_tokens` reported **173,783** input tokens for the unproxied body
and **41,321** `cache_create` tokens for the proxied body — a ~76%
reduction in tokens shipped on that single request. That's an
*encoding-density* observation about one request, not an aggregate
$-savings claim. See "How we report numbers" below for the difference.

## What this is NOT

- **Not ToS evasion.** Pixelpipe uses the [Anthropic vision API](https://docs.anthropic.com/en/docs/build-with-claude/vision)
  exactly as documented. Image tokens are billed at the documented input
  rate. No reverse-engineering, no rate-limit circumvention, no API
  abuse — every encoded byte traverses Anthropic's stack under the same
  per-request budgets and content policies as a plain-text request.
- **Not a billing loophole.** The savings come from genuinely shipping
  fewer tokens, measured by Anthropic's own `count_tokens` endpoint
  before and after the encoding change. If Anthropic re-prices images
  tomorrow, the encoding-density argument still stands — text is just no
  longer the cheaper modality.
- **Not a cost-arbitrage tool.** The token reduction is the *measurable
  proof* that pixels pack more semantic info than serialized text. The
  actual claim — and the reason this repo exists — is that the LLM
  context window deserves to be designed like a UI, not concatenated
  like a log file. Cost is a side effect of density.

Runs on **Node 18+** and **Cloudflare Workers** from the same source.

```
                                  ┌─ original ────────────────────┐
                                  │ ~68K input tok                │
Claude Code  ──►  pixelpipe  ──►  │  (system + tools as text)     │  ──►  Anthropic
                       │          └───────────────────────────────┘
                       └──────►   ┌─ via proxy ───────────────────┐
                                  │ ~3.5K input tok               │
                                  │  (system + tools as PNG +     │
                                  │   prompt-cache breakpoint)    │
                                  └───────────────────────────────┘
                                          ↓ Anthropic vision OCR
                                          100% reasoning quality retained
```

---

## Why it works (the math)

The proxy intercepts `POST /v1/messages`, pulls the system prompt + tool
documentation out of the JSON body, renders it into one or more grayscale
PNGs using a build-time-generated hybrid glyph atlas: Spleen 5×8 for
printable ASCII/code glyphs, with GNU Unifont 8px fallback for ~35k BMP
codepoints by default — Latin extended, Cyrillic, Greek, CJK, Hiragana,
Katakana, Hangul, Hebrew, Arabic, math symbols, box drawing, decorative
symbols. It substitutes those PNGs back in as `image` content blocks with
an `ephemeral` `cache_control` breakpoint.

Three independent derivations, each anchored on a number you can verify
against the source.

### Step 1 — image → tokens

Anthropic bills images by area
([Vision docs](https://docs.anthropic.com/en/docs/build-with-claude/vision)):

```
image_tokens ≈ (width × height) / 750
```

Pixelpipe renders at a 7×10-px cell (see *Why it's hard → Image density*);
a single-column `cols=100` PNG is 708×1568, so the textbook estimate is:

```
708 × 1568 / 750 ≈ 1,480 tokens/image
```

Real `count_tokens` probes bill far above that textbook lower bound.
Pixelpipe anchors on a measured **2,500 tokens** for a single-col PNG at
the old 5×8 cell (a 508-px-wide canvas) and scales it by canvas width: the
7×10 cell's 708-px canvas works out to ≈ **3,484 tokens/image** single-col
and ≈ **7,665** at `multiCol=2`. Those are the `TOKENS_PER_IMAGE_SINGLE_COL`
/ `effectiveTokensPerImage(numCols)` constants in `src/core/transform.ts`.

### Step 2 — text → tokens

The "English prose ≈ 4 chars/token" rule from Anthropic's
[pricing docs](https://docs.anthropic.com/en/docs/about-claude/pricing)
does not survive contact with real Claude Code traffic. Across N=391
production `count_tokens` probes on Opus 4.7 `/v1/messages` bodies:

```
avg outgoing text chars  231,925
avg real input tokens    115,893
observed mean            1.91 chars/token
```

Real bodies are JSON-dense — tool definitions, schemas, structured
`CLAUDE.md` slabs, `tool_result` blocks — which tokenize 2-4× denser than
prose. The gate `isCompressionProfitable()` uses
`SLAB_CHARS_PER_TOKEN = 2.0` at the slab call site (slightly conservative
versus the observed 1.91 cpt), so it only compresses when
the text actually costs more tokens than the image will. At the textbook
4 ch/tok the gate silently rejects every realistic slab as
`not_profitable` — that bug is what motivates the constant.

### Step 3 — tokens → $

Rates from [Anthropic's pricing page](https://www.anthropic.com/pricing)
for Opus 4.7 (input pricing has been flat across 4.5/4.6/4.7). Image
tokens are billed at the input rate.

| line item            | rate          |
| -------------------- | ------------- |
| input                | $5.00 / MTok  |
| output               | $25.00 / MTok |
| cache_create (5 min) | $6.25 / MTok  |
| cache_read           | $0.50 / MTok  |

> Opus 4.7 uses a different tokenizer than 4.5 / 4.6 (per
> [Anthropic's pricing page](https://docs.claude.com/en/docs/about-claude/pricing)).
> The same input string does not produce the same token count across
> models, so any hardcoded image-token / chars-per-token constants in
> pixelpipe were tuned on an earlier tokenizer and may be biased on
> 4.7. The break-even gate's only honest oracle is `count_tokens`
> against the actual target model.

### Worked example — one real cold-miss event

From `events.jsonl`, 2026-05-20T12:30:01 (a fresh session, 161,101-char
system slab + 37 images-worth of accumulated history):

```
orig_chars             161,101    system + tool docs slab
image_count                 37
baseline_tokens        173,783    count_tokens probe of the unproxied
                                  body — what Anthropic would have
                                  billed without the proxy
cache_create_tokens     41,321    what actually got billed via pixelpipe
cache_read_tokens            0    cold miss
```

Byte reduction on the cold miss: **76%** (173,783 → 41,321 tokens). Same
event, run later in the session (11:53:06, warm hit on the cached PNGs):

```
baseline_tokens        168,707
cache_create_tokens        111    only the per-turn dynamic delta
cache_read_tokens      140,786    paid at 0.1× the input rate
```

| metric                       | original | via proxy | delta    |
| ---------------------------- | -------- | --------- | -------- |
| Cold input tokens (per call) | ~174k    | ~41k      | ~76% fewer |
| Cache-warm input tokens      | ~169k    | ~141k     | ~17% fewer |
| Per-image OCR quality vs txt | -        | -         | ~99.5%   |

These are per-request token-count deltas, not a session-level cost
claim. A real session interleaves cold-miss and cache-warm calls,
includes output / thinking tokens we don't touch, and depends on cache
TTL and Claude Code's usage shape — none of which a single-request
delta captures.

### How we report numbers

Pixelpipe instruments every proxied request with two free
`count_tokens` probes on the original uncompressed body — one full,
one truncated at the last cache marker — and persists them alongside
Anthropic's billing `usage` block. The bundled dashboard uses those
to show **token deltas per request** and **aggregate token counts**,
and refuses to display a "$ saved" headline unless both probes
succeeded *and* the host has wired in pricing. On real traffic to
date, the honest aggregate is closer to break-even than the
cold-miss number above suggests; the value proposition is still
under measurement.

If you see a "$ saved" number coming out of a host integration that
doesn't expose this gating, treat it as marketing, not measurement.

---

## Why it's hard (the parts that bite)

Most of the engineering in this repo is not "render text to PNG." That
part is a build-time atlas and a `Uint8Array` blit. The hard parts are
all about *what is safe to compress, when, and at what cost.*

**Prompt caching changes the question.** Anthropic's cache writes cost
**1.25× normal input** (`cache_create`), reads cost **0.1×**
(`cache_read`), the TTL is **5 minutes**, you get **4 breakpoints** per
request, and **any change to prefixed content invalidates everything
downstream.** A naive "compress everything" proxy would *lose* money on
warm requests where 90% of the slab was already cached at 10% billing —
the image still costs its full ~5,500 tokens at `cache_create` price the
first time it's seen. The proxy stays a win because (a) the image's
`cache_create` is still 95%+ cheaper than the text's `cache_create`, and
(b) Claude Code sessions are bursty: 5-15 min coding bursts separated by
lunch / meetings / context-switching hit cache expiry constantly. Every
~5 min idle = a fresh cold miss = the 1.25× tax re-paid on the full
uncompressed slab. **Cache expiry argues *for* compression, not against
it** — the tax stays the same, the base shrinks.

**The static slab is mostly free; the real headroom is dynamic.** Once
the system prompt + tool definitions are cached, they bill at 10% on
every warm turn. That's where Anthropic's "just use the cache" guidance
ends. But Claude Code's `tool_result` blocks change every turn, never
cache, and pay full freight every single turn — a 30k `tool_result` × 10
turns = 300k uncached tokens billed at 100%, *bigger than the slab fix.*
History compression (Variant C) addresses the other side: long sessions
push older turns out of the 4-breakpoint cache budget, so a 50-turn
session with 30 turns of `tool_result`s pays 600k tokens of uncached,
repeat-billed text on every turn. Collapsing those into one synthetic
prepended user message + PNG is the same shape of fix as the slab.

**Assistant outputs and the model's thinking cannot be image-encoded.**
This is a hard architectural constraint, not a tuning choice. The
Anthropic Messages API only accepts `image` content blocks inside `user`
messages — `assistant` turns are text-only by contract. And even if the
API allowed it, the proxy never sees an assistant token until *after*
the model has generated it; you can't render what hasn't been emitted
yet. The same applies to extended-thinking blocks: they're produced by
the model, billed as output, and round-tripped on subsequent turns as
opaque assistant content. **Everything pixelpipe compresses is
input-side, host-supplied, and known before the call.** That's why the
two compression paths are (1) the static slab — system prompt + tool
docs that Claude Code injects identically every turn — and (2) closed
prefix history — user/tool_result turns that have already happened and
will never change. Anything the model wrote, or will write, is off the
table.

**The break-even gate has to be honest about real text shape.** A 161k
production slab was being silently rejected as `not_profitable` for
weeks because the gate estimated text at the textbook 4 chars/token when
the real density was 1.17. The gate's job is "compress if and only if
doing so saves tokens" — if the constant is too low we miss profitable
compressions, if it's too high we accept money-losers. The fix wasn't a
flag; it was wiring a `chars_per_token` value derived from a parallel
`/v1/messages/count_tokens` probe into the call site that owns the
decision. The same fix applied at the history call site unlocks
`historyReason: "collapsed"` for long sessions.

**Image density / font size: more DPI is not the answer.** Recent
VLM/OCR work points the tuning direction pretty clearly. ReadBench
([arXiv:2505.19091](https://arxiv.org/abs/2505.19091)) renders text-only
benchmarks as images and reports that *text resolution has negligible
effects* once the text is readable, while performance drops sharply on
longer multi-page visual contexts. Typographic attack studies over GPT-4o,
Claude Sonnet 4.5, Mistral, and Qwen
([arXiv:2604.12371](https://arxiv.org/abs/2604.12371),
[arXiv:2604.25102](https://arxiv.org/abs/2604.25102)) find a real
small-font cliff: very small fonts (~6 px) become ineffective, while
mid-range font sizes are read reliably. A typography-gap study
([arXiv:2603.08497](https://arxiv.org/abs/2603.08497)) reinforces the
practical lesson: VLMs are much better at reading *what text says* than
recognizing font family/style. For pixelpipe this means:

- Do **not** increase DPI / pixel dimensions to improve savings. More
  pixels usually means more image tokens.
- Tiny margins are fine, but shrinking `PAD_X/PAD_Y` from 4 px to 2 px is
  only a ~1% win; it is not the main lever.
- Density is the *cell pitch*, not a letter-spacing knob: the production
  render cell is **7×10 px** — the 5×8 Spleen glyph bitmap plus a 2-px
  `DEFAULT_CELL_W_BONUS` / `DEFAULT_CELL_H_BONUS` pad per axis. The
  `eval/`-only `cellWBonus` / `cellHBonus` overrides sweep other sizes.
- We ship Spleen 5×8 glyphs for ASCII/code plus Unifont 8px fallback,
  after 4×8 proved too brittle in exact code-reading tests.
- Gutter/padding changes are secondary; the gutter is an OCR-ordering cue
  for multi-column layouts, so removing it can save pixels while silently
  causing row-interleaved reads.

**Measured (`eval/`): 5×8 is below the legible floor for dense text — so
production renders at 7×10.** An L1 OCR-fidelity harness renders real
Claude Code transcript blocks, sends them through Anthropic's vision
stack, and scores the
transcription character-for-character against the source. The result:
5×8 reads *sparse* text (real newlines, lots of whitespace) at ~97 %, but
**corrupts *dense* text — ~81 % mean, with individual blocks below 25 %.**
This is content-agnostic: the encoder sees pixels, not newlines. A
reflow-packed block and a zero-newline minified JSON produce the same
dense pixels and fail the same way. Density is density. A cell-pitch
sweep on Opus 4.7 (20 blocks) located the floor:

| Render cell | Mean accuracy | Δ vs baseline |
|-------------|---------------|---------------|
| 5×8 (dense) | 81 %          | −16 pp        |
| 6×9         | 90 %          | −7 pp         |
| 7×9 / 6×10  | ~93 %         | −4 pp         |
| **7×10**    | **96.5 %**    | **−0.8 pp**   |
| 8×10        | 93 %          | −5 pp         |

**7×10 is the floor** — the densest cell where OCR still holds. Below it
text corrupts; above it (8×10) over-spacing dilutes the glyph just as
badly. This is a property of the *renderer*, not of reflow, so the
production cell default is now 7×10 (`DEFAULT_CELL_W_BONUS` /
`DEFAULT_CELL_H_BONUS` in `render.ts`) and the break-even gate is
recalibrated to it: `TOKENS_PER_IMAGE_SINGLE_COL` and `LINES_PER_IMAGE`
both derive from the 7×10 cell, so a 7×10 image — ~75 % more pixels per
character than 5×8 — is now priced as it actually bills. Compressions
that only "won" on corrupt-but-cheap 5×8 images now correctly fail the
gate.

One honest caveat remains: **the glyph is not purpose-built for the
cell.** The 7×10 result came purely from *spacing* a 5×8 Spleen bitmap —
a small glyph floating in 2 px of padding per axis. At 7×10 the token
economics are close to break-even for average text; the real win narrows
to genuinely dense content and the cache-stability of a byte-identical
image prefix. The one untested lever that could lower the legible floor
again is an **anti-aliased glyph** — see *Limitations*.

**Multi-column packing has an OCR cliff.** Two columns side-by-side
double the per-image text capacity, but the renderer must guarantee
Anthropic's vision stack reads column 1 fully top-to-bottom before
column 2. Layouts with line lengths near 1568 px and a weak column
divider can produce row-interleaved OCR output. The renderer adds a
light-gray gutter divider, a per-image break-even check specifically
for `multiCol=2` (image cost scales with `numCols` plus a 10 %
extrapolation margin — `effectiveTokensPerImage(2)` ≈ 7,665), and a global
`multiCol: 2` default that can be overridden to 1 if OCR ordering ever
turns out wrong on a specific deployment.

**Cache prefix invalidation is asymmetric in time.** Anthropic matches
prompt cache by *byte prefix*, so any change to the request changes what
caches downstream of that change. The first turn we replace a chunk of
message history with a PNG, the prior text-based prefix becomes wasted
bytes from Anthropic's POV — cache flushes from the change-point onward
and we pay `cache_create` (1.25×) on the new image. Subsequent turns
with the same image bytes get `cache_read` (0.1×) on the image. So
history compression is **multi-turn economics**: a single-turn break-even
gate that asks *"is image_tokens < text_tokens cold?"* always says no
once Anthropic has already cached the text — text-at-10% beats
image-at-40%. But that reasoning ignores that *the text cache will
expire / get evicted / hit the 4-breakpoint cliff anyway*, and when it
does, the next cold call pays full freight on the giant text prefix.
The honest framing is **expected lifetime cost** of the prefix in this
session vs. **expected lifetime cost** if we collapse now. Neither
number is locally observable. The same shape of problem shows up in
database indexes (cost of building amortizes over future queries), JIT
compilation (interpret first, compile what proves hot), and ZFS block
compression (compress speculatively, keep only if it shrinks ≥ a
threshold). Pixelpipe today uses a per-turn `chars/token` gate — the
JIT analogue is "always interpret." We have data on individual turns
but no session-scoped amortization model yet, which is why history
collapse declines as `not_profitable` on warm Codex traffic even when
the long-run answer would be "collapse and let `cache_read` recoup it."
The next iteration is the ZFS-style **try-then-decide** path:
render, count rendered tokens against a parallel `count_tokens` probe
on the pre-collapse text, commit the collapse only if the difference
exceeds a multi-turn break-even (e.g. image_tokens × (1+0.1·N) <
text_tokens × (1+0.1·N) for N ≥ a configured amortization horizon).
Honest, local, deterministic, no session-state required — at the cost
of ~30 ms of wasted render CPU on turns we end up discarding. Worth it
to stop guessing.

****Telemetry is the only honest oracle.** Every constant in the gate —
`SLAB_CHARS_PER_TOKEN`, `HISTORY_CHARS_PER_TOKEN`, `LINES_PER_IMAGE`,
`TOKENS_PER_IMAGE_SINGLE_COL`, `effectiveTokensPerImage(numCols)` — has
a comment pointing at the production probe that grounded it, with date
and sample size. The proxy logs every request to `events.jsonl` with
`baseline_tokens` (from a parallel cold `count_tokens` call),
`cache_create_tokens`, `cache_read_tokens`, `orig_chars`, `image_count`,
`image_pixels`, `outgoing_text_chars`, and (when history fires)
`collapsed_turns`, `collapsed_chars`, `collapsed_images`. The dashboard
at `/` regresses `total_tokens = α·outgoingTextChars + β·imagePixels`
on every cold-miss event to keep the per-image cost estimate honest as
the model and atlas evolve.

**Proving a compression is safe needs the real workload — not SWE-bench.**
Pixelpipe has one speculative lever, *reflow*, that packs text denser by
replacing newlines with a `↵` (U+21B5) glyph so the renderer fits ~970
chars/image instead of ~470. Whether that lever is safe to pull depends
entirely on one question: *can the model still read the text it is given?*
SWE-bench is the wrong instrument for that question. SWE-bench instances
are essentially single-shot bug-fix tasks — they never accumulate the
hundreds of turns of `tool_result` history that reflow actually operates
on, and a SWE-bench score moves for a hundred reasons unrelated to whether
one `↵` glyph was resolved correctly. The workload that genuinely stresses
reflow is *our own* multi-turn Claude Code sessions, and those already
exist on disk: `~/.claude/projects/` holds real transcripts and
`events.jsonl` holds ~7,900 real proxied requests. So the eval harness
(`eval/`) replays that real corpus instead of a synthetic benchmark, in
two tiers. **L1 — OCR fidelity:** render each text block both ways
(baseline newlines vs. reflow `↵`), ask the model to transcribe it
verbatim, and score against ground truth by character-level Levenshtein
distance. Cheap, deterministic, and it isolates the one variable.
**L2 — session replay:** rebuild whole sessions with the collapsed-history
PNG, ask a real question, and have a separate judge model score whether
the reflowed answer is equivalent to the baseline answer. The shipping
gate requires L1 accuracy delta ≥ −2pp, L1 macro accuracy ≥ 95%, L2 judge
score ≥ 0.80, and L2 pass rate ≥ 80%. All four must hold.

**The eval must run against the production model, and it found the real
bottleneck.** Run at the old 5×8 cell on Opus 4.7, reflow dropped L1
character accuracy from **97.67% → 80.59%** (−17pp) while saving 0.0%
image area, and L2 session replay scored a **49.5% mean judge score**. A
Sonnet 4.5 control produced near-identical numbers (−17.09pp at L1) — and
*that* was the key finding: the failure was not model vision capability
(Opus reads the *baseline* render at 97.67%) and not `↵` comprehension
(enlarging and recoloring the marker in dedicated variants changed
nothing). It was raw pixel density. The cell-pitch sweep above followed
directly from that result. **Re-run at the 7×10 cell, reflowed text reads
at ~96.5% L1 character accuracy — within ~1 pp of baseline.** Reflow
therefore ships **on by default** (`reflow: true` in `DEFAULTS`), paired
with the 7×10 cell that makes it legible. An L2 session-replay re-run at
7×10 is the remaining confirmation — the harness makes it one
`node eval/run-eval.mjs --level all --confirm --model <production-model>`
away from a verdict instead of a guess.

---

## How history compression works

This is `Variant C` in `src/core/transform.ts` (the `collapseHistory`
path). It addresses a different cache cliff than the static slab.

### The problem it solves

Claude Code uses 4 prompt-cache breakpoints. The static slab (system +
tools + `CLAUDE.md`) holds one. The remaining 3 live the conversation
tail. In a long session:

```
[system slab][turn 1][turn 2]...[turn 50][turn 51 live]
              ↑                    ↑
              cache breakpoint     cache breakpoint
              from 40 turns ago    on current turn
```

When the gap between the oldest cached breakpoint and the live tail
exceeds the **4-breakpoint cache budget**, every new turn page-faults
the historical prefix and Anthropic re-bills the whole `tool_result`
river at 1.25× `cache_create`. A 50-turn session with 30 turns of
fat `tool_result` blocks (file reads, bash outputs, MCP responses) can
pay **~600k tokens of uncached, repeat-billed text every turn**.

### The collapse

`collapseHistory()` walks from oldest message forward looking for the
**closed prefix** — the longest run of turns that's *guaranteed* never
to change again (no open `tool_use` waiting for a result, ends on a
clean `user`/`assistant` boundary). It serialises that whole run into
one giant block of text and feeds it to the same `renderTextToPngs`
pipeline the slab uses.

Output looks like:

```
[system slab]
[synthetic user message 1: "[Earlier in this conversation:]"
  └ image block: PNG of 175 turns serialised as JSON
  └ text block: "[End of earlier context.]"]
[turn 48 (last 2 turns kept verbatim in "Live tail")]
[turn 49]
[turn 50 live]
```

`keepTail: 4` is the default — the 4 most recent turns stay as native
messages so the model still has structured access to recent
`tool_use`/`tool_result` pairs.

### Why it's tricky

Three honesty gates have to all clear:

1. **`historyReason: 'no_history'`** — only one message, nothing to
   collapse.
2. **`'prefix_too_short'`** — the closed prefix is under
   `minCollapsePrefix: 10` turns.
3. **`'no_closed_prefix'`** — every prefix ends on an open `tool_use`
   (mid-call). Common in single-turn smoke tests.
4. **`'not_profitable'`** — the gate (`isCompressionProfitable`)
   decided the text was so sparse the image cost would exceed the text
   cost. This is the one that was firing wrong before today's
   `e8545a9` commit.
5. **`'collapsed'`** — actually fired.

### Today's fix (the `42ef4c5` commit)

History was using `charsPerToken: 4` (Anthropic's English-prose
default). Real chat-shaped JSONL (`[{role: 'user', content:
[{type: 'tool_result', content: '...'}]}]`) tokenizes denser than
prose. The N=10 rejected history events in `events.jsonl` had real cpt
1.08–1.10 — every one of them was a profitable compression the gate
dropped on the floor.

Fixed by wiring `HISTORY_CHARS_PER_TOKEN = 2.0` at the call site (same
shape as the slab's `SLAB_CHARS_PER_TOKEN = 2.0` Opus-4.7 calibration). Live data after restart shows it firing: the 12:30:01
event in `events.jsonl` has `historyReason: 'collapsed'`,
`collapsed_turns: 175`, `collapsed_chars: 180,684`.

### The unsolved part: multi-turn amortization

The break-even gate above (`isCompressionProfitable`) is **per-turn** —
it asks *"on this single request, is the image cheaper than the text?"*
That question has a clean answer when both sides are cold (no
prompt-cache hits), but it has the wrong answer when Anthropic has
already cached the prior text-based prefix:

| state | text cost | image cost | per-turn winner |
|---|---|---|---|
| cold (turn 1, fresh session) | 1.00× | 0.40× of text-token-count | image |
| warm with cached text prefix | 0.10× | 0.40× cold → 0.10× after | **text** |
| cache expired (5-min idle / 4-bp eviction) | 1.00× again | re-cached image hits at 0.10× | **image** |

A pure per-turn gate happily collapses on cold and correctly refuses on
warm — but it can't see that a warm session will eventually go cold
again, and on that cold turn the giant text prefix pays full freight
while the image prefix pays once and then rides cache for the rest of
the session.

This is the same shape of decision a JIT compiler makes (interpret first
turns, compile what proves hot), a DB optimiser makes (build the index
if N future queries amortize the scan), or ZFS makes (compress the block,
keep the compressed form if it shrinks by ≥ 12.5%). None of them rely
on knowing N exactly. They all rely on a **bounded amortization
horizon** baked into the gate: assume N=K turns, decide once, eat the
loss if K turned out to be smaller.

Pixelpipe today is the "always interpret" mode. The design space for
fixing it has four credible options. Documenting all of them — including
the ones we rejected — so the next contributor doesn't reinvent the
analysis.

#### Option A — Try-then-decide (ZFS block-compression analogue)

Render the closed-prefix history to PNG(s) speculatively, count actual
image tokens via a parallel `count_tokens` probe, compare against text
tokens for the same prefix evaluated at a fixed amortization horizon
(e.g. `N=5` future turns, accept iff
`image_tokens × (1 + 0.1·(N-1)) < text_tokens × (1 + 0.1·(N-1))`).
Commit the image only if it wins; discard the render otherwise — ~30 ms
of wasted CPU on the daemon, no token cost.

- **Pro:** local, deterministic, no session state, no future-knowledge
  assumption. Honest about the horizon and accepts bounded waste on
  misjudgments. Composes with all the other gates we already have.
- **Con:** one extra `count_tokens` round-trip per request that's
  considering collapse. Wasted render CPU on rejects (~30 ms each at
  current image counts).
- **Status:** chosen path. Specced; not yet implemented.

#### Option B — Session-state aware (JIT tiered-compilation analogue)

Derive a session id from request shape (e.g. hash of the first user
message + system slab), track per-session `{turn_count, cache_state,
last_render_decision}` in the host, leave history as text for turns
`1..K`, collapse once `K` is exceeded. ocproxy already has
`cache_session_hash` which can stand in as the session id.

- **Pro:** matches the JIT pattern exactly — interpret first, compile
  what proves hot. Avoids speculative render cost on short-lived
  sessions. Cleanest economics on long sessions.
- **Con:** introduces durable state. State means schema, eviction,
  migration. State means "why is pixelpipe behaving differently on
  identical inputs?" debugging. Cross-process / cross-host coordination
  if the daemon restarts or fans out. The honesty cost is high relative
  to the marginal win over Option A.
- **Status:** rejected for v1 of the fix. Revisit if Option A leaves
  measurable money on the table after a few weeks of data.

#### Option C — Always collapse, trust the law of large numbers (CDN analogue)

Drop the break-even check entirely for history; collapse always when
prefix ≥ `minCollapsePrefix` turns. Trust that amortization wins on
average across many sessions. Measure for a week; if average savings go
negative, raise the gate.

- **Pro:** simplest code change. Fastest to ship. Generates the most
  data fastest because every eligible request collapses.
- **Con:** dishonest about per-request economics. On warm-cache-heavy
  workloads (which is what production Codex traffic actually looks
  like) this loses money on a non-trivial fraction of requests. "It
  averages out" is true in expectation but bad UX when the user's
  specific session is the one that pays the tax.
- **Status:** considered as a measurement-only experiment. Rejected as
  a default because pixelpipe's reputation is honesty per-request, not
  per-quarter.

#### Option D — Cache-bust-driven (event-driven analogue)

Watch incoming requests for the signal that the static-slab cache just
flushed (e.g. `cache_created_tokens > 0` on a turn where the slab sha
didn't change → 4-breakpoint cliff or 5-min idle eviction). On that
turn the next call will pay full freight on the entire prefix anyway,
so collapse aggressively. On subsequent warm turns, leave the prefix as
text.

- **Pro:** maximally honest — only collapses when the host has visible
  evidence the text path is about to lose. Smallest possible waste.
- **Con:** requires session state (same con as B) plus prior-turn
  observation. The signal arrives one turn late: by the time we see
  `cache_created`, the current turn already paid the cold tax. Best we
  can do is amortize on the *next* cold turn, which may be 5 minutes
  away or never (user closes session).
- **Status:** rejected for v1. The signal arrives too late to drive the
  current turn's decision. Possibly a useful telemetry signal regardless
  — knowing *when* the cache flushed is interesting even if we don't
  act on it.

#### Why Option A wins

The decision criteria were, in order:

1. **No session state.** Pixelpipe is stateless by design — the same
   request bytes always produce the same response bytes. State is what
   turns a library into a service.
2. **No flag.** Decisions belong inside the proxy, not on the operator.
3. **Per-request honesty.** A request should not pay a tax on the
   assumption that other requests will recoup it.
4. **Local data only.** Don't need to observe the future, don't need to
   remember the past.

Option A clears all four. B and D fail (1). C fails (3). A's only cost
is the speculative render CPU on rejects, which is bounded and
measurable.

Why we haven't shipped it yet: needs a `count_tokens` probe wired
through the renderer's output and a host-supplied amortization-horizon
constant. Specced; not implemented.

### Where to find it in code

- **Decision:** `transform.ts:1670` — the `historyProfitable` predicate
- **Walking the closed prefix:** `core/history.ts:findClosedPrefixBoundary`
- **Serialising turns to text:** `core/history.ts` (`messagesToText` /
  `blocksToText`)
- **Constants:** `transform.ts:175` (`HISTORY_CHARS_PER_TOKEN`,
  `HISTORY_DEFAULTS`)

---

## Quick start (Node)

```bash
npm install
npm run build           # produces dist/node.js
node bin/cli.js         # listens on 127.0.0.1:47821 by default
```

After editing code, restart in one step:

```bash
pnpm run restart                              # graceful SIGTERM → rebuild → start
pnpm run restart -- --no-build                # skip rebuild (dist/ is fresh)
PORT=47822 pnpm run restart                   # override listen port via env
```

`pnpm run restart` does, in order:

1. Lists every running pixelpipe PID (via `pgrep`) and SIGTERMs them all.
   Orphans from prior crashed sessions are cleaned up too.
2. Waits up to 5s for graceful exit (the SIGTERM handler flushes the JSONL
   tracker). Escalates to SIGKILL only if anything's still alive.
3. Runs `pnpm run build`. Build failures abort the restart — the script
   refuses to start a stale binary. Pass `--no-build` to skip when you
   know `dist/` is fresh.
4. Checks the target port is free. If it isn't, names the holding process
   and refuses to start (cheaper than a crashed Node stacktrace).
5. `exec`s `node bin/cli.js` in the foreground so Ctrl-C reaches Node.
   The proxy takes no behavioral flags — env vars only (see Configuration).

Point Claude Code at it:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:47821 \
  claude --exclude-dynamic-system-prompt-sections
```

That's it. Use Claude Code normally.

The `--exclude-dynamic-system-prompt-sections` flag suppresses the small
per-turn variable section so the rendered image stays byte-identical
across turns — that's what makes the prompt cache actually hit.

---

## Quick start (Cloudflare Workers)

```bash
npx wrangler dev        # local dev on :8787
npx wrangler deploy     # ship to *.workers.dev
```

Then in Claude Code:

```bash
ANTHROPIC_BASE_URL=https://pixelpipe.<your-account>.workers.dev \
  claude --exclude-dynamic-system-prompt-sections
```

You can attach a custom hostname and route in `wrangler.toml`.

---

## Configuration

The proxy runs with a single codepath. Every compression mode is on,
every break-even threshold is at its measured-best value, and tuning
parameters are not user-adjustable. The only configurable surface is
where to listen, what to proxy, and where to log — env-var only, no
CLI flags.

| env var              | default                       | meaning                       |
| -------------------- | ----------------------------- | ----------------------------- |
| `PORT`               | `47821`                       | Node only — listen port       |
| `ANTHROPIC_UPSTREAM` | `https://api.anthropic.com`   | upstream API base             |
| `PIXELPIPE_LOG`      | `~/.pixelpipe/events.jsonl`   | persistent event log          |

In Workers, set the optional upstream API key with:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

If unset, the proxy forwards whatever `x-api-key` the client sent.


---

## Library API

Pixelpipe is also published as a runtime-agnostic transform library so another
local proxy can own auth/routing while reusing the Opus 4.7 compression and
measurement logic directly:

```ts
import {
  transformAnthropicMessages,
  buildCountTokensBodies,
  isPixelpipeSupportedModel,
} from "pixelpipe";

if (isPixelpipeSupportedModel(upstreamModel)) {
  // Run these probes with the host proxy's own auth/transport.
  const baseline = buildCountTokensBodies(originalMessagesBody);

  const result = await transformAnthropicMessages({
    body: originalMessagesBody,
    model: upstreamModel,
  });

  // result.body is the body to forward; result.cache.ownsCacheControl tells
  // the host not to stack a second cache injector on top of pixelpipe.
}
```

Stable public exports:

- `pixelpipe` — library API plus `createProxy` for standalone use.
- `pixelpipe/transform` — `transformAnthropicMessages(...)`.
- `pixelpipe/measurement` — count-token probe body builders.
- `pixelpipe/applicability` — Opus 4.7 applicability helpers.
- `pixelpipe/proxy` — standalone Web `fetch` proxy.

---

## Architecture

```
src/
├── core/              100% runtime-agnostic (Web Standard APIs only)
│   ├── atlas.ts         (generated) sparse Unicode atlas, base64-inlined
│   ├── png.ts           minimal grayscale PNG encoder
│   ├── render.ts        text → PNG bytes
│   ├── transform.ts     request body rewriter
│   ├── library.ts       public transform wrapper for host proxies
│   ├── measurement.ts   count_tokens probe body builders
│   ├── applicability.ts Opus 4.7 eligibility helpers
│   ├── proxy.ts         the fetch handler
│   └── types.ts         Anthropic API types
├── node.ts            node:http adapter + CLI
└── worker.ts          export default { fetch }

scripts/
├── gen-atlas.ts       build-time: font files → atlas.ts (uses @napi-rs/canvas)
└── build.mjs          esbuild bundler for Node target

assets/
├── Spleen-5x8.otb            primary ASCII/code bitmap font (BSD-2-Clause)
├── SPLEEN_LICENSE.txt        Spleen license
├── Unifont-16.0.04.otf       Unicode fallback (~35k BMP codepoints w/ full-bmp profile)
├── UNIFONT_LICENSE.txt       OFL + GPL-with-font-exception
└── JetBrainsMono-Regular.ttf legacy / ASCII-only fallback (kept on disk)
```

The atlas is generated **at build time** from `Spleen-5x8.otb` (printable
ASCII/code) plus `Unifont-16.0.04.otf` (Unicode fallback), base64-inlined
into a `.ts` file with sparse codepoint + offset tables (binary-packed),
and shipped with the bundle. At runtime there are zero external files to
read and zero non-Web-Standard imports — that's the only way this works
in Workers without per-request asset fetches.

Regenerate the atlas (after swapping fonts, sizes, or codepoint profile):

```bash
pnpm run build:atlas                          # default: Spleen 5×8 ASCII + full-bmp Unifont fallback
ATLAS_PROFILE=practical pnpm run build:atlas  # drops Hangul (~24k cp; for Workers free-tier)
```

---

## Limitations

- The bundled hybrid atlas uses Spleen 5×8 for printable ASCII/code and
  Unifont 8px fallback for ~35k BMP codepoints by default (`full-bmp`
  profile): Latin extended, Cyrillic, Greek, CJK Unified Ideographs,
  Hiragana, Katakana, Hangul, Hebrew, Arabic, math symbols, box-drawing,
  arrows, Dingbats, Letterlike Symbols, Enclosed Alphanumerics, etc. Drops for
  codepoints outside the profile (e.g. emoji 😀 — supplementary plane)
  get counted in `events.jsonl#dropped_chars` (with the top-20 broken
  out as `dropped_codepoints_top`) so you can spot patterns. For
  Workers free-tier deployments under the 1 MB compressed-bundle cap,
  switch to `ATLAS_PROFILE=practical pnpm run build:atlas` (~24k cp;
  drops Hangul). Right-to-left scripts render left-to-right in source
  order (no bidi shaping); Devanagari / Thai / similar
  complex shaping is also unsupported.
- The render cell is **7×10 px** — the measured OCR-legible floor for
  *dense* input (minified JSON, long log lines, reflow-packed history).
  At 7×10 a character costs ~75 % more pixels than the old 5×8 cell, so
  the token economics are close to break-even for average text; the win
  is concentrated in genuinely dense content and the cache-stability of a
  byte-identical image prefix. The one untested lever that could lower
  the legible floor below 7×10 — and widen the margin again — is an
  **anti-aliased glyph**: the renderer currently blits 1-bit (hard
  black/white) pixels, and grayscale glyph edges may survive the vision
  encoder's downsample at a smaller cell. Eval pending. See *Why it's
  hard → Image density*.
- Compression sets a 5-minute prompt-cache TTL. Adding `cache_control:
  ephemeral` causes warm-cache rotation, not eviction.
- A 5KB break-even point: if input is `< MIN_COMPRESS_CHARS` chars we
  skip compression entirely (overhead would exceed savings).
- Per-machine font: regenerate the atlas if you swap fonts. The
  generated `src/core/atlas.ts` is checked in so consumers don't need
  `@napi-rs/canvas` to install.
- Workers CPU limit: this is fine for free-tier (10ms CPU) on small
  prompts; large prompts (>30K chars) may need the paid tier.

---

## Development

```bash
npm install
npm run dev:node              # tsx watch on src/node.ts
npm run dev:worker            # wrangler dev
npm run test                  # vitest
npm run test:watch
npm run typecheck             # tsc --noEmit
pnpm run build:atlas          # regenerate src/core/atlas.ts from OTF
npm run build                 # build dist/node.js
npm run deploy:worker         # wrangler deploy
```

## License

MIT.
