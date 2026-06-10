# pxpipe

**Cut Claude Code input-token spend by rendering old context as images.**

Anthropic bills a 1568px-wide image at a flat rate regardless of how much text
is inside it. Dense content (code, JSON, tool output) packs ~3.1 chars per
image-token vs ~1 char per text-token on real Claude Code traffic. pxpipe is a
local proxy that exploits that gap: it rewrites the bulky middle of your
conversation into compact PNGs before the request leaves your machine.

Running against real Claude Code sessions, the production log shows
**77% input tokens saved across 6,691 requests** (3.21B baseline → 735M
actual). Single sessions measure ~68%.

This is what the model sees instead of text:

![example: a real `transformRequest` output — system prompt + tool docs reflowed into one dense 1573×1248 page, instruction banner on top, ↵ marking original newlines](docs/assets/example-render.png)

*~48k characters of system prompt + tool docs (this repo's own README,
FINDINGS, and source) — ≈25k tokens as text, ≈2.7k image tokens as this page.
Produced by the real `transformRequest` pipeline: whitespace-minified, reflowed
into full rows with ↵ marking original newlines, OCR instruction banner
co-rendered on top. The model reads renders like this at 100/100 on a clean
eval (see benchmarks).*

## Try it (30 seconds)

```bash
npx pxpipe                                        # proxy on 127.0.0.1:47821
ANTHROPIC_BASE_URL=http://localhost:47821 claude  # point Claude Code at it
```

Open <http://127.0.0.1:47821/> for a live dashboard: tokens saved, per-session
stats, every text→image conversion side by side, and a kill switch.

Nothing else changes. Responses stream normally — pxpipe only compresses the
*request* (your context going up), never the model's output. Recent turns stay
text; only older bulk history is imaged.

## The honest part — read before relying on it

**It is lossy.** pxpipe is a *gist* tier, not a lossless store. In a
needle-in-haystack eval, exact 12-char hex strings inside dense imaged content
came back **0/15** on Opus and 3/4 on Fable 5 — and the failure mode is
*silent confabulation*: a plausible wrong value, not an error. Anything you
need back byte-exact (IDs, hashes, secrets, exact numbers) must stay text.
Recent turns do; a dedicated verbatim-risk guard is not built yet.

**Savings are workload-dependent.** It wins on token-dense content
(~1 char/token: code, JSON, hashes) and *loses money* on sparse English prose
(~3.5 chars/token). The built-in gate only images content where the math wins,
calibrated against N=391 production rows.

**Model scope: Fable 5 only** (`claude-fable-5`), enforced in library and
proxy. Opus 4.7/4.8 was the original scope but misread ~7% of renders
(`10200`→`9400`), so it was disabled once Fable 5 hit 100/100 with identical
image billing. Everything else passes through untouched.

## Benchmarks (reproducible)

Measured with novel random-number problems the model cannot have memorized:

| test | N | text | pxpipe (image) | tokens |
|---|---:|---:|---:|---|
| novel arithmetic, `claude-fable-5` | 100 | 100% | **100%** | **−38%** |
| novel arithmetic, `claude-opus-4-8` | 100 | 100% | 93% | −38% |
| verbatim 12-char hex recall, dense render, Opus | 15 | 15/15 | **0/15** | — |
| verbatim 12-char hex recall, dense render, Fable 5 | 4 | — | 3/4 | — |

<sub>We also ran GSM8K: 96% imaged. But GSM8K is in training data — the model
recalls memorized answers through its own misreads, inflating the score — so we
lead with the clean novel-number eval instead. Reproduce:
[`eval/gsm8k/`](eval/gsm8k/) · [`eval/needle-haystack/`](eval/needle-haystack/) ·
full analysis in [`FINDINGS.md`](FINDINGS.md).</sub>

## How it works

```
tool_result string ──► wrap at 1568px-wide columns ──► pack ~5,000 chars/page ──► PNG[]
```

The proxy intercepts `/v1/messages`, rewrites eligible bulk history into image
blocks, splices them back cache-friendly (static prefix preserved, so prompt
caching keeps working), and forwards. Per-request events log to
`~/.pxpipe/events.jsonl`.

The economics: a 1568×1568 image costs ≈1,568 vision tokens and holds ≈5,000
readable chars (≈1,250 text tokens) — so plain text is cheaper *unless* your
text is token-dense. Claude Code transcripts are (observed 1.91 chars/token,
N=391). The runtime estimator (`estimateImageCount`) plus a chars/token gate
decides per-request; sparse prose is left as text.

## Library use (no proxy)

```ts
import { renderTextToPngs, estimateImageCount } from "pxpipe";

const pngs = await renderTextToPngs(toolResultText);  // Buffer[] — attach to the next user turn
```

```ts
renderTextToPngs(text: string, cols?: number, style?: RenderStyle): Promise<Buffer[]>
estimateImageCount(text: string, cols?: number): number   // gate yourself
wrapLines(text: string, cols: number, markerScale?: number): string[]
```

| constant | value | meaning |
|---|---|---|
| `DENSE_CONTENT_CHARS_PER_IMAGE` | 5 000 | target chars per page |
| `READABLE_CHARS_PER_IMAGE` | 50 000 | hard ceiling per page |
| `DEFAULT_COLS` | 313 | column width |
| `MAX_HEIGHT_PX` | 1 568 | page height ceiling |

## Development

```bash
pnpm install && pnpm test     # 323 tests
pnpm run build                # regenerates dist/
```

## Limitations

* **Lossy** — see "the honest part" above. Verbatim recall from images is unreliable.
* Render latency: encoding PNGs adds time to large requests before they leave
  (partly offset by the model ingesting fewer tokens). Responses stream normally.
* ASCII/Latin-1 well tested; CJK works but conservatively.
* `node-canvas` native dep on Node.
* Fable 5 only.

## License

MIT.
