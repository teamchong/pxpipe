# Context Risk Router (prototype)

Status: **prototype**, additive, **wired into the live proxy path but OFF by
default** (env-gated by `PXPIPE_CONTEXT_ROUTER`). With the flag unset, behavior is
byte-identical to before. Also usable directly as a `keepSharp` drop-in / standalone
routing API.

## Why this exists (and what pxpipe already had)

pxpipe's image lane is deliberately lossy: dense text → PNG saves 59–73% input
tokens but exact strings can be silently mis-OCR'd (FINDINGS.md: dense 12-char hex
recall is unreliable on non-allowlisted models).

**pxpipe already ships the `image_plus_exact_rescue` idea** — it's `factSheetText()`
(src/core/factsheet.ts), appended after every imaged block. It extracts paths, URLs,
UUIDs, SHAs, versions, CLI flags, numbers, and CONST_IDs and rides them next to the
image as text, budget-capped to 64 tokens (~5% of source chars) so it can't erase the
imaging win. So the "rescue exact anchors" half of the handoff was already solved.

**The real unmet gap is secrets.** The factsheet extracts a secret's *key name* but
not its value, and the imaging path renders the full secret value into the PNG —
where a capable model reads it straight back. pxpipe has no secret concept and
nothing populates `keepSharp` by default, so **secrets in tool outputs are silently
imaged** — the one hard constraint the handoff names ("do not silently image
secrets"). This router closes that: secret-bearing (and other high-risk/dense)
blocks are pinned to text instead of imaged; the existing factsheet keeps handling
the sparse-anchor rescue on blocks that do image. `tests/context-router-e2e.test.ts`
demonstrates the gap and the fix through the real transform.

## Files

| File | Role |
|------|------|
| `src/core/exact-token-extractor.ts` | Deterministic regex + entropy extraction of exactness-sensitive fragments. Secrets masked at source. |
| `src/core/risk-classifier.ts` | `assessContextRisk(text)` → risk + routing decision + tokens. Size and density logic. |
| `src/core/context-router.ts` | `makeKeepSharp(policy)` (drop-in hook), `routeBlock`, `buildRescueStrip`, policy presets. |
| `tests/context-router.test.ts` | 13 tests: extractor units, the 5 handoff cases, density fallback, secret non-leak, keepSharp adapter. |
| `scripts/context-router-demo.ts` | `npx tsx scripts/context-router-demo.ts` — prints every case's decision. |

## Routing decisions

```
text_only                 keep as text (small, or exactness-sensitive)
image_only                large + no exact anchors → safe to image wholesale
image_plus_exact_rescue   large + SPARSE anchors → image bulk, append text rescue strip
redact_or_block           secret detected → never image, mask value
summary_candidate         reserved (future work — not emitted)
```

Risk levels: `low | medium | high | critical`.

## Decision logic (in order)

1. **Secret present** → `critical` / `redact_or_block`. Never imaged, value masked.
2. **strict policy + any anchor** → `text_only`.
3. **Small block** (≤ `smallBlockChars`, default 6000) → `text_only`. Below pxpipe's
   own break-even, imaging can't profit anyway, so keeping it exact is free.
4. **Large, no anchors** → `image_only`.
5. **Large, with anchors** → density decides:
   - anchor char coverage ≥ `denseAnchorCoverage` (default 0.12) → `text_only`
   - else → `image_plus_exact_rescue`

### Why the density fallback matters (the non-obvious part)

`image_plus_exact_rescue` only saves tokens when exact anchors are **sparse**. If a
block is anchor-dense — a diff, a stack dump, a path listing — extracting every
anchor into a text rescue strip reproduces most of the block as text. You'd then
pay image cost **plus** near-full text cost: worse than just keeping it text. So
above the coverage threshold the router routes `text_only`. Without this guard the
feature is self-defeating on exactly the blocks it's meant to protect. (Demo case 6
shows a 0.977-coverage block correctly falling back to `text_only`.)

## Secret handling

- Known prefixes (`sk-ant-`, `sk-`, `ghp_`/`gho_`/…, `xox*-`, `AKIA…`, `AIza…`, `Bearer …`).
- `NAME=value` where NAME contains SECRET/TOKEN/PASSWORD/API_KEY/… .
- **Entropy fallback**: long (≥24) mixed-class, high-entropy (≥3.6 bits/char) tokens
  with no `/` — catches unknown-format secrets that prefix lists miss. This is the
  dangerous direction (a missed secret gets silently imaged), so it errs toward
  false positives; a flagged non-secret merely stays text, which is harmless.
