/**
 * Request-body transformer. Takes an Anthropic Messages API request body,
 * extracts the large static parts (system prompt + tool definitions),
 * renders them as PNG image blocks, and rewrites the body to reference
 * those images instead — saving 65-73% input tokens on Opus 4.7 while
 * preserving 100% reasoning quality.
 *
 * Originally ported from a Python reference implementation; the Python
 * has since been removed (live cache-rate validation passed at 98.7% by
 * tokens). Byte-output determinism is now verified by tests alone.
 */

import type {
  ContentBlock,
  ImageBlock,
  Message,
  MessagesRequest,
  SystemField,
  TextBlock,
  ToolDef,
  ToolResultBlock,
  ToolUseBlock,
} from './types.js';
import {
  renderTextToPngs,
  renderTextToPngsMultiCol,
  reflow,
  maxFittingCols,
  shrinkColsToContent,
  MAX_HEIGHT_PX,
  NL_SENTINEL,
  PAD_X,
  PAD_Y,
  CELL_W,
  CELL_H,
  READABLE_CHARS_PER_IMAGE,
} from './render.js';
import { bytesToBase64 } from './png.js';
import { collapseHistory } from './history.js';
import { CACHE_CREATE_RATE, CACHE_READ_RATE } from './baseline.js';

export interface TransformOptions {
  /** Master switch — false makes this a no-op pass-through. */
  compress?: boolean;
  /** Move tool descriptions into the same image (and stub the originals). */
  compressTools?: boolean;
  /** Include full input_schema JSON for each tool. Adds tokens but maximizes parity. */
  compressSchemas?: boolean;
  /** Compress large `<system-reminder>` text blocks in the first user message.
   *  Claude Code re-injects these every turn; rendering them to images shares
   *  the cache anchor with the system+tools render. */
  compressReminders?: boolean;
  /** Compress large tool_result text content across all user messages. Tool
   *  output is static once produced and accumulates across the conversation,
   *  so image-rendering it compounds savings as the session grows. */
  compressToolResults?: boolean;
  /** Don't compress if total compressible chars below this. */
  minCompressChars?: number;
  /** Per-block threshold for compressReminders (chars). */
  minReminderChars?: number;
  /** Per-block threshold for compressToolResults (chars). */
  minToolResultChars?: number;
  /** Soft-wrap column count. */
  cols?: number;
  /** Hard upper bound on images emitted per single tool_result. Above this,
   *  the source text is truncated (head + paging marker + tail) BEFORE
   *  rendering so the request stays under Anthropic's 100-image-per-request
   *  cap even when a single tool dumps a huge log. Default 10. */
  maxImagesPerToolResult?: number;
  /** R2 multi-column rendering: pack N text columns side-by-side per image
   *  so each image covers `N×LINES_PER_IMAGE` wrapped lines instead of one.
   *  Default 1 (single column = current behavior). 2 roughly halves image
   *  count on real Claude Code workloads at the cost of OCR ordering risk
   *  — the model must read column 1 fully top-to-bottom before column 2.
   *  Modern vision LLMs handle this well on newspaper layouts; keep this
   *  off until a smoke test against the real slab confirms ordering.
   *  Auto-clamped if the resulting canvas would exceed 1568 px wide. */
  multiCol?: number;
  /** Chars-per-token assumption used by `isCompressionProfitable()`. Default
   *  4 (Anthropic's published English-text average). Host may override per
   *  request if it has a better number for the specific deployment. */
  charsPerToken?: number;
  /** Multi-turn amortization horizon for the **history-collapse** break-even
   *  gate. The per-turn gate that asks "is the image cheaper than the text
   *  on this single request, cold?" gets the wrong answer when Anthropic has
   *  already cached the text-based prefix — text-at-10% beats image-at-100%
   *  on warm turns. But the text prefix's cache *will* eventually expire (5-
   *  min idle or 4-breakpoint cliff), and on that cold turn the giant text
   *  pays full freight while an image prefix pays once and rides
   *  `cache_read` for the rest of the session.
   *
   *  Setting this to N ≥ 2 evaluates the gate as if N future turns will
   *  share the same prefix, weighting both sides by
   *  `(cache_create_rate × 1 + cache_read_rate × (N-1))`. Honest expected-
   *  lifetime-cost framing, no session state required. Mirrors the JIT
   *  tiered-compilation analogue: assume the hot path runs N more times,
   *  decide once, eat the loss if the session ended early.
   *
   *  Default 1 (= per-turn gate, current behaviour). Hosts opt in by
   *  passing a value ≥ 2 (e.g. ocproxy passes 5 for Codex traffic). See
   *  README's "The unsolved part: multi-turn amortization" section for the
   *  full design space — try-then-decide (this), session-state (rejected),
   *  always-collapse (rejected), cache-bust-driven (rejected). */
  historyAmortizationHorizon?: number;
  /** Tokens that the *un-rewritten* request would have hit Anthropic's cache
   *  on (cache_read at 0.10×). When pixelpipe rewrites the cacheable prefix
   *  (slab compression, image substitution, history collapse), the new
   *  prefix has a different cache key — Anthropic charges cache_create
   *  (1.25×) on the new prefix's first turn, destroying the prior warm
   *  cache. The break-even gate accounts for this burn cost as a one-time
   *  penalty amortized over `historyAmortizationHorizon` turns:
   *
   *    burn = priorWarmTokens × (CACHE_CREATE_RATE − CACHE_READ_RATE) / N
   *
   *  Set by the host from a recent `count_tokens` cacheable-prefix probe
   *  on the un-rewritten body, or from a session-keyed LRU populated by
   *  prior responses. Default 0 (no burn — current behavior, correct for
   *  the first turn of a fresh conversation). Hosts that already populate
   *  `historyAmortizationHorizon` should populate this too; mismatched
   *  values bias the gate toward over-compression on short conversations.
   *
   *  Cold-start safe: 0 disables the burn term entirely. Negative or
   *  non-finite values are clamped to 0. */
  priorWarmTokens?: number;
  /** Symmetric counterpart of `priorWarmTokens` for the IMAGE-mode side.
   *
   *  When the prior turn rendered the static prefix as image blocks
   *  (pixelpipe applied), Anthropic's prompt cache holds the IMAGE prefix,
   *  not the text prefix. Declining compression on this turn — sending
   *  plain text — invalidates the image-prefix cache key and forces a
   *  fresh `cache_create` on the un-rewritten text prefix. Symmetric to
   *  `priorWarmTokens`, the burn cost is
   *
   *    burn = priorWarmImageTokens × (CACHE_CREATE_RATE − CACHE_READ_RATE)
   *
   *  and is added to the TEXT side of the break-even comparison so the
   *  gate stays in image mode when the image cache is already warm. This
   *  is the foundational fix for gate flapping: without it the gate
   *  re-decides every turn purely on per-turn cost and ping-pongs between
   *  modes, paying cache_create on both sides.
   *
   *  Set by the host from a session-keyed LRU that remembers the prior
   *  turn's chosen mode AND the upstream-observed cacheable prefix size
   *  on that turn. Hosts populating `priorWarmTokens` SHOULD also
   *  populate this; supplying one without the other biases the gate
   *  toward whichever side has the asymmetric burn term.
   *
   *  Cold-start safe: 0 disables the burn term entirely. Negative or
   *  non-finite values are clamped to 0. */
  priorWarmImageTokens?: number;
  /** R3 reflow: re-pack each image-bound text block into a continuous
   *  sentinel-delimited stream so rendered rows fill `cols` instead of
   *  leaving line-end dead margin (measured glyph-fill ~29% → ~75-80%).
   *  Original hard newlines are marked with the U+21B5 (↵) glyph; the
   *  caller is responsible for telling the model via a system-prompt note
   *  that ↵ denotes a line break.
   *
   *  ON by default: the L1 OCR eval cleared it at the production 5×8 cell
   *  with the in-image instruction band (`reflow-inimage` variant) at 98.95 %
   *  char accuracy, +1pp over the text-only baseline. The ↵ marker is
   *  comprehended. Hosts can still force it off per request (e.g. for an
   *  A/B). */
  reflow?: boolean;
}

const DEFAULTS: Required<TransformOptions> = {
  compress: true,
  compressTools: true,
  compressSchemas: true,
  compressReminders: true,
  compressToolResults: true,
  minCompressChars: 2000,
  // Keep small tool text as text. Below ~6k chars, the per-image cost
  // dominates the savings (one PNG ≈ 1300 image tokens, vs ~1500 text
  // tokens for 6 KB of text — break-even territory). The profitability
  // gate still runs above this floor. Decoupled from READABLE_CHARS_PER_IMAGE
  // (now 50k = per-page capacity) since the floor is about round-trip cost,
  // not per-page packing.
  minReminderChars: 6000,
  minToolResultChars: 6000,
  // NOTE: Anthropic's `system` field accepts text blocks only — image blocks
  // there come back as `400 system.N.type: Input should be 'text'`. Images
  // are always attached to the first user message; there's no flag for this
  // because the system-field path is API-rejected. (Removed `placement` +
  // `compressSystem` knobs that gated the dead system-field branch.)
  // 313 cells × 5 px = 1565 px ≈ full 1568 px canvas width. We fill the
  // canvas — no shrink-to-content — so every page packs the maximum chars
  // per image and the per-image token cost amortizes over more text.
  cols: 313,
  // Cap at 10 images per tool_result. With ~50k chars/image at the 5×8
  // production cell, a single-column tool_result can grow to ~500k chars
  // before paging kicks in. A `find` over a big tree or `grep -r` can easily
  // exceed this; the paging marker tells the model what was elided. Tuneable
  // per session.
  maxImagesPerToolResult: 10,
  // English ~4 chars/tok default (= the CHARS_PER_TOKEN constant declared
  // later in this file — kept as a literal here to avoid forward-reference).
  // Host overrides per-request when the dashboard's live fit has converged.
  charsPerToken: 4,
  // Per-turn break-even gate by default (= horizon 1). Hosts that want
  // multi-turn amortization (e.g. ocproxy's Codex integration) pass an
  // integer ≥ 2 via `historyAmortizationHorizon`. See option jsdoc.
  historyAmortizationHorizon: 1,
  priorWarmTokens: 0,
  priorWarmImageTokens: 0,
  // Multi-column disabled: at 313 cols × 196 rows the single-column page
  // already holds ~50k chars, so multi-col packing adds OCR-ordering risk
  // without meaningful savings. Kept in the type for backward compat.
  multiCol: 1,
  // R3 reflow ON by default — the L1 OCR eval cleared it at the production
  // 5×8 cell with the in-image instruction band (`reflow-inimage`): 98.95 %
  // char accuracy on the 20-block corpus, +1pp over the text-only baseline.
  // The ↵ newline marker is comprehended. See eval/.
  reflow: true,
};

// --- per-block break-even check ---
//
// Anthropic's real per-image cost is ~2,500 tokens for a single-col PNG at
// the OLD 5×8 atlas cell — a 508×1559 canvas (history-researcher's round-3
// N=33 measurement on cold-miss events 2026-05-18). The published
// theoretical formula `(w × h) / 750` underpredicts actual Anthropic
// billing by ~2.4×, so we anchor on the empirical number. Billing is ∝
// pixel area, so we scale that anchor on two axes: by canvas WIDTH for the
// cell-size change (the production 5×8 cell keeps the cols=100 canvas at
// 508 px — see TOKENS_PER_IMAGE_SINGLE_COL) and LINEARLY by numCols for
// multi-col packing (N text columns side-by-side multiplies pixel area).
//
// Safety: the gate's job is to compress a block only when doing so saves
// tokens. The constants below bias CONSERVATIVE — every uncertainty
// resolves in favor of pass-through, so a misprediction at worst leaves
// money on the table; it never burns money on a net-loss image:
//   • CHARS_PER_TOKEN = 4 over-estimates tokens-per-char for typical
//     tool_result code/JSON (real cpt ≈ 3-3.5), which UNDER-estimates
//     text savings → bias toward pass-through.
//   • numCols=1 cost is empirical (2500). numCols≥2 cost is linearly
//     extrapolated + 10% margin since we don't yet have empirical
//     measurements at wider canvases. Over-stating image cost ALSO
//     biases toward pass-through.
//
// Production bug context (2026-05-19): a request with orig_chars=169k spread
// across 88 small blocks each cost ~2,500 tokens as images = 220k tokens
// when the text would have been only 42k tokens. The flat per-block-min
// threshold (5k) was wide of the break-even point (10k) and let net-loss
// compressions through.
//
// Multi-col safety hole (closed 2026-05-19): production runs multiCol=2
// by default. The OLD flat `TOKENS_PER_IMAGE = 2500` applied at all
// numCols, so the gate believed multi-col images were ~2× cheaper than
// they actually are and would compress slabs that net-lost in reality.
// The scaled cost below fixes that — at multiCol≥2, image cost reflects
// the wider canvas.

/** English ~4 chars per token average. Holds well enough for code + prose
 *  mix; tool_result content is typically code-shaped. */
const CHARS_PER_TOKEN = 4;

/** Empirical chars-per-token for the *image-slab* path.
 *
 *  Updated 2026-05-21 from 2.5 → 2.0 on the basis of N=391 production
 *  rows on Opus 4.7 (last 7 days, baseline_probe_status='ok'):
 *
 *      avg_outgoing_text_chars = 231,925
 *      avg_real_input_tokens   = 115,893    (input + cache_created + cache_read)
 *      => observed cpt         = 1.91
 *
 *  Opus 4.7 ships a new tokenizer; the older 2.5 value was calibrated on
 *  Opus 4.5/4.6 text and now systematically OVER-estimates chars-per-token
 *  by ~30%, which UNDER-estimates the real text-token cost the gate is
 *  comparing image cost against. The result: the gate rejects compressions
 *  that would actually be net wins. 2.0 brings the gate's text-token
 *  estimate close to reality while still rounding slightly conservative
 *  versus the observed mean (1.91), so a marginal-shape outlier slab can
 *  still fail the gate without becoming a runaway loss.
 *
 *  Why this is slab-specific and NOT a global default: reminders and
 *  tool_result content have unknown shape (could be raw English prose
 *  with cpt~4). Leaving those at CHARS_PER_TOKEN=4 preserves the
 *  conservative bias where shape isn't known a priori. */
export const SLAB_CHARS_PER_TOKEN = 2.0;

/** Empirical chars-per-token for the *history compression* path.
 *
 *  Updated 2026-05-21 from 2.5 → 2.0 on the same Opus 4.7 telemetry as
 *  SLAB_CHARS_PER_TOKEN (N=391, observed cpt=1.91). History content is
 *  even denser than the slab path on average (tool_use JSON dominates
 *  Claude Code sessions, body cpt observed ~1.09 on rejected events),
 *  so the 2.5 → 2.0 move here is doubly conservative.
 *
 *  Diagnostic that drove this change: 283/391 = 72% of measured Opus 4.7
 *  pixelpipe rows in the last 7 days carried
 *  pixelpipe_history_reason='not_profitable'. The break-even gate was
 *  rejecting most history-collapse opportunities because it was
 *  comparing real image costs against a 30%-under-counted text cost.
 *
 *  Prediction grading (one session out): 'not_profitable' rows should
 *  drop below 40% of ok-status measured Opus 4.7 rows; the 'collapsed'
 *  count should rise. If 'not_profitable' stays >55%, the gate is being
 *  rejected for a non-cpt reason (horizon, prefix shape) and constants
 *  alone won't fix it.
 *
 *  Safety: at cpt=2.0 the gate's text-token estimate (textLen / 2.0) is
 *  a LOWER bound on real text cost whenever real cpt ≤ 2.0. The current
 *  observed cpt is 1.91, comfortably under. Chat-only sessions could in
 *  theory drive cpt above 2.0 — if that ever lands in production, we'll
 *  see it in the dashboard before any net-loss compression. */
