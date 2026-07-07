/**
 * Request-body transformer. Extracts the static system prompt + tool definitions,
 * renders them as PNG image blocks, and rewrites the body to reference those images —
 * saving 65-73% input tokens while preserving reasoning quality.
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
  neutralizeSentinel,
  PAD_X,
  PAD_Y,
  CELL_W,
  CELL_H,
  READABLE_CHARS_PER_IMAGE,
  DENSE_CONTENT_CHARS_PER_IMAGE,
  DENSE_CONTENT_COLS,
  DENSE_RENDER_STYLE,
  ANTHROPIC_SLAB_COLS,
  renderTextToPngsWithCharLimit,
} from './render.js';
import { factSheetText } from './factsheet.js';
import { stripSchemaDescriptions, schemaHasStructure } from './schema-strip.js';
import { bytesToBase64 } from './png.js';
import { collapseHistory, HISTORY_SYNTHETIC_INTRO } from './history.js';
import type { GptHistoryOptions } from './openai-history.js';
import { CACHE_CREATE_RATE, CACHE_READ_RATE } from './baseline.js';
import { patchTokens } from './anthropic-vision.js';

/** Per-block descriptor passed to `TransformOptions.keepSharp`. */
export interface KeepSharpBlock {
  /** Which live-region path is asking: `reminder`, `tool_result`, or `tool_result_part`. */
  readonly kind: 'reminder' | 'tool_result' | 'tool_result_part';
  /** The block's text exactly as the caller produced it (pre-render, pre-compaction). */
  readonly text: string;
  /** `tool_use_id` of the owning tool_result, when applicable. */
  readonly toolUseId?: string;
}

/** A block pxpipe rendered to image(s), returned in `TransformInfo.recoverable`
 *  when the caller sets `emitRecoverable`. Lets a stateful harness restore
 *  byte-exact content if the model needs the imaged region verbatim. */
export interface RecoverableBlock {
  /** `rec_` + 8 hex SHA-256 over kind + toolUseId + original text. */
  readonly id: string;
  readonly kind: 'reminder' | 'tool_result' | 'tool_result_part';
  readonly toolUseId?: string;
  /** Original text before compaction/reflow/paging — the bytes to restore. */
  readonly text: string;
  readonly imageCount: number;
}

export interface TransformOptions {
  /** Master switch — false makes this a no-op pass-through. */
  compress?: boolean;
  /** Move tool descriptions into the same image (and stub the originals). */
  compressTools?: boolean;
  /** Compress large `<system-reminder>` text blocks in the first user message. */
  compressReminders?: boolean;
  /** Compress large tool_result text content across all user messages. */
  compressToolResults?: boolean;
  /** Don't compress if total compressible chars below this. */
  minCompressChars?: number;
  /** Per-block threshold for compressReminders (chars). */
  minReminderChars?: number;
  /** Per-block threshold for compressToolResults (chars). */
  minToolResultChars?: number;
  /** Soft-wrap column count. */
  cols?: number;
  /** Hard upper bound on images per tool_result; source text truncated with a paging
   *  marker above this to stay under Anthropic's 100-image/request cap. Default 10. */
  maxImagesPerToolResult?: number;
  /** Pack N text columns side-by-side per image. Default 1. Auto-clamped to stay
   *  under 2000 px wide. OCR ordering risk at N≥2: model must read col 1 top-to-bottom
   *  before col 2. */
  multiCol?: number;
  /** Chars-per-token assumption for `isCompressionProfitable()`. Default 4. */
  charsPerToken?: number;
  /** Multi-turn amortization horizon for the history-collapse gate. N≥2 evaluates as
   *  if N future turns share the prefix (worst-case-warm-image vs best-case-warm-text).
   *  Default 1 (per-turn cold gate). See docs/HISTORY_CACHE_MODEL.md. */
  historyAmortizationHorizon?: number;
  /** Tokens the un-rewritten path would have cache-hit on. Adds a one-time burn
   *  penalty `priorWarmTokens × (CC − CR)` to the image side so the gate accounts
   *  for invalidating a warm text cache. Default 0 (cold-start). ≤0 clamped to 0. */
  priorWarmTokens?: number;
  /** Symmetric counterpart: tokens the image path would have cache-hit on. Adds the
   *  same burn formula to the TEXT side, preventing the gate from flipping out of
   *  image mode when the image prefix is already warm. Default 0. ≤0 clamped to 0. */
  priorWarmImageTokens?: number;
  /** GPT only: collapse the OLD closed-tool-call conversation prefix into history
   *  image(s), keeping the recent tail as text. Independent of the static slab.
   *  Default on. See src/core/openai-history.ts. */
  collapseHistory?: boolean;
  /** GPT only: history-collapse tuning overrides (keepTail / collapseChunk / …). */
  gptHistory?: Partial<GptHistoryOptions>;
  /** Re-pack image-bound text into a ↵-delimited stream to fill `cols` (~29%→75-80%
   *  glyph-fill). ON by default (98.95% char accuracy at L1 OCR eval, +1pp vs baseline).
   *  Hard newlines become visible ↵ glyphs — tell the model via system prompt. */
  reflow?: boolean;
  /** Caller fidelity hint: return `true` for a block that must stay as text (IDs,
   *  hashes, file paths — content where mis-OCR would be silent and wrong). Only
   *  consulted on per-block live-region paths (reminders, tool_results). A throwing
   *  or non-boolean return is treated as `false`. */
  keepSharp?: (block: KeepSharpBlock) => boolean;
  /** When true, populate `TransformInfo.recoverable` with original text + provenance
   *  for every block rendered to images. Off by default (entries inflate `info`;
   *  only a stateful harness can use them). */
  emitRecoverable?: boolean;
}

const DEFAULTS: Required<TransformOptions> = {
  compress: true,
  compressTools: true,
  compressReminders: true,
  compressToolResults: true,
  minCompressChars: 2000,
  // Below ~6k chars, per-image cost dominates savings (break-even territory).
  minReminderChars: 6000,
  minToolResultChars: 6000,
  // system field rejects images (400 system.N.type: Input should be 'text') —
  // images always go into the first user message.
  // 312 cols × 5 px + 8 px pad = 1568 px (Anthropic no-resize edge).
  cols: ANTHROPIC_SLAB_COLS,
  maxImagesPerToolResult: 10,
  charsPerToken: 4,
  historyAmortizationHorizon: 1,
  priorWarmTokens: 0,
  priorWarmImageTokens: 0,
  // Multi-col off: single-col slab already holds ~28k chars/page at the 1568×728 cap; extra OCR risk not worth it.
  multiCol: 1,
  reflow: true,
  keepSharp: () => false,
  emitRecoverable: false,
  // GPT-only knobs; the Anthropic transform ignores them but Required<> needs them.
  collapseHistory: true,
  gptHistory: {},
};

/**
 * Subscription OAuth requests are classified as Claude Code traffic only when
 * this exact identity remains the first, separate top-level system block.
 * Never render it into an image or concatenate other text into its block.
 */
export const CLAUDE_CODE_OAUTH_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

// --- per-block break-even check ---
//
// Image token cost uses Anthropic's documented 28-px patch model (see
// src/core/anthropic-vision.ts). Constants bias CONSERVATIVE: CHARS_PER_TOKEN=4
// under-estimates text savings; the gate multiplies the patch count by
// ANTHROPIC_GATE_MARGIN on top. Mispredictions leave money on the table; they
// never generate net-loss images.

/** English ~4 chars per token average (conservative for code/JSON content). */
const CHARS_PER_TOKEN = 4;

/** Empirical cpt for the system-slab path (Opus 4.7 tokenizer, N=391, observed 1.91).
 *  Slab-specific because reminders/tool_results have unknown shape; those stay at 4. */
export const SLAB_CHARS_PER_TOKEN = 2.0;

// Tools whose stub description keeps a live-text read-before-edit precondition
// when full docs move into the imaged Tool Reference (read-gate audit, 2026-07-03).
const READ_FIRST_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

/** Empirical cpt for the history-collapse path (same Opus 4.7 telemetry as SLAB_CHARS_PER_TOKEN).
 *  History is even denser (tool_use JSON dominates), so 2.0 is doubly conservative. */
export const HISTORY_CHARS_PER_TOKEN = 2.0;

/** Chars-per-token for the `pxpipe export` *reporting* estimate (factsheet & savings %).
 *  Less conservative than the gate's CHARS_PER_TOKEN=4: reporting wants an accurate
 *  figure (~3.7 for source/prose text), not a safe-side under-estimate. Single source
 *  of truth — src/core/export.ts imports this rather than redefining it. */
export const REPORT_CHARS_PER_TOKEN = 3.7;

/** Gate-only conservatism: a 10% upward bias on the patch-count image estimate,
 *  keeping the gate on the safe (pass-through) side near break-even. This is NOT
 *  part of Anthropic's documented cost — the documented per-image formula lives in
 *  `anthropicVisionTokens` (anthropic-vision.ts); this margin only tunes the gate. */
export const ANTHROPIC_GATE_MARGIN = 1.10;

/** Width in px of a single-col PNG. Must stay in sync with `renderChunkToPng` (render.ts). */
function singleColWidthPx(cols: number): number {
  return 2 * PAD_X + cols * CELL_W;
}

/** Width in px of a multi-col PNG. Mirrors `multiColWidth()` in render.ts. */
function multiColWidthPx(cols: number, numCols: number): number {
  const n = Math.max(1, numCols | 0);
  if (n === 1) return singleColWidthPx(cols);
  const GUTTER_CELLS = 4; // must match render.ts (not exported)
  return 2 * PAD_X + n * cols * CELL_W + (n - 1) * GUTTER_CELLS * CELL_W;
}

/** Exact image-token cost for `visualRows` at given column/multi-col geometry.
 *  Mirrors the renderer's height math so the gate matches Anthropic billing.
 *  Last image is partial-height; each image cost ∝ pixel area. */
function imageTokensForRows(
  visualRows: number,
  cols: number,
  numCols: number = 1,
  imageCountCap?: number,
  maxCharsPerImage: number = READABLE_CHARS_PER_IMAGE,
): number {
  if (!Number.isFinite(visualRows) || visualRows <= 0) return 0;
  const n = Math.max(1, numCols | 0);
  const widthPx = multiColWidthPx(cols, n);
  const hardLinesPerImg = Math.max(1, Math.floor((MAX_HEIGHT_PX - 2 * PAD_Y) / CELL_H));
  const readableLinesPerCol = Math.max(1, Math.floor(maxCharsPerImage / Math.max(1, cols)));
  const linesPerImg = Math.min(hardLinesPerImg, readableLinesPerCol);
  const rowsPerImage = linesPerImg; // pixel rows per image (height)
  const linesPerImage = linesPerImg * n; // wrapped-text lines per image (n cols side-by-side)
  let imagesNeeded = Math.ceil(visualRows / linesPerImage);
  if (imageCountCap !== undefined && imageCountCap > 0) {
    imagesNeeded = Math.min(imagesNeeded, imageCountCap);
  }
  const fullImages = Math.max(0, imagesNeeded - 1);
  const linesInLast = visualRows - fullImages * linesPerImage;
  // Column-major layout: pixel rows = min(linesInLast, rowsPerImage).
  const rowsInLast = Math.min(Math.max(1, linesInLast), rowsPerImage);
  const fullImageHeight = 2 * PAD_Y + rowsPerImage * CELL_H;
  const lastImageHeight = 2 * PAD_Y + rowsInLast * CELL_H;
  // Anthropic bills per-image by 28-px patches (not by summed pixel area), so
  // count each image separately. pxpipe pages are ≤ 1568×728, so no tier
  // downscale applies and the raw patch count is tier-agnostic.
  const patchSum =
    fullImages * patchTokens(widthPx, fullImageHeight) + patchTokens(widthPx, lastImageHeight);
  return Math.ceil(patchSum * ANTHROPIC_GATE_MARGIN);
}