- Secret values are **masked at extraction** (`ANTHROPIC_…yz [40ch]`). A raw secret
  never enters the token list, reasons, rescue strip, logs, or test snapshots. A
  test asserts the raw value never appears in serialized output.

## How to enable

**Live proxy (wired):** set the env var. Off/unset = unchanged behavior.

```
PXPIPE_CONTEXT_ROUTER=on        # → coding-agent policy
PXPIPE_CONTEXT_ROUTER=strict    # any anchor stays text
PXPIPE_CONTEXT_ROUTER=research  # prose-heavy, images more
PXPIPE_CONTEXT_ROUTER=off       # (default) no change
```

node.ts reads it per request (`contextRouterPolicyFromEnv()`) and, when set, passes
`keepSharp: makeKeepSharp(policy)` into the transform. Flips live, no restart.

**SDK / library:** zero-touch drop-in for the existing hook:

```ts
import { transformAnthropicMessages } from 'pxpipe-proxy';           // ./library.js
import { makeKeepSharp } from 'pxpipe-proxy/.../context-router.js';

await transformAnthropicMessages({
  body, model,
  options: { keepSharp: makeKeepSharp('coding-agent') },
});
```

Policies: `default | coding-agent | research | strict`.
- `coding-agent` — protects hardest (paths/hashes/diffs are anchor-dense): larger
  small-block floor, lower density threshold. (What `=on` selects.)
- `research` — prose-heavy, images more.
- `strict` — any anchor at all stays text (max fidelity, min savings).

To disable: unset the env var (or don't pass `keepSharp`). Default proxy behavior
is unchanged.

## Known limitations

1. **Rescue on imaged blocks is pxpipe's factsheet, not this module's strip.** When
   the router decides `image_plus_exact_rescue`, `makeKeepSharp` returns `false` and
   the block images — the existing `factSheetText()` then rescues the anchors. That's
   the right split (don't duplicate a shipped, budget-capped extractor), but note the
   factsheet has *no secret awareness*: it's the router's job (via `keepSharp`) to
   keep secret blocks out of the image path entirely. `buildRescueStrip` /
   `routeBlock().rescueStrip` remain available for callers that walk the request
   themselves and want the classifier's own strip instead.
2. **Only the 3 live-region sites are guarded.** `keepSharp` fires on reminders and
   tool_results — where tool output (the likely secret carrier: a printed env, a
   leaked token in a log) flows. The static system slab + tool-doc path has no
   keepSharp check, so a secret embedded in a system prompt or tool description would
   still image. Rare, but real; guarding the slab is future work.
3. **Regex extraction is heuristic.** Unix path detection is greedy; `line_number`
   (`42:13`) can collide with times/ratios; `hash` requires ≥1 `a–f` letter so a
   7-digit decimal isn't mistaken for a short hash (a hex-looking decimal still
   could be). Conservative-false-positive by policy: over-flagging keeps content as
   text, which is safe.
3. **`unknown_identifier` is not emitted.** A deterministic regex can't separate a
   must-stay-exact identifier from a prose noun. Left as future work.
4. **No cost measurement yet.** The router decides by heuristic density, not by
   actually pricing image-vs-text-plus-rescue per block. pxpipe already has
   `isCompressionProfitable()` / `evalCompressionProfitability()`; a real
   integration should feed the rescue-strip size into that gate.
5. **Not production-safe.** Prototype. No claim of completeness on secret formats.

## What's wired vs. what's next

**Wired (this change):** `PXPIPE_CONTEXT_ROUTER` → `node.ts` injects
`keepSharp: makeKeepSharp(policy)` per request. Secret + high-risk/dense blocks stay
text; safe blocks image as before (with the factsheet rescue). Off by default; the
e2e test proves the secret gap and the fix.

**Next:**
1. Guard the static slab / tool-doc path (no `keepSharp` there today) so a secret in
   a system prompt can't image.
2. Feed rescue-strip / factsheet size into `evalCompressionProfitability` for a
   *measured* density gate instead of the heuristic coverage threshold.
3. Before/after token-count replay on real production traces (from `events.jsonl`)
   to quantify the savings delta from pinning secret/dense blocks to text — expected
   small, since those blocks were marginal to image anyway.
4. Then PR upstream with the replay numbers.

## Future work

- Feed rescue-strip size into `evalCompressionProfitability` for a measured (not
  heuristic) density gate.
- A/B replay: full-text vs image-only vs image+rescue token counts on real traces.
- Per-model policy matrix keyed on measured visual exactness (FINDINGS.md data).
- Context ledger: per-block routing decision + preserved-token count into
  `~/.pxpipe/events.jsonl`.
- CI benchmark for exact-token recall.
