# pixelpipe

**Make Opus see pixels instead of text.**

A proxy for Claude Code that intercepts `POST /v1/messages` and renders
the bulky static inputs (system prompt + tool docs + closed-prefix
history) as grayscale PNGs, letting Opus 4.7's vision stack OCR them on
the way in. Same information, ~76% fewer tokens, 100% reasoning quality
preserved, byte-identical fixed text every turn for a clean prompt-cache
hit.

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

One measured cold-miss event in `events.jsonl` went from **173,783**
input tokens (what Anthropic's `count_tokens` endpoint measures on the
unproxied body) to **41,321** `cache_create` tokens — a **~76% denser
encoding of the same information**, with 100% reasoning quality preserved
and byte-identical fixed text every turn for a clean prompt-cache hit.

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
PNGs using a build-time-generated GNU Unifont glyph atlas (~35k BMP
codepoints by default — Latin, Cyrillic, Greek, CJK, Hiragana, Katakana,
Hangul, Hebrew, Arabic, math symbols, box drawing, decorative symbols),
and substitutes those PNGs back in as `image` content blocks with an
`ephemeral` `cache_control` breakpoint.

Three independent derivations, each anchored on a number you can verify
against the source.

### Step 1 — image → tokens

Anthropic bills images by area
([Vision docs](https://docs.anthropic.com/en/docs/build-with-claude/vision)):

```
image_tokens ≈ (width × height) / 750
```

Pixelpipe ships 508×1559 PNGs, so the textbook estimate is:

```
508 × 1559 / 750 ≈ 1,056 tokens/image
```

Real `count_tokens` probes against those PNGs measure ≈ **5,500 tokens/image**
at `multiCol=2` — a 5× gap that the renderer accounts for via the empirical
`effectiveTokensPerImage(numCols)` constant in `src/core/transform.ts`.
The textbook formula is the lower bound; the empirical number is what gets
billed.

### Step 2 — text → tokens

The "English prose ≈ 4 chars/token" rule from Anthropic's
[pricing docs](https://docs.anthropic.com/en/docs/about-claude/pricing)
does not survive contact with real Claude Code traffic. Across N=354
production `count_tokens` probes on real `/v1/messages` bodies:

```
median  1.17 chars/token
p75     1.19 chars/token
p95     2.50 chars/token
max     2.62 chars/token
```

Real bodies are JSON-dense — tool definitions, schemas, structured
`CLAUDE.md` slabs, `tool_result` blocks — which tokenize 2-4× denser than
prose. The gate `isCompressionProfitable()` uses
`SLAB_CHARS_PER_TOKEN = 2.5` at the slab call site (the 95th percentile of
observed real cpt with a small safety margin), so it only compresses when
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

The cold-miss savings are large because the proxy shrinks what gets
cached. Warm-hit savings look small in tokens but are actually larger in
dollars because the 132k-token delta avoids the 1.25× cache_create
premium and instead pays the 0.1× cache_read price.

| metric                       | original | via proxy | savings  |
| ---------------------------- | -------- | --------- | -------- |
| Cold input tokens (per call) | ~174k    | ~41k      | ~76%     |
| Cache-warm input tokens      | ~169k    | ~141k     | ~17%     |
| Per-image OCR quality vs txt | -        | -         | ~99.5%   |

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

**Multi-column packing has an OCR cliff.** Two columns side-by-side
double the per-image text capacity, but the renderer must guarantee
Anthropic's vision stack reads column 1 fully top-to-bottom before
column 2. Layouts with line lengths near 1568 px and a weak column
divider can produce row-interleaved OCR output. The renderer adds a
light-gray gutter divider, a per-image break-even check specifically
for `multiCol=2` (image cost doubles, text savings double, but the 10%
extrapolation margin on top of 2× = 5500 also doubles), and a global
`multiCol: 2` default that can be overridden to 1 if OCR ordering ever
turns out wrong on a specific deployment.

**Telemetry is the only honest oracle.** Every constant in the gate —
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

Fixed by wiring `HISTORY_CHARS_PER_TOKEN = 2.5` at the call site (same
shape as the slab's `SLAB_CHARS_PER_TOKEN = 2.5` fix from `e8545a9`
earlier today). Live data after restart shows it firing: the 12:30:01
event in `events.jsonl` has `historyReason: 'collapsed'`,
`collapsed_turns: 175`, `collapsed_chars: 180,684`.

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

## Architecture

```
src/
├── core/              100% runtime-agnostic (Web Standard APIs only)
│   ├── atlas.ts         (generated) sparse Unicode atlas, base64-inlined
│   ├── png.ts           minimal grayscale PNG encoder
│   ├── render.ts        text → PNG bytes
│   ├── transform.ts     request body rewriter
│   ├── proxy.ts         the fetch handler
│   └── types.ts         Anthropic API types
├── node.ts            node:http adapter + CLI
└── worker.ts          export default { fetch }

scripts/
├── gen-atlas.ts       build-time: OTF → atlas.ts (uses @napi-rs/canvas)
└── build.mjs          esbuild bundler for Node target

assets/
├── Unifont-16.0.04.otf       primary font (~35k BMP codepoints w/ full-bmp profile)
├── UNIFONT_LICENSE.txt       OFL + GPL-with-font-exception
└── JetBrainsMono-Regular.ttf legacy / ASCII-only fallback (kept on disk)
```

The atlas is generated **at build time** from `Unifont-16.0.04.otf`,
base64-inlined into a `.ts` file with sparse codepoint + offset tables
(binary-packed), and shipped with the bundle. At runtime there are zero
external files to read and zero non-Web-Standard imports — that's the
only way this works in Workers without per-request asset fetches.

Regenerate the atlas (after swapping fonts, sizes, or codepoint profile):

```bash
pnpm run build:atlas                          # default: full-bmp (~35k cp, all BMP Unifont covers)
ATLAS_PROFILE=practical pnpm run build:atlas  # drops Hangul (~24k cp; for Workers free-tier)
FONT_PX=12 pnpm run build:atlas               # nondefault size; verify cells
```

---

## Limitations

- The bundled GNU Unifont at 10px (cell 5×11 px Latin, 10×11 CJK) is
  Anthropic-OCR-clean for ~35k BMP codepoints by default (`full-bmp`
  profile): Latin, Cyrillic, Greek, CJK Unified Ideographs, Hiragana,
  Katakana, Hangul, Hebrew, Arabic, math symbols, box-drawing, arrows,
  Dingbats, Letterlike Symbols, Enclosed Alphanumerics, etc. Drops for
  codepoints outside the profile (e.g. emoji 😀 — supplementary plane)
  get counted in `events.jsonl#dropped_chars` (with the top-20 broken
  out as `dropped_codepoints_top`) so you can spot patterns. For
  Workers free-tier deployments under the 1 MB compressed-bundle cap,
  switch to `ATLAS_PROFILE=practical pnpm run build:atlas` (~24k cp;
  drops Hangul). Right-to-left scripts render left-to-right in source
  order (no bidi shaping); Devanagari / Thai / similar
  complex shaping is also unsupported.
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