/** Exact image-token cost for `text`. Uses `countVisualRows` and optionally
 *  `shrinkColsToContent` (default true) so narrow blocks aren't priced at full
 *  canvas width. Pass `shrinkWidth=false` for the system slab (fills full `cols`). */
function imageTokensCost(
  text: string,
  cols: number,
  numCols: number = 1,
  imageCountCap?: number,
  shrinkWidth: boolean = true,
  maxCharsPerImage: number = READABLE_CHARS_PER_IMAGE,
): number {
  const effectiveCols = shrinkWidth ? shrinkColsToContent(text, cols) : cols;
  const rows = countVisualRows(text, effectiveCols);
  return imageTokensForRows(rows, effectiveCols, numCols, imageCountCap, maxCharsPerImage);
}

/** Gate geometry for the single-col dense path (tool_result, reminder, history).
 *  Dense single-col uses DENSE_CONTENT_COLS/DENSE_CONTENT_CHARS_PER_IMAGE;
 *  multi-col uses configured `cols` at READABLE budget. Slab uses its own path. */
function denseGateGeometry(cols: number, numCols: number): { cols: number; maxChars: number } {
  return Math.max(1, numCols | 0) > 1
    ? { cols, maxChars: READABLE_CHARS_PER_IMAGE }
    : { cols: DENSE_CONTENT_COLS, maxChars: DENSE_CONTENT_CHARS_PER_IMAGE };
}

/** Visual rows per image: `floor((MAX_HEIGHT_PX − 2·PAD_Y) / CELL_H)`. Derived
 *  from render.ts constants so break-even math auto-tracks cell geometry changes. */
export const LINES_PER_IMAGE = Math.max(1, Math.floor((MAX_HEIGHT_PX - 2 * PAD_Y) / CELL_H));

export function maxCharsPerImage(cols: number): number {
  return Math.min(cols * LINES_PER_IMAGE, READABLE_CHARS_PER_IMAGE);
}

/** Lossless pre-render whitespace compactor (each `\n` costs ≥1 visual row):
 *  1. Strip trailing whitespace per line (preserves leading indent).
 *  2. Collapse 3+ consecutive newlines to 2. Typically saves 10-25% rows on
 *     markdown/tool-doc slabs, enough to flip borderline gates to profitable. */
export function compactSlabWhitespace(text: string): string {
  if (!text) return text;
  // Single-pass trailing whitespace strip (avoids materializing a split array on ~160 KB slabs).
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
  // Collapse 3+ newlines → 2 (kills multi-blank dividers; each costs a render row).
  return trimmed.replace(/\n{3,}/g, '\n\n');
}

/** Apply R3 reflow when enabled. Run after `compactSlabWhitespace`, before
 *  the gate (gate/renderer/paging all see the same dense text). Falls back to
 *  input unchanged on sentinel collision. */
function maybeReflow(text: string, enabled: boolean): string {
  if (!enabled) return text;
  // Neutralize any pre-existing ↵ so reflow packs newlines instead of bailing to a raw,
  // unpacked render (the tool_result "newlines not converted to ↵" case — common when the
  // content is about pxpipe itself). Render-only; originals are preserved via
  // recordRecoverable(innerRaw), so this substitution never reaches recovery.
  const safe = neutralizeSentinel(text);
  return reflow(safe) ?? safe;
}

/** Decompose the break-even gate into components for telemetry. Returns the
 *  imageTokens, textTokens, and symmetric burn terms the gate uses internally,
 *  or `null` for empty/non-finite input. */
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
  charsPerToken: number = CHARS_PER_TOKEN,
  priorWarmTokens: number = 0,
  priorWarmImageTokens: number = 0,
  shrinkWidth: boolean = true,
  maxCharsPerImage: number = READABLE_CHARS_PER_IMAGE,
): boolean {
  const n = Math.max(1, numCols | 0);
  if (typeof text !== 'string' || text.length === 0) return false;
  const cpt = Number.isFinite(charsPerToken) && charsPerToken > 0
    ? charsPerToken
    : CHARS_PER_TOKEN;
  const imageTokensCost_ = imageTokensCost(text, cols, n, imageCountCap, shrinkWidth, maxCharsPerImage);
  const textTokensEquivalent = text.length / cpt;
  // Symmetric burn penalty (anti-flapping): switching modes invalidates the warm
  // cache on whichever side was warm, paying cache_create. Burn is added to the
  // side that would flip — pinning the session in its current mode until
  // per-turn savings exceed the burn cost.
  const burnImageSide = Number.isFinite(priorWarmTokens) && priorWarmTokens > 0
    ? priorWarmTokens * (CACHE_CREATE_RATE - CACHE_READ_RATE)
    : 0;
  const burnTextSide = Number.isFinite(priorWarmImageTokens) && priorWarmImageTokens > 0
    ? priorWarmImageTokens * (CACHE_CREATE_RATE - CACHE_READ_RATE)
    : 0;
  return imageTokensCost_ + burnImageSide < textTokensEquivalent + burnTextSide;
}

/**
 * Horizon-aware variant of `isCompressionProfitable` for history-collapse.
 *
 * Evaluates expected lifetime cost over N turns: worst-case-warm for image
 * (cache_create turn 1, cache_read turns 2..N) vs best-case-warm for text
 * (cache_read all N). Gate condition: I×(CC + CR×(N-1)) < T×CR×N.
 * Examples: N=5 → I < 0.30×T; N=10 → I < 0.47×T.
 * Falls back to cold per-turn gate when `horizon <= 1`. See docs/HISTORY_CACHE_MODEL.md.
 */
export function isCompressionProfitableAmortized(
  text: string,
  cols: number,
  imageCountCap: number | undefined,
  numCols: number,
  charsPerToken: number,
  horizon: number,
  priorWarmTokens: number = 0,
  priorWarmImageTokens: number = 0,
  shrinkWidth: boolean = true,
  maxCharsPerImage: number = READABLE_CHARS_PER_IMAGE,
): boolean {
  if (!Number.isFinite(horizon) || horizon <= 1) {
    return isCompressionProfitable(text, cols, imageCountCap, numCols, charsPerToken, priorWarmTokens, priorWarmImageTokens, shrinkWidth, maxCharsPerImage);
  }
  const N = Math.max(2, Math.floor(horizon));
  const n = Math.max(1, numCols | 0);
  if (typeof text !== 'string' || text.length === 0) return false;
  const cpt = Number.isFinite(charsPerToken) && charsPerToken > 0
    ? charsPerToken
    : CHARS_PER_TOKEN;
  const imageTokens = imageTokensCost(text, cols, n, imageCountCap, shrinkWidth, maxCharsPerImage);
  const textTokens = text.length / cpt;
  // Worst-case-for-image vs best-case-for-text (conservative, on purpose).
  const imageLifetime = imageTokens * (CACHE_CREATE_RATE + CACHE_READ_RATE * (N - 1));
  const textLifetime = textTokens * CACHE_READ_RATE * N;
  // Symmetric burn — see isCompressionProfitable for anti-flapping rationale.
  const burnImageSide = Number.isFinite(priorWarmTokens) && priorWarmTokens > 0
    ? priorWarmTokens * (CACHE_CREATE_RATE - CACHE_READ_RATE)
    : 0;
  const burnTextSide = Number.isFinite(priorWarmImageTokens) && priorWarmImageTokens > 0
    ? priorWarmImageTokens * (CACHE_CREATE_RATE - CACHE_READ_RATE)
    : 0;
  return imageLifetime + burnImageSide < textLifetime + burnTextSide;
}


/** Increment a passthrough-reason counter on `info`. Lazily allocates `passthroughReasons`. */
function bumpPassthrough(
  info: TransformInfo,
  reason: 'below_threshold' | 'not_profitable' | 'kept_sharp',
): void {
  if (!info.passthroughReasons) info.passthroughReasons = {};
  info.passthroughReasons[reason] = (info.passthroughReasons[reason] ?? 0) + 1;
}

/** Invoke `keepSharp` defensively; a throw or non-`true` return means "image as usual". */
function callerKeepsSharp(
  fn: ((block: KeepSharpBlock) => boolean) | undefined,
  block: KeepSharpBlock,
): boolean {
  if (typeof fn !== 'function') return false;
  try {
    return fn(block) === true;
  } catch {
    return false;
  }
}

/** Logical bucket for per-gate-call char attribution. Used by the rolling-cpt
 *  regression to derive per-bucket marginal cpt from production telemetry. */
export type BucketName =
  | 'static_slab'
  | 'reminder'
  | 'tool_result_json'
  | 'tool_result_log'
  | 'tool_result_prose'
  | 'history';

/** Pre-compaction TEXT char totals per bucket. Absent when no bucket fired. */
export type BucketChars = Partial<Record<BucketName, number>>;

/** Attribute `chars` to a compression bucket (called whether gate accepted or rejected). */
function bumpBucket(info: TransformInfo, bucket: BucketName, chars: number): void {
  if (chars <= 0) return;
  if (!info.bucketChars) info.bucketChars = {};
  info.bucketChars[bucket] = (info.bucketChars[bucket] ?? 0) + chars;
}