export const HISTORY_CHARS_PER_TOKEN = 2.0;

/** Anthropic's documented image-billing formula: `tokens ≈ width × height / 750`.
 *  https://docs.anthropic.com/en/docs/build-with-claude/vision#image-tokens
 *
 *  This is the SOURCE OF TRUTH. The renderer (render.ts) produces images
 *  whose height tracks content (`height = 2·PAD_Y + rows·CELL_H`), so a
 *  10-row tool_result block at the 5×8 cell renders to ~88 px tall, which
 *  Anthropic bills at `508 × 88 / 750 ≈ 60 tokens`, NOT the 2,500 tokens
 *  a full-canvas image would cost. The old `TOKENS_PER_IMAGE_ANCHOR=2500`
 *  constant assumed every image was full-canvas, which is the right
 *  assumption ONLY for the system+tools slab (always 60 KB+). For
 *  per-block tool_result and reminder compression, the old gate over-
 *  estimated image cost by 20-50× and refused compressions that would
 *  have saved real tokens.
 *
 *  Empirical N=14 calibration on high-image cold-miss rows (where text
 *  overhead in cache_create is negligible) shows the documented formula
 *  is accurate to within ~5% on dense glyph PNGs. We apply a 10 % safety
 *  margin: bias toward pass-through, never toward predicting cheap-when-
 *  expensive. */
const ANTHROPIC_PIXELS_PER_TOKEN = 750;
const IMAGE_COST_SAFETY_MARGIN = 1.10;

/** Width in px of a single-col PNG at the given `cols` and current cell.
 *  Must stay in sync with `renderChunkToPng` width math (render.ts:524). */
function singleColWidthPx(cols: number): number {
  return 2 * PAD_X + cols * CELL_W;
}

/** Width in px of a multi-col PNG. Mirrors `multiColWidth()` in render.ts. */
function multiColWidthPx(cols: number, numCols: number): number {
  const n = Math.max(1, numCols | 0);
  if (n === 1) return singleColWidthPx(cols);
  // GUTTER_CELLS = 4 in render.ts; replicate the constant here (not exported).
  const GUTTER_CELLS = 4;
  return 2 * PAD_X + n * cols * CELL_W + (n - 1) * GUTTER_CELLS * CELL_W;
}

/** Compute the exact image-token cost for `visualRows` of content at the
 *  given column width and multi-col packing. Mirrors the renderer's height
 *  math (`renderChunkToPng` / `renderMultiColChunkFromLines`) so the gate's
 *  prediction matches what Anthropic will actually bill.
 *
 *  The renderer splits content into images of at most `linesPerImg` rows
 *  each (multi-col packs `numCols` text columns side-by-side, so one image
 *  covers `numCols × linesPerImg` wrapped lines). Each image's height
 *  scales with the rows it actually holds — full-canvas only when the
 *  image is full; the last image of a sequence is partial.
 *
 *  Returns total token cost summed across all images that the renderer
 *  will produce for `visualRows` rows. */
function imageTokensForRows(
  visualRows: number,
  cols: number,
  numCols: number = 1,
  imageCountCap?: number,
): number {
  if (!Number.isFinite(visualRows) || visualRows <= 0) return 0;
  const n = Math.max(1, numCols | 0);
  const widthPx = multiColWidthPx(cols, n);
  const hardLinesPerImg = Math.max(1, Math.floor((MAX_HEIGHT_PX - 2 * PAD_Y) / CELL_H));
  const readableLinesPerCol = Math.max(1, Math.floor(READABLE_CHARS_PER_IMAGE / Math.max(1, cols)));
  const linesPerImg = Math.min(hardLinesPerImg, readableLinesPerCol);
  // Multi-col packs n text columns side-by-side, so one image holds
  // n × linesPerImg wrapped lines but its HEIGHT only tracks the tallest
  // column (= min(rowsInChunk, linesPerImg)). See renderMultiColChunkFromLines.
  const rowsPerImage = linesPerImg; // pixel rows per image (height-wise)
  const linesPerImage = linesPerImg * n; // wrapped-text lines per image
  let imagesNeeded = Math.ceil(visualRows / linesPerImage);
  if (imageCountCap !== undefined && imageCountCap > 0) {
    imagesNeeded = Math.min(imagesNeeded, imageCountCap);
  }
  // First (imagesNeeded-1) images are full-height; last is partial.
  const fullImages = Math.max(0, imagesNeeded - 1);
  // How many wrapped lines spill into the last image (1..linesPerImage).
  const linesInLast = visualRows - fullImages * linesPerImage;
  // Last-image pixel-row count = min(linesInLast distributed across n cols, rowsPerImage).
  // Column-major: col 0 takes the first `rowsPerImage` lines, col 1 the next, etc.
  // So pixel rows used = min(linesInLast, rowsPerImage).
  const rowsInLast = Math.min(Math.max(1, linesInLast), rowsPerImage);
  // Total pixels across all images.
  const fullImageHeight = 2 * PAD_Y + rowsPerImage * CELL_H;
  const lastImageHeight = 2 * PAD_Y + rowsInLast * CELL_H;
  const totalPixels = fullImages * widthPx * fullImageHeight + widthPx * lastImageHeight;
  return Math.ceil((totalPixels / ANTHROPIC_PIXELS_PER_TOKEN) * IMAGE_COST_SAFETY_MARGIN);
}

/** Compute the exact image-token cost for the given `text` at the given
 *  column geometry. The string IS the source of truth: row count comes from
 *  `countVisualRows` (matches the renderer line-for-line) and width comes
 *  from `shrinkColsToContent` when `shrinkWidth=true` (matches the
 *  renderer column-for-column, so a 16-char "File not found" block bills
 *  for an ~80 px wide canvas, not the full 508 px slab).
 *
 *  `shrinkWidth=false` is the system-slab path (multi-col, packs the full
 *  configured `cols` regardless of any individual line's length) and any
 *  caller that explicitly wants full-canvas pricing.
 *
 *  No numeric overload — every production caller has the text, and the old
 *  chars-only fallback predicted cheaper than reality (it assumed every
 *  char filled a full-width row), which silently leaked net-losing
 *  compressions through the gate. */
function imageTokensCost(
  text: string,
  cols: number,
  numCols: number = 1,
  imageCountCap?: number,
  shrinkWidth: boolean = true,
): number {
  const effectiveCols = shrinkWidth ? shrinkColsToContent(text, cols) : cols;
  const rows = countVisualRows(text, effectiveCols);
  return imageTokensForRows(rows, effectiveCols, numCols, imageCountCap);
}

/** Visual rows per image at the current render cell. Derived once at module
 *  load from render.ts CELL_H (single source of truth) so the break-even
 *  math always tracks the renderer's real geometry.
 *
 *  Formula: `floor((MAX_HEIGHT_PX − 2·PAD_Y) / CELL_H)`
 *
 *  At the production 5×8 cell, cols=100:
 *    floor((1568 − 8) / 8) = 195 rows → maxCharsPerImage = 100 × 195 = 19,500
 *
 *  When the cell changes (render.ts DEFAULT_CELL_*_BONUS or a new atlas),
 *  this auto-updates and the break-even threshold moves with it. */
export const LINES_PER_IMAGE = Math.max(1, Math.floor((MAX_HEIGHT_PX - 2 * PAD_Y) / CELL_H));

export function maxCharsPerImage(cols: number): number {
  return Math.min(cols * LINES_PER_IMAGE, READABLE_CHARS_PER_IMAGE);
}

/** Lossless pre-render slab compactor. Reduces the visual-row count the
 *  renderer sees (each `\n` is at least one row regardless of column width),
 *  without changing what the model reads:
 *
 *  1. Strip trailing whitespace per line (preserves leading indent — code
 *     and JSON structure stay intact).
 *  2. Collapse runs of 3+ newlines down to 2 (one blank line max between
 *     paragraphs). Multi-blank "section dividers" cost rows but carry no
 *     information once rendered to a flat image.
 *
 *  Real Claude Code system slabs hit production data 2026-05-20 had ~2,000
 *  newline-bounded rows in 161 KB — the row-aware gate correctly rejected
 *  them as unprofitable. This compactor typically drops 10-25% of rows on
 *  markdown-heavy / tool-doc-heavy slabs, which is enough to flip a
 *  meaningful fraction of currently-rejected slabs to profitable.
 *
 *  Exported so the per-block reminder/tool_result compressions can share
 *  the same pre-processor — same row-cost dynamics. */
export function compactSlabWhitespace(text: string): string {
  if (!text) return text;
  // Per-line trailing whitespace strip. Iterate the buffer once instead
  // of split/join — avoids materialising an intermediate array on a
  // ~160 KB slab. We only touch spaces/tabs (codepoint 32 and 9) so
  // newlines are passed through verbatim and the line count is unchanged
  // at this step.
  let trimmed = '';
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 10 /* \n */) {
      let end = i;
      while (end > lineStart) {
        const c = text.charCodeAt(end - 1);
        if (c !== 32 && c !== 9) break;
        end--;
      }
      trimmed += text.slice(lineStart, end);
      if (i < text.length) trimmed += '\n';
      lineStart = i + 1;
    }
  }
  // Collapse 3+ consecutive newlines to exactly 2. Preserves paragraph
  // breaks while killing multi-blank section dividers — they cost one
  // row each in the renderer and carry zero information once flattened
  // to an image.
  return trimmed.replace(/\n{3,}/g, '\n\n');
}

/** Apply R3 reflow when enabled. Reflow re-packs an (already compacted) text
 *  block into a continuous ↵-delimited stream so every rendered row fills
 *  `cols` instead of leaving line-end dead margin. Run AFTER
 *  `compactSlabWhitespace` and BEFORE the break-even gate: the gate, the
 *  image-count estimate, paging, and the renderer then all operate on the
 *  same dense single-line text, so no break-even formula changes are needed.
 *  Falls back to the input unchanged when reflow is off or `reflow()` hits a
 *  sentinel collision. */
function maybeReflow(text: string, enabled: boolean): string {
  if (!enabled) return text;
  return reflow(text) ?? text;
}

/** Returns true iff image-compressing a text block would actually save tokens
 *  vs leaving it as text. Used as the gate before every image-encoding
 *  decision in transformRequest.
 *
 *  ## Content-aware geometry
 *
 *  The gate is **string-only** — every production caller has the text, and
 *  the gate uses it to compute the renderer's exact image cost two ways at
 *  once:
 *
 *  - **Rows** come from `countVisualRows` (matches `wrapLines` line-for-
 *    line, including soft-wraps and codepoint width).
 *  - **Width** comes from `shrinkColsToContent` when `shrinkWidth=true`
 *    (the default): a 16-char `"File not found"` block bills for an
 *    ~80 px wide canvas, not the full 508 px slab canvas. This matters
 *    most for tool_result and reminder blocks, which dominate per-turn
 *    image cost and are usually much narrower than `cols`.
 *
 *  Set `shrinkWidth=false` for the system slab (multi-col, fills the
 *  configured `cols` deliberately to maximise OCR density) and anywhere
 *  the caller needs full-canvas pricing for telemetry parity.
 *
 *  ## No numeric overload
 *
 *  The historical `textOrLen: string | number` shape existed for unit-
 *  test back-compat. The numeric path assumed every char filled a full-
 *  width row (= lower-bound rows = under-estimated image cost), which
 *  silently let net-losing compressions through whenever a caller passed
 *  `text.length` instead of `text`. Removed.
 */
/** Decompose the per-block break-even gate's evaluation into its components.
 *  Returns the exact `imageTokens`, `textTokens`, and symmetric burn terms
 *  the gate uses internally. Pairs with `isCompressionProfitable` for
 *  telemetry: callers can record the numbers without re-implementing the
 *  formula and risking drift.
 *
 *  Returns `null` when the input is empty or non-finite. Stays in sync with
 *  `isCompressionProfitable` because both use the same `imageTokensCost`
 *  and the same width-shrink toggle. */
export function evalCompressionProfitability(
  text: string,
  cols: number,
  imageCountCap: number | undefined = undefined,
  numCols: number = 1,
  charsPerToken: number = CHARS_PER_TOKEN,
  priorWarmTokens: number = 0,
  priorWarmImageTokens: number = 0,
  shrinkWidth: boolean = true,
): {
  imageTokens: number;
  textTokens: number;
  burnImageSide: number;
  burnTextSide: number;
  profitable: boolean;
} | null {
  const n = Math.max(1, numCols | 0);
  if (typeof text !== 'string' || text.length === 0) return null;
  const cpt = Number.isFinite(charsPerToken) && charsPerToken > 0
    ? charsPerToken
    : CHARS_PER_TOKEN;
  const imageTokens = imageTokensCost(text, cols, n, imageCountCap, shrinkWidth);
  const textTokens = text.length / cpt;
  const burnImageSide = Number.isFinite(priorWarmTokens) && priorWarmTokens > 0
    ? priorWarmTokens * (CACHE_CREATE_RATE - CACHE_READ_RATE)
    : 0;
  const burnTextSide = Number.isFinite(priorWarmImageTokens) && priorWarmImageTokens > 0
    ? priorWarmImageTokens * (CACHE_CREATE_RATE - CACHE_READ_RATE)
    : 0;
  return {
    imageTokens,
    textTokens,
    burnImageSide,
    burnTextSide,
    profitable: imageTokens + burnImageSide < textTokens + burnTextSide,
  };
}

