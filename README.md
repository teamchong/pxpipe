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

![chart: characters a frontier context window holds, 2018–2026 — vendor text series including Grok 4.5; orange measured overlays are Fable 5 [1m] + pxpipe ~19.0M (4.8×) and Gemini 3.6 Flash + pxpipe ~21.3M (5.3×)](docs/assets/context-window-chars.png)

*Eight years of context growth, in characters. Every text line tops out near
~4M chars (a 1M-token window at ~4 chars/token); **Grok 4.5** is shown as a
text-window point only (500K). The orange overlays are the **same 1M
windows** read through pxpipe images — ~19.0M chars for Fable 5 (**4.8×**) and ~21.3M chars for Gemini 3.6 Flash (**5.3×** text capacity). Density is measured from a live render at
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

## Offline export (no proxy)

You can render text, files, or diffs to PNG pages without running the proxy or
connecting Claude Code:

```bash
npx pxpipe-proxy export src/
cat prompt.txt | npx pxpipe-proxy export --stdin
npx pxpipe-proxy export --git
```

If the package is installed, use `pxpipe export` instead of
`npx pxpipe-proxy export`.

Each run writes a fresh `pxpipe-export-XXXXXX/` output folder (the exact path
is printed when the command finishes) containing `page-*.png`, `factsheet.txt`,
`manifest.json`, and `prompt.txt`. Upload the PNG pages and paste the prompt
into image-upload clients such as Cursor when you want dense visual context
without running the proxy.

## The honest part

- **It is lossy.** Exact 12-char hex strings in dense imaged content:
  **13/15** on Fable 5, **0/15** on Opus, and **0/15** on Sol — misses are *silent
  confabulations*, not errors. Byte-exact values (IDs, hashes, secrets)
  must stay text; recent turns do. The factsheet selectively preserves up to
  96 recognized precision-critical tokens, not every identifier. A dedicated
  verbatim-risk guard is not built yet.
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
- **Client-dependent.** Savings track uncached bulk the client still
  re-sends as text. Claude Code re-sends system + tools + history on
  `/anthropic/messages` and typically lands ~60–70%. Details and measured
  splits: [docs/CACHING_AND_SAVINGS.md](docs/CACHING_AND_SAVINGS.md).

<details>
<summary><strong>Model support and rendering details</strong></summary>

- **Model scope:** default `PXPIPE_MODELS=claude-fable-5,gemini-3.6-flash`. Sol, Opus
  4.7/4.8, GPT 5.5, and **Grok** are opt-in only (dashboard chips or
  `PXPIPE_MODELS`). The exact Sol id still matters. Sibling variants such as
  `gpt-5.6-terra` do not
  inherit Sol's allowlist or render profile. `PXPIPE_MODELS=off` disables
  imaging. Everything else passes through byte-identical. On the GPT path,
  tool definitions stay native JSON and no Anthropic `cache_control`
  markers are used. Responses history compression recognizes completed
  `function_call`/`function_call_output` pairs, including OpenCode's parallel
  calls-then-outputs rounds: only old closed rounds are imaged atomically;
  every open call and malformed/orphan state remains native. The base profile
  keeps the newest six completed pairs and allows 32 images; Sol keeps one pair
  and allows 64 images, while Grok allows 24 images. Opt-in long-session
  coverage can be changed (defensive cap 100) with
  `PXPIPE_GPT_HISTORY_MAX_IMAGES=48` after validating the provider's request cap.
- **Per-model rendering:** opt-in `gpt-5.6-sol` uses a 152-column,
  768px-wide 5×8 Spleen profile; Claude keeps its 312-column, 1568×728
  5×8 Spleen profile. These
  are selected by exact model id, including history pages and profitability
  math. Recognized IDs can ride in the bounded factsheet, and
  recent/open tool state stays native.
  [Sol receipts](eval/sol-profile/QUALITY_RESULTS.md) and
  [profile evidence](docs/MODEL_RENDER_PROFILES.md).
- **Grok 4.5 (opt-in):** same production recipe as Sol (5×8 Spleen, IDS, text
  factsheet; Grok strip maxH 512). Off by default (not Fable-level pure-image).
  Enable with
  `PXPIPE_MODELS=claude-fable-5,grok-4.5` or the dashboard chip.
  [eval/grok-density/QUALITY_RESULTS.md](eval/grok-density/QUALITY_RESULTS.md).

</details>

## Benchmark results and receipts

### Model quality

