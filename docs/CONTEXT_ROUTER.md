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
PXPIPE_CONTEXT_ROUTER=on        # → coding-agent policy (secrets kept as text)
PXPIPE_CONTEXT_ROUTER=redact    # coding-agent + redaction lane (mask secret, image rest)
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

## Measured savings (replay)

`npx tsx scripts/context-router-bench.ts` prices a turn using pxpipe's own cost model
(`evalCompressionProfitability`): ALL-TEXT (no pxpipe), IMAGE-EVERY (no router),
ROUTER-ON (keep-text), ROUTER+REDACT (`=redact`). Two scenarios (savings vs ALL-TEXT):

| scenario | IMAGE-EVERY | ROUTER-ON | ROUTER+REDACT | secret |
|----------|-------------|-----------|---------------|--------|
| **Typical turn** (no secret, sparse anchors) | 76.0% | 76.0% | **76.0%** | safe all |
| **Risky turn** (secret in a profitable log + path-dense listing) | 75.4% ⚠ *leaks secret* | 39.1% | **63.4%** | ROUTER/REDACT safe |

Takeaways:
- **Common case is free** — no secret, no anchor-dense block → the router images
  exactly what pxpipe would; savings identical across all modes.
- **Keep-text (`=on`) is safe but costs on risky turns** — keeping a *whole* block as
  text when it holds a secret (a 6.5k-token log with one secret line stays fully text)
  is the conservative default; the bench makes its price visible (39% vs an unsafe 75%).
- **Redaction (`=redact`) recovers most of it** — masking just the secret *value* and
  imaging the rest keeps the block safe *and* compressed: **63.4% vs 39.1%** on the
  risky turn, still zero secret leak. The residual gap vs IMAGE-EVERY is the path-dense
  listing kept as `text_only` — a genuine exactness-vs-savings tradeoff (the factsheet
  caps at 64 tokens, so it can't rescue *every* path on a large listing).

## Known limitations

1. **Rescue on imaged blocks is pxpipe's factsheet, not this module's strip.** When
   the router decides `image_plus_exact_rescue`, `makeKeepSharp` returns `false` and
   the block images — the existing `factSheetText()` then rescues the anchors. That's
   the right split (don't duplicate a shipped, budget-capped extractor), but note the
   factsheet has *no secret awareness*: it's the router's job (via `keepSharp`) to
   keep secret blocks out of the image path entirely. `buildRescueStrip` /
   `routeBlock().rescueStrip` remain available for callers that walk the request
   themselves and want the classifier's own strip instead.
2. **Redaction mutates content (opt-in for that reason).** Under `=redact`, a secret
   span is replaced with `[redacted-secret]` before imaging. A secret *false positive*
   (e.g. the entropy heuristic flagging a high-entropy non-secret) therefore destroys
   that token rather than merely keeping it as text. The loss is localized to the one
   flagged span (the rest of the block images fine), and the threshold is conservative,
   but this is why redaction is opt-in and `=on` (keep-text) is the default.
3. **Regex extraction is heuristic.** Unix path detection is greedy; `line_number`
   (`42:13`) can collide with times/ratios; `hash` requires ≥1 `a–f` letter so a
   7-digit decimal isn't mistaken for a short hash (a hex-looking decimal still
   could be). Conservative-false-positive by policy: over-flagging keeps content as
   text, which is safe.
4. **`unknown_identifier` is not emitted.** A deterministic regex can't separate a
   must-stay-exact identifier from a prose noun. Left as future work.
5. **Density gate is heuristic, not priced.** The `text_only` fallback uses an
   anchor-coverage threshold, not a per-block image-vs-text-plus-rescue price. Feeding
   factsheet size into `evalCompressionProfitability` would make it measured.
6. **Slab redaction not implemented.** `guardSlabSecrets` keeps the *whole* request as
   text when the system slab holds a secret (safe, rare); it does not yet redact the
   slab in place the way the 3 live-region sites do.
7. **Not production-safe.** Prototype. No claim of completeness on secret formats.

## What's wired vs. what's next

**Wired (`PXPIPE_CONTEXT_ROUTER`, off by default):**
- `=on` / policy names → `keepSharp: makeKeepSharp(policy)`: secrets + high-risk/dense
  blocks stay text; safe blocks image (with the factsheet rescue).
- `=redact` → `makeRedactingHooks(policy)`: secret *values* masked in place and the
  block imaged — safe **and** compressed (63.4% vs 39.1% keep-text on the risky turn).
- `guardSlabSecrets: true` (both modes) → a secret in the static system slab keeps the
  whole request as text (the slab has no `keepSharp`/`redactBlock` check).
- Redaction wired at all 3 live-region sites (reminder / tool_result / tool_result_part)
  via the new `TransformOptions.redactBlock` hook; the redacted text is what gets
  gated, imaged, fact-sheeted, and recorded as recoverable.

**Next:**
1. Redact the slab in place (instead of whole-request-to-text) to recover slab savings.
2. Feed factsheet size into `evalCompressionProfitability` for a *measured* density gate.
3. Replay on real production traces (`events.jsonl`) beyond the synthetic bench.

## Future work

- Per-model policy matrix keyed on measured visual exactness (FINDINGS.md data).
- Context ledger: per-block routing decision + preserved-token count into
  `~/.pxpipe/events.jsonl`.
- CI benchmark for exact-token recall.