export function isCompressionProfitable(
  text: string,
  cols: number = DEFAULTS.cols,
  imageCountCap?: number,
  numCols: number = 1,
  /** Chars-per-token assumption for the text side of the break-even math.
   *  Default 4 (Anthropic's English-text average). Lower values = more
   *  profitable text compressions (each char buys more tokens back). */
  charsPerToken: number = CHARS_PER_TOKEN,
  /** Tokens the un-rewritten path would have hit cache on. Adds a one-time
   *  burn penalty of `priorWarmTokens × (CACHE_CREATE_RATE − CACHE_READ_RATE)`
   *  to the image side — the cost of forcing a fresh cache_create when the
   *  rewritten prefix invalidates Anthropic's prior cache key. Default 0
   *  (cold-start behavior; matches pre-burn-aware callers byte-for-byte). */
  priorWarmTokens: number = 0,
  /** Symmetric image-side burn: tokens the rewritten (IMAGE) path would
   *  have hit cache on. Adds a one-time burn penalty of
   *  `priorWarmImageTokens × (CACHE_CREATE_RATE − CACHE_READ_RATE)` to the
   *  TEXT side — the cost of forcing a fresh cache_create on the
   *  un-rewritten text prefix when the rewritten image prefix was warm.
   *  Default 0 (back-compat; existing single-arg callers behave unchanged).
   *  See PixelpipeOptions.priorWarmImageTokens for the foundational rationale. */
  priorWarmImageTokens: number = 0,
  /** Shrink the rendered canvas width to the longest actual wrapped line.
   *  Default `true` (per-block content: tool_result, reminder, history).
   *  Set `false` for the system slab, which deliberately fills the full
   *  configured `cols` (multi-col packing). */
  shrinkWidth: boolean = true,
): boolean {
  const n = Math.max(1, numCols | 0);
  if (typeof text !== 'string' || text.length === 0) return false;
  const cpt = Number.isFinite(charsPerToken) && charsPerToken > 0
    ? charsPerToken
    : CHARS_PER_TOKEN;
  const imageTokensCost_ = imageTokensCost(text, cols, n, imageCountCap, shrinkWidth);
  const textTokensEquivalent = text.length / cpt;
  // Cache-burn penalty (symmetric form, ANTI-FLAPPING):
  //
  //   text→image flip: invalidate the warm text cache. Burn applied to
  //                    the IMAGE side — discourages compressing when
  //                    the text prefix is already warm.
  //   image→text flip: invalidate the warm image cache. Burn applied to
  //                    the TEXT side — discourages decompressing when
  //                    the image prefix is already warm.
  //
  // Without the symmetric term the gate ping-pongs: once a session
  // commits to a mode, single-turn cost can favor flipping, but the
  // flip forces cache_create on the new side, then the next turn flips
  // back. We pay cache_create twice. The symmetric burn pins the
  // session in its current mode unless the per-turn delta exceeds the
  // burn cost.
  const burnImageSide = Number.isFinite(priorWarmTokens) && priorWarmTokens > 0
    ? priorWarmTokens * (CACHE_CREATE_RATE - CACHE_READ_RATE)
    : 0;
  const burnTextSide = Number.isFinite(priorWarmImageTokens) && priorWarmImageTokens > 0
    ? priorWarmImageTokens * (CACHE_CREATE_RATE - CACHE_READ_RATE)
    : 0;
  return imageTokensCost_ + burnImageSide < textTokensEquivalent + burnTextSide;
}

/**
 * Horizon-aware variant of `isCompressionProfitable` for the
 * **history-collapse** call site only.
 *
 * The per-turn gate (above) compares cold image cost vs cold text cost.
 * That's the right question when the request is cold on both sides, but
 * the wrong question once Anthropic has already cached the text-based
 * prefix — text-at-10% beats image-at-100% per-turn. The text prefix's
 * cache *will* eventually expire, though (5-min idle, 4-breakpoint
 * cliff, system-slab churn), and on that cold turn the giant text pays
 * `cache_create` (1.25×) on the full uncompressed prefix while an image
 * prefix pays `cache_create` once and `cache_read` (0.1×) for the rest
 * of the session.
 *
 * Honest expected-lifetime-cost framing over `N` future turns starting
 * from a *worst-case warm* state for the image (cache_create on turn 1,
 * cache_read on turns 2..N) and a best-case warm state for the text
 * (cache_read every turn for the full N). The gate accepts the collapse
 * iff
 *
 *   I × (CC + CR×(N-1)) < T × CR × N
 *
 * where I = image_tokens, T = text_tokens, CC = 1.25, CR = 0.10.
 *
 * Examples (CC=1.25, CR=0.10):
 *   N=1:  I < 0.08 × T   (essentially never — text-at-10% beats image)
 *   N=5:  I < 0.30 × T
 *   N=10: I < 0.47 × T
 *   N=20: I < 0.64 × T
 *
 * Real history typically renders to I/T ≈ 0.3–0.5 (one image per
 * ~14 KB of dense text vs ~2,500 tokens per image at 1.5 cpt), so a
 * horizon of N=5–10 flips a lot of currently-rejected collapses
 * into accepts without ever taking a bet a single-turn session would lose.
 *
 * Falls back to the cold per-turn gate when `horizon <= 1`.
 */
export function isCompressionProfitableAmortized(
  text: string,
  cols: number,
  imageCountCap: number | undefined,
  numCols: number,
  charsPerToken: number,
  horizon: number,
  /** Burn penalty source — see same-named param on `isCompressionProfitable`.
   *  Amortized across `horizon` turns at this gate (the prior cache is
   *  burned exactly once, on the first rewritten turn). Default 0. */
  priorWarmTokens: number = 0,
  /** Symmetric image-side burn — see same-named param on
   *  `isCompressionProfitable`. Default 0 (back-compat). */
  priorWarmImageTokens: number = 0,
  /** Shrink rendered width to longest wrapped line (see
   *  `isCompressionProfitable`). Default `true`. */
  shrinkWidth: boolean = true,
): boolean {
  if (!Number.isFinite(horizon) || horizon <= 1) {
    return isCompressionProfitable(text, cols, imageCountCap, numCols, charsPerToken, priorWarmTokens, priorWarmImageTokens, shrinkWidth);
  }
  const N = Math.max(2, Math.floor(horizon));
  const n = Math.max(1, numCols | 0);
  if (typeof text !== 'string' || text.length === 0) return false;
  const cpt = Number.isFinite(charsPerToken) && charsPerToken > 0
    ? charsPerToken
    : CHARS_PER_TOKEN;
  // Content-aware image cost — see `imageTokensCost` and the matching
  // comment in `isCompressionProfitable` for the full rationale.
  const imageTokens = imageTokensCost(text, cols, n, imageCountCap, shrinkWidth);
  const textTokens = text.length / cpt;
  // Worst-case-for-image vs best-case-for-text framing — this is on
  // purpose. We refuse to collapse on the optimistic side, so the gate
  // only fires when the collapse wins even under pessimistic warm-cache
  // assumptions.
  const imageLifetime = imageTokens * (CACHE_CREATE_RATE + CACHE_READ_RATE * (N - 1));
  const textLifetime = textTokens * CACHE_READ_RATE * N;
  // Symmetric burn — each side pays its own cache_create invalidation
  // cost when the verdict flips its mode. See
  // `isCompressionProfitable` for the full anti-flapping argument.
  const burnImageSide = Number.isFinite(priorWarmTokens) && priorWarmTokens > 0
    ? priorWarmTokens * (CACHE_CREATE_RATE - CACHE_READ_RATE)
    : 0;
  const burnTextSide = Number.isFinite(priorWarmImageTokens) && priorWarmImageTokens > 0
    ? priorWarmImageTokens * (CACHE_CREATE_RATE - CACHE_READ_RATE)
    : 0;
  return imageLifetime + burnImageSide < textLifetime + burnTextSide;
}


/** Increment a passthrough-reason counter on `info`. Lazily allocates the
 *  `passthroughReasons` sub-object so happy-path events stay lean. */
function bumpPassthrough(
  info: TransformInfo,
  reason: 'below_threshold' | 'not_profitable',
): void {
  if (!info.passthroughReasons) info.passthroughReasons = {};
  info.passthroughReasons[reason] = (info.passthroughReasons[reason] ?? 0) + 1;
}

/** Logical bucket that a char-attribution event lands in. One bucket per
 *  gate-call neighborhood in `transformRequest`:
 *    - `static_slab`        — the combined CLAUDE.md + tool docs slab
 *    - `reminder`           — `<system-reminder>` blocks in the first user message
 *    - `tool_result_json`   — tool_result content classified `structured`
 *    - `tool_result_log`    — tool_result content classified `log`
 *    - `tool_result_prose`  — tool_result content classified `other` (prose)
 *    - `history`            — text folded into the Variant C history image
 *  Used by the rolling-cpt regression (Task #18) to derive a per-bucket
 *  marginal cpt so the gate can stop using one global text-cpt for content
 *  with very different real cpts (JSON-dense tool_results vs prose). */
export type BucketName =
  | 'static_slab'
  | 'reminder'
  | 'tool_result_json'
  | 'tool_result_log'
  | 'tool_result_prose'
  | 'history';

/** Per-bucket sum of TEXT chars that flowed through each gate-call site this
 *  request. Pre-compaction lengths — values stay comparable to `origChars`
 *  and the chars that would have been billed if compression were off, and
 *  give the regression a clean denominator. Absent when no bucket fired. */
export type BucketChars = Partial<Record<BucketName, number>>;

/** Attribute `chars` of TEXT to a logical compression bucket. Lazily allocates
 *  `info.bucketChars` so happy-path events stay lean. Called at every gate
 *  call site regardless of whether the gate accepted or rejected — we want
 *  the denominator to reflect everything the gate saw, not just the wins. */
function bumpBucket(info: TransformInfo, bucket: BucketName, chars: number): void {
  if (chars <= 0) return;
  if (!info.bucketChars) info.bucketChars = {};
  info.bucketChars[bucket] = (info.bucketChars[bucket] ?? 0) + chars;
}

/** Map a `classifyContent` shape to a tool_result bucket name. Keeps the
 *  per-call-site code free of repeated string checks. */
function toolResultBucket(shape: 'structured' | 'log' | 'other'): BucketName {
  if (shape === 'structured') return 'tool_result_json';
  if (shape === 'log') return 'tool_result_log';
  return 'tool_result_prose';
}

/** Parsed contents of Claude Code's <env> + git status blocks. All optional —
 *  fields are only populated if the corresponding line is present. */
export interface EnvFields {
  /** Working directory at the time `claude` was launched. */
  cwd?: string;
  isGitRepo?: boolean;
  /** Current git branch, parsed from <git_status> or a "Branch:" line. */
  gitBranch?: string;
  platform?: string;
  osVersion?: string;
  /** "Today's date" as Claude Code reported it (YYYY-MM-DD). */
  today?: string;
}

export interface TransformInfo {
  compressed: boolean;
  reason?: string;
  origChars: number;
  /** Total chars of source text that were image-encoded across ALL blocks
   *  this request (static slab + reminders + tool_results). Pairs with
   *  `imageCount` for honest savings math:
   *     textTokens  = compressedChars / 4
   *     imageTokens = imageCount × 2500
   *     savings     = textTokens − imageTokens
   *  Unlike `origChars` (which is just static slab + tool docs),
   *  `compressedChars` reflects what `imageCount` actually replaced. */
  compressedChars: number;
  imageCount: number;
  imageBytes: number;
  /** Total pixel area summed across all rendered images this request
   *  (`Σ width × height`). Pairs with `cache_create_tokens` on cold-miss
   *  events to derive empirical pixels-per-token under the current model —
   *  the dashboard's `OPUS_IMAGE_TOKEN_COST` and the gate's `TOKENS_PER_IMAGE`
   *  are both stale empirical constants from a different model; this gives
   *  us the raw data to re-ground them via regression instead of guessing. */
  imagePixels?: number;
  /** Total chars of TEXT remaining in the outgoing transformed body — every
   *  TextBlock across `system`, `messages[].content`, and any tool_result
   *  text that didn't get image-compressed. Pairs with `imagePixels` and
   *  the upstream token count so we can solve for chars-per-token (α) and
   *  pixels-per-token (β) empirically: `total_tokens ≈ α·outgoingTextChars +
   *  β·imagePixels`. On a cold-miss event the upstream `cache_create_tokens`
   *  is the full LHS, so a regression over N cold-misses pins both. */
  outgoingTextChars?: number;
  /** Length of the static (cacheable) slab rendered into the image. */
  staticChars: number;
  /** Length of the dynamic (per-turn) slab kept as plain text. */
  dynamicChars: number;
  /** Number of dynamic blocks detected (<env>, <context>, etc.). */
  dynamicBlockCount: number;
  /** Tag-shaped blocks found in the *static* slab that are NOT in
   *  DYNAMIC_BLOCK_TAGS. Early-warning canary: if Claude Code ships a new
   *  per-turn tag, it'll show up here before our cache hit rate collapses. */
  unknownStaticTags?: string[];
  /** Parsed env block, if Claude Code injected one. Useful for telemetry
   *  (per-project compression ratios, etc.). */
  env?: EnvFields;
  /** sha256[0..8] of the static slab + tool docs (what ends up in the image).
   *  Repeats across turns → cache_control SHOULD be hitting upstream. */
  systemSha8?: string;
  /** sha256[0..8] of just the CLAUDE.md section if detectable. Lets us
   *  bucket requests by project even when cwd is absent. */
  claudeMdSha8?: string;
  /** sha256[0..8] of the first user message text (first 4 KiB). Rough
   *  thread/session id since the wire protocol carries none. */
  firstUserSha8?: string;
  /** Raw bytes of the FIRST rendered image. Used by the in-process dashboard
   *  to show a preview. NOT persisted to JSONL (toTrackEvent drops it). */
  firstImagePng?: Uint8Array;
  /** Pixel dimensions of the first image. */
  firstImageWidth?: number;
  firstImageHeight?: number;
  /** Every rendered PNG for this request, in render order. images[0] === firstImagePng.
   *  Surfaced separately so the dashboard can pin any image individually. */
  imagePngs?: Uint8Array[];
  /** Matching pixel dimensions for each entry in imagePngs. */
  imageDims?: Array<{ width: number; height: number }>;
  /** Number of images we added by compressing `<system-reminder>` blocks in
   *  the first user message. */
  reminderImgs?: number;
  /** Number of images we added by compressing tool_result content across
   *  user messages. */
  toolResultImgs?: number;
  /** Codepoints in the rendered text that weren't in the atlas. They
   *  rendered as blank cells. A non-zero count means the user is producing
   *  glyphs we don't ship — useful telemetry for tuning the atlas profile
   *  (e.g. switch from `practical` → `full-bmp` if Hangul shows up). */
  droppedChars?: number;
  /** Top dropped codepoints by frequency for this request, keyed `U+HHHH`
   *  (uppercase hex, at least 4 digits). At most 20 entries, sorted by count
   *  descending. Only set when `droppedChars > 0`. Lets the operator
   *  identify which Unicode blocks to add to the atlas profile without
   *  having to capture & inspect the request body. */
  droppedCodepointsTop?: Record<string, number>;
  /** Counters for why blocks didn't get image-compressed this request.
   *  Helps tune the break-even check vs the flat threshold:
   *    - `below_threshold`: block below `minReminderChars` / `minToolResultChars`
   *      (the fast-path skip; saves CPU on obvious-no cases)
   *    - `not_profitable`: block above the threshold but `isCompressionProfitable`
   *      returned false (image cost ≥ text cost at current cell config)
   *  Only emitted when at least one counter is > 0. */
  passthroughReasons?: { below_threshold?: number; not_profitable?: number };
  /** Per-gate-call diagnostics — exactly what the slab break-even gate
   *  saw and compared. Foundational observability for why a turn flipped
   *  or stayed: hosts that persist this can compute the verdict margin
   *  (`textTokens + burnTextSide − imageTokens − burnImageSide`),
   *  measure flap-prevention efficacy (`burnTextSide` > 0 rows that
   *  declined despite `imageTokens < textTokens`), and tune
   *  `historyAmortizationHorizon` against observed cache lifetimes.
   *
   *  Currently emitted for the session-anchor slab gate only. Per-block
   *  reminder / tool_result gates remain summarised in `passthroughReasons`
   *  + `bucketChars` — adding per-call diagnostics there would multiply
   *  event size without commensurate signal (those gates don't flap). */
  gateEval?: {
    /** "slab" today; reserved for future gates if they grow flapping risk. */
    readonly site: 'slab';
    /** Image-side cost estimate the gate used (token-equivalents). */
    readonly imageTokens: number;
    /** Text-side cost estimate the gate used (token-equivalents). */
    readonly textTokens: number;
    /** `priorWarmTokens × (1.25 − 0.10)` applied to the image side. */
    readonly burnImageSide: number;
    /** `priorWarmImageTokens × (1.25 − 0.10)` applied to the text side.
     *  Non-zero rows are the anti-flapping anchor — text would otherwise
     *  have looked cheaper. */
    readonly burnTextSide: number;
    /** Gate's verdict; `true` ⇒ compression applied on this turn. */
    readonly profitable: boolean;
  };
  /** Per-bucket sum of TEXT chars that flowed through each gate-call site
   *  (static slab, reminder, tool_result by classifyContent shape, history).
   *  Pre-compaction lengths — stays comparable to `origChars` and to what
   *  Anthropic would have billed if compression were off. Used by the
   *  rolling-cpt regression (Task #18) to learn per-bucket marginal cpts
   *  from production telemetry instead of relying on one global constant.
   *  Absent when no bucket fired this request. */
  bucketChars?: BucketChars;
  /** Variant C history bucket: chars of TEXT that fed into the history-image
   *  renderer (post-`messagesToHistoryText`, pre-`renderTextToPngs`). Folded
   *  into `bucketChars.history` too — surfaced separately so the regression
   *  can credit history-image cost even on no-collapse paths (where the
   *  collapsed-prefix gate ran but landed on `not_profitable` / `render_empty`
   *  and we still want to record that the bucket saw text). */
  historyTextChars?: number;
  /** Number of tool_result blocks where the source text exceeded the
   *  per-tool_result image budget and was truncated before rendering. */
  truncatedToolResults?: number;
  /** Total chars elided by paging across all tool_results this request. */
  omittedChars?: number;
  /** Variant C history-image: how many original `messages[]` entries got
   *  collapsed into the prepended synthetic user message. 0 / unset when
   *  no collapse happened (no closed prefix, too few turns, gate rejected
   *  as not_profitable, etc. — see `historyReason`). */
  collapsedTurns?: number;
  /** Variant C: total chars of text serialized into the history image(s)
   *  before render (pre-OCR loss). */
  collapsedChars?: number;
  /** Variant C: number of PNG image blocks emitted for the history. Folded
   *  into `info.imageCount` too — surfaced separately so dashboards can
   *  attribute image-count growth to history vs system-slab vs reminders. */
  collapsedImages?: number;
  /** Variant C: sha8 of the concatenated history-image base64 emitted this
   *  request. The quantized collapse boundary keeps the synthetic history
   *  message byte-identical for a full `collapseChunk` window — an UNCHANGED
   *  `history_image_sha8` across consecutive collapsed events is the
   *  ground-truth proof that the upstream prompt cache can `cache_read` the
   *  history prefix (0.1x) instead of re-billing `cache_create` (1.25x). A
   *  hash that changes every turn ⟹ the cache-key drift bug is back. Only
   *  set when a collapse actually produced image blocks. */
  historyImageSha?: string;
  /** Variant C: why the history collapse didn't run (or did). Diagnostic
   *  only — see `HistoryCollapseInfo.reason` for the value set. */
  historyReason?:
    | 'no_history'
    | 'prefix_too_short'
    | 'no_closed_prefix'
    | 'not_profitable'
    | 'render_empty'
    | 'collapsed';
  /** Ground-truth baseline token count for THIS request, from a parallel
   *  call to /v1/messages/count_tokens on the PRE-COMPRESSION body. The
   *  endpoint is free (no input-token billing). Absent when the probe
   *  failed (network, 4xx) — that event is then excluded from the
   *  savings rollup. */
  baselineTokens?: number;
  /** Second baseline probe: input_tokens of the original body TRUNCATED at
   *  the last `cache_control` marker — the prefix that would have cached
   *  on the unproxied path. Used by the dashboard to weight the baseline by
   *  the SAME cache class the proxied request landed in (cache_create ×1.25,
   *  cache_read ×0.10, no-cache ×1.0), giving an exact cache-aware
   *  counterfactual instead of cold-every-time. Absent when the original
   *  body has no cache_control markers anywhere (in which case the unproxied
   *  path doesn't cache and cacheable_prefix_tokens = 0). */
  baselineCacheableTokens?: number;
  /** Status of the cache-aware baseline probe for this request.
   *
   *   'ok'       both `baselineTokens` and `baselineCacheableTokens` resolved
   *              (or the body had no `cache_control` markers, so cacheable=0
   *              is exact, not estimated).
   *   'partial'  the full-body probe resolved but the cacheable-prefix probe
   *              didn't return a number even though the body had markers.
   *              We can't honestly attribute savings on this row — the
   *              dashboard must exclude it from the saved-cost rollup
   *              rather than fall through to `cacheable=0`, which biases
   *              the baseline up (= dishonest "$ saved").
   *   'failed'   the full-body probe itself didn't resolve. No baseline at all.
   *   undefined  no probe was attempted (proxy path didn't run /v1/messages
   *              with a parseable body).
   */
  baselineProbeStatus?: 'ok' | 'partial' | 'failed';
}