This matrix shows coverage as well as scores. `—` means the model was not run
on that test; it does not mean zero. Arithmetic uses novel random-number
problems. Gist, state, and never-stated probes share one corpus. Never-stated
is confabulations, so lower is better.

| model | arithmetic (N=100) | gist (N=98) | state (N=18) | never-stated (N=16) | dense hex (N=15) | profile provenance and receipts |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `claude-fable-5` | **100/100** | **98/98** | **18/18** | **0/16** | **13/15** | June 2026 production profiles: [arithmetic + hex](FINDINGS.md), [gist/state/guards](eval/gist-recall/) |
| `google/gemini-3.6-flash` | **100/100** | **98/98** | **18/18** | **0/16** | **14/15** | current shipped profile: [quality results](eval/gemini-profile/QUALITY_RESULTS.md) |
| `gpt-5.6-sol` | **98/100** | 83/98 | 17/18 | 4/16 | 0/15 | current shipped profile: [quality results](eval/sol-profile/QUALITY_RESULTS.md) |
| `claude-opus-4-8` | 93/100 | — | — | — | 0/15 | historical profile: [arithmetic](eval/gsm8k/), [dense hex](eval/needle-haystack/) |
| `grok-4.5` | 82/100 | 83/98 | 13/18 | **0/16** | 0/15 | current shipped profile: [quality results](eval/grok-density/QUALITY_RESULTS.md) |
| `moonshotai/kimi-k3` | 79/100 | 84/98 | 15/18 | 1/16 | 0/15 | generic GPT profile: [quality results](eval/sol-profile/KIMI_K3_QUALITY_RESULTS.md) |

The runs use different transports and profile generations, not one identical
image geometry. Fable and Opus use Claude; Gemini uses Google AI Studio; Sol
and Grok use Codex Responses; Kimi K3 uses Cloudflare's OpenAI-compatible
transport. Current production profiles include the adjacent bounded factsheet;
historical or pure-image exceptions are identified in the linked evaluation.

### Model-specific evaluations

These are not cross-model comparisons. Every unlisted model is **not run**.

