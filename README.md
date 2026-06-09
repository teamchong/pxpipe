# pxpipe (npm: `pxpipe`)

Turn Claude or GPT static context into compact PNGs before it ever reaches the
model. Text tokens are expensive; vision tokens for a dense 1568×1568 image can
be dramatically cheaper than the same content delivered as transcript text.
pxpipe is the encoder that exploits that gap.

It is a small, focused TypeScript library — no daemon, no MCP wiring, no
opinions about transport. You hand it a string, it hands you one or more
ready-to-send PNG buffers.

---

## Status

Experimental, and the cost math is **workload-dependent** — read this before
relying on it.

**What it does.** Rewrites Claude Code tool-result / history text into dense
PNGs. On a live, multi-session run against real Claude Code traffic it
measured **~68% fewer input tokens** (856k → 277k over the session), and the
cumulative production log now shows **77% saved across 6,691 compressed
requests** (3.21B baseline tokens → 735M actual, as of 2026-06-09), because
that traffic is token-dense (~1 char/token: JSON, code, tool output, hashes)
and a dense image packs ~3.1 chars per image-token. On sparse English prose
(~3.5 chars/token) the same images *lose* money — so the savings depend
entirely on what you feed it.

**What it is.** A lossy, recency-graded **gist** compressor. Recent turns stay
text; older bulk history becomes images. A needle-in-haystack eval recovered
**0/15** exact 12-char hex strings from rendered images across two model
generations — so imaged content is safe to skim by gist but **cannot be
relied on for verbatim recall**, and the failure mode is *silent
confabulation* (it returns a plausible wrong value, not an error). Do not
image anything you may need back byte-exact (IDs, hashes, secrets, exact
numbers) until a verbatim-risk guard keeps those blocks as text.

**Model scope.** Fable 5 (`claude-fable-5`) only on the Anthropic route,
enforced in both the library (`isPxpipeSupportedModel`) and the proxy.
Opus (4.7/4.8, the original measured scope) was disabled 2026-06-09: Fable 5
reads renders at 100/100 on the novel-arithmetic eval vs Opus 4.8's 93/100,
with identical image billing (same Opus 4.7-line tokenizer, verified by direct
measurement) — so the ~7% Opus read tax is no longer worth carrying. An OpenAI
`/v1/chat/completions` route exists for GPT 5.5 (`gpt-5.5*`) but is not the
focus and is unmeasured beyond smoke tests. Mythos 5 is unmeasured (no access).

---

## Benchmarks (reproducible)

**One number: on short, readable content Fable 5 reads pxpipe's render
100% of the time, at ~38% fewer tokens.** Measured clean — with novel
random-number problems it cannot have memorized:

| test | N | text | pxpipe (image) | tokens |
|---|---:|---:|---:|---|
| novel arithmetic, `claude-fable-5` (2026-06-09) | 100 | 100% | **100%** | **−38%** |
| novel arithmetic, `claude-opus-4-8` | 100 | 100% | 93% | −38% |

The Opus ~7% gap was real misreads (`10200`→`9400`, `7873`→`7793`) — that read
tax is why Opus is now disabled and the gate is Fable-only.

**The boundary** — push to dense, exact-recall content and it degrades:

| test | text | pxpipe (image) |
|---|---:|---:|
| verbatim recall — 12-char hex from a *dense* render, Opus | 15/15 | **0/15** |
| verbatim recall — 12-char hex, dense JSON render, Fable 5 (n=4, smaller page) | — | **3/4** |

Fable 5 dramatically improves verbatim recall but still produces single-glyph
silent misreads (`125f9e6e1c77`→`125f9e6a1c77`, `cc33ae67`→`cc33a867`), so the
rule stands: do not image anything you need back byte-exact. Full analysis in
[`FINDINGS.md`](FINDINGS.md).

<sub>We also ran the standard **GSM8K** suite: 96% imaged. But GSM8K is in training
data, so the model recalls memorized answers through its own misreads — inflating
the score ~3pp over the clean novel number above, which is why we don't lead with
it. Reproduce: [`eval/gsm8k/`](eval/gsm8k/) · [`eval/needle-haystack/`](eval/needle-haystack/).</sub>

---

## How it works

```
tool_result string  ──►  wrapLines  ──►  renderTextToPngs  ──►  PNG[]
```

1. **Wrap** the input at a column width that fits 1568 px wide.
2. **Pack** as many lines as fit into a single readable image
   (≈ `DENSE_CONTENT_CHARS_PER_IMAGE = 5000` chars per page).
3. **Render** each page to a PNG via `node-canvas`.
4. **Return** the array. Callers attach the PNGs to the user message and
   drop the original text.

### The math

A Claude 1568×1568 image costs ≈ 1568 vision tokens (Anthropic, 2026-04-16).
At ≈ 6 readable characters per square monospace glyph, that page holds
≈ 5 000 text chars. Same content as plain text: ≈ 1 250 text tokens. So
plain text is cheaper *unless* the model treats vision tokens as much
fatter than text tokens — which they effectively do on cold-miss
cached transcripts.

We measure rather than guess. The runtime estimator
(`estimateImageCount`) tells the caller how many images a string would
produce; the caller's gate decides whether that beats sending text. The
built-in gate constant is `2.0` chars/token, calibrated against N=391
production rows (observed 1.91), unless the host supplies an empirical
override via `opts.charsPerToken`.

### Why we don't just render one giant image

Earlier versions packed everything into a single 1568×1568 PNG. With long
inputs this either (a) shrank the font below OCR-legibility or (b) used
multi-column packing that broke OCR ordering on the encoder side.

The current behaviour:

| input size                | output                                  |
|---------------------------|------------------------------------------|
| ≤ `minToolResultChars` (~6 000) | not rendered — caller sends as text |
| moderate (≤ 5 000/page)   | one 1568×~480 PNG                       |
| long                      | N pages, each 1568×~480, paginated      |

Every page renders at the same font size and column width. Page heights
scale with content; no more dense walls of unreadable text.

### Single-column vs. multi-column

Multi-column packing (two columns side-by-side on one page) is supported
but disabled by default. Reason: the OCR / vision encoder reads in row
order, so two columns silently corrupt sequence integrity. The code is
preserved behind `numCols > 1`; do not enable it unless you have measured
both faithfulness *and* savings.

---

## Quick start (CLI proxy — Claude Code)

The fastest way to try it: run the local proxy and point Claude Code at it.
It transparently compresses eligible `/v1/messages` bodies and passes
everything else through untouched.

```bash
npx pxpipe                               # listens on http://127.0.0.1:47821
ANTHROPIC_BASE_URL=http://localhost:47821 claude
```

A live dashboard (tokens saved, per-session stats, compression kill switch)
is served at the same address: <http://127.0.0.1:47821/>. Per-request events
are logged to `~/.pxpipe/events.jsonl`.

## Quick start (Node)

```ts
import { renderTextToPngs } from "pxpipe";

const pngs = await renderTextToPngs(toolResultText);
// pngs: Buffer[]  — attach to the next user turn
```

## Proxy Usage

The Node proxy can serve both API families from one port:

```bash
npx pxpipe
```

Claude Code continues to use the Anthropic route:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude
```

OpenAI-compatible GPT clients use the OpenAI route:

```bash
OPENAI_BASE_URL=http://127.0.0.1:47821/v1
```

Environment variables:

| name | default | meaning |
|---|---|---|
| `ANTHROPIC_UPSTREAM` | `https://api.anthropic.com` | Upstream for `/v1/messages` |
| `OPENAI_UPSTREAM` | `https://api.openai.com` | Upstream for `/v1/chat/completions` |
| `OPENAI_API_KEY` | unset | Optional OpenAI key override; otherwise client `Authorization` is forwarded |

## Quick start (Cloudflare Workers)

`renderTextToPngs` works in Workers via the WASM build of `node-canvas`
shipped under `dist/wasm/`. Set `nodejs_compat` in `wrangler.toml`.

```ts
import { renderTextToPngs } from "pxpipe";

export default {
  async fetch(req: Request) {
    const text = await req.text();
    const pngs = await renderTextToPngs(text);
    return new Response(pngs[0], { headers: { "content-type": "image/png" } });
  },
};
```

---

## Library API

```ts
// Top-level: render a string to one or more PNG pages.
renderTextToPngs(text: string, cols?: number, style?: RenderStyle): Promise<Buffer[]>

// Lower-level helpers (exported for callers that want to gate themselves):
estimateImageCount(text: string, cols?: number): number
shrinkColsToContent(text: string, cols: number): number
wrapLines(text: string, cols: number, markerScale?: number): string[]
```

### Constants

| name                            | value  | meaning                                        |
|---------------------------------|--------|------------------------------------------------|
| `READABLE_CHARS_PER_IMAGE`      | 50 000 | hard ceiling on chars packed into one page     |
| `DENSE_CONTENT_CHARS_PER_IMAGE` | 5 000  | target chars/page for dense tool-result pages  |
| `DENSE_CONTENT_COLS`            | 180    | column width for dense pages                   |
| `DEFAULT_COLS`                  | 313    | column width when caller doesn't override      |
| `MAX_HEIGHT_PX`                 | 1 568  | page height ceiling                            |

---

## Configuration

There is none in the library itself. Callers (e.g. ocproxy) decide:

* whether to render this particular tool_result at all
* what `cols` to pass (often `DEFAULT_COLS` is fine)
* what to do with the PNGs (attach, cache, etc.)

---

## Architecture

```
src/core/
  render.ts        renderTextToPngs, wrapLines, encodeGrayPng
  transform.ts    estimateImageCount, transformAnthropicMessages,
                  textToImageBlocks, shrinkColsToContent
  library.ts       public re-exports → dist/core/index.js
```

`src/server/` and `src/dashboard*` are *not* part of the library; they
are tools used during development and for the demo dashboard.

---

## Development

```bash
pnpm install
pnpm run typecheck
pnpm test                # 320 tests
pnpm run build           # regenerates dist/
```

Tests of interest:

* `tests/paging.test.ts` — page-count contract across sizes
* `tests/render.test.ts` — wrap / shrink / gate behaviour

The paging contract: with the 6 000-char readable cap, geometry is
~480 px tall per page, and `estimateImageCount` returns ceil(chars / 6 000)
once the input clears the profitability gate.

---

## Limitations

* Only ASCII / Latin-1 has been seriously tested. Wide CJK glyphs work
  but their `markerScale` heuristics are conservative.
* `node-canvas` is a native dep on Node and a WASM dep on Workers. The
  Workers build is larger.
* No streaming. Rendering is per-tool_result.
* Profitability is **workload-specific**, not just model-specific. It wins on
  token-dense content (code, JSON, tool output, hashes ~1 char/token) and
  loses on sparse prose (~3.5 chars/token). Enabled for Fable 5 callers.
* **Verbatim recall is unreliable.** Exact strings inside imaged content (0/15
  in eval) can be silently confabulated — a plausible wrong value, not an
  error. Keep anything you need byte-exact as text; pxpipe is a lossy gist
  tier, not a lossless store. A verbatim-risk guard (skip blocks with unique
  IDs / hashes / exact values) is not yet built.

---

## License

MIT.