// --- helpers ---------------------------------------------------------------

/** Extract `(text, remainder)` from a system field that may be string or list. */
function extractSystemText(sys: SystemField | undefined): { text: string; kept: SystemField } {
  if (sys == null) return { text: '', kept: [] };
  if (typeof sys === 'string') return { text: sys, kept: '' };
  const textParts: string[] = [];
  const kept: SystemField = [];
  for (const block of sys) {
    if (block && typeof block === 'object' && block.type === 'text') {
      textParts.push(block.text);
    } else {
      kept.push(block);
    }
  }
  return { text: textParts.join('\n\n'), kept };
}

function lastStaticSystemCacheControl(sys: SystemField | undefined): TextBlock['cache_control'] | undefined {
  if (!Array.isArray(sys)) return undefined;
  let cacheControl: TextBlock['cache_control'] | undefined;
  for (const block of sys) {
    if (!block || block.type !== 'text' || block.cache_control === undefined) continue;
    const { body } = stripBillingLine(block.text);
    if (splitStaticDynamic(body).staticText.length > 0) {
      cacheControl = block.cache_control;
    }
  }
  return cacheControl;
}

/**
 * Claude Code injects a handful of per-turn dynamic blocks into the system
 * prompt (e.g. <env>, <context>, <git_status>, <directoryStructure>,
 * <system-reminder>). Including these in the rendered image kills the
 * Anthropic prompt cache because the bytes drift turn-to-turn. Splitting
 * them out lets us render the static slab (CLAUDE.md, agent defs, tool docs)
 * with cache_control while forwarding the dynamic slab as cheap text so the
 * model still sees cwd / git status / today's date.
 */
const DYNAMIC_BLOCK_TAGS = [
  'env',
  'context',
  'git_status',
  'directoryStructure',
  'system-reminder',
] as const;

/**
 * Tag-shaped blocks that DO appear in the static slab and SHOULD be baked into
 * the cached image. These are part of Claude Code's built-in system prompt /
 * tool documentation, not per-turn injections, so they're stable across turns.
 *
 * The canary in splitStaticDynamic flags any tag-shaped block in the static
 * slab that isn't in DYNAMIC_BLOCK_TAGS — designed to catch a new Claude Code
 * release that ships a per-turn tag we'd accidentally cache. Without this
 * allowlist, known-static tags like <types> trigger the canary on most turns
 * and drown out the real signal. Add a tag here only after confirming it's
 * static (appears in the cacheable part of the prompt, not rotated per turn).
 */
const KNOWN_STATIC_TAGS = ['types'] as const;

function splitStaticDynamic(text: string): {
  staticText: string;
  dynamicText: string;
  blockCount: number;
  unknownTags: string[];
} {
  if (!text)
    return { staticText: '', dynamicText: '', blockCount: 0, unknownTags: [] };
  // Match <tag ...?>...</tag> where tag ∈ DYNAMIC_BLOCK_TAGS. Closing tag
  // must match opening tag exactly. Non-greedy body — earliest close wins.
  const pattern = new RegExp(
    `<(${DYNAMIC_BLOCK_TAGS.join('|')})(\\s[^>]*)?>[\\s\\S]*?</\\1>`,
    'g',
  );
  const dynamicParts: string[] = [];
  let staticBuf = '';
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    staticBuf += text.slice(cursor, m.index);
    dynamicParts.push(m[0]);
    cursor = m.index + m[0].length;
  }
  staticBuf += text.slice(cursor);

  // Sniff for OTHER tag-shaped blocks in the static slab. If Claude Code
  // ships a new per-turn tag (say <recent_files>...</recent_files>) we'd
  // silently bake it into the cached image and our cache hit rate would
  // collapse. Surfacing the tag name as telemetry lets us detect that
  // within hours of a Claude Code release.
  const known = new Set<string>(DYNAMIC_BLOCK_TAGS);
  const knownStatic = new Set<string>(KNOWN_STATIC_TAGS);
  const sniffer = /<([a-zA-Z][a-zA-Z0-9_-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g;
  const unknown = new Set<string>();
  let s: RegExpExecArray | null;
  while ((s = sniffer.exec(staticBuf)) !== null) {
    const tag = s[1]!;
    if (!known.has(tag) && !knownStatic.has(tag) && tag.length <= 64)
      unknown.add(tag);
  }

  return {
    // Collapse the run of blank lines left behind by removed blocks.
    staticText: staticBuf.replace(/\n{3,}/g, '\n\n').trim(),
    dynamicText: dynamicParts.join('\n\n'),
    blockCount: dynamicParts.length,
    unknownTags: [...unknown],
  };
}

/**
 * Compute sha256 and return the first 8 hex chars. Web Crypto so it works
 * the same in Node 18+ and Workers. 8 chars = 32 bits = collision-safe for
 * the request volume we'd see in a single proxy instance.
 */
export async function sha8(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 4; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Hash the concatenated base64 of every image block carried by the synthetic
 * history message. `collapseHistory` returns `[syntheticUser, ...tail]`, so
 * the history images — if any — live on `messages[0]`.
 *
 * Logging this per request makes the cache-key drift bug (#28) observable
 * straight from `events.jsonl`: while the quantized collapse boundary holds,
 * consecutive collapsed events MUST report an identical `history_image_sha8`.
 * That byte-stability is exactly what lets Anthropic's prompt cache serve the
 * history prefix as a `cache_read` (0.1x) instead of re-billing a fresh
 * `cache_create` (1.25x) every turn. A hash that moves turn-over-turn is the
 * signature of the regression — the proxy can't *see* Anthropic's cache
 * decision, so this hash is our ground-truth proxy for it.
 *
 * Returns `undefined` when `messages[0]` carries no image blocks (i.e. no
 * collapse happened this request) — callers gate on `collapsedTurns` anyway.
 */
async function historyImageSha8(
  messages: Message[],
): Promise<string | undefined> {
  const synthetic = messages[0];
  if (!synthetic || !Array.isArray(synthetic.content)) return undefined;
  let concat = '';
  for (const blk of synthetic.content) {
    if (blk.type === 'image') concat += blk.source.data;
  }
  return concat ? sha8(concat) : undefined;
}

/**
 * Best-effort: pull out the CLAUDE.md slab from a system text. Heuristic —
 * Claude Code typically wraps it with a heading like "Claude Code Rules"
 * or includes it under a `# CLAUDE.md` / system-reminder block. Returns
 * empty string if nothing CLAUDE.md-shaped is detected; callers should
 * skip hashing in that case.
 */
export function extractClaudeMdSlab(staticText: string): string {
  if (!staticText) return '';
  // Common markers Claude Code uses around the CLAUDE.md content.
  const startPatterns = [
    /^\s*#+\s*Claude\s+Code\s+Rules\s*$/im,
    /^\s*#+\s*CLAUDE\.md\s*$/im,
    /^\s*Claude\s+Code\s+Rules:?\s*$/im,
  ];
  let startIdx = -1;
  for (const p of startPatterns) {
    const m = p.exec(staticText);
    if (m && (startIdx === -1 || m.index < startIdx)) startIdx = m.index;
  }
  if (startIdx === -1) return '';
  // Run until the next top-level heading (# foo) or end of text.
  const tail = staticText.slice(startIdx);
  const endMatch = /\n#\s+\S/.exec(tail.slice(1));
  const end = endMatch ? endMatch.index + 1 : tail.length;
  return tail.slice(0, end).trim();
}

/**
 * Hash the first user message text, capped at 4 KiB so very long initial
 * pastes don't dominate hashing time and so we still get a stable id for
 * the conversation thread (initial prompt usually fits well within 4 KiB).
 */
export function firstUserText(req: MessagesRequest): string {
  const msgs = req.messages ?? [];
  for (const m of msgs) {
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content.slice(0, 4096);
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block && (block as any).type === 'text' && typeof (block as any).text === 'string') {
          return ((block as any).text as string).slice(0, 4096);
        }
      }
    }
    // First user message found but unreadable → return empty so we don't
    // accidentally hash some downstream user message.
    return '';
  }
  return '';
}

/**
 * Pull structured fields out of the dynamic slab. Only reads — does not
 * modify the text. Used purely for telemetry / improvement signals.
 */
export function extractEnvFields(dynamicText: string): EnvFields {
  const out: EnvFields = {};
  if (!dynamicText) return out;

  const envMatch = /<env>([\s\S]*?)<\/env>/i.exec(dynamicText);
  if (envMatch) {
    const body = envMatch[1]!;
    const cwd = /(?:^|\n)\s*Working directory:\s*(.+?)\s*(?:\n|$)/i.exec(body);
    if (cwd) out.cwd = cwd[1]!.trim();
    const gitRepo = /(?:^|\n)\s*Is directory a git repo:\s*(Yes|No)\b/i.exec(body);
    if (gitRepo) out.isGitRepo = gitRepo[1]!.toLowerCase() === 'yes';
    const platform = /(?:^|\n)\s*Platform:\s*(.+?)\s*(?:\n|$)/i.exec(body);
    if (platform) out.platform = platform[1]!.trim();
    const osVer = /(?:^|\n)\s*OS Version:\s*(.+?)\s*(?:\n|$)/i.exec(body);
    if (osVer) out.osVersion = osVer[1]!.trim();
    const today = /(?:^|\n)\s*Today'?s date:\s*(.+?)\s*(?:\n|$)/i.exec(body);
    if (today) out.today = today[1]!.trim();
  }

  // Git branch may live in <git_status>, <context name="git">, or just a
  // "Branch: foo" / "On branch foo" line somewhere in the dynamic slab.
  const branch =
    /(?:^|\n)\s*(?:On branch|Branch:)\s*([^\s\n]+)/i.exec(dynamicText) ??
    /(?:^|\n)\s*Current branch:\s*([^\s\n]+)/i.exec(dynamicText);
  if (branch) out.gitBranch = branch[1]!.trim();

  return out;
}

/**
 * Strip the per-turn random billing header line that Claude Code injects.
 * It changes every turn and would defeat prompt-cache hits if we left it
 * inside the image. We keep it as a leading text block so the upstream
 * still receives it.
 */
function stripBillingLine(text: string): { kept: string | null; body: string } {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first.startsWith('x-anthropic-billing-header:')) {
    return { kept: first, body: nl === -1 ? '' : text.slice(nl + 1) };
  }
  return { kept: null, body: text };
}

/** Maximum recursion depth when stripping descriptions out of an input_schema.
 *  Real tool schemas can be deeper than naive 3-level shapes — think filter
 *  DSLs, query objects, structured-output schemas. 20 is generous enough to
 *  handle anything realistic; deeper than that and we leave the node untouched
 *  rather than corrupt it. */