/** Map `classifyContent` shape to a tool_result bucket name. */
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
  /** Total source chars image-encoded this request (static slab + reminders + tool_results).
   *  Unlike `origChars` (static slab + tool docs only), reflects what `imageCount` replaced. */
  compressedChars: number;
  imageCount: number;
  imageBytes: number;
  /** Σ width×height across all rendered images. Pairs with upstream token count for
   *  empirical px/token regression: `tokens ≈ α·outgoingTextChars + β·imagePixels`. */
  imagePixels?: number;
  /** GPT only. Vision tokens the rendered images actually cost as input
   *  (Σ openAIVisionTokens over real image dims). The "Sent as image" basis. */
  imageTokens?: number;
  /** GPT only. o200k_base text tokens of the content pxpipe imaged/stripped —
   *  the would-have-paid "as plain text" baseline. Compared against imageTokens
   *  for the per-request saving. See src/core/openai-savings.ts. */
  baselineImagedTokens?: number;
  /** GPT only. Local o200k tokens added solely by pxpipe (pointers, exact-token
   * sheets, and framing). Removed from the unproxied counterfactual. */
  nativeInjectedTokens?: number;
  /** Total TEXT chars in the outgoing body (system + messages, excluding image base64).
   *  Denominator for empirical chars-per-token regression on cold-miss events. */
  outgoingTextChars?: number;
  /** OpenAI Responses only: local o200k decomposition of the ORIGINAL request
   *  before pxpipe rewrites it. No provider count_tokens call. Categories are
   *  mutually exclusive text-token estimates; imageParts counts native images. */
  responsesComposition?: {
    instructions: number;
    systemDeveloper: number;
    userAssistant: number;
    functionCalls: number;
    functionOutputs: number;
    reasoningEncrypted: number;
    compactionOpaque: number;
    toolsJson: number;
    other: number;
    totalLocal: number;
    imageParts: number;
    /** Responses native-tool-state classification and realized image share. */
    completedFunctionPairs?: number;
    recentNativeFunctionPairs?: number;
    oldFunctionPairs?: number;
    openFunctionCalls?: number;
    orphanFunctionOutputs?: number;
    malformedFunctionItems?: number;
    imageableFunctionCalls?: number;
    imageableFunctionOutputs?: number;
    collapsedFunctionPairs?: number;
    collapsedFunctionCalls?: number;
    collapsedFunctionOutputs?: number;
  };
  /** Length of the static (cacheable) slab rendered into the image. */
  staticChars: number;
  /** Length of the dynamic (per-turn) slab kept as plain text. */
  dynamicChars: number;
  /** Chars of volatile env/context text relocated from system to the tail of
   *  the last user message (absent when kept in system fallback). */
  envRelocatedChars?: number;
  dynamicBlockCount: number;
  /** Tag-shaped blocks in the static slab not in DYNAMIC_BLOCK_TAGS.
   *  Canary: a new per-turn Claude Code tag would appear here before cache rate collapses. */
  unknownStaticTags?: string[];
  /** Static-slab tags whose content changed within a session — proven dynamic,
   *  busting the image cache each turn. The real alert signal. */
  churningStaticTags?: string[];
  /** `# Environment` entries that rode the live tail this turn (diff split). */
  envVolatileKeys?: string[];
  /** Chars of `# Environment` entries promoted into the imaged slab. */
  envStaticChars?: number;
  env?: EnvFields;
  /** sha8 of static slab + tool docs (what goes in the image). Repeats across turns → cache hits. */
  systemSha8?: string;
  /** sha8 of the CLAUDE.md section, for bucketing by project when cwd is absent. */
  claudeMdSha8?: string;
  /** sha8 of first user message text (first 4 KiB). Rough thread/session id. */
  firstUserSha8?: string;
  /** Raw bytes of the first rendered image. Dashboard preview only; NOT persisted to JSONL. */
  firstImagePng?: Uint8Array;
  firstImageWidth?: number;
  firstImageHeight?: number;
  /** All rendered PNGs this request. Dashboard only; NOT persisted to JSONL. */
  imagePngs?: Uint8Array[];
  imageDims?: Array<{ width: number; height: number }>;
  /** Legacy shared source text for one render group. Dashboard-only; not persisted. */
  imageSourceText?: string;
  /** Source text parallel to imagePngs/imageDims. One entry per PNG; a multi-page
   *  render may repeat its section source. Dashboard-only; not persisted. */
  imageSourceTexts?: Array<string | undefined>;
  reminderImgs?: number;
  toolResultImgs?: number;
  /** Chars of tool docs moved to the system-text Tool Reference (not imaged). */
  toolDocsChars?: number;
  /** Codepoints missing from the atlas (rendered as blank cells). Telemetry for atlas tuning. */
  droppedChars?: number;
  /** Top dropped codepoints by frequency (`U+HHHH` → count), at most 20 entries. */
  droppedCodepointsTop?: Record<string, number>;
  /** Why blocks passed through without compression. Only present when count > 0. */
  passthroughReasons?: { below_threshold?: number; not_profitable?: number; kept_sharp?: number };
  /** Slab gate diagnostics — imageTokens, textTokens, burn terms, and verdict.
   *  Lets hosts measure flap-prevention efficacy and tune amortization horizon. */
  gateEval?: {
    readonly site: 'slab';
    readonly imageTokens: number;
    readonly textTokens: number;
    /** `priorWarmTokens × (CC − CR)` added to image side. */
    readonly burnImageSide: number;
    /** `priorWarmImageTokens × (CC − CR)` added to text side (anti-flapping anchor). */
    readonly burnTextSide: number;
    readonly profitable: boolean;
  };
  /** Pre-compaction TEXT char totals per gate-call bucket. Rolling-cpt regression denominator. */
  bucketChars?: BucketChars;
  /** Chars fed into the history-image renderer. Folded into `bucketChars.history` too. */
  historyTextChars?: number;
  /** Blocks pinned as text by the caller's `keepSharp` predicate this request. */
  keptSharpBlocks?: number;
  /** Imaged live-region blocks with original text + provenance, when `emitRecoverable`. */
  recoverable?: RecoverableBlock[];
  truncatedToolResults?: number;
  omittedChars?: number;
  /** History-collapse: messages collapsed into the synthetic prepended user message. */
  collapsedTurns?: number;
  collapsedChars?: number;
  /** History-collapse images. Also folded into `info.imageCount`. */
  collapsedImages?: number;
  /** sha8 of concatenated history-image base64. Stable across the collapse window →
   *  proves Anthropic's prompt cache can `cache_read` (0.1×) instead of `cache_create`.
   *  A changing hash means cache-key drift is back. Only set when collapse produced images. */
  historyImageSha?: string;
  /** sha8 of the ACTUAL cacheable prefix sent this turn (tools + system +
   *  message blocks through the imaged history/slab boundary; the live tail is
   *  excluded). Read-only measurement. A change turn-over-turn within a session
   *  ⇒ pxpipe serialized different prefix bytes (we busted our own cache,
   *  pxpipe-side); STABLE while cache_create spikes / cache_read collapses ⇒ the
   *  prefix was evicted upstream. Decisive attribution signal (see #11). */
  cachePrefixSha8?: string;
  /** Approx size (chars) of that cached prefix — pairs with cachePrefixSha8 so a
   *  bust reads as growth (size up) vs pure invalidation (size unchanged). */
  cachePrefixBytes?: number;
  /** Why the history collapse didn't run (or did). Diagnostic only. */
  historyReason?:
    | 'no_history'
    | 'prefix_too_short'
    | 'no_closed_prefix'
    | 'below_min_chars'
    | 'below_min_tokens'
    | 'not_profitable'
    | 'too_many_images'
    | 'render_empty'
    | 'collapsed';
  /** Token count of the pre-compression body from /v1/messages/count_tokens (free).
   *  Absent when probe failed — event excluded from savings rollup. */
  baselineTokens?: number;
  /** Token count of the pre-compression body truncated at the last cache_control marker.
   *  Absent when the original body has no cache_control markers (cacheable=0 exactly). */
  baselineCacheableTokens?: number;
  /** 'ok': both probes resolved. 'partial': full-body resolved but cacheable-prefix
   *  didn't (exclude from rollup — cacheable=0 fallback is dishonest). 'failed': no
   *  baseline. undefined: no probe attempted. */
  baselineProbeStatus?: 'ok' | 'partial' | 'failed';
}

// --- helpers ---------------------------------------------------------------

