# pixelpipe

Turn Claude's tool-result text into compact PNGs before it ever reaches the
model. Anthropic charges per token; vision tokens for a dense 1568×1568 image
are dramatically cheaper than the same content delivered as transcript text.
pixelpipe is the encoder that exploits that gap.

It is a small, focused TypeScript library — no daemon, no MCP wiring, no
opinions about transport. You hand it a string, it hands you one or more
ready-to-send PNG buffers.

---

## Status

Experimental. The library ships and runs, but the cost math depends on
Anthropic's current image-token pricing and on the model you point at it.
Today, **only Opus 4.6 and Opus 4.7 are enabled** in practice — newer
models (Opus 5.x) tighten image tokenization enough that the savings
disappear or invert, and non-Opus families have not been validated. We gate
on this at runtime; see *Why option A* below.

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
fatter than text tokens — which Opus 4.6/4.7 effectively do on cold-miss
cached transcripts.

We measure rather than guess. The runtime estimator
(`estimateImageCount`) tells the caller how many images a string would
produce; the caller's gate decides whether that beats sending text. Built-in
defaults are model-aware: Opus 4.7 uses `2.0` chars/token for slab/history
gates, while Opus 4.6 uses the older, more conservative `2.5` chars/token
default unless the host supplies an empirical override.

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

## Quick start (Node)

```ts
import { renderTextToPngs } from "pixelpipe";

const pngs = await renderTextToPngs(toolResultText);
// pngs: Buffer[]  — attach to the next user turn
```

## Quick start (Cloudflare Workers)

`renderTextToPngs` works in Workers via the WASM build of `node-canvas`
shipped under `dist/wasm/`. Set `nodejs_compat` in `wrangler.toml`.

```ts
import { renderTextToPngs } from "pixelpipe";

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

| name                       | value | meaning                                      |
|----------------------------|-------|----------------------------------------------|
| `READABLE_CHARS_PER_IMAGE` | 6 000 | upper bound on chars packed into one page    |
| `MIN_TOO_L_RESULT_CHARS`   | 6 000 | inputs below this should not be rendered     |
| `MIN_REMINDER_CHARS`       | 6 000 | gate for adding "(see image)" reminder text  |
| `DEFAULT_COLS`             | 100   | column width when caller doesn't override     |
| `MAX_HEIGHT_PX`            | 1 568 | page height ceiling                          |
| `MAX_WIDTH_PX`             | 1 568 | page width                                   |

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
pnpm run typecheck      # 315 tests pass
pnpm test
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
* Profitability is model-specific. We currently expect Opus 4.6 / 4.7 callers.

---

## License

MIT.