const SCHEMA_STRIP_MAX_DEPTH = 20;

/** Long-form description / metadata keys that contribute tokens but no
 *  validation. The image already carries this content for the model to read,
 *  so we strip them from the wire payload to recover the tokens. */
const SCHEMA_STRIP_KEYS = new Set([
  'description',
  'title',
  'examples',
  'default',
  '$schema',
  '$id',
  '$comment',
]);

/** JSON Schema composition keys whose values are *arrays of subschemas*. We
 *  recurse into each element so descriptions inside variant branches still get
 *  stripped while the variant structure is preserved. */
const SCHEMA_COMPOSITION_KEYS = new Set(['oneOf', 'anyOf', 'allOf']);

/** JSON Schema keys whose values are *objects keyed by name* (each value is
 *  itself a subschema). Both `properties` and `patternProperties` use this
 *  shape; `definitions` / `$defs` are pre-2020 and 2020-12 spellings of the
 *  same idea and we strip descriptions inside them too. */
const SCHEMA_NAMED_SUBSCHEMA_KEYS = new Set([
  'properties',
  'patternProperties',
  'definitions',
  '$defs',
]);

/** Keys whose values are a *single subschema* — recurse but don't unwrap. */
const SCHEMA_SINGLE_SUBSCHEMA_KEYS = new Set([
  'items',
  'additionalProperties',
  'not',
  'contains',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
  'if',
  'then',
  'else',
]);

/** Keys that are *arrays of primitives* (or otherwise opaque) — preserve
 *  verbatim, don't recurse. */
const SCHEMA_VERBATIM_KEYS = new Set([
  'required',
  'enum',
  'const',
  'type',          // string or array of strings
  '$ref',          // we don't resolve refs but we mustn't drop them
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'multipleOf',
  'uniqueItems',
  'pattern',
]);

/** `format` values from JSON Schema's vocabulary are short tokens
 *  (`date-time`, `uri`, `email`, `ipv4`, …). If something larger than this
 *  shows up it's almost certainly a human-readable hint that belongs in the
 *  image, not the wire payload. */
const FORMAT_MAX_LEN = 32;

/** Strip long-form metadata from a JSON-Schema-shaped node while preserving
 *  the structural keys Anthropic's tool-use validator needs to type-check the
 *  model's calls.
 *
 *  PRESERVED (verbatim or recursed):
 *    - `type`, `enum`, `const`, `$ref`
 *    - `properties` / `patternProperties` / `definitions` / `$defs` (recurse
 *       into each named subschema)
 *    - `items` / `additionalProperties` / `not` / `contains` /
 *       `propertyNames` / conditional `if`/`then`/`else` (single-subschema)
 *    - `oneOf` / `anyOf` / `allOf` (recurse into each variant)
 *    - `required` arrays
 *    - All numeric / length / pattern constraints (`minLength`, `pattern`, …)
 *    - `format` if its value is ≤ 32 chars (real format tokens are tiny)
 *
 *  STRIPPED:
 *    - `description`, `title`, `examples`, `default`
 *    - `$schema`, `$id`, `$comment`
 *    - `format` longer than 32 chars (treated as a description in disguise)
 *
 *  PASS-THROUGH for unknown keys: copy primitive/string values verbatim;
 *  recurse into nested objects so descriptions hidden under custom keys still
 *  get stripped.
 *
 *  Returns a fresh object — never mutates the input. */
function stripSchemaDescriptions(node: unknown, depth: number): unknown {
  // Beyond depth cap: leave the subtree alone. Brief: "if anything's deeper,
  // that tool is pathological and we leave it untouched." Better to ship a
  // slightly bigger schema than to corrupt one.
  if (depth > SCHEMA_STRIP_MAX_DEPTH) return node;

  // Arrays at top level (e.g. a bare `required: [...]` if we land here by
  // accident) get passed through. Real subschema arrays — `oneOf`/`anyOf`/
  // `allOf` — are handled by the parent object below.
  if (Array.isArray(node)) return node;

  // Primitives and null bottom-out unchanged.
  if (!node || typeof node !== 'object') return node;

  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(obj)) {
    if (SCHEMA_STRIP_KEYS.has(k)) continue;

    if (k === 'format' && typeof v === 'string' && v.length > FORMAT_MAX_LEN) {
      // Long "format" values are descriptions in disguise; the real
      // vocabulary tokens are <32 chars.
      continue;
    }

    if (SCHEMA_VERBATIM_KEYS.has(k)) {
      out[k] = v;
      continue;
    }

    if (
      SCHEMA_NAMED_SUBSCHEMA_KEYS.has(k) &&
      v &&
      typeof v === 'object' &&
      !Array.isArray(v)
    ) {
      // properties / patternProperties / definitions / $defs: object whose
      // values are themselves schemas.
      const nested: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        nested[pk] = stripSchemaDescriptions(pv, depth + 1);
      }
      out[k] = nested;
      continue;
    }

    if (SCHEMA_COMPOSITION_KEYS.has(k) && Array.isArray(v)) {
      // oneOf / anyOf / allOf: array of subschemas.
      out[k] = v.map((sub) => stripSchemaDescriptions(sub, depth + 1));
      continue;
    }

    if (SCHEMA_SINGLE_SUBSCHEMA_KEYS.has(k)) {
      // items / additionalProperties / not / etc. May be a schema OR a
      // boolean (additionalProperties: true/false is legal). Booleans pass
      // through untouched.
      if (typeof v === 'boolean') {
        out[k] = v;
      } else {
        out[k] = stripSchemaDescriptions(v, depth + 1);
      }
      continue;
    }

    // Unknown key. If the value is a nested object, recurse so descriptions
    // hidden under vendor extensions still get stripped. Primitives pass
    // through.
    if (v && typeof v === 'object') {
      out[k] = stripSchemaDescriptions(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Keys whose presence in a (stripped) schema gives Anthropic's validator
 *  something to bind the model's tool call against. If a stripped schema has
 *  *none* of these, we treat it as no-structure and ship the legacy bare stub
 *  with a `schema_no_properties` advisory. */
const SCHEMA_STRUCTURAL_KEYS = [
  'properties',
  'patternProperties',
  'oneOf',
  'anyOf',
  'allOf',
  'items',
  '$ref',
  'enum',
  'const',
];

function schemaHasStructure(schema: Record<string, unknown>): boolean {
  for (const k of SCHEMA_STRUCTURAL_KEYS) {
    if (k in schema) return true;
  }
  return false;
}

/** Build the "## Tool: name\n<desc>\n<schema>" block for one tool definition.
 *
 *  Schema serialization is **compact** (no whitespace). Pretty-printing
 *  with 2-space indent was the dominant source of sparse fill: each schema
 *  key on its own line, indented, wastes 70%+ of horizontal space at
 *  cols=100. Live measurement on 2026-05-19 showed 150 KB of pretty
 *  tool-doc JSON across ~30 tools rendering to 31 static-slab images per
 *  request — a 40% fill ratio that pushed every request well past the
 *  break-even point.
 *
 *  Compact form is still unambiguous JSON. Descriptions are already
 *  stripped under compressSchemas so only structural keys
 *  (type/properties/required/enum/items) remain — they read fluently
 *  on one line. Frontier models handle compact JSON natively (it's the
 *  default wire format for tool_use blocks). */
function renderToolDoc(t: ToolDef, includeSchema: boolean): string {
  const parts: string[] = [`## Tool: ${t.name ?? '?'}`];
  if (t.description) parts.push(t.description);
  if (includeSchema && t.input_schema !== undefined) {
    parts.push('```json\n' + JSON.stringify(t.input_schema) + '\n```');
  }
  return parts.join('\n');
}

function makeImageBlock(pngB64: string, _ephemeral = false): ImageBlock {
  // Per Task #21: pixelpipe NEVER adds its own cache_control marker.
  // Claude Code already places markers on system+tools, CLAUDE.md, and the
  // per-turn anchor; we honor those positions byte-identically and add
  // nothing of our own. The `_ephemeral` parameter is preserved for call-
  // site compatibility but is now a no-op.
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: pngB64 },
  };
}

/** Render a long text blob to one or more PNG image blocks. Helper for the
 *  per-message compressions (reminders, tool_results) — no cache_control on
 *  these (Anthropic caps at 4 breakpoints; the system+tools image already
 *  anchors the cacheable prefix).
 *
 *  Also returns the total `droppedChars` across all rendered images plus the
 *  merged codepoint→count map so the caller can fold both into the request's
 *  `info.droppedChars` / `info.droppedCodepointsTop`. */

// --- paging / truncation -------------------------------------------------
//
// Anthropic's API caps a request at 100 images. A single huge tool_result
// (find over a big tree, multi-MB log dump) can blow that cap by itself.
// To keep the request valid AND not waste tokens on dozens of bottom-of-log
// images, we truncate the source text before render with a marker that
// tells the model what was elided.

/** Visual rows a single input line will consume after soft-wrap at `cols`. */
function lineRows(line: string, cols: number): number {
  return Math.max(1, Math.ceil(line.length / cols));
}

/** Count the visual rows `text` will consume after soft-wrap at `cols`.
 *  Wrap-the-line reflow breaks the render row at every ↵, so both `\n` and
 *  the ↵ sentinel end a counted line — and the ↵ glyph occupies a cell on
 *  the line it terminates. */
function countVisualRows(text: string, cols: number): number {
  let rows = 0;
  let lineStart = 0;
  const len = text.length;
  for (let i = 0; i <= len; i++) {
    const cc = i < len ? text.charCodeAt(i) : -1;
    const isSentinel = cc === 0x21b5 /* ↵ */;
    if (i === len || cc === 10 /* \n */ || isSentinel) {
      // ↵ renders as a glyph on the line it ends — count it in the length.
      const lineLen = (isSentinel ? i + 1 : i) - lineStart;
      rows += Math.max(1, Math.ceil(lineLen / cols));
      lineStart = i + 1;
    }
  }
  return rows;
}

/** Estimate how many images `text` will render to at the given column width.
 *  Counts soft-wrapped visual rows, which is what render.ts actually budgets
 *  against. Exported for tests + the paging gate.
 *
 *  `numCols` (default 1) packs that many text columns side-by-side per
 *  image — must match the `multiCol` setting wired through to the renderer
 *  for the math to predict the actual image count. */
export function estimateImageCount(
  textOrLen: string | number,
  cols: number,
  numCols: number = 1,
): number {
  const n = Math.max(1, numCols | 0);
  const readableLinesPerCol = Math.max(1, Math.floor(READABLE_CHARS_PER_IMAGE / Math.max(1, cols)));
  const linesPerImage = Math.min(LINES_PER_IMAGE, readableLinesPerCol) * n;
  if (typeof textOrLen === 'number') {
    // Back-compat shim — numeric arg gets the looser chars-based estimate.
    return Math.max(1, Math.ceil(textOrLen / Math.max(1, READABLE_CHARS_PER_IMAGE * n)));
  }
  const rows = countVisualRows(textOrLen, cols);
  return Math.max(
    1,
    Math.ceil(rows / linesPerImage),
    Math.ceil(textOrLen.length / Math.max(1, READABLE_CHARS_PER_IMAGE * n)),
  );
}

/** Classify content so we can pick a truncation strategy. Cheap heuristics on
 *  the first ~4 KiB. Returns:
 *    - `'structured'`: JSON/YAML/diff markers at the top. Truncate tail.
 *    - `'log'`: ≥30% of lines start with a log level or timestamp. Truncate middle.
 *    - `'other'`: prose, file dumps, etc. Truncate middle.
 *  Exported for tests. */