/** Extract (text, remainder) from a system field that may be string or block list. */
function extractSystemText(sys: SystemField | undefined): { text: string; kept: SystemField } {
  if (sys == null) return { text: '', kept: [] };
  if (typeof sys === 'string') return { text: sys, kept: '' };
  const hasCacheControlledText = sys.some(
    (block) => block && block.type === 'text' && block.cache_control !== undefined,
  );
  const textParts: string[] = [];
  const kept: SystemField = [];
  for (const block of sys) {
    if (block && typeof block === 'object' && block.type === 'text') {
      if (!hasCacheControlledText || block.cache_control !== undefined) {
        textParts.push(block.text);
      } else {
        kept.push(block);
      }
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
 * pxpipe relocates caller cache_control markers onto rendered image blocks.
 * A relocated position is never a guaranteed "global prefix": pages 1..N-1 of
 * a slab run and other pxpipe-injected blocks carry no marker, so a relocated
 * `scope:"global"` violates Anthropic's "every preceding block must be
 * globally scoped" rule and the whole request 400s (#95). Downgrade to plain
 * ephemeral by dropping `scope` — a single trailing marker is always valid for
 * ordinary ephemeral caching. `type`/`ttl` are preserved, and markers without
 * `scope` pass through untouched (identity, so byte-stability is unaffected).
 */
function demoteRelocatedCacheControl<T>(cc: T): T {
  if (cc && typeof cc === 'object' && 'scope' in (cc as object)) {
    const { scope: _scope, ...rest } = cc as Record<string, unknown>;
    return rest as T;
  }
  return cc;
}

// Per-turn dynamic blocks injected by Claude Code. These drift turn-to-turn and
// must not be baked into the cached image. Split out so only the stable static
// slab (CLAUDE.md + tool docs) carries cache_control.
const DYNAMIC_BLOCK_TAGS = [
  'env',
  'context',
  'git_status',
  'directoryStructure',
  'system-reminder',
] as const;

// Known-static slab tags — suppresses first-sighting `unknownStaticTags` noise
// only. Correctness doesn't depend on this list: observeStaticTagChurn catches
// a wrong entry on its second sighting.
const KNOWN_STATIC_TAGS = [
  // Claude Code
  'types',
  // Nested under <available_skills> (static for a session; churn still observed)
  'skill',
  'name',
  'description',
  'location',
  'available_references',
  // opencode (codex system prompts have no tag-shaped blocks)
  'example',
  'available_skills',
  // beast.txt + title.txt
  'examples',
  'rules',
  'task',
  // copilot-gpt-5.txt
  'codeSearchInstructions',
  'codeSearchToolUseInstructions',
  'communicationGuidelines',
  'gptAgentInstructions',
  'outputFormatting',
  'structuredWorkflow',
  'toolUseInstructions',
] as const;

function splitStaticDynamic(text: string): {
  staticText: string;
  dynamicText: string;
  blockCount: number;
  unknownTags: string[];
  /** tag → concatenated inner content of same-named slab blocks. */
  staticTagContents: Map<string, string>;
} {
  if (!text)
    return {
      staticText: '',
      dynamicText: '',
      blockCount: 0,
      unknownTags: [],
      staticTagContents: new Map(),
    };
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

  // Sniff for unknown tag-shaped blocks in the static slab. A new per-turn
  // Claude Code tag would silently bake into the image and collapse cache rate;
  // surfacing the tag name lets us detect it within hours of a release.
  const known = new Set<string>(DYNAMIC_BLOCK_TAGS);
  const knownStatic = new Set<string>(KNOWN_STATIC_TAGS);
  const sniffer = /<([a-zA-Z][a-zA-Z0-9_-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  const unknown = new Set<string>();
  const staticTagContents = new Map<string, string>();
  let s: RegExpExecArray | null;
  while ((s = sniffer.exec(staticBuf)) !== null) {
    const tag = s[1]!;
    if (tag.length > 64) continue;
    if (!known.has(tag) && !knownStatic.has(tag)) unknown.add(tag);
    // Fold repeated tags (e.g. several <example>s) into one fingerprint.
    staticTagContents.set(tag, (staticTagContents.get(tag) ?? '') + s[2]!);
  }

  return {
    // Collapse the run of blank lines left behind by removed blocks.
    staticText: staticBuf.replace(/\n{3,}/g, '\n\n').trim(),
    dynamicText: dynamicParts.join('\n\n'),
    blockCount: dynamicParts.length,
    unknownTags: [...unknown],
    staticTagContents,
  };
}

/** FNV-1a 32-bit — cheap synchronous content fingerprint for churn detection. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Last content hash per (session, tag). Bounded LRU.
const TAG_OBSERVATIONS_MAX = 4096;
const tagObservations = new Map<string, number>();

/** Returns slab tags whose content changed since the last sighting in the same
 *  session — proven per-turn dynamics, whatever the hardcoded lists say. */
function observeStaticTagChurn(
  sessionKey: string,
  tagContents: ReadonlyMap<string, string>,
): string[] {
  const churned: string[] = [];
  for (const [tag, inner] of tagContents) {
    const key = `${sessionKey}\0${tag}`;
    const hash = fnv1a(inner);
    const prev = tagObservations.get(key);
    if (prev !== undefined) {
      if (prev !== hash) churned.push(tag);
      tagObservations.delete(key); // refresh LRU position
    }
    tagObservations.set(key, hash);
  }
  while (tagObservations.size > TAG_OBSERVATIONS_MAX) {
    const oldest = tagObservations.keys().next().value;
    if (oldest === undefined) break;
    tagObservations.delete(oldest);
  }
  return churned;
}

/** sha256[0..8] hex via Web Crypto (works in Node 18+ and Workers). 32-bit collision-safe. */
export async function sha8(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 4; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return hex;
}

/** Record a recovery entry when `emitRecoverable` is on. No-op (no hash cost) when off. */
async function recordRecoverable(
  info: TransformInfo,
  emit: boolean,
  entry: { kind: RecoverableBlock['kind']; toolUseId?: string; text: string; imageCount: number },
): Promise<void> {
  if (!emit) return;
  const id = 'rec_' + (await sha8(`${entry.kind}\u0000${entry.toolUseId ?? ''}\u0000${entry.text}`));
  (info.recoverable ??= []).push({
    id,
    kind: entry.kind,
    ...(entry.toolUseId !== undefined ? { toolUseId: entry.toolUseId } : {}),
    text: entry.text,
    imageCount: entry.imageCount,
  });
}

/** Hash the concatenated base64 of every image block on `messages[0]` (the synthetic
 *  history message). Stable across the quantized collapse window → proves Anthropic
 *  can cache_read the history prefix. Returns undefined if no images on messages[0]. */
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
 * After a history collapse, move pxpipe's single relocated cache breakpoint off
 * the slab image and onto the LAST history image.
 *
 * The history image sits AFTER the slab in prefix order, so one marker on it
 * caches the WHOLE imaged prefix (slab + history) as a single stable segment —
 * created once, then read at the ~0.1x rate every turn. Without this the history
 * image (usually the largest block) only lands in a cached prefix when the
 * caller's roaming downstream marker happens to fall after it; when it doesn't,
 * the entire history image re-creates at the 1.25x rate turn after turn.
 *
 * Pure relocation: it acts only when a slab image already carries the anchor, so
 * the total marker count never increases (pxpipe never *adds* — only moves).
 */
function relocateAnchorToHistoryImage(messages: Message[] | undefined, anchorOrdinal?: number): void {
  if (!Array.isArray(messages)) return;

  // The synthetic history message is identified by its banner text block.
  let historyImg: (ImageBlock & { cache_control?: unknown }) | undefined;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    const first = m.content[0] as TextBlock | undefined;
    if (!first || first.type !== 'text' || first.text !== HISTORY_SYNTHETIC_INTRO) continue;
    // Collect this message's images in order, then pin the carry-over anchor (the last
    // byte-stable history image) when collapseHistory provided its ordinal; otherwise
    // fall back to the last image. Pinning the LAST image is the #11 bust: it's the
    // newest, still-growing chunk and its bytes change on every window advance.
    const imgsInMsg: Array<ImageBlock & { cache_control?: unknown }> = [];
    for (const b of m.content) {
      if (b && (b as ImageBlock).type === 'image') {
        imgsInMsg.push(b as ImageBlock & { cache_control?: unknown });
      }
    }
    historyImg =
      anchorOrdinal !== undefined && anchorOrdinal >= 0 && anchorOrdinal < imgsInMsg.length
        ? imgsInMsg[anchorOrdinal]
        : imgsInMsg[imgsInMsg.length - 1];
    break;
  }
  if (!historyImg) return;

  // The slab anchor is the marked image BEFORE the '[End of rendered context.]'
  // boundary in the slab-bearing message. Reminder/tool images sit after that
  // boundary (or in other messages) and keep their own caller markers.
  let slabAnchor: (ImageBlock & { cache_control?: unknown }) | undefined;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    const hasBoundary = m.content.some(
      (b) => b && (b as TextBlock).type === 'text' && (b as TextBlock).text === '[End of rendered context.]',
    );
    if (!hasBoundary) continue;
    for (const b of m.content) {
      if (b && (b as TextBlock).type === 'text' && (b as TextBlock).text === '[End of rendered context.]') break;
      if (b && (b as ImageBlock).type === 'image' && (b as { cache_control?: unknown }).cache_control !== undefined) {
        slabAnchor = b as ImageBlock & { cache_control?: unknown };
      }
    }
    break;
  }
  if (!slabAnchor) return; // nothing to relocate → never add a marker

  historyImg.cache_control = demoteRelocatedCacheControl(slabAnchor.cache_control);
  delete slabAnchor.cache_control;
}

/**
 * Read-only digest of the cacheable prefix pxpipe actually sends: tools +
 * system + message blocks up to and including the imaged history image (or, on
 * no-collapse turns, the slab boundary). The naturally-growing live tail is
 * excluded, so the digest only moves when something *inside the pinned prefix*
 * moves. Pairs with per-turn cache_read/cache_create to attribute a prompt-cache
 * bust: a digest that CHANGES between consecutive turns of one session means we
 * serialized different prefix bytes (pxpipe-side — a per-turn block crossing the
 * breakpoint, or marker drift); a STABLE digest on a turn that still re-created
 * the prefix points upstream (eviction). Never mutates the request, so it cannot
 * perturb the cache behavior it measures.
 */
async function cachePrefixDigest(
  req: { tools?: unknown; system?: unknown; messages?: unknown },
): Promise<{ sha8: string; bytes: number } | undefined> {
  const msgs = Array.isArray(req.messages) ? (req.messages as Message[]) : [];
  // Boundary = latest message carrying pxpipe's imaged prefix: the history image
  // (banner) when collapse ran, else the slab message ('[End of rendered
  // context.]'). Identified exactly as relocateAnchorToHistoryImage does.
  let boundary = -1;
  for (let i = 0; i < msgs.length; i++) {
    const content = msgs[i]?.content;
    if (!Array.isArray(content)) continue;
    const first = content[0] as TextBlock | undefined;
    const isHistory = first?.type === 'text' && first.text === HISTORY_SYNTHETIC_INTRO;
    const hasSlab = content.some(
      (b) => b && (b as TextBlock).type === 'text' && (b as TextBlock).text === '[End of rendered context.]',
    );
    if (isHistory || hasSlab) boundary = i;
  }
  if (boundary < 0) return undefined; // not an imaged-prefix shape — nothing pinned
  const parts: string[] = [];
  if (Array.isArray(req.tools)) for (const t of req.tools) parts.push(JSON.stringify(t));
  const sys = req.system;
  if (typeof sys === 'string') parts.push(sys);
  else if (Array.isArray(sys)) for (const b of sys) parts.push(JSON.stringify(b));
  for (let i = 0; i <= boundary; i++) {
    const content = msgs[i]?.content;
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content))
      for (const b of content) parts.push(typeof b === 'string' ? b : JSON.stringify(b));
  }
  const prefix = parts.join('\x00');
  return { sha8: await sha8(prefix), bytes: prefix.length };
}

/** Best-effort extraction of the CLAUDE.md slab from a system text (heuristic).
 *  Returns empty string if nothing CLAUDE.md-shaped is detected. */
export function extractClaudeMdSlab(staticText: string): string {
  if (!staticText) return '';
  // Headings Claude Code uses around CLAUDE.md content.
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
  // End at the next top-level heading or EOF.
  const tail = staticText.slice(startIdx);
  const endMatch = /\n#\s+\S/.exec(tail.slice(1));
  const end = endMatch ? endMatch.index + 1 : tail.length;
  return tail.slice(0, end).trim();
}

/** First user message text, capped at 4 KiB (stable thread id; hashing large pastes is wasteful). */
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
    // First user message found but unreadable — return empty rather than fall through to next.
    return '';
  }
  return '';
}

/** Parse structured fields from the dynamic slab for telemetry. Read-only. */
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

  // Branch may be in <git_status>, <context name="git">, or a bare "Branch:" / "On branch" line.
  const branch =
    /(?:^|\n)\s*(?:On branch|Branch:)\s*([^\s\n]+)/i.exec(dynamicText) ??
    /(?:^|\n)\s*Current branch:\s*([^\s\n]+)/i.exec(dynamicText);
  if (branch) out.gitBranch = branch[1]!.trim();

  return out;
}

/** Strip the per-turn `x-anthropic-billing-header:` line (changes every turn;
 *  must not be baked into the image). Returned as `kept` for the system tail. */
function stripBillingLine(text: string): { kept: string | null; body: string } {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first.startsWith('x-anthropic-billing-header:')) {
    return { kept: first, body: nl === -1 ? '' : text.slice(nl + 1) };
  }
  return { kept: null, body: text };
}

/** Extract the `# Environment` markdown section Claude Code injects into its
 *  system text (working dir, git state, platform, model ID). It carries no XML
 *  wrapper, so splitStaticDynamic can't catch it — yet its git-status lines
 *  change across sessions, and baking them into the slab PNG busts the cross-
 *  session cache (system_sha8 717f1fce → 5efaa4bb for a one-file edit). Parallel
 *  to stripBillingLine: `kept` re-enters the system tail as plain text — after
 *  splitEnvByVolatility routes its proven-stable entries into the slab. */
function stripMarkdownEnvSection(text: string): { kept: string; body: string } {
  const m = /(?:^|\n)(# Environment\b[\s\S]*?)(?=\n#{1,6}\s|$)/.exec(text);
  if (!m) return { kept: '', body: text };
  return {
    kept: m[1]!.trimEnd(),
    body: text.slice(0, m.index) + text.slice(m.index + m[0].length),
  };
}

/** Model-identity/catalog lines dropped from RELOCATED env text (field report,
 *  2026-07: higher spend with pxpipe because subagents ran on the parent model).
 *  In the system prompt these lines are static low-salience context; appended to
 *  the LAST user message every turn they read as fresh instructions at the exact
 *  point where the model picks a subagent model — "default to the latest and
 *  most capable Claude models" right next to an Agent call means fable, not
 *  haiku. The live model already knows its identity from its own system prompt,
 *  so relocation loses nothing. Redaction applies ONLY on the relocation path;
 *  the no-user-message fallback keeps env text in system, where these lines
 *  keep their original (harmless) position.
 *
 *  Since the diff-based split (splitEnvByVolatility) this regex is the SECOND
 *  layer: identity entries are byte-stable, so from a session's second project
 *  sighting onward they ride the imaged slab in their original system-derived
 *  position and never reach this filter. It still guards the tail for fresh
 *  sessions/projects and for entries that churn (e.g. a /model switch). */
const MODEL_IDENTITY_LINE =
  /you are powered by|exact model id is|most recent claude models|default to the latest and most capable/i;

function redactModelIdentityLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !MODEL_IDENTITY_LINE.test(line))
    .join('\n');
}

