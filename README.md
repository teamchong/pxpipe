# pxpipe

**Cut Claude Code's input tokens by rendering bulky context as images — the same system prompt, tool docs, and history, in a fraction of the tokens.**

An image's token cost is fixed by its pixel dimensions, not by how much text
is inside it. Dense content (code, JSON, tool output) packs ~3.1 chars per
image-token vs ~1 char per text-token on real Claude Code traffic. The
reader is the same vision channel that Anthropic's computer use already
relies on for screenshots. pxpipe is a local proxy that uses that channel
for context: it rewrites the bulky parts of each request into compact PNGs
before it leaves your machine. At current Fable
list prices that lands as a **~59–70% lower end-to-end bill** — but prices
move and workloads differ, so the durable number is the token cut itself,
measured per-request against a free `count_tokens` counterfactual in
`~/.pxpipe/events.jsonl`.

This is what the model sees instead of text:

![example: a real `transformRequest` output: system prompt + tool docs reflowed into one dense page, instruction banner on top, ↵ marking original newlines](https://raw.githubusercontent.com/teamchong/pxpipe/main/docs/assets/example-render.png)

*~48k chars of system prompt + tool docs: ≈25k tokens as text, ≈2.7k image
tokens as this page. Real pipeline output; the model reads renders like this
at 100/100 (see benchmarks).*

![chart: characters a frontier context window holds, 2018–2026 — vendor text series including Grok 4.5; orange measured overlay is Fable 5 [1m] + pxpipe ~18M (4.6×)](docs/assets/context-window-chars.png)

*Eight years of context growth, in characters. Every text line tops out near
~4M chars (a 1M-token window at ~4 chars/token); **Grok 4.5** is shown as a
text-window point only (500K). The orange overlay is the **same Fable 5 1M
window** read through pxpipe images — ~18M chars at the measured Anthropic
density (**4.6×** the text ceiling). Density is measured from a live render at
generation time, not hand-typed: regenerate with
`npx tsx scripts/gen-context-chart.ts`
([source](scripts/gen-context-chart.ts)).*

## Demo

**Fable 5 (the default, 100/100 reader) — plain left, pxpipe right:**

https://github.com/user-attachments/assets/1c8ee63a-fcd7-4958-917b-da788d718349

pxpipe counts an exact token **10/10** across 39 imaged filler files
(matches `grep` line-for-line), gets the multi-step ledger arithmetic right,
and ends the session at **$6.06** with context to spare (73.5k/1M) vs
**$42.21** at 96% full. One caveat visible in the clip: the pxpipe arm
needed a nudge to match the requested one-line output format.

**Opus 4.8 (disabled by default) — same layout:**

https://github.com/user-attachments/assets/f4e50137-31b5-426f-a6ed-b83f829b4a2c

Text needles read fine on both arms; the imaged phrase-count doesn't read on
Opus — and pxpipe **says so instead of fabricating a number**. That misread
rate is why Opus is opt-in.

## Try it (30 seconds)

```bash
npx pxpipe-proxy                                  # proxy on 127.0.0.1:47821
ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude  # point Claude Code at it
```

Dashboard at <http://127.0.0.1:47821/>: tokens saved, every text→image
conversion side by side, kill switch, live model chips. Responses stream
normally — pxpipe compresses the *request* only, never the model's output.
Recent turns stay text; the system prompt, tool docs, and older bulk history
are imaged.

## The honest part

- **It is lossy.** Exact 12-char hex strings in dense imaged content:
  **13/15** on Fable 5, **0/15** on Opus — and misses are *silent
  confabulations*, not errors. Byte-exact values (IDs, hashes, secrets)
  must stay text; recent turns do. A dedicated verbatim-risk guard is not
  built yet.
- **Escape hatch:** subagents on non-allowlisted models pass through as
  text — route byte-exact work there
  (`CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-4-6`, or `model: sonnet` in
  agent frontmatter).
- **Real work:** SWE-bench Lite pilot **10/10 both arms** at −65% request
  size; SWE-bench Pro **14/19 ON vs 15/19 OFF** at −60%, verdicts agree
  18/19, and the single split re-resolved 3/3 on replication — run-to-run
  variance, not compression. Small n; receipts in `eval/`.
- **Workload-dependent.** Wins on token-dense content (~1 char/token),
  loses money on sparse prose (~3.5 chars/token); a profitability gate
  (calibrated on N=391 production rows) images only where the math wins.
- **Client-dependent, not product-name-dependent.** Savings track uncached
  bulk the client still re-sends as text. Claude Code re-sends system + tools
  + history on `/anthropic/messages` and typically lands ~60–70%. Codex on
  `/v1/responses` is supported; when the prompt is already ~98%
  `cached_tokens`, only the static slab (and rare history collapses) remain
  to image, so Saved can honestly sit near 1%. The same Responses path saves
  tens of percent when history collapse fires, and an OpenAI client that
  re-sends the full transcript as plain text each turn is in the same high-
  savings class as Claude Code. Details and measured splits:
  [docs/CACHING_AND_SAVINGS.md](docs/CACHING_AND_SAVINGS.md#openai-responses-path-codex-and-friends).
- **Model scope:** default `PXPIPE_MODELS=claude-fable-5`. Sol, Opus
  4.7/4.8, GPT 5.5, and **Grok** are opt-in only (dashboard chips or
  `PXPIPE_MODELS`) — not good enough as silent defaults for imaged context.
  Grok packing + factsheet helps exact IDs, but pure-image is not Fable-
  level and the full quality suite is incomplete. The exact Sol id still
  matters when opted in: sibling variants such as `gpt-5.6-terra` do not
  inherit Sol's allowlist or render profile. `PXPIPE_MODELS=off` disables
  imaging. Everything else passes through byte-identical. On the GPT path,
  tool definitions stay native JSON and no Anthropic `cache_control`
  markers are used.
- **Per-model rendering:** opt-in `gpt-5.6-sol` currently uses a 126-column,
  6×11 JetBrains Mono profile; Claude keeps its 312-column 5×8 Spleen profile. These
  are selected by exact model id, including history pages and profitability
  math. **Sol recall caveat:** raw-image calls scored 0/4 exact with four
  inventions at both current 6×11 and old shared 5×8; 6×11 passed gist/guard,
  while 5×8 also missed gist. Production's verbatim fact-sheet remains a text
  fallback for extracted identifiers. An effective 9×12 Sol retune is rendered
  but not yet model-tested, so the current Sol geometry is operational—not
  recall-validated. [Sol receipts](eval/sol-profile/RESULTS.md) and
  [profile evidence](docs/MODEL_RENDER_PROFILES.md).
- **Grok 4.5 (opt-in): 5×8 white + IDS + text factsheet.** Off by default
  (not Fable-level pure-image). Production packing (Spleen 5×8, 152 cols,
  maxH 512, AA white, no grid) plus in-image IDS and the **verbatim text
  factsheet**. Live Codex-path matrix: pure-image alone fails exact; **image
  + factsheet is 4/4** and multi-seed **3/3** full pass — still opt-in until
  the full quality suite matches Fable. Enable with
  `PXPIPE_MODELS=claude-fable-5,grok-4.5` or the dashboard chip.
  [eval/grok-density/QUALITY_RESULTS.md](eval/grok-density/QUALITY_RESULTS.md).

## Benchmarks (reproducible)

### Model quality (does the model read the images?)

Claude numbers are novel problems the model cannot have memorized. Grok’s
shipped claim is the pure-image ID battery on the production 5×8 white+IDS
profile (no factsheet).

| test | model | N | text | pxpipe (image) | tokens |
|---|---|---:|---:|---:|---|
| novel arithmetic | `claude-fable-5` | 100 | 100% | **100%** | **−38%** |
| novel arithmetic | `claude-opus-4-8` | 100 | 100% | 93% | −38% |
| gist recall A/B (decisions, values, paths, names, negations; distractors; 15k–45k char sessions) | Fable 5 | 98/arm | 98/98 | **98/98** | - |
| state tracking (value mutated 3×, final/first/count) | Fable 5 | 18/arm | 18/18 | **18/18** | - |
| confabulation on never-stated facts (lower is better) | Fable 5 | 16/arm | 0/16 | **0/16** | - |
| verbatim 12-char hex, dense render | Opus | 15 | 15/15 | **0/15** | - |
| verbatim 12-char hex, dense render | Fable 5 | 15 | - | **13/15** | - |
| ID battery (hex / camel / path / port), 5×8 white+IDS **+ factsheet** (production) | **`grok-4.5`** | 3 seeds | - | **3/3 full 4/4** (0 confab); pure-image alone fails live | - |

Grok receipt:
[`eval/grok-density/VISUAL_5X8_SOLUTION.md`](eval/grok-density/VISUAL_5X8_SOLUTION.md) ·
[`five-by-eight-ids-block-white-stability.json`](eval/grok-density/five-by-eight-ids-block-white-stability.json).
**Harness split:** Fable/Opus quality rows use **Claude**; Grok quality uses
**Codex’s Responses provider** (`OPENAI_BASE_URL`, typically ocproxy) — see
[`eval/grok-density/QUALITY_SUITE.md`](eval/grok-density/QUALITY_SUITE.md).
Multi-seed IDs + factsheet (**3/3 pass**) and fix-matrix results are in
[`QUALITY_RESULTS.md`](eval/grok-density/QUALITY_RESULTS.md). Novel arithmetic
N=100 still open. Pure-image-only is **not** Fable-grade on live Grok.

### Capacity / density (how many chars per vision-token?)

Measured by rendering this repo’s dense fixture through the real pipeline and
pricing pixels at each family’s vision rate. Multiplier = measured
chars/vision-token ÷ 4 (prose text baseline). Not a model-quality score.

| family | window | as text (@4 c/tok) | as pxpipe images | density | multiplier |
|---|---:|---:|---:|---:|---:|
| **`claude-fable-5[1m]`** (default) | 1M | ~4.0M | **~18.3M** | ~18.3 c/vt (px÷750) | **~4.6×** |
| **`grok-4.5`** (opt-in; chart = text only) | 500K (xAI `maxPromptLength`) | ~2.0M | — | — | — |

Regenerate: `npx tsx scripts/gen-context-chart.ts` · chart PNG
[`docs/assets/context-window-chars.png`](docs/assets/context-window-chars.png).

SWE-bench run totals, receipts, and caveats:
[`eval/swe-bench/`](eval/swe-bench/) ·
[`eval/swe-bench-pro/`](eval/swe-bench-pro/) ·
[`eval/needle-haystack/`](eval/needle-haystack/) ·
[`eval/gist-recall/`](eval/gist-recall/) ·
[`eval/grok-density/`](eval/grok-density/) · analysis in
[`FINDINGS.md`](FINDINGS.md). (GSM8K scored 96% imaged, but it's in training
data — memorized answers survive misreads — so we lead with the novel-number
evals.)

## How it works

```
model id ──► render profile ──► wrap/reflow bulk context ──► PNG[] + exact-token factsheet
```

The proxy intercepts `/v1/messages`, rewrites eligible bulk into image
blocks, splices them back cache-friendly (static prefix preserved, prompt
caching keeps working), and forwards. Claude uses 1568×728 pages; GPT 5.6 Sol
uses 764px-wide portrait strips; opt-in Grok 4.5 uses 152-col 5×8 strips
(maxH 512) with white AA, an in-image IDS block, and a text factsheet. A
per-request estimator uses that same resolved profile, so sparse prose stays
text. Events log to `~/.pxpipe/events.jsonl`.

## Library use (no proxy)

```ts
import { renderTextToImages, transformAnthropicMessages } from "pxpipe-proxy";

const { pages } = await renderTextToImages(toolResultText);     // pages[i].png: Uint8Array
const { body, applied, info } = await transformAnthropicMessages({
  body: requestBytes,
  model: "claude-fable-5",
});
```

`options.keepSharp(block)` pins blocks as text; `options.emitRecoverable`
returns the originals of imaged blocks. Pure-JS runtime (Node and
edge/Workers); `@napi-rs/canvas` is build-time only. Full API:
`src/core/index.ts`.

## Development

```bash
pnpm install && pnpm test
pnpm run build                # regenerates dist/
```

## FAQ

**Is the headline end-to-end, or only on the requests you touched?**
End-to-end, the whole bill. Most compression tools report savings only on
the input slice they touched, which flatters the number. The end-to-end
denominator is *every* production request: the small ones pxpipe correctly
left untouched, all cache writes and reads, and all output tokens (which the
proxy never compresses). On a 13,709-request snapshot that was 59% ($100 →
~$41); a later 8,904-compressed-request trace measured ~70%. Compressed-only
runs higher (~72–74%) and is quoted separately, never as the headline. The
exact figure is workload-dependent — reproduce it on your own log.

**How is the math measured?**
Both sides of the same request, at the same moment. For every `/v1/messages`
POST the proxy fires a free `count_tokens` probe on the original uncompressed
body (the counterfactual) in parallel with the real forward, and reads
Anthropic's actually-billed usage block off the response. Both land in the
same row of `~/.pxpipe/events.jsonl`, so there is no turn-count or
run-to-run confound. Dollar conversion uses Fable 5 list ratios: input ×1.0,
cache write ×1.25, cache read ×0.1, output ×5. Cache pricing is applied
identically to both sides, so the caching discount cancels and cannot be
double-counted as "savings". Re-derive it yourself from the events log: the
formula and field names are documented in `src/core/baseline.ts`.

**What does it actually compress?**
Three kinds of *input* blocks, each behind a profitability gate:

1. large `tool_result` bodies (file reads, command output, logs) above
   ~6k chars of token-dense content
2. older collapsed history: turns behind the live tail get re-rendered as
   image pages, recent turns always stay text
3. the static system prompt + tool docs slab

Everything else passes through byte-identical: your messages, recent turns,
the model's output (it is the response, the proxy never touches it), sparse
prose, and anything too small to win. Models outside the allowlist pass
through entirely — the built-in default scope is Fable 5 only. Sol, Opus
4.8, GPT 5.5, and Grok are deliberately opt-in via the dashboard or
`PXPIPE_MODELS`, never silently imaged. Sol joined that list after both its
6×11 profile and the old shared 5×8 profile scored 0/4 exact with four
confabulations in direct raw-image calls. Grok stays opt-in: pure-image is
not Fable-level and the full quality suite is incomplete.

**Has it ever failed for real, outside the benchmarks?**
Yes, once in weeks of daily use: the model recalled a person's name from
imaged chat history and got it confidently wrong. No error, just a
plausible wrong name. That is the documented failure mode: exact strings
in imaged content are not byte-safe. Coding sessions tolerate this because
the agent re-reads files before editing; pure chat recall has no such check.
This failure mode is measured, not anecdotal:
[the legibility audit](docs/LEGIBILITY-AUDIT-2026-07-01.md) quantifies
exact-string recall off rendered pages (blind reads top out at 63% on dense
identifiers, with every miss predicted by a glyph-confusability matrix) and
documents the shipped mitigations — page geometry clamped to the API's
resample cap so billed pixels actually reach the vision encoder, and exact
identifiers (SHAs, numbers) riding alongside as text.

**Why are misses silent confabulations instead of read errors?**
Because model vision is not OCR: the image becomes patch embeddings, never
discrete characters, so there is no per-glyph confidence to fail loudly
on. When pixels underdetermine a glyph, the language prior fills the gap
with something plausible. Mechanism and receipts:
[docs/NOT-OCR.md](docs/NOT-OCR.md).

**Didn't DeepSeek-OCR show this doesn't hold up in practice?**
No: it proved the channel works, using an encoder/decoder pair trained for
the job. The skepticism dates from October 2025, when no stock production
model could read dense renders; that changed with Fable 5 (0/15 verbatim
hex on Opus 4.8 vs 13/15 on Fable 5, same pages). Timeline and per-model
numbers: [docs/NOT-OCR.md](docs/NOT-OCR.md).

**Why does the README read like an AI wrote it?**
Because one did. Most of this repo's commits — the code and the docs — were
authored by Opus/Fable agent sessions running behind pxpipe itself, reading
their own collapsed history as image pages while they worked.

## Limitations

- Lossy (above); verbatim recall from images is unreliable.
- PNG encoding adds latency to large requests before they leave.
- ASCII/Latin-1 well tested; CJK works but conservatively.

## Roadmap

Rendering research is parked as of 2026-07-05: verbatim misreads are
capacity-bound, not trick-bound, so no font/color/layout change fixes
exact-string recall at profitable density. The why is in
[docs/NOT-OCR.md](docs/NOT-OCR.md); the dated analysis and the three
documented follow-up threads (glyph-style A/B with banked pages, runtime
canary + re-fetch, surrogate-reader pre-flight) are in
[FINDINGS.md](FINDINGS.md), 2026-07-05 entry. Watch condition: re-run the
resolution sweep per model release; readable density moved ~4x in glyph
area from Opus 4.8 to Fable 5, and a model that reads production cells
near 100% means savings rise for free.

Still open, unchanged: whether imaged bulk stretches effective context (~2x
the real content in the same 1M window), and whether a smaller active
context improves long-task accuracy. Hypotheses, not claims — they ship as
numbers with an n or they get cut.

## License

MIT.