export function classifyContent(text: string): 'structured' | 'log' | 'other' {
  const head = text.slice(0, 4096);
  const trimmed = head.trimStart();
  if (trimmed.startsWith('{') && /^\{\s*("|\})/.test(trimmed)) return 'structured';
  if (trimmed.startsWith('[') && /^\[\s*("|\{|\[|-?\d|true\b|false\b|null\b|\])/.test(trimmed))
    return 'structured';
  if (trimmed.startsWith('---\n') || trimmed.startsWith('---\r\n')) return 'structured';
  if (trimmed.startsWith('diff --git ') || /^---\s+\S/.test(trimmed)) return 'structured';
  const lines = head.split('\n').slice(0, 40).filter((l) => l.length > 0);
  if (lines.length < 4) return 'other';
  const LOG_LINE =
    /^(\[?(DEBUG|INFO|WARN|WARNING|ERROR|TRACE|FATAL)\]?\b|\d{4}-\d{2}-\d{2}[T ]?|\d{2}:\d{2}:\d{2}\b)/;
  let logHits = 0;
  for (const line of lines) if (LOG_LINE.test(line)) logHits++;
  if (logHits / lines.length >= 0.3) return 'log';
  return 'other';
}

/** Build the paging marker text. The model sees this verbatim INSIDE the
 *  rendered image so it can reason about what was elided. */
function buildPagingMarker(args: {
  originalChars: number;
  originalLines: number;
  originalEstImages: number;
  shownHeadLines: number;
  shownTailLines: number;
  omittedLines: number;
  omittedChars: number;
}): string {
  const tailNote =
    args.shownTailLines > 0
      ? ` Showing first ${args.shownHeadLines} lines and last ${args.shownTailLines} lines.`
      : ` Showing first ${args.shownHeadLines} lines (tail elided).`;
  return (
    `\n\n[ pixelpipe paging: omitted ${args.omittedLines.toLocaleString('en-US')} lines ` +
    `(${args.omittedChars.toLocaleString('en-US')} chars) of content here. ` +
    `Original length: ${args.originalChars.toLocaleString('en-US')} chars ` +
    `(${args.originalLines.toLocaleString('en-US')} lines, ~${args.originalEstImages} images).` +
    `${tailNote} ]\n\n`
  );
}

/** Truncate `text` so it renders to roughly `maxImages` images at the given
 *  `cols`. Picks head/tail split based on `classifyContent`. Budget measured
 *  in visual rows (what render.ts actually slices on). Returns the truncated
 *  text (with paging marker embedded) and the count of chars omitted. If
 *  `text` already fits, returns unchanged with `omittedChars: 0`. Exported
 *  for tests. */
export function truncateForBudget(
  text: string,
  maxImages: number,
  cols: number,
  numCols: number = 1,
): { text: string; omittedChars: number; truncated: boolean } {
  const n = Math.max(1, numCols | 0);
  const estImages = estimateImageCount(text, cols, n);
  if (estImages <= maxImages) return { text, omittedChars: 0, truncated: false };
  const readableLinesPerCol = Math.max(1, Math.floor(READABLE_CHARS_PER_IMAGE / Math.max(1, cols)));
  const totalRowBudget = Math.max(8, maxImages * Math.min(LINES_PER_IMAGE, readableLinesPerCol) * n - 6);
  const shape = classifyContent(text);
  // Reflowed text uses NL_SENTINEL (↵ U+21B5) as line separator instead of \n.
  // Split on whichever delimiter the text uses so we can truncate at logical
  // line boundaries rather than treating the entire reflowed blob as one line.
  const nlChar = text.indexOf('\n') >= 0 ? '\n' : NL_SENTINEL;
  const lines = text.split(nlChar);
  const originalLines = lines.length;
  const originalChars = text.length;

  if (shape === 'structured') {
    let rows = 0;
    let cut = 0;
    for (let i = 0; i < lines.length; i++) {
      const r = lineRows(lines[i]!, cols);
      if (rows + r > totalRowBudget) break;
      rows += r;
      cut = i + 1;
    }
    if (cut === 0) cut = 1;
    const head = lines.slice(0, cut).join(nlChar);
    const omitted = originalChars - head.length;
    return {
      text:
        head +
        buildPagingMarker({
          originalChars,
          originalLines,
          originalEstImages: estImages,
          shownHeadLines: cut,
          shownTailLines: 0,
          omittedLines: originalLines - cut,
          omittedChars: omitted,
        }),
      omittedChars: omitted,
      truncated: true,
    };
  }

  // log / other: 60% head, 40% tail.
  const headRowBudget = Math.floor(totalRowBudget * 0.6);
  const tailRowBudget = totalRowBudget - headRowBudget;
  let headRows = 0;
  let headCut = 0;
  for (let i = 0; i < lines.length; i++) {
    const r = lineRows(lines[i]!, cols);
    if (headRows + r > headRowBudget) break;
    headRows += r;
    headCut = i + 1;
  }
  if (headCut === 0) headCut = 1;
  let tailRows = 0;
  let tailStart = lines.length;
  for (let i = lines.length - 1; i >= headCut; i--) {
    const r = lineRows(lines[i]!, cols);
    if (tailRows + r > tailRowBudget) break;
    tailRows += r;
    tailStart = i;
  }
  if (tailStart <= headCut || tailStart >= lines.length) {
    const head = lines.slice(0, headCut).join(nlChar);
    const omitted = originalChars - head.length;
    return {
      text:
        head +
        buildPagingMarker({
          originalChars,
          originalLines,
          originalEstImages: estImages,
          shownHeadLines: headCut,
          shownTailLines: 0,
          omittedLines: originalLines - headCut,
          omittedChars: omitted,
        }),
      omittedChars: omitted,
      truncated: true,
    };
  }
  const headText = lines.slice(0, headCut).join(nlChar);
  const tailText = lines.slice(tailStart).join(nlChar);
  const shownChars = headText.length + tailText.length;
  const omitted = originalChars - shownChars;
  return {
    text:
      headText +
      buildPagingMarker({
        originalChars,
        originalLines,
        originalEstImages: estImages,
        shownHeadLines: headCut,
        shownTailLines: lines.length - tailStart,
        omittedLines: originalLines - headCut - (lines.length - tailStart),
        omittedChars: omitted,
      }) +
      tailText,
    omittedChars: omitted,
    truncated: true,
  };
}

async function textToImageBlocks(
  text: string,
  cols: number,
  numCols: number = 1,
  /** Shrink the rendered canvas width to the longest actual wrapped line.
   *  Default `true` (matches the `isCompressionProfitable` default and is
   *  correct for per-block content: tool_result, reminder, history). Set
   *  `false` for the system slab path, which fills the full configured
   *  `cols` deliberately for multi-col packing. */
  shrinkWidth: boolean = true,
): Promise<{
  blocks: ImageBlock[];
  droppedChars: number;
  droppedCodepoints: Map<number, number>;
  /** Total pixel area across the rendered images (`Σ width × height`).
   *  Lets the caller accumulate `info.imagePixels` for the empirical
   *  px/token regression. */
  pixels: number;
}> {
  // Width-shrink at the renderer entry so the renderer's canvas matches
  // the gate's prediction (gate also uses `shrinkColsToContent` when its
  // own `shrinkWidth=true`). Multi-col packing only kicks in when the
  // configured `cols` is wide enough to need it, so we shrink BEFORE the
  // numCols branch — for narrow content, single-col is the right call
  // even if numCols>1 was configured.
  const effectiveCols = shrinkWidth ? shrinkColsToContent(text, cols) : cols;
  // If shrinkage drops the canvas below the multi-col threshold, stay
  // single-col to avoid burning a divider column on near-empty space.
  const effectiveNumCols = effectiveCols < cols ? 1 : numCols;
  const imgs =
    effectiveNumCols > 1
      ? await renderTextToPngsMultiCol(text, effectiveCols, effectiveNumCols)
      : await renderTextToPngs(text, effectiveCols);
  let droppedChars = 0;
  let pixels = 0;
  const droppedCodepoints = new Map<number, number>();
  const blocks: ImageBlock[] = [];
  for (const img of imgs) {
    blocks.push(makeImageBlock(bytesToBase64(img.png), false));
    droppedChars += img.droppedChars;
    pixels += img.width * img.height;
    for (const [cp, n] of img.droppedCodepoints) {
      droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + n);
    }
  }
  return { blocks, droppedChars, droppedCodepoints, pixels };
}

/** Best-effort byte-count of an image block's PNG payload (decoded from b64).
 *  Used only for the imageBytes telemetry; an exact value isn't worth a
 *  second base64 round-trip. */
function approxBlockBytes(blk: ImageBlock): number {
  const b64 = blk.source.data;
  // base64 → bytes: every 4 chars decode to 3 bytes, minus padding.
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

// --- main transform --------------------------------------------------------


/**
 * Run history-image compression on `req.messages` and finalize the
 * outgoing body. Called from BOTH the main success path AND the
 * early-exit paths (below_min_chars, not_profitable slab) so message
 * history is collapsed regardless of whether the static slab compresses.
 *
 * Real Codex traffic has tiny system slabs but huge `messages[]`. Without
 * this, history collapse never runs on real production requests — the
 * early-exits fire first and return the original bytes.
 *
 * The fn is intentionally tolerant to a missing or short messages array
 * (collapseHistory itself short-circuits with reason='no_history' /
 * 'prefix_too_short') so it's always safe to call.
 */
async function runHistoryCollapseAndFinalize(
  req: MessagesRequest,
  info: TransformInfo,
  o: Required<TransformOptions>,
  opts: TransformOptions,
  droppedCodepoints: Map<number, number>,
): Promise<{ body: Uint8Array; info: TransformInfo; collapsed: boolean }> {
  let collapsedFlag = false;
  if (Array.isArray(req.messages) && req.messages.length > 0) {
    const historyCpt = opts.charsPerToken !== undefined
      ? o.charsPerToken
      : HISTORY_CHARS_PER_TOKEN;
    const horizon = Math.max(1, Math.floor(o.historyAmortizationHorizon));
    // Pass the symmetric warm-cache burn through to the history-collapse
    // gate as well. The slab gate alone got the symmetric treatment, which
    // let the history gate flip a session out of image mode even when
    // symmetric burn would have kept the slab gate in. Production data
    // 2026-05-23 showed three-turn sessions paying cache_create every
    // turn because the history gate ignored priorWarmImageTokens.
    const historyProfitable = (text: string, cols: number): boolean =>
      isCompressionProfitableAmortized(
        text, cols, undefined, 1, historyCpt, horizon,
        o.priorWarmTokens, o.priorWarmImageTokens,
      );
    const { messages: newMessages, info: histInfo } = await collapseHistory(
      req.messages,
      historyProfitable,
      { cols: o.cols },
    );
    if (histInfo.collapsedTurns > 0) {
      req.messages = newMessages;
      info.collapsedTurns = histInfo.collapsedTurns;
      info.collapsedChars = histInfo.collapsedChars;
      info.collapsedImages = histInfo.collapsedImages;
      info.imageCount += histInfo.collapsedImages;
      info.imageBytes += histInfo.collapsedImageBytes;
      info.imagePixels = (info.imagePixels ?? 0) + histInfo.collapsedImagePixels;
      info.droppedChars = (info.droppedChars ?? 0) + histInfo.droppedChars;
      for (const [cp, n] of histInfo.droppedCodepoints) {
        droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + n);
      }
      info.historyReason = 'collapsed';
      info.historyTextChars = histInfo.collapsedChars;
      info.historyImageSha = await historyImageSha8(newMessages);
      bumpBucket(info, 'history', histInfo.collapsedChars);
      collapsedFlag = true;
    } else if (histInfo.reason) {
      info.historyReason = histInfo.reason;
    }
  }
  info.outgoingTextChars = countOutgoingTextChars(req);
  const outBody = new TextEncoder().encode(JSON.stringify(req));
  return { body: outBody, info, collapsed: collapsedFlag };
}

/**
 * Rewrite a Messages API request body. Returns the new body (still JSON
 * bytes) plus diagnostic info. On any error, returns the original bytes
 * unchanged.
 */
export async function transformRequest(
  body: Uint8Array,
  opts: TransformOptions = {},
): Promise<{ body: Uint8Array; info: TransformInfo }> {
  // Merge caller opts over DEFAULTS, but treat explicit `undefined` as "not
  // provided" so it falls through to the default. Without this, a caller that
  // passes `{ minToolResultChars: undefined }` (common when forwarding partial
  // options from upstream — e.g. ocproxy's handler) would silently disable the
  // tool_result text-passthrough gate and route everything through the
  // renderer.
  const merged: TransformOptions = { ...DEFAULTS, ...opts };
  for (const k of Object.keys(merged) as (keyof TransformOptions)[]) {
    if (merged[k] === undefined) {
      (merged as Record<string, unknown>)[k] = (DEFAULTS as Record<string, unknown>)[k];
    }
  }
  const o: Required<TransformOptions> = merged as Required<TransformOptions>;
  const info: TransformInfo = {
    compressed: false,
    origChars: 0,
    compressedChars: 0,
    imageCount: 0,
    imageBytes: 0,
    staticChars: 0,
    dynamicChars: 0,
    dynamicBlockCount: 0,
    droppedChars: 0,
  };
  // Per-request codepoint drop histogram. Merged from every render call
  // (static slab + reminder + tool_result compressions). Serialized to
  // `info.droppedCodepointsTop` at the end of transformRequest IF non-empty.
  const droppedCodepoints = new Map<number, number>();

  if (!o.compress) {
    info.reason = 'compress=false';
    return { body, info };
  }

  let req: MessagesRequest;
  try {
    req = JSON.parse(new TextDecoder().decode(body));
  } catch (e) {
    info.reason = `parse_error: ${(e as Error).message}`;
    return { body, info };
  }

  // 1. Pull system text out. Split into:
  //    - billingLine: Claude Code's per-turn random header (must NOT be cached).
  //    - dynamicText: <env>/<context>/... blocks (per-turn, kept as text).
  //    - staticText: everything else (cacheable, goes into the image).
  const systemStaticCacheControl = lastStaticSystemCacheControl(req.system);
  const { text: rawSysText, kept: sysRemainder } = extractSystemText(req.system);
  const { kept: billingLine, body: sysBody } = stripBillingLine(rawSysText);
  const {
    staticText,
    dynamicText,
    blockCount: dynBlocks,
    unknownTags,
  } = splitStaticDynamic(sysBody);
  info.staticChars = staticText.length;
  info.dynamicChars = dynamicText.length;
  info.dynamicBlockCount = dynBlocks;
  if (unknownTags.length > 0) info.unknownStaticTags = unknownTags;
  // Parse env fields out of the dynamic slab — telemetry only, never mutates.
  const env = extractEnvFields(dynamicText);
  if (Object.keys(env).length > 0) info.env = env;

  // Privacy-safe fingerprints that don't depend on tool docs (computed
  // here so they're available even if we below_min_chars out below).
  // systemSha8 is set later, after we know the combined image-bound text.
  const claudeMdSlab = extractClaudeMdSlab(staticText);
  const firstUser = firstUserText(req);
  const [claudeMdSha, firstUserSha] = await Promise.all([
    claudeMdSlab ? sha8(claudeMdSlab) : Promise.resolve(undefined),
    firstUser ? sha8(firstUser) : Promise.resolve(undefined),
  ]);
  if (claudeMdSha) info.claudeMdSha8 = claudeMdSha;
  if (firstUserSha) info.firstUserSha8 = firstUserSha;

  // 2. Optionally fold tool docs into the same image, stubbing originals.
  let toolDocsText = '';
  let toolsRewritten: ToolDef[] | undefined;
  if (o.compressTools && Array.isArray(req.tools) && req.tools.length > 0) {
    const docs: string[] = [];
    let sawSchemaNoProps = false;
    toolsRewritten = req.tools.map((t) => {
      docs.push(renderToolDoc(t, o.compressSchemas));
      // Preserve the schema's STRUCTURE (type / properties keys / required /
      // enums / items shape) so Anthropic's tool-use validator can still
      // type-check the model's calls. Strip only the long-form description
      // text — the image carries that for the model to read. Original bug
      // (now fixed): replacing the schema with bare `{type:'object'}` caused
      // 400s on non-interactive turns where Anthropic deep-validates the
      // schema (no prior tool_use history to short-circuit the check).
      let stubSchema: unknown | undefined;
      if (o.compressSchemas) {
        if (t.input_schema && typeof t.input_schema === 'object') {
          const stripped = stripSchemaDescriptions(
            t.input_schema,
            0,
          ) as Record<string, unknown> | null;
          if (!stripped || typeof stripped !== 'object') {
            // Should not happen for object input, but be defensive.
            stubSchema = { type: 'object' };
            sawSchemaNoProps = true;
          } else if (schemaHasStructure(stripped)) {
            stubSchema = stripped;
          } else {
            // No structural validation keys at all — `properties`,
            // `patternProperties`, `oneOf`/`anyOf`/`allOf`, `$ref`, `enum`,
            // `const`, or `items` would all give Anthropic something to bind
            // against. Without any of them the model has no parameter
            // contract. Ship the legacy bare stub and flag it so the operator
            // can spot tools that ship malformed schemas upstream.
            stubSchema = { type: 'object' };
            sawSchemaNoProps = true;
          }
        }
        // If t.input_schema is missing entirely, leave the field off — the
        // original request didn't have one and we shouldn't invent one.
      }
      return {
        ...t,
        description: 'ⓘ See image.',
        ...(stubSchema !== undefined ? { input_schema: stubSchema } : {}),
      };
    });
    toolDocsText = docs.join('\n\n');
    if (sawSchemaNoProps && !info.reason) {
      info.reason = 'schema_no_properties';
    }
  }

  // Only the STATIC slab + tool docs goes into the renderer. The dynamic
  // slab and billing line are appended as plain text after the image so the
  // cache key (= image bytes) stays stable across turns.
  //
  // Run the lossless whitespace compactor before measuring/rendering. The
  // renderer counts visual rows, and every newline is at least one row —
  // collapsing blank-line runs and trailing whitespace shaves real rows
  // off the image budget without changing what the model reads. Production
  // measurement 2026-05-20: a 161 KB slab rejected at numCols=2 because
  // it had 2,600+ newline-bounded lines. The compactor reliably moves the
  // needle on those by 10-25%.
  const combinedRaw = [staticText, toolDocsText].filter((s) => s.length > 0).join('\n\n');
  // R3: reflow runs after compaction, before the break-even gate, so the gate
  // and renderer below both see the same dense text. `info.origChars` /
  // `compressedChars` stay anchored to `combinedRaw.length` (raw) — reflow
  // only changes pixels, never the savings denominator.
  const combined = maybeReflow(compactSlabWhitespace(combinedRaw), o.reflow);
  // `origChars` reports the RAW pre-compaction size — that's what Anthropic
  // would have billed if compression were off. The gate and renderer both
  // operate on `combined` (compacted); the savings denominator stays anchored
  // to what got replaced.
  info.origChars = combinedRaw.length;
  // Track chars of the static slab+tools that DO end up imaged. The
  // break-even gate below may reject — bump only when the slab actually
  // renders. Reminder/tool_result compressions add to this at their sites.
  info.compressedChars = 0;
  // Hash the EXACT text that goes into the image. Repeats of this hash across
  // turns = cache_control should be earning its keep.
  if (combined) info.systemSha8 = await sha8(combined);

  if (combined.length < o.minCompressChars) {
    info.reason = `below_min_chars (${combined.length} < ${o.minCompressChars})`;
    // Even with a static slab below the gate, message history may still be
    // collapsable. Run history collapse on the in-memory request so
    // production Codex traffic (tiny system, huge messages) still benefits.
    // If history collapses, we flip `info.compressed = true` and let the
    // library wrapper return reason='applied'; otherwise this still
    // populates `outgoingTextChars` for the regression denominator.
    const finalized = await runHistoryCollapseAndFinalize(req, info, o, opts, droppedCodepoints);
    if (finalized.collapsed) {
      info.compressed = true;
      return { body: finalized.body, info };
    }
    return { body, info };
  }

  // Per-block break-even check applied to the static slab too. The slab is
  // usually 25-30 KB so it always passes (1 image @ 2500 tokens < 25000/4 =
  // 6250 text-equivalent tokens), but the check guards against the edge
  // case where a tiny tool docs + tiny static slab combine to <10k chars.
  // Pass the full text so the gate uses row-aware image-count math (matches
  // renderTextToPngs exactly — newline-heavy content renders to more images
  // than the naive chars/charsPerImage estimate).
  // Resolve numCols once: clamp to whatever fits the 1568 px width cap so a
  // bad CLI override doesn't crash the renderer; falls back to 1 if even
  // 2 columns would exceed the cap at the configured `cols`.
  const numCols = Math.min(
    Math.max(1, (o.multiCol | 0) || 1),
    Math.max(1, maxFittingCols(o.cols)),
  );
  // Slab cpt is empirically ~1.2 (N=354 production samples) — far from the
  // English-prose default 4 baked into CHARS_PER_TOKEN. Use a slab-specific
  // upper-bound cpt at this gate so JSON-dense system + tool-doc content
  // gets a fair break-even check. Host can still override via
  // `opts.charsPerToken` (e.g., to plug in a live empirical fit).
  // Discriminate on the *raw* `opts` so a host that genuinely wants the
  // English-prose `4` can pin to it without colliding with the merged default.
  const slabCpt = opts.charsPerToken !== undefined
    ? o.charsPerToken
    : SLAB_CHARS_PER_TOKEN;
  // System slab: width-shrink like every other block. Earlier versions of
  // this code path fixed the slab at the full configured `cols` on the
  // theory that (a) the slab is huge so any shrink savings would be
  // negligible and (b) it's the cache anchor so width must be stable
  // turn-to-turn. (b) is still true and is preserved by feeding the same
  // text through the same shrinker every turn — the shrink output is a
  // pure function of `(text, cols)` so the cache prefix stays byte-
  // identical across turns. (a) was wrong: short-history sessions ship
  // slabs around 3-5 k chars where a full 508 px canvas wastes most of
  // its pixel budget. Use the smallest legible image, always.
  // Build the in-image instruction header up front so we can shrink the
  // canvas width against the *actual* rendered content (header + slab).
  // The `==== SYSTEM PROMPT + TOOL DOCS ====` banner is ~40 chars and
  // naturally sets the minimum width floor for shrinkColsToContent —
  // exactly the "minwidth via banner" exception the operator called out.
  const reflowNoteImg = o.reflow
    ? ' The glyph ↵ (U+21B5) marks an original hard line break in content — treat as a real newline.'
    : '';
  const columnNoteImg =
    numCols > 1
      ? ` Multi-column layout (${numCols} cols): read column 1 (leftmost) top-to-bottom, then column 2, etc.`
      : '';
  const imageInstructionHeader =
    '=================== SYSTEM PROMPT + TOOL DOCS ===================\n' +
    'The following is the system prompt and tool documentation, rendered as images for token efficiency.' +
    ' OCR carefully and treat as authoritative system instructions.' +
    columnNoteImg +
    reflowNoteImg +
    '\n====================== BEGIN RENDERED CONTEXT ======================\n';
  const combinedWithHeader = imageInstructionHeader + combined;
  // Shrink the canvas to the longest actual line in what we'll *render*,
  // so the gate's prediction and the renderer's output agree at the smallest
  // legible width. The banner above sets the natural floor — no separate
  // minWidth knob needed. Multi-col packing still gets numCols × this width.
  const slabCols = shrinkColsToContent(combinedWithHeader, o.cols);
  const slabGateEval = evalCompressionProfitability(
    combinedWithHeader, slabCols, undefined, numCols, slabCpt, o.priorWarmTokens, o.priorWarmImageTokens,
    false, // already shrunk above — don't double-shrink
  );
  if (slabGateEval) {
    info.gateEval = {
      site: 'slab',
      imageTokens: slabGateEval.imageTokens,
      textTokens: slabGateEval.textTokens,
      burnImageSide: slabGateEval.burnImageSide,
      burnTextSide: slabGateEval.burnTextSide,
      profitable: slabGateEval.profitable,
    };
  }
  if (!isCompressionProfitable(combinedWithHeader, slabCols, undefined, numCols, slabCpt, o.priorWarmTokens, o.priorWarmImageTokens, false)) {
    info.reason = `not_profitable (slab=${combined.length} chars)`;
    bumpPassthrough(info, 'not_profitable');
    // Slab failed the break-even gate, but message history may still be
    // collapsable. Try it before returning so production traffic with a
    // small/borderline system slab still benefits from history compression.
    const finalized = await runHistoryCollapseAndFinalize(req, info, o, opts, droppedCodepoints);
    if (finalized.collapsed) {
      info.compressed = true;
      return { body: finalized.body, info };
    }
    return { body, info };
  }

  // In-image instruction header. Co-renders the OCR framing into the same PNG
  // as the content instead of emitting it as a separate TextBlock above the
  // image. Measured at +1.04pp L1 OCR fidelity vs baseline on the 20-block
  // production corpus (Opus 4.7, eval/eval-L1-ocr.mjs `reflow-inimage`
  // variant), recovering the -5.93pp reflow regression entirely. Mechanism:
  // single-modal task framing — the encoder stays in image-reading mode for
  // both the instruction and the content, no cross-modal switch. Delimiter
  // lines are deliberately heavy so the model pattern-matches "instruction
  // zone ends, content begins" without ambiguity.
  //
  // Cache impact on deploy: the image bytes change, so prefix-cached prefixes
  // built against the OLD intro layout invalidate. Every host pays one
  // cache_create on its first post-deploy turn, then warm-caches at the new
  // image. Steady-state cost is identical (the header amortizes over the
  // same cache prefix the slab already uses).
  // Header text — written as continuous prose, NO hard \n inside paragraphs.
  // The renderer soft-wraps to `cols`, packing rows densely. Hard newlines
  // here would (a) leave ~38 cells of dead margin per row and (b) on the
  // reflow path become visible ↵ glyphs, polluting the header with noise
  // markers that only make sense for content. Genuine paragraph breaks
  // (between banner / prose / banner) stay as \n.
    // 3. Render to one or more PNGs at the width chosen above. The slab
  // shrinks to the longest actual wrapped line (see `slabCols` computation
  // before the gate) so the canvas matches what the gate measured. This
  // keeps the cache prefix byte-identical when the natural floor doesn't
  // move turn-to-turn. (Per-block contexts use `textToImageBlocks` with
  // `shrinkWidth=true`; this is the same idea, hoisted above the gate.)
  const images =
    numCols > 1
      ? await renderTextToPngsMultiCol(combinedWithHeader, slabCols, numCols)
      : await renderTextToPngs(combinedWithHeader, slabCols);
  const imageBlocks: ImageBlock[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i]!;
    const b64 = bytesToBase64(img.png);
    info.imageBytes += img.png.length;
    info.imagePixels = (info.imagePixels ?? 0) + img.width * img.height;
    info.droppedChars = (info.droppedChars ?? 0) + img.droppedChars;
    for (const [cp, n] of img.droppedCodepoints) {
      droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + n);
    }
    const imageBlock = makeImageBlock(b64, i === images.length - 1);
    imageBlocks.push(
      i === images.length - 1 && systemStaticCacheControl !== undefined
        ? { ...imageBlock, cache_control: systemStaticCacheControl }
        : imageBlock,
    );
  }
  info.imageCount = imageBlocks.length;
  // Static slab made it through the break-even gate and rendered. Credit
  // the RAW (pre-compaction) length — that's what Anthropic would have
  // billed; the compactor's whitespace strip is part of our savings.
  info.compressedChars += combinedRaw.length;
  // Phase 1 (Task #18): per-bucket char attribution. Credit the same RAW
  // length to the `static_slab` bucket so the rolling cpt regression can
  // bucket-fit chars/token by call site instead of relying on one global
  // constant. Mirrors the `compressedChars` accounting exactly.
  bumpBucket(info, 'static_slab', combinedRaw.length);
  // Stash the first image's raw bytes + dimensions for the dashboard preview.
  // Stripped before persisting to JSONL by toTrackEvent. Memory cost is bounded
  // (we only ever keep ONE — the latest — via the dashboard's replace-on-update).
  if (images.length > 0) {
    info.firstImagePng = images[0]!.png;
    info.firstImageWidth = images[0]!.width;
    info.firstImageHeight = images[0]!.height;
    info.imagePngs = images.map((i) => i.png);
    info.imageDims = images.map((i) => ({ width: i.width, height: i.height }));
  }

  // 4. Splice images back into the request.
  // Cache-friendly layout:
  //   [intro text]                 ← static (helps OCR framing)
  //   [image block(s)]             ← static; LAST one carries cache_control
  //   ─── cache breakpoint ───
  //   [end-marker + dynamic + billing]  ← per-turn, NO cache_control
  //   [sysRemainder]               ← any non-text blocks the caller had
  // OCR framing (instruction header + column/reflow notes) is now baked into
  // the image itself — see `imageInstructionHeader` above. No standalone
  // TextBlock is emitted before the image. The tail closer below still sits
  // as plain text after the image so the model knows where rendered context
  // ends and per-turn dynamic content begins.
  const tailParts: string[] = ['[End of rendered context.]'];
  if (dynamicText) tailParts.push(dynamicText);
  if (billingLine) tailParts.push(billingLine);
  const tailText = tailParts.join('\n\n');

  // Image blocks ALWAYS go into the first user message — Anthropic's `system`
  // field rejects images with `400 system.N.type: Input should be 'text'`.
  // The system field stays as cheap text (billing line + dynamic blocks +
  // sysRemainder) so the model still sees env / context info.
  {
    const sysTail: SystemField = [];
    if (billingLine) sysTail.push({ type: 'text', text: billingLine });
    if (dynamicText) sysTail.push({ type: 'text', text: dynamicText });
    if (Array.isArray(sysRemainder)) sysTail.push(...sysRemainder);
    req.system = sysTail.length > 0 ? sysTail : undefined;

    const firstUserIdx = (req.messages ?? []).findIndex((m) => m.role === 'user');
    if (firstUserIdx >= 0) {
      const m = req.messages![firstUserIdx]!;
      const existing = Array.isArray(m.content)
        ? m.content
        : [{ type: 'text' as const, text: m.content }];

      // 5a. User-message text compression — long text blocks in the first
      // user message get re-injected every turn; rendering them to images
      // amortizes the cost. ALL eligible text blocks compress (not just
      // <system-reminder>-prefixed ones); the per-block coarse threshold +
      // profitability gate decide whether each block is worth converting.
      // If the source text block had a cache_control marker, it's moved
      // onto the LAST produced image so the cache anchors at the end of
      // that content. pixelpipe never adds its own markers (Task #21) —
      // it only relocates ones the caller already set.
      const processedExisting: ContentBlock[] = [];
      if (o.compressReminders) {
        for (const blk of existing) {
          const isReminderText =
            blk &&
            (blk as TextBlock).type === 'text' &&
            typeof (blk as TextBlock).text === 'string' &&
            (blk as TextBlock).text.trimStart().startsWith('<system-reminder>');
          if (!isReminderText) {
            processedExisting.push(blk);
            continue;
          }
          const textLen = (blk as TextBlock).text.length;
          if (textLen < o.minReminderChars) {
            // Below coarse threshold; can't possibly be profitable. Skip.
            bumpPassthrough(info, 'below_threshold');
            processedExisting.push(blk);
            continue;
          }
          // Lossless whitespace compaction — same dynamics as the system
          // slab: every newline costs ≥1 visual row regardless of column
          // width, so stripped trailing whitespace + collapsed blank-line
          // runs reduce real renderer cost without changing what the
          // model reads.
          const reminderRaw = (blk as TextBlock).text;
          const reminderText = maybeReflow(compactSlabWhitespace(reminderRaw), o.reflow);
          if (!isCompressionProfitable(reminderText, o.cols, undefined, numCols, o.charsPerToken, 0)) {
            // Above threshold but image cost ≥ text cost. Net loss to compress.
            bumpPassthrough(info, 'not_profitable');
            processedExisting.push(blk);
            continue;
          }
          const { blocks: imgs, droppedChars, droppedCodepoints: dcp, pixels } =
            await textToImageBlocks(reminderText, o.cols, numCols);
          // Preserve any cache_control the caller set on this text block by
          // re-attaching it to the LAST produced image (cache anchors at the
          // end of the content). pixelpipe never adds new markers — only
          // moves existing ones across the text→image flip (Task #21).
          const srcCacheControl = (blk as { cache_control?: unknown }).cache_control;
          for (let i = 0; i < imgs.length; i++) {
            const img = imgs[i]!;
            const out =
              i === imgs.length - 1 && srcCacheControl !== undefined
                ? { ...img, cache_control: srcCacheControl }
                : img;
            processedExisting.push(out as ImageBlock);
            info.imageBytes += approxBlockBytes(img);
          }
          info.imagePixels = (info.imagePixels ?? 0) + pixels;
          info.reminderImgs = (info.reminderImgs ?? 0) + imgs.length;
          // Credit raw length — billed equivalent if compression were off.
          info.compressedChars += reminderRaw.length;
          // Phase 1 (Task #18): reminders are a distinct content shape from
          // the static slab (per-turn re-injected, JSON-light, prose-heavy);
          // attribute them to their own bucket so cpt can drift independently.
          bumpBucket(info, 'reminder', reminderRaw.length);
          info.imageCount += imgs.length;
          info.droppedChars = (info.droppedChars ?? 0) + droppedChars;
          for (const [cp, n] of dcp) {
            droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + n);
          }
        }
      } else {
        processedExisting.push(...existing);
      }

      // Cache-friendly layout:
      //   [image block(s)]                   ← static; LAST has cache_control
      //                                          ↑ cache breakpoint
      //                                          (OCR framing is rendered
      //                                           INTO the image — no
      //                                           standalone intro TextBlock)
      //   [End of rendered context.]         ← static text closer for the image
      //   [processed existing content]       ← per-turn (incl. reminder images,
      //                                          which have NO cache_control)
      m.content = [
        ...imageBlocks,
        { type: 'text' as const, text: '[End of rendered context.]' },
        ...processedExisting,
      ];
    }

    // 5b. tool_result compression — walks ALL user messages (not just the
    // first). Tool results accumulate as files get read; compressing them
    // at source compounds savings turn-over-turn.
    if (o.compressToolResults) {
      for (const msg of req.messages ?? []) {
        if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
        const rewritten: ContentBlock[] = [];
        let changed = false;
        for (const blk of msg.content) {
          if (blk && (blk as ToolResultBlock).type === 'tool_result') {
            const tr = blk as ToolResultBlock;
            // Anthropic rejects images inside is_error tool_results — leave alone.
            if (tr.is_error === true) {
              rewritten.push(blk);
              continue;
            }
            const innerRaw = tr.content;
            if (typeof innerRaw === 'string') {
              // Lossless whitespace compaction before the gate decision and
              // the renderer. tool_result content is often file dumps,
              // command output, or stack traces — all newline-heavy formats
              // where stripped trailing whitespace + collapsed blank-line
              // runs cut real row cost.
              const inner = compactSlabWhitespace(innerRaw);
              // R3: gate, page, and render on the reflowed text. `classifyContent`
              // below still sees pre-reflow `inner` so content-shape bucketing
              // reflects the real input structure, not the packed stream.
              const innerR = maybeReflow(inner, o.reflow);
              if (innerR.length < o.minToolResultChars) {
                bumpPassthrough(info, 'below_threshold');
                rewritten.push(blk);
              } else if (!isCompressionProfitable(innerR, o.cols, o.maxImagesPerToolResult, numCols, o.charsPerToken)) {
                bumpPassthrough(info, 'not_profitable');
                rewritten.push(blk);
              } else {
                // Paging: truncate before render if it would blow the image cap.
                const paged = truncateForBudget(innerR, o.maxImagesPerToolResult, o.cols, numCols);
                if (paged.truncated) {
                  info.truncatedToolResults = (info.truncatedToolResults ?? 0) + 1;
                  info.omittedChars = (info.omittedChars ?? 0) + paged.omittedChars;
                }
                const { blocks: imgs, droppedChars, droppedCodepoints: dcp, pixels } =
                  await textToImageBlocks(paged.text, o.cols, numCols);
                for (const img of imgs) info.imageBytes += approxBlockBytes(img);
                info.imagePixels = (info.imagePixels ?? 0) + pixels;
                info.toolResultImgs = (info.toolResultImgs ?? 0) + imgs.length;
                info.imageCount += imgs.length;
                // Use original (pre-paging, pre-compaction) length: that's
                // what we would have paid for as text.
                info.compressedChars += innerRaw.length;
                info.droppedChars = (info.droppedChars ?? 0) + droppedChars;
                for (const [cp, n] of dcp) {
                  droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + n);
                }
                rewritten.push({ ...tr, content: imgs });
                changed = true;
                // Phase 1 (Task #18): bucket tool_result text by content shape
                // so structured (JSON/YAML/diff), log, and prose can each track
                // their own marginal cpt. Use the post-compaction text since
                // that matches what the gate evaluated and what got imaged.
                bumpBucket(info, toolResultBucket(classifyContent(inner)), innerRaw.length);
              }
            } else if (Array.isArray(innerRaw)) {
              const newInner: Array<TextBlock | ImageBlock> = [];
              let innerChanged = false;
              for (const ib of innerRaw) {
                const isTextBlock =
                  ib &&
                  (ib as TextBlock).type === 'text' &&
                  typeof (ib as TextBlock).text === 'string';
                if (!isTextBlock) {
                  newInner.push(ib as TextBlock | ImageBlock);
                  continue;
                }
                const innerTextRaw = (ib as TextBlock).text;
                // Lossless whitespace compaction before gate + render.
                const innerText = compactSlabWhitespace(innerTextRaw);
                // R3: gate/page/render on reflowed text; classify pre-reflow.
                const innerTextR = maybeReflow(innerText, o.reflow);
                if (innerTextR.length < o.minToolResultChars) {
                  bumpPassthrough(info, 'below_threshold');
                  newInner.push(ib as TextBlock | ImageBlock);
                  continue;
                }
                if (!isCompressionProfitable(innerTextR, o.cols, o.maxImagesPerToolResult, numCols, o.charsPerToken)) {
                  bumpPassthrough(info, 'not_profitable');
                  newInner.push(ib as TextBlock | ImageBlock);
                  continue;
                }
                const paged = truncateForBudget(innerTextR, o.maxImagesPerToolResult, o.cols, numCols);
                if (paged.truncated) {
                  info.truncatedToolResults = (info.truncatedToolResults ?? 0) + 1;
                  info.omittedChars = (info.omittedChars ?? 0) + paged.omittedChars;
                }
                const { blocks: imgs, droppedChars, droppedCodepoints: dcp, pixels } =
                  await textToImageBlocks(paged.text, o.cols, numCols);
                // Preserve any cache_control the caller set on this inner
                // text block (inside a tool_result) by re-attaching it to the
                // LAST produced image. pixelpipe never adds new markers (Task #21).
                const srcCacheControl = (ib as { cache_control?: unknown }).cache_control;
                for (let i = 0; i < imgs.length; i++) {
                  const img = imgs[i]!;
                  const out =
                    i === imgs.length - 1 && srcCacheControl !== undefined
                      ? { ...img, cache_control: srcCacheControl }
                      : img;
                  newInner.push(out as ImageBlock);
                  info.imageBytes += approxBlockBytes(img);
                }
                info.imagePixels = (info.imagePixels ?? 0) + pixels;
                info.toolResultImgs = (info.toolResultImgs ?? 0) + imgs.length;
                info.imageCount += imgs.length;
                // Credit raw length — billed equivalent if compression were off.
                info.compressedChars += innerTextRaw.length;
                info.droppedChars = (info.droppedChars ?? 0) + droppedChars;
                for (const [cp, n] of dcp) {
                  droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + n);
                }
                // Phase 1 (Task #18): per-block bucket attribution — same as
                // the string tool_result path. Each text block inside a
                // multi-block tool_result classifies on its own content.
                bumpBucket(info, toolResultBucket(classifyContent(innerText)), innerTextRaw.length);
                innerChanged = true;
              }
              if (innerChanged) {
                rewritten.push({ ...tr, content: newInner });
                changed = true;
              } else {
                rewritten.push(blk);
              }
            } else {
              rewritten.push(blk);
            }
          } else {
            rewritten.push(blk);
          }
        }
        if (changed) msg.content = rewritten;
      }
    }
  }

  if (toolsRewritten) req.tools = toolsRewritten;

  // 6. Variant C history-image compression. ALWAYS-ON, unconditional.
  // Runs AFTER all per-message rewrites so the collapsed prefix reflects
  // final state. Walks messages[] tracking open tool_use_ids; collapses
  // the largest closed-prefix run into one prepended synthetic user
  // message. Live tail (HISTORY_DEFAULTS.keepTail turns + anything in an
  // open tool sequence) stays as text. History image carries NO
  // cache_control — the static-slab breakpoint remains pixelpipe's sole
  // breakpoint.
  //
  // The per-block break-even gate (`isCompressionProfitable`) is passed
  // numCols=1 + the request's charsPerToken so its row-aware estimate
  // matches the single-col `renderTextToPngs` exactly. This closes the
  // 2026-05-19 -250% measurement gap: the old call passed `text.length`
  // (number → loose chars-only estimate) which under-counted images by
  // 5-10× on newline-heavy history text and let net-losers through.
  if (Array.isArray(req.messages) && req.messages.length > 0) {
    // Closure that gives the row-aware gate the same numCols/cpt context
    // the renderer will use. History is single-col; pinning numCols=1
    // here makes the gate decision identical to the renderer's image
    // count after wrapping.
    // History cpt is empirically ~1.09 (N=10 rejected-events sample) — JSON-
    // dense like the slab, so use the same conservative upper-bound cpt
    // baked into HISTORY_CHARS_PER_TOKEN=2.0. Host override (opts.charsPerToken)
    // wins if the dashboard ever feeds back a live empirical fit.
    // Same discriminator as the slab path: check the *raw* `opts` so a host
    // that genuinely wants `4` can pin to it without colliding with the merged
    // default.
    const historyCpt = opts.charsPerToken !== undefined
      ? o.charsPerToken
      : HISTORY_CHARS_PER_TOKEN;
    const horizon = Math.max(1, Math.floor(o.historyAmortizationHorizon));
    // Pass the symmetric warm-cache burn through to the history-collapse
    // gate as well. The slab gate alone got the symmetric treatment, which
    // let the history gate flip a session out of image mode even when
    // symmetric burn would have kept the slab gate in. Production data
    // 2026-05-23 showed three-turn sessions paying cache_create every
    // turn because the history gate ignored priorWarmImageTokens.
    const historyProfitable = (text: string, cols: number): boolean =>
      isCompressionProfitableAmortized(
        text, cols, undefined, 1, historyCpt, horizon,
        o.priorWarmTokens, o.priorWarmImageTokens,
      );
    const { messages: newMessages, info: histInfo } = await collapseHistory(
      req.messages,
      historyProfitable,
      { cols: o.cols },
    );
    if (histInfo.collapsedTurns > 0) {
      req.messages = newMessages;
      info.collapsedTurns = histInfo.collapsedTurns;
      info.collapsedChars = histInfo.collapsedChars;
      info.collapsedImages = histInfo.collapsedImages;
      info.imageCount += histInfo.collapsedImages;
      info.imageBytes += histInfo.collapsedImageBytes;
      info.imagePixels = (info.imagePixels ?? 0) + histInfo.collapsedImagePixels;
      info.droppedChars = (info.droppedChars ?? 0) + histInfo.droppedChars;
      for (const [cp, n] of histInfo.droppedCodepoints) {
        droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + n);
      }
      info.historyReason = 'collapsed';
      // Phase 1 (Task #18): per-bucket char attribution. History gets its
      // own bucket because it runs on JSON-dense prose at a different cpt
      // from system slabs and tool_results. The chars that fed the history
      // renderer are exactly what `collapsedChars` already tracks.
      info.historyTextChars = histInfo.collapsedChars;
      info.historyImageSha = await historyImageSha8(newMessages);
      bumpBucket(info, 'history', histInfo.collapsedChars);
    } else if (histInfo.reason) {
      info.historyReason = histInfo.reason;
    }
  }

  info.compressed = true;
  // Serialize the top dropped codepoints (if any) as `U+HHHH` → count. Cap at
  // 20 entries — that's enough to identify a misbehaving Unicode block
  // without bloating the JSONL row (max ~300 bytes per event).
  if (droppedCodepoints.size > 0) {
    const TOP_N = 20;
    const sorted = [...droppedCodepoints.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N);
    const out: Record<string, number> = {};
    for (const [cp, count] of sorted) {
      const hex = cp.toString(16).toUpperCase().padStart(4, '0');
      out[`U+${hex}`] = count;
    }
    info.droppedCodepointsTop = out;
  }
  // Empirical-cost telemetry: count every char of TEXT remaining in the
  // outgoing body (system text blocks + every TextBlock across messages).
  // Pairs with `imagePixels` and the upstream usage so a regression over
  // N cold-miss events solves `tokens ≈ α·outgoingTextChars + β·imagePixels`
  // for the empirical chars/token and pixels/token under the live model.
  info.outgoingTextChars = countOutgoingTextChars(req);
  const outBody = new TextEncoder().encode(JSON.stringify(req));
  return { body: outBody, info };
}