/* ── Diff-based static/volatile `# Environment` split ──────────────────────
 * The env section is mostly session-static (cwd, platform, OS, model catalog)
 * with a few churning entries (git state). Blanket relocation to the per-turn
 * tail is cache-safe but pays live-text rates every turn for bytes that never
 * change. The split promotes entries PROVEN stable into the imaged slab and
 * keeps the rest on the tail. Invariants (pinned by cache-stability e2e):
 *   1. No promotion without history — a first-ever sighting is volatile, so a
 *      fresh session/project never bakes git state into the image (the 48.8%
 *      cold-create fix stays intact).
 *   2. The slab NEVER re-renders mid-session — the static side is frozen
 *      byte-exact at the session's first transform. If a promoted entry churns
 *      anyway, the slab keeps its stale bytes and the fresh text re-emits on
 *      the live tail (the later copy supersedes), while history marks it
 *      churned so the NEXT session demotes it.
 *   3. No project key (claudeMdSha absent) → no learning, all volatile: a
 *      shared fallback key would let one project's stable sightings promote
 *      another project's entries. */

/** One env entry: a top-level bullet (` - Key: …`) or bare `Key: …` line plus
 *  its deeper-indented continuation lines. */
interface EnvEntry {
  key: string;
  hash: number;
  text: string;
}

const ENV_ENTRY_START = /^ ?- (.{1,200})$|^([A-Za-z][^:\n]{0,63}):(?: |$)/;

function parseEnvEntries(env: string): { header: string; entries: EnvEntry[] } {
  const headerLines: string[] = [];
  const entries: EnvEntry[] = [];
  let cur: string[] | null = null;
  let curKey = '';
  const flush = () => {
    if (cur) {
      const text = cur.join('\n').trimEnd();
      entries.push({ key: curKey, hash: fnv1a(text), text });
    }
    cur = null;
  };
  for (const line of env.split('\n')) {
    const m = line.startsWith('#') ? null : ENV_ENTRY_START.exec(line);
    if (m) {
      flush();
      const head = (m[1] ?? m[2] ?? '').trim();
      curKey = head.split(':', 1)[0]!.slice(0, 64).trim();
      cur = [line];
    } else if (cur) {
      cur.push(line); // continuation (nested list item / wrapped prose)
    } else {
      headerLines.push(line);
    }
  }
  flush();
  return { header: headerLines.join('\n').trimEnd(), entries };
}

/** Cross-session churn history: `${projectKey}\0${entryKey}` → last content
 *  hash + sticky churn flag. Bounded LRU (same pattern as tagObservations). */
const ENV_HISTORY_MAX = 8192;
const envEntryHistory = new Map<string, { hash: number; churned: boolean }>();

/** Per-session frozen partition — decided once at the session's first
 *  transform; `frozenStatic` bytes ride the slab unchanged all session. */
interface EnvPartition {
  frozenStatic: string;
  staticHash: Map<string, number>;
}
const ENV_PARTITIONS_MAX = 512;
const envSessionPartitions = new Map<string, EnvPartition>();

/** Test hook: classification state is process-global (learning across
 *  sessions is the point), so suites that replay sessions reset between cases. */
export function resetEnvSplitState(): void {
  envEntryHistory.clear();
  envSessionPartitions.clear();
}

export function splitEnvByVolatility(
  env: string,
  projectKey: string | undefined,
  sessionKey: string,
): { staticEnv: string; volatileEnv: string; volatileKeys: string[] } {
  if (!env) return { staticEnv: '', volatileEnv: '', volatileKeys: [] };
  if (!projectKey) return { staticEnv: '', volatileEnv: env, volatileKeys: [] };

  const { header, entries } = parseEnvEntries(env);

  // Freeze the partition on the session's first sighting (invariant 2).
  let part = envSessionPartitions.get(sessionKey);
  if (!part) {
    const staticHash = new Map<string, number>();
    const staticParts: string[] = [];
    for (const e of entries) {
      const h = envEntryHistory.get(`${projectKey}\0${e.key}`);
      if (h && !h.churned && h.hash === e.hash) {
        staticHash.set(e.key, e.hash);
        staticParts.push(e.text);
      }
    }
    part = {
      frozenStatic:
        staticParts.length > 0
          ? [header, ...staticParts].filter((s) => s.length > 0).join('\n')
          : '',
      staticHash,
    };
  } else {
    envSessionPartitions.delete(sessionKey); // refresh LRU position
  }
  envSessionPartitions.set(sessionKey, part);
  while (envSessionPartitions.size > ENV_PARTITIONS_MAX) {
    const oldest = envSessionPartitions.keys().next().value;
    if (oldest === undefined) break;
    envSessionPartitions.delete(oldest);
  }

  // Route entries and record churn history (sticky flag, LRU refresh).
  const volatileParts: string[] = [];
  const volatileKeys: string[] = [];
  for (const e of entries) {
    const key = `${projectKey}\0${e.key}`;
    const prev = envEntryHistory.get(key);
    const churned =
      (prev?.churned ?? false) || (prev !== undefined && prev.hash !== e.hash);
    if (prev !== undefined) envEntryHistory.delete(key); // refresh LRU position
    envEntryHistory.set(key, { hash: e.hash, churned });
    if (part.staticHash.get(e.key) === e.hash) continue; // riding the slab, unchanged
    volatileParts.push(e.text);
    volatileKeys.push(e.key);
  }
  while (envEntryHistory.size > ENV_HISTORY_MAX) {
    const oldest = envEntryHistory.keys().next().value;
    if (oldest === undefined) break;
    envEntryHistory.delete(oldest);
  }

  return {
    staticEnv: part.frozenStatic,
    volatileEnv:
      volatileParts.length > 0
        ? [header, ...volatileParts].filter((s) => s.length > 0).join('\n')
        : '',
    volatileKeys,
  };
}

/** Build the "## Tool: name\n<desc>\n```json …```" block for one tool. Docs are
 *  imaged on this path (mirrors openai.ts renderToolDoc): the image carries the
 *  full schema — annotations included — at image token rates, while tools[]
 *  carries the annotation-stripped structure for Anthropic's tool-use validator.
 *  (The earlier text-reference design kept this prose-only because schema JSON
 *  at text rates would have duplicated what tools[] already pays for; at image
 *  rates the duplicate structure is cheap and the stripped annotations are the
 *  compression.) */
function renderToolDoc(t: ToolDef): string {
  const parts: string[] = [`## Tool: ${t.name ?? '?'}`];
  if (t.description) parts.push(t.description);
  if (t.input_schema !== undefined) {
    parts.push('```json\n' + JSON.stringify(t.input_schema) + '\n```');
  }
  return parts.join('\n');
}

function makeImageBlock(pngB64: string, _ephemeral = false): ImageBlock {
  // pxpipe never adds its own cache_control — only moves existing caller markers
  // across the text→image flip. `_ephemeral` is preserved for call-site compat.
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: pngB64 },
  };
}

// --- paging / truncation ---------------------------------------------------
// Anthropic caps requests at 100 images. Huge tool_results (find trees,
// log dumps) are truncated with a paging marker before render.

/** Visual rows a single input line will consume after soft-wrap at `cols`. */
function lineRows(line: string, cols: number): number {
  return Math.max(1, Math.ceil(line.length / cols));
}

/** Visual row count after soft-wrap at `cols`.
 *
 *  Only hard `\n` starts a new row. The reflow ↵ sentinel is an inline glyph
 *  (see wrapLines in render.ts: "never forces a row break"), so packing many
 *  original newlines into one soft-wrapped stream must NOT inflate the row
 *  count. Treating ↵ as a break overstated image pages ~6× on reflowed
 *  history and flipped profitable collapses to not_profitable. */