| test | model | result | evaluation and receipts |
| --- | --- | --- | --- |
| SWE-bench Lite | `claude-fable-5` | pxpipe 10/10; text 10/10; −65% request size | [paired pilot](eval/swe-bench/) |
| SWE-bench Pro | `claude-fable-5` | pxpipe 14/19; text 15/19; −60% request size | [paired pilot](eval/swe-bench-pro/) |
| production-history row localization | `google/gemini-3.6-flash` | text 17/30; pxpipe 18/30 | [positional retrieval](eval/gemini-profile/QUALITY_RESULTS.md#production-history-positional-retrieval) |
| production-history exact row | `google/gemini-3.6-flash` | text 3/30; pxpipe 3/30 | [positional retrieval](eval/gemini-profile/QUALITY_RESULTS.md#production-history-positional-retrieval) |

The SWE-bench runner is Claude Code/Fable-specific; no other model has an ON/OFF
run. Gemini's positional-retrieval sweep is directional evidence, not a general
Lost-in-the-Middle result.

### Capacity / density (how many chars per vision-token?)

Measured by rendering this repo’s dense fixture through the real pipeline and
pricing pixels at each family’s vision rate. Multiplier = measured
chars/vision-token ÷ 4 (prose text baseline). Not a model-quality score.

| family | window | as text (@4 c/tok) | as pxpipe images | density | multiplier |
|---|---:|---:|---:|---:|---:|
| **`claude-fable-5[1m]`** (default) | 1M | ~4.0M | **~19.0M** | ~19.0 c/vt (exact 28px patches) | **~4.8×** |
| **`google/gemini-3.6-flash`** | 1M | ~4.0M | **~21.3M** | ~21.3 c/vt (1,078 tok/page) | **~5.3×** |

Regenerate: `npx tsx scripts/gen-context-chart.ts` · chart PNG
[`docs/assets/context-window-chars.png`](docs/assets/context-window-chars.png).

The older GSM8K result is omitted because its training-data contamination can
hide image misreads; the linked arithmetic evaluations use novel numbers.

## How it works

```
model id ──► render profile ──► wrap/reflow bulk context ──► PNG[] + bounded factsheet
```

The proxy handles Anthropic Messages, OpenAI Responses and Chat Completions,
and Google `generateContent` requests. It rewrites eligible bulk into image
blocks and forwards the provider-native request, or bridges Anthropic Messages
to a configured OpenAI-compatible provider. On Anthropic, the static prefix and
prompt-cache boundary are preserved. Model-specific profiles control geometry,
factsheets, history retention, and profitability, so sparse prose stays text.
Events log to `~/.pxpipe/events.jsonl`.

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

Windows is community-supported: primary development targets macOS/Linux, and Windows-specific fixes rely on contributor PRs (thanks @makoribrian).

## FAQ

<details>
<summary><strong>Is the headline end-to-end, or only on the requests you touched?</strong></summary>

End-to-end, the whole bill. Most compression tools report savings only on
the input slice they touched, which flatters the number. The end-to-end
denominator is *every* production request: the small ones pxpipe correctly
left untouched, all cache writes and reads, and all output tokens (which the
proxy never compresses). On a 13,709-request snapshot that was 59% ($100 →
~$41); a later 8,904-compressed-request trace measured ~70%. Compressed-only
runs higher (~72–74%) and is quoted separately, never as the headline. The
exact figure is workload-dependent — reproduce it on your own log.

</details>

<details>
<summary><strong>How is the math measured?</strong></summary>

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

</details>

<details>
<summary><strong>What does it actually compress?</strong></summary>

Three kinds of *input* blocks, each behind a profitability gate:

1. large `tool_result` bodies (file reads, command output, logs) above
   ~6k chars of token-dense content
2. older collapsed history: turns behind the live tail get re-rendered as
   image pages, recent turns always stay text
3. the static cacheable system prompt + tool docs slab; appended non-cacheable
   system blocks stay live text so host custom instructions keep system-level
   salience

Everything else passes through byte-identical: your messages, recent turns,
the model's output (it is the response, the proxy never touches it), sparse
prose, and anything too small to win. Model defaults and detailed results are
listed under [model support](#the-honest-part) and
[benchmarks](#benchmark-results-and-receipts).

</details>

<details>
<summary><strong>Has it ever failed for real, outside the benchmarks?</strong></summary>

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
resample cap so billed pixels actually reach the vision encoder, and selected
identifiers (SHAs, numbers) riding alongside as text.

</details>

<details>
<summary><strong>Why are misses silent confabulations instead of read errors?</strong></summary>

Because model vision is not OCR: the image becomes patch embeddings, never
discrete characters, so there is no per-glyph confidence to fail loudly
on. When pixels underdetermine a glyph, the language prior fills the gap
with something plausible. Mechanism and receipts:
[docs/NOT-OCR.md](docs/NOT-OCR.md).

</details>

<details>
<summary><strong>Didn't DeepSeek-OCR show this doesn't hold up in practice?</strong></summary>

No: it proved the channel works, using an encoder/decoder pair trained for
the job. The skepticism dates from October 2025, when no stock production
model could read dense renders; that changed with Fable 5 (0/15 verbatim
hex on Opus 4.8 vs 13/15 on Fable 5, same pages). Timeline and per-model
numbers: [docs/NOT-OCR.md](docs/NOT-OCR.md).

</details>

<details>
<summary><strong>Why does the README read like an AI wrote it?</strong></summary>

Because one did. Most of this repo's commits — the code and the docs — were
authored by Opus/Fable agent sessions running behind pxpipe itself, reading
their own collapsed history as image pages while they worked.

</details>

## Additional limitations

- PNG encoding adds latency to large requests before they leave.
- ASCII/Latin-1 well tested; CJK works but conservatively.

## Research status

Current as of 2026-07-22. The broad conclusion from the 2026-07-05 pass still
holds: exact recall is limited by pixels per glyph, so rendering changes do not
eliminate errors at profitable density. A later glyph-style A/B did find a
useful local improvement: repainting `K` reduced Fable's H/K error from 47.2%
to 18.7% without changing geometry or token cost. It shipped, but exact control
IDs did not improve. See [FINDINGS.md](FINDINGS.md), 2026-07-19 entry.

Runtime canary + text re-fetch and surrogate-reader pre-flight remain untested.
The release tripwire remains a resolution sweep for each new model; a model
that reads production cells near 100% would permit higher density.

Effective-context benefits remain unproven. The production-history results
above are directional evidence, not a general context-window or long-task
accuracy claim.

## Community projects

Third-party projects listed here are not maintained or supported by pxpipe.

- [pxpipe-windows](https://github.com/DivyeshPatro/pxpipe-windows) — Windows support for `pxpipe mitm` (node-forge CA in place of openssl, Task Scheduler autostart).
- [OmniGlyph](https://github.com/diegosouzapw/OmniGlyph) — A community-maintained project derived from pxpipe and used by [OmniRoute](https://github.com/diegosouzapw/OmniRoute).

## License

MIT.