/** Walk the outgoing transformed request body and sum the length of every
 *  char the upstream tokenizer will see as text. Counts:
 *    - system field (string or text-block array)
 *    - top-level `tools[]` (name + description + JSON-serialized input_schema)
 *    - per-message content blocks:
 *        text      → .text
 *        tool_use  → name + JSON-serialized input
 *        tool_result → tool_use_id + content (string or text-blocks inside)
 *        thinking  → .thinking  (extended-thinking blocks, Opus/Sonnet 4.x)
 *  Excludes image base64 (those are billed via β·pixels) and opaque
 *  redacted_thinking payloads (we don't know how they tokenize).
 *
 *  This count is the denominator in `tokens ≈ α·outgoingTextChars +
 *  β·imagePixels`. Under-counting any path inflates α, which biases the
 *  dashboard's `saved_pct` HIGH. The blocks added beyond plain `text` —
 *  especially `tools[]` and `tool_use.input` — carry a large fraction of
 *  the chars in a real Claude Code request. */
function countOutgoingTextChars(req: MessagesRequest): number {
  let n = 0;

  // 1. system field
  const sys = req.system;
  if (typeof sys === 'string') {
    n += sys.length;
  } else if (Array.isArray(sys)) {
    for (const b of sys) {
      if (b && (b as TextBlock).type === 'text' && typeof (b as TextBlock).text === 'string') {
        n += (b as TextBlock).text.length;
      }
    }
  }

  // 2. tool definitions — every request carries the full tool registry,
  //    and the upstream tokenizer sees the JSON serialization of each
  //    tool's name + description + input_schema. This is a large
  //    constant-ish chunk in Claude Code traffic (~15-20 tools).
  if (Array.isArray(req.tools)) {
    for (const tool of req.tools) {
      if (!tool || typeof tool !== 'object') continue;
      if (typeof tool.name === 'string') n += tool.name.length;
      if (typeof tool.description === 'string') n += tool.description.length;
      if (tool.input_schema !== undefined) {
        n += safeStringifyLen(tool.input_schema);
      }
    }
  }

  // 3. per-message content
  for (const msg of req.messages ?? []) {
    const c = msg.content;
    if (typeof c === 'string') {
      n += c.length;
      continue;
    }
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      const type = (b as { type?: string }).type;

      if (type === 'text') {
        const tb = b as TextBlock;
        if (typeof tb.text === 'string') n += tb.text.length;
        continue;
      }

      // Assistant turns issuing a tool call: name + serialized input.
      // `input` is arbitrary JSON; tokenizer sees its serialization.
      if (type === 'tool_use') {
        const tu = b as ToolUseBlock;
        if (typeof tu.name === 'string') n += tu.name.length;
        if (tu.input !== undefined) n += safeStringifyLen(tu.input);
        continue;
      }

      if (type === 'tool_result') {
        const tr = b as ToolResultBlock;
        if (typeof tr.tool_use_id === 'string') n += tr.tool_use_id.length;
        const inner = tr.content;
        if (typeof inner === 'string') {
          n += inner.length;
        } else if (Array.isArray(inner)) {
          for (const ib of inner) {
            if (ib && (ib as TextBlock).type === 'text' && typeof (ib as TextBlock).text === 'string') {
              n += (ib as TextBlock).text.length;
            }
          }
        }
        continue;
      }

      // Extended-thinking blocks: { type: 'thinking', thinking: string, ... }
      // Not in our local types yet (we don't rewrite them), but they carry
      // real characters that the upstream tokenizer sees.
      if (type === 'thinking') {
        const th = b as unknown as { thinking?: unknown };
        if (typeof th.thinking === 'string') n += (th.thinking as string).length;
        continue;
      }

      // image, redacted_thinking, server_tool_use, etc. — skip. Either
      // billed via pixels (image) or opaque to us (redacted_thinking).
    }
  }

  return n;
}

/** JSON.stringify, but tolerant of cycles / non-serializable values.
 *  We only care about the LENGTH; if it blows up we just return 0 rather
 *  than crash the whole transform. */
function safeStringifyLen(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}