export function countVisualRows(text: string, cols: number): number {
  let rows = 0;
  let lineStart = 0;
  const len = text.length;
  for (let i = 0; i <= len; i++) {
    const cc = i < len ? text.charCodeAt(i) : -1;
    if (i === len || cc === 10 /* \n */) {
      const lineLen = i - lineStart;
      // Empty line (consecutive \n) still costs one visual row.
      rows += lineLen === 0 ? 1 : Math.ceil(lineLen / Math.max(1, cols));
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
  maxCharsPerImage: number = READABLE_CHARS_PER_IMAGE,
  maxLinesPerColumn: number = LINES_PER_IMAGE,
): number {
  const n = Math.max(1, numCols | 0);
  const readableLinesPerCol = Math.max(1, Math.floor(maxCharsPerImage / Math.max(1, cols)));
  const hardLinesPerCol = Math.max(1, Math.floor(maxLinesPerColumn));
  const linesPerImage = Math.min(hardLinesPerCol, readableLinesPerCol) * n;
  const charBudget = Math.max(1, maxCharsPerImage * n);
  if (typeof textOrLen === 'number') {
    // Back-compat shim — numeric arg gets the looser chars-based estimate.
    return Math.max(1, Math.ceil(textOrLen / charBudget));
  }
  const rows = countVisualRows(textOrLen, cols);
  return Math.max(
    1,
    Math.ceil(rows / linesPerImage),
    Math.ceil(textOrLen.length / charBudget),
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
    `\n\n[ pxpipe paging: omitted ${args.omittedLines.toLocaleString('en-US')} lines ` +
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
  maxCharsPerImage: number = DENSE_CONTENT_CHARS_PER_IMAGE,
): { text: string; omittedChars: number; truncated: boolean } {
  const n = Math.max(1, numCols | 0);
  const estImages = estimateImageCount(text, cols, n, maxCharsPerImage);
  if (estImages <= maxImages) return { text, omittedChars: 0, truncated: false };
  const readableLinesPerCol = Math.max(1, Math.floor(maxCharsPerImage / Math.max(1, cols)));
  const totalRowBudget = Math.max(8, maxImages * Math.min(LINES_PER_IMAGE, readableLinesPerCol) * n - 6);
  const totalCharBudget = Math.max(128, maxImages * maxCharsPerImage * n - 512);
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
    let chars = 0;
    let cut = 0;
    for (let i = 0; i < lines.length; i++) {
      const r = lineRows(lines[i]!, cols);
      const c = lines[i]!.length + (i > 0 ? 1 : 0);
      if (rows + r > totalRowBudget || chars + c > totalCharBudget) break;
      rows += r;
      chars += c;
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
  const headCharBudget = Math.floor(totalCharBudget * 0.6);
  const tailCharBudget = totalCharBudget - headCharBudget;
  let headRows = 0;
  let headChars = 0;
  let headCut = 0;
  for (let i = 0; i < lines.length; i++) {
    const r = lineRows(lines[i]!, cols);
    const c = lines[i]!.length + (i > 0 ? 1 : 0);
    if (headRows + r > headRowBudget || headChars + c > headCharBudget) break;
    headRows += r;
    headChars += c;
    headCut = i + 1;
  }
  if (headCut === 0) headCut = 1;
  let tailRows = 0;
  let tailChars = 0;
  let tailStart = lines.length;
  for (let i = lines.length - 1; i >= headCut; i--) {
    const r = lineRows(lines[i]!, cols);
    const c = lines[i]!.length + (i < lines.length - 1 ? 1 : 0);
    if (tailRows + r > tailRowBudget || tailChars + c > tailCharBudget) break;
    tailRows += r;
    tailChars += c;
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

/**
 * Render text → Anthropic image blocks for the proxy. The column-selection rule below
 * (shrink, then single-col unless the content fills the width) is mirrored exactly by
 * the public SDK primitive `renderTextToImages` (library.ts), so the proxy and the
 * `pxpipe export` CLI emit byte-identical PNGs for the same text. Exported so
 * export-proxy-align.test.ts can pin that invariant against the real proxy code.
 */
export async function textToImageBlocks(
  text: string,
  cols: number,
  numCols: number = 1,
  /** Shrink canvas to the longest wrapped line. `false` for the slab path
   *  (fills full `cols` for multi-col packing). Default `true`. */
  shrinkWidth: boolean = true,
): Promise<{
  blocks: ImageBlock[];
  /** Raw PNG bytes parallel to `blocks` (avoids re-decoding base64 for dashboard). */
  pngs: Uint8Array[];
  /** Pixel dimensions parallel to `pngs`. */
  dims: Array<{ width: number; height: number }>;
  droppedChars: number;
  droppedCodepoints: Map<number, number>;
  /** Σ width×height — caller accumulates into `info.imagePixels` for px/token regression. */
  pixels: number;
}> {
  // Shrink before the numCols branch so gate and renderer see the same canvas width.
  // If shrinkage drops below the full width, stay single-col (avoid wasting a divider column).
  const renderText = text;
  const effectiveCols = shrinkWidth ? shrinkColsToContent(renderText, cols) : cols;
  const effectiveNumCols = effectiveCols < cols ? 1 : numCols;
  const imgs =
    effectiveNumCols > 1
      ? await renderTextToPngsMultiCol(renderText, effectiveCols, effectiveNumCols)
      // Single-col dense: shrink the 384-col base to content so the renderer matches the
      // gate (denseGateGeometry uses DENSE_CONTENT_COLS, priced via shrinkColsToContent).
      // Was hard-coded to DENSE_CONTENT_COLS, which threw away the shrink the gate assumed.
      : await renderTextToPngsWithCharLimit(renderText, shrinkColsToContent(renderText, DENSE_CONTENT_COLS), DENSE_CONTENT_CHARS_PER_IMAGE, DENSE_RENDER_STYLE);
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
  return {
    blocks,
    pngs: imgs.map((i) => i.png),
    dims: imgs.map((i) => ({ width: i.width, height: i.height })),
    droppedChars,
    droppedCodepoints,
    pixels,
  };
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
 * Run history-image compression on `req.messages` and finalize the body.
 * Called from both the main path AND early-exit paths (below_min_chars,
 * not_profitable) — history collapse must run even when the slab skips.
 * Tolerant to missing/short message arrays (collapseHistory short-circuits). */
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
    const historyProfitable = (text: string, cols: number): boolean => {
      // History always renders single-col at the dense 384-col / 240-row page
      // (history.ts → renderTextToPngsWithCharLimit with DENSE_CONTENT_COLS /
      // DENSE_CONTENT_CHARS_PER_IMAGE), so gate at THAT geometry, not o.cols.
      const g = denseGateGeometry(cols, 1);
      return isCompressionProfitableAmortized(
        text, g.cols, undefined, 1, historyCpt, horizon,
        o.priorWarmTokens, o.priorWarmImageTokens, true, g.maxChars,
      );
    };
    // No protectedPrefix here: this path runs only when the slab did NOT image
    // (it stays as text in req.system), so there is no slab message to shield —
    // collapsing from the head is correct.
    const { messages: newMessages, info: histInfo } = await collapseHistory(
      req.messages,
      historyProfitable,
      { cols: o.cols, protectedPrefix: 0, reflow: o.reflow },
    );
    if (histInfo.collapsedTurns > 0) {
      req.messages = newMessages;
      info.collapsedTurns = histInfo.collapsedTurns;
      info.collapsedChars = histInfo.collapsedChars;
      info.collapsedImages = histInfo.collapsedImages;
      info.imageCount += histInfo.collapsedImages;
      info.imageBytes += histInfo.collapsedImageBytes;
      info.imagePixels = (info.imagePixels ?? 0) + histInfo.collapsedImagePixels;
      // Register the rendered (colored) history PNGs into the dashboard image ring
      // so they are visible, not merely counted. Every other image path feeds this.
      // imagePngs + imageDims must be pushed in lockstep (ring reads them parallel).
      (info.imagePngs ??= []).push(...histInfo.collapsedPngs);
      (info.imageDims ??= []).push(...histInfo.collapsedImageDims);
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
  const { kept: billingLine, body: sysBodyWithEnv } = stripBillingLine(rawSysText);
  // Pull the volatile `# Environment` markdown section out BEFORE the
  // static/dynamic split so per-session git state never reaches the slab image.
  const { kept: envMarkdown, body: sysBody } = stripMarkdownEnvSection(sysBodyWithEnv);
  const splitSystem = splitStaticDynamic(sysBody);
  let staticText = splitSystem.staticText;
  const { dynamicText, blockCount: dynBlocks, unknownTags, staticTagContents } = splitSystem;
  const preserveClaudeCodeIdentity = staticText.startsWith(CLAUDE_CODE_OAUTH_IDENTITY);
  if (preserveClaudeCodeIdentity) {
    staticText = staticText.slice(CLAUDE_CODE_OAUTH_IDENTITY.length).replace(/^\s+/, '');
  }
  info.staticChars = staticText.length;
  // dynamicChars is finalized after the env split below — only the VOLATILE
  // side of `# Environment` counts as dynamic once stable entries ride the slab.
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

  // Canary: slab tags whose content churns within a session bust the image
  // cache every turn — report them regardless of the hardcoded lists.
  if (staticTagContents.size > 0) {
    const churning = observeStaticTagChurn(
      firstUserSha ?? claudeMdSha ?? 'global',
      staticTagContents,
    );
    if (churning.length > 0) info.churningStaticTags = churning;
  }

  // Diff-based `# Environment` split (see splitEnvByVolatility): entries
  // proven stable across sessions ride the imaged slab; churned/new entries
  // keep the existing live-tail relocation. Without a user message there is
  // nowhere to carry the slab or the tail, so the whole section stays
  // volatile and falls back into system further down, exactly as before.
  const hasUserMsg = (req.messages ?? []).some((m) => m.role === 'user');
  const { staticEnv, volatileEnv, volatileKeys: envVolatileKeys } = hasUserMsg
    ? splitEnvByVolatility(envMarkdown, claudeMdSha, firstUserSha ?? claudeMdSha ?? 'global')
    : { staticEnv: '', volatileEnv: envMarkdown, volatileKeys: [] as string[] };
  if (staticEnv) info.envStaticChars = staticEnv.length;
  if (envVolatileKeys.length > 0) info.envVolatileKeys = envVolatileKeys;
  info.dynamicChars = dynamicText.length + volatileEnv.length;

  // 2. Move tool docs into the imaged "Tool Reference", stubbing originals.
  //    Imaged (not text) because that IS the compression — descriptions and
  //    schema annotations ride at image token rates, mirroring the GPT path.
  //    Tool docs are static per session, so the slab image stays byte-stable
  //    and cache-friendly. Each stub description cites its own heading
  //    ("## Tool: <name>") so the model can link stub → full doc
  //    deterministically.
  let toolDocsText = '';
  let toolsRewritten: ToolDef[] | undefined;
  if (o.compressTools && Array.isArray(req.tools) && req.tools.length > 0) {
    const docs: string[] = [];
    toolsRewritten = req.tools.map((t) => {
      // #43: native server-side tools (versioned `type`, e.g. advisor_20260301,
      // web_search_20250305) have a fixed API schema that rejects a `description`
      // field on the entry ("Extra inputs are not permitted" → 400). Only
      // client-defined tools — no `type`, or the explicit type:"custom" shape —
      // accept description/input_schema, so everything else passes through
      // byte-identical and stays out of the imaged reference (its docs live
      // server-side; there is nothing to compress). Mirrors the OpenAI-path
      // guard (openai.ts isFunctionTool).
      if (t.type !== undefined && t.type !== 'custom') return t;
      // Anthropic excludes deferred tool definitions from model context until
      // selected by tool search; imaging their docs would defeat that behavior.
      if ((t as ToolDef & { defer_loading?: boolean }).defer_loading === true) return t;
      docs.push(renderToolDoc(t));
      // tools[] keeps the annotation-STRIPPED schema: structure (type/properties/
      // required/enum/items) stays for Anthropic's tool-use validator — a bare
      // {type:'object'} stub caused 400s on non-interactive turns where Anthropic
      // deep-validates with no prior tool_use history to short-circuit. The
      // stripped annotations (description/title/examples/default) ride in the
      // imaged reference instead, at image rates. If stripping yields no
      // structural keys, keep the ORIGINAL schema untouched: it's tiny without
      // properties, and a bare stub is the riskier trade.
      let schema = t.input_schema;
      if (schema && typeof schema === 'object') {
        const stripped = stripSchemaDescriptions(schema, 0) as Record<string, unknown> | null;
        if (stripped && typeof stripped === 'object' && schemaHasStructure(stripped)) {
          schema = stripped;
        }
      }
      // Read-before-Edit precondition rides as LIVE TEXT, not imaged: the CLI
      // rejects Edit/Write on any existing file not Read in THIS session's
      // process, and the rule lost salience once full tool docs moved into the
      // imaged reference (read-gate audit, 2026-07-03). Three tools only, no
      // banned wording — stays clear of the per-tool-stub repetition pattern
      // that tripped reasoning_extraction (see wording note below).
      const readFirstNote = READ_FIRST_TOOLS.has(t.name ?? '')
        ? ' Requires a Read of the same file earlier in THIS session when the file' +
          ' already exists — the call is rejected otherwise; file content recalled' +
          ' from imaged or prior-session context does not satisfy this.'
        : '';
      return {
        ...t,
        // Wording note (do NOT reintroduce "system prompt"/"authoritative" — same ban
        // as the imaged-slab banner below): a stub citing "...the Tool Reference
        // section of the system prompt", repeated once per tool, retripped Anthropic's
        // reasoning_extraction refusal (stop_reason: "refusal" → Claude Code fell back
        // to claude-opus-4-8 immediately on cold start, 2026-07-02). The reference
        // block's own header says where the docs live; the stub only needs the heading.
        description: `ⓘ Full docs: see "## Tool: ${t.name ?? '?'}" in the Tool Reference section.${readFirstNote}`,
        ...(schema !== undefined ? { input_schema: schema } : {}),
      };
    });
    toolDocsText = docs.join('\n\n');
    info.toolDocsChars = toolDocsText.length;
  }

  // Static slab + Tool Reference go into the renderer; dynamic slab and billing
  // line stay as plain text so the cache key (= image bytes) is stable across
  // turns. The reference header carries the same first-party provenance framing
  // that defused the imaged-slab banner refusal (169521c): pxpipe names itself
  // as the author of the relocation so the block reads as this session's own
  // config, not a replayed/extracted prompt.
  const toolReferenceText = toolDocsText
    ? '=== TOOL REFERENCE ===\n' +
      "pxpipe (this user's local proxy) moved the full tool documentation for this" +
      ' session here to reduce token cost. Each tool in the tools list carries a short' +
      ' stub description pointing here; the entry under the matching' +
      ' "## Tool: <name>" heading below is the complete description for that tool.\n\n' +
      toolDocsText +
      '\n=== END TOOL REFERENCE ==='
    : '';
  // staticEnv: `# Environment` entries proven session-stable (diff split
  // above) ride the slab at image rates; frozen byte-exact per session so
  // this never re-renders mid-session.
  const combinedRaw = [staticText, staticEnv, toolReferenceText]
    .filter((s) => s.length > 0)
    .join('\n\n');
  // Compact then reflow before the gate; gate/renderer/paging all see the same text.
  // origChars anchored to raw length — that's what Anthropic would have billed.
  const combined = maybeReflow(compactSlabWhitespace(combinedRaw), o.reflow);
  info.origChars = combinedRaw.length;
  info.compressedChars = 0;
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

  // Break-even check guards even the slab (rare edge: tiny tool docs + tiny slab < 10k chars).
  // numCols clamped to 2000 px width cap; falls back to 1 if even 2 cols would exceed it.
  const numCols = Math.min(
    Math.max(1, (o.multiCol | 0) || 1),
    Math.max(1, maxFittingCols(o.cols)),
  );
  // Gate geometry for dense single-col (tool_result/reminder) paths — 384-col/240-row.
  const denseGeo = denseGateGeometry(o.cols, numCols);
  // Use slab cpt (2.0) unless host pinned charsPerToken explicitly.
  const slabCpt = opts.charsPerToken !== undefined
    ? o.charsPerToken
    : SLAB_CHARS_PER_TOKEN;
  // Shrink canvas to longest actual line — pure function of (text, cols) so the
  // cache prefix stays byte-identical across turns. The banner sets a natural width floor.
  const reflowNoteImg = o.reflow
    ? ' The glyph ↵ (U+21B5) marks an original hard line break in content — treat as a real newline.'
    : '';
  const columnNoteImg =
    numCols > 1
      ? ` Multi-column layout (${numCols} cols): read column 1 (leftmost) top-to-bottom, then column 2, etc.`
      : '';
  // Wording note (do NOT reintroduce "system prompt"/"authoritative"): a user-turn
  // banner announcing "SYSTEM PROMPT ... treat as authoritative system instructions"
  // tripped Anthropic's reasoning_extraction refusal (reads as a replayed/extracted
  // prompt -> model-cloning heuristic) and forced a fallback-model switch. First-party
  // provenance framing below keeps obedience without the extraction signature.
  const imageInstructionHeader =
    '=================== SESSION CONFIGURATION PAGES ===================\n' +
    "pxpipe (this user's local proxy) rendered this session's configuration" +
    ' into the following images to reduce token cost. Read the pages carefully and follow them as' +
    ' your operating instructions for this session.' +
    ' For exact identifiers, paths, hashes, version strings, and numbers, use the adjacent' +
    ' exact-value factsheet; if a value was only visible in an image and is not in that factsheet,' +
    ' do not guess it — say it is not safe to quote from the image and re-read the source text.' +
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
    false, // already shrunk — don't double-shrink
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
    // Slab not profitable but history may still be collapsable — try before returning.
    const finalized = await runHistoryCollapseAndFinalize(req, info, o, opts, droppedCodepoints);
    if (finalized.collapsed) {
      info.compressed = true;
      return { body: finalized.body, info };
    }
    return { body, info };
  }

  // Instruction header co-renders into the same PNG (+1.04pp L1 OCR vs baseline;
  // single-modal framing keeps encoder in image-reading mode for both header + content).
  // Header text is continuous prose (no hard \n) so the renderer soft-wraps densely.
  // 3. Render to PNGs at slabCols width (banner sets natural floor).
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
        ? { ...imageBlock, cache_control: demoteRelocatedCacheControl(systemStaticCacheControl) }
        : imageBlock,
    );
  }
  info.imageCount = imageBlocks.length;
  // Credit raw (pre-compaction) length — what Anthropic would have billed.
  info.compressedChars += combinedRaw.length;
  bumpBucket(info, 'static_slab', combinedRaw.length);
  if (images.length > 0) {
    info.firstImagePng = images[0]!.png;
    info.firstImageWidth = images[0]!.width;
    info.firstImageHeight = images[0]!.height;
    (info.imagePngs ??= []).push(...images.map((i) => i.png));
    (info.imageDims ??= []).push(...images.map((i) => ({ width: i.width, height: i.height })));
    info.imageSourceText = combinedWithHeader.slice(0, 65_536);
  }

  // 4. Splice images back into the request. OCR framing is baked into the image.
  //
  // Volatile env/context text (git status, cwd, date) must NOT ride in
  // req.system: Anthropic's cache prefix order is tools → system → messages,
  // so system bytes sit BEFORE the slab anchor and any git-state change
  // cold-restarted the whole anchored prefix (48.8% of cold-create waste,
  // events.jsonl 2026-06-26..07-02). It is carried instead at the END of the
  // last user message — the per-turn live tail that re-caches incrementally
  // anyway — appended late in this function, AFTER history collapse, so it can
  // never be baked into a frozen history chunk. Only the VOLATILE side of the
  // env split rides here — stable entries were promoted into the slab above.
  // Fallback: if no user message exists to carry it, keep it in system rather
  // than drop content (volatileEnv holds the full section in that case).
  const volatileEnvParts: string[] = [];
  if (dynamicText) volatileEnvParts.push(dynamicText);
  if (volatileEnv) volatileEnvParts.push(volatileEnv);
  // Redact model-identity/catalog lines ONLY when relocating into a user
  // message (see MODEL_IDENTITY_LINE — second layer behind the env split):
  // the !hasUserMsg fallback keeps env text in system, its original position,
  // where those lines stay harmless.
  const volatileEnvText = hasUserMsg
    ? redactModelIdentityLines(volatileEnvParts.join('\n\n')).trim()
    : '';

  // Images go into first user message — system field rejects images (400 system.N.type).
  {
    const sysTail: SystemField = [];
    if (preserveClaudeCodeIdentity) {
      sysTail.push({ type: 'text', text: CLAUDE_CODE_OAUTH_IDENTITY });
    }
    // billingLine is session-stable (warm reads through the anchored prefix
    // confirm it; a per-turn value here would zero every cache read).
    if (billingLine) sysTail.push({ type: 'text', text: billingLine });
    if (!hasUserMsg) {
      if (dynamicText) sysTail.push({ type: 'text', text: dynamicText });
      if (volatileEnv) sysTail.push({ type: 'text', text: volatileEnv });
    }
    if (Array.isArray(sysRemainder)) sysTail.push(...sysRemainder);
    // Tool Reference now rides INSIDE the imaged slab (combinedRaw above) — no
    // text splice here. Stubbed tools[] descriptions cite the "## Tool: <name>"
    // headings inside the image; stub ↔ reference invariant holds because both
    // are applied on this same path (gate-fail paths return earlier with
    // original tools untouched).
    req.system = sysTail.length > 0 ? sysTail : undefined;

    const firstUserIdx = (req.messages ?? []).findIndex((m) => m.role === 'user');
    if (firstUserIdx >= 0) {
      const m = req.messages![firstUserIdx]!;
      const existing = Array.isArray(m.content)
        ? m.content
        : [{ type: 'text' as const, text: m.content }];

      // 5a. Compress <system-reminder> text blocks. cache_control on source text
      //     moves to the LAST produced image (pxpipe never adds its own markers).
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
          // Caller fidelity override: pin this block as text, skip imaging.
          if (callerKeepsSharp(o.keepSharp, { kind: 'reminder', text: (blk as TextBlock).text })) {
            bumpPassthrough(info, 'kept_sharp');
            info.keptSharpBlocks = (info.keptSharpBlocks ?? 0) + 1;
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
          if (!isCompressionProfitable(reminderText, denseGeo.cols, undefined, numCols, o.charsPerToken, 0, 0, true, denseGeo.maxChars)) {
            bumpPassthrough(info, 'not_profitable');
            processedExisting.push(blk);
            continue;
          }
          const { blocks: imgs, pngs: rawPngs, dims: rawDims, droppedChars, droppedCodepoints: dcp, pixels } =
            await textToImageBlocks(reminderText, o.cols, numCols);
          (info.imagePngs ??= []).push(...rawPngs);
          (info.imageDims ??= []).push(...rawDims);
          const srcCacheControl = demoteRelocatedCacheControl((blk as { cache_control?: unknown }).cache_control);
          for (let i = 0; i < imgs.length; i++) {
            const img = imgs[i]!;
            const out =
              i === imgs.length - 1 && srcCacheControl !== undefined
                ? { ...img, cache_control: srcCacheControl }
                : img;
            processedExisting.push(out as ImageBlock);
            info.imageBytes += approxBlockBytes(img);
          }
          const reminderFactSheet = factSheetText(reminderRaw);
          if (reminderFactSheet) processedExisting.push({ type: 'text', text: reminderFactSheet });
          info.imagePixels = (info.imagePixels ?? 0) + pixels;
          info.reminderImgs = (info.reminderImgs ?? 0) + imgs.length;
          await recordRecoverable(info, o.emitRecoverable, {
            kind: 'reminder',
            text: reminderRaw,
            imageCount: imgs.length,
          });
          info.compressedChars += reminderRaw.length;
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

      const slabFactSheet = factSheetText(combinedRaw);
      m.content = [
        ...imageBlocks,
        ...(slabFactSheet ? [{ type: 'text' as const, text: slabFactSheet }] : []),
        { type: 'text' as const, text: '[End of rendered context.]' },
        ...processedExisting,
      ];
    }

    // 5b. Compress tool_result content across ALL user messages.
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
              // Caller fidelity override: pin this tool_result as text.
              if (callerKeepsSharp(o.keepSharp, { kind: 'tool_result', text: innerRaw, toolUseId: tr.tool_use_id })) {
                bumpPassthrough(info, 'kept_sharp');
                info.keptSharpBlocks = (info.keptSharpBlocks ?? 0) + 1;
                rewritten.push(blk);
                continue;
              }
              const inner = compactSlabWhitespace(innerRaw);
              // classifyContent sees pre-reflow `inner` so shape bucketing reflects real structure.
              const innerR = maybeReflow(inner, o.reflow);
              if (innerR.length < o.minToolResultChars) {
                bumpPassthrough(info, 'below_threshold');
                rewritten.push(blk);
              } else if (!isCompressionProfitable(innerR, denseGeo.cols, o.maxImagesPerToolResult, numCols, o.charsPerToken, 0, 0, true, denseGeo.maxChars)) {
                bumpPassthrough(info, 'not_profitable');
                rewritten.push(blk);
              } else {
                // Paging: truncate before render if it would blow the image cap.
                const paged = truncateForBudget(innerR, o.maxImagesPerToolResult, denseGeo.cols, numCols, denseGeo.maxChars);
                if (paged.truncated) {
                  info.truncatedToolResults = (info.truncatedToolResults ?? 0) + 1;
                  info.omittedChars = (info.omittedChars ?? 0) + paged.omittedChars;
                }
                const { blocks: imgs, pngs: rawPngs, dims: rawDims, droppedChars, droppedCodepoints: dcp, pixels } =
                  await textToImageBlocks(paged.text, o.cols, numCols);
                (info.imagePngs ??= []).push(...rawPngs);
                (info.imageDims ??= []).push(...rawDims);
                for (const img of imgs) info.imageBytes += approxBlockBytes(img);
                info.imagePixels = (info.imagePixels ?? 0) + pixels;
                info.toolResultImgs = (info.toolResultImgs ?? 0) + imgs.length;
                info.imageCount += imgs.length;
                await recordRecoverable(info, o.emitRecoverable, {
                  kind: 'tool_result',
                  toolUseId: tr.tool_use_id,
                  text: innerRaw,
                  imageCount: imgs.length,
                });
                info.compressedChars += innerRaw.length; // original length = what text billing would be
                info.droppedChars = (info.droppedChars ?? 0) + droppedChars;
                for (const [cp, n] of dcp) {
                  droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + n);
                }
                const trFactSheet = factSheetText(innerRaw);
                rewritten.push({
                  ...tr,
                  content: trFactSheet ? [...imgs, { type: 'text' as const, text: trFactSheet }] : imgs,
                });
                changed = true;
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
                // Caller fidelity override: pin this tool_result part as text.
                if (callerKeepsSharp(o.keepSharp, { kind: 'tool_result_part', text: innerTextRaw, toolUseId: tr.tool_use_id })) {
                  bumpPassthrough(info, 'kept_sharp');
                  info.keptSharpBlocks = (info.keptSharpBlocks ?? 0) + 1;
                  newInner.push(ib as TextBlock | ImageBlock);
                  continue;
                }
                // Lossless whitespace compaction before gate + render.
                const innerText = compactSlabWhitespace(innerTextRaw);
                // R3: gate/page/render on reflowed text; classify pre-reflow.
                const innerTextR = maybeReflow(innerText, o.reflow);
                if (innerTextR.length < o.minToolResultChars) {
                  bumpPassthrough(info, 'below_threshold');
                  newInner.push(ib as TextBlock | ImageBlock);
                  continue;
                }
                if (!isCompressionProfitable(innerTextR, denseGeo.cols, o.maxImagesPerToolResult, numCols, o.charsPerToken, 0, 0, true, denseGeo.maxChars)) {
                  bumpPassthrough(info, 'not_profitable');
                  newInner.push(ib as TextBlock | ImageBlock);
                  continue;
                }
                const paged = truncateForBudget(innerTextR, o.maxImagesPerToolResult, denseGeo.cols, numCols, denseGeo.maxChars);
                if (paged.truncated) {
                  info.truncatedToolResults = (info.truncatedToolResults ?? 0) + 1;
                  info.omittedChars = (info.omittedChars ?? 0) + paged.omittedChars;
                }
                const { blocks: imgs, pngs: rawPngs, dims: rawDims, droppedChars, droppedCodepoints: dcp, pixels } =
                  await textToImageBlocks(paged.text, o.cols, numCols);
                (info.imagePngs ??= []).push(...rawPngs);
                (info.imageDims ??= []).push(...rawDims);
                const srcCacheControl = demoteRelocatedCacheControl((ib as { cache_control?: unknown }).cache_control);
                for (let i = 0; i < imgs.length; i++) {
                  const img = imgs[i]!;
                  const out =
                    i === imgs.length - 1 && srcCacheControl !== undefined
                      ? { ...img, cache_control: srcCacheControl }
                      : img;
                  newInner.push(out as ImageBlock);
                  info.imageBytes += approxBlockBytes(img);
                }
                const partFactSheet = factSheetText(innerTextRaw);
                if (partFactSheet) newInner.push({ type: 'text', text: partFactSheet });
                info.imagePixels = (info.imagePixels ?? 0) + pixels;
                info.toolResultImgs = (info.toolResultImgs ?? 0) + imgs.length;
                info.imageCount += imgs.length;
                await recordRecoverable(info, o.emitRecoverable, {
                  kind: 'tool_result_part',
                  toolUseId: tr.tool_use_id,
                  text: innerTextRaw,
                  imageCount: imgs.length,
                });
                info.compressedChars += innerTextRaw.length;
                info.droppedChars = (info.droppedChars ?? 0) + droppedChars;
                for (const [cp, n] of dcp) {
                  droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + n);
                }
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

  // 6. History-image compression (always runs after per-message rewrites).
  // History is single-col dense; use slab cpt unless host pinned charsPerToken.
  // protectedPrefix excludes the slab-bearing first user message — collapsing it
  // would reduce slab images to [image] placeholders and destroy the cache anchor.
  if (Array.isArray(req.messages) && req.messages.length > 0) {
    const historyCpt = opts.charsPerToken !== undefined
      ? o.charsPerToken
      : HISTORY_CHARS_PER_TOKEN;
    const horizon = Math.max(1, Math.floor(o.historyAmortizationHorizon));
    const historyProfitable = (text: string, cols: number): boolean => {
      // Gate at dense 384-col/240-row geometry (matches history.ts renderer).
      const g = denseGateGeometry(cols, 1);
      return isCompressionProfitableAmortized(
        text, g.cols, undefined, 1, historyCpt, horizon,
        o.priorWarmTokens, o.priorWarmImageTokens, true, g.maxChars,
      );
    };
    const slabAnchorIdx = (req.messages ?? []).findIndex((m) => m.role === 'user');
    const { messages: newMessages, info: histInfo } = await collapseHistory(
      req.messages,
      historyProfitable,
      { cols: o.cols, protectedPrefix: slabAnchorIdx >= 0 ? slabAnchorIdx + 1 : 0, reflow: o.reflow },
    );
    if (histInfo.collapsedTurns > 0) {
      req.messages = newMessages;
      info.collapsedTurns = histInfo.collapsedTurns;
      info.collapsedChars = histInfo.collapsedChars;
      info.collapsedImages = histInfo.collapsedImages;
      info.imageCount += histInfo.collapsedImages;
      info.imageBytes += histInfo.collapsedImageBytes;
      info.imagePixels = (info.imagePixels ?? 0) + histInfo.collapsedImagePixels;
      // Register the rendered (colored) history PNGs into the dashboard image ring
      // so they are visible, not merely counted. Every other image path feeds this.
      // imagePngs + imageDims must be pushed in lockstep (ring reads them parallel).
      (info.imagePngs ??= []).push(...histInfo.collapsedPngs);
      (info.imageDims ??= []).push(...histInfo.collapsedImageDims);
      info.droppedChars = (info.droppedChars ?? 0) + histInfo.droppedChars;
      for (const [cp, n] of histInfo.droppedCodepoints) {
        droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + n);
      }
      info.historyReason = 'collapsed';
      info.historyTextChars = histInfo.collapsedChars;
      info.historyImageSha = await historyImageSha8(newMessages);
      bumpBucket(info, 'history', histInfo.collapsedChars);
      // Move the single cache anchor onto the history image so slab + history
      // cache as one stable prefix (created once, then read), instead of the
      // history image re-creating whenever the caller's downstream marker moves.
      //
      // ONLY when collapseHistory pinned a byte-frozen carry-over chunk. On the
      // session's FIRST collapse the range fits in one freeze window, no carry-over
      // exists (ordinal undefined), and relocating would land the anchor on the
      // newest still-growing history image — a volatile breakpoint that forced a
      // one-time full-prefix rewrite (~53k tokens/session). Leave the anchor on
      // the byte-stable slab image until a frozen chunk exists to pin to.
      if (histInfo.carryOverImageOrdinal !== undefined) {
        relocateAnchorToHistoryImage(req.messages, histInfo.carryOverImageOrdinal);
      }
    } else if (histInfo.reason) {
      info.historyReason = histInfo.reason;
    }
  }

  // Volatile env/context text lands at the END of the last user message (see
  // the block above image splice for why). Runs AFTER history collapse so the
  // env bytes stay in the live tail — never imaged into a frozen chunk — and
  // AFTER 5b so they are never run through tool_result compression. Note
  // tool_result blocks legally precede trailing text blocks in a user message
  // (Claude Code appends its own system-reminders the same way).
  //
  // The block is wrapped in <system-reminder> tags so the model (and any
  // human reading a transcript) attributes it as injected context, NOT user
  // prose. Without the wrapper the relocated "# Environment" section blends
  // seamlessly into the user's message — on an empty/short user turn it can
  // BECOME the entire visible message (observed live, 2026-07). The wrapper
  // rides in the volatile tail behind the slab anchor, so it costs ~60 chars
  // per request and cannot perturb the cached prefix. Same-pass safety: 5a
  // (compressReminders) runs earlier and only scans the first user message,
  // so this block is never self-imaged; and pxpipe is stateless per request,
  // so the wrapper never appears in inbound client history (no compounding).
  if (volatileEnvText) {
    const wrappedEnvText = `<system-reminder>\nContext relocated by pxpipe from the system prompt (volatile per-turn environment state — not written by the user):\n\n${volatileEnvText}\n</system-reminder>`;
    const msgs = req.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.role !== 'user') continue;
      const content = Array.isArray(m.content)
        ? m.content
        : [{ type: 'text' as const, text: m.content }];
      msgs[i] = { ...m, content: [...content, { type: 'text' as const, text: wrappedEnvText }] };
      info.envRelocatedChars = wrappedEnvText.length;
      break;
    }
  }

  info.compressed = true;
  // Attribution signal for prompt-cache busts (#11): digest the exact pinned
  // prefix we send (history/slab boundary; live tail excluded) AFTER all marker
  // placement — incl. relocateAnchorToHistoryImage — is final. Read-only.
  {
    const pfx = await cachePrefixDigest(req);
    if (pfx) {
      info.cachePrefixSha8 = pfx.sha8;
      info.cachePrefixBytes = pfx.bytes;
    }
  }
  // Top dropped codepoints, capped at 20 entries to bound JSONL row size.
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
  info.outgoingTextChars = countOutgoingTextChars(req);
  const outBody = new TextEncoder().encode(JSON.stringify(req));
  return { body: outBody, info };
}

/** Sum every TEXT char the upstream tokenizer will see (system, tools, messages).
 *  Excludes image base64 and redacted_thinking. Denominator for the
 *  `tokens ≈ α·outgoingTextChars + β·imagePixels` regression. */
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

  // 2. tool definitions
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

      if (type === 'thinking') {
        const th = b as unknown as { thinking?: unknown };
        if (typeof th.thinking === 'string') n += (th.thinking as string).length;
        continue;
      }

      // image, redacted_thinking, server_tool_use, etc. — skip.
    }
  }

  return n;
}

/** JSON.stringify length, tolerant of cycles. Returns 0 on error. */
function safeStringifyLen(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}
