/**
 * History-image compression (Variant C).
 *
 * Walks `messages[]` left-to-right tracking open `tool_use_id`s. Identifies
 * the largest **closed-tool-sequence prefix** — the longest run from the
 * head of the conversation that has no straddling `tool_use` references
 * into the live tail. Renders that prefix's text content into one or more
 * PNG image blocks and replaces the prefix with ONE synthetic user message:
 *
 *   { role: 'user', content: [
 *     { type: 'text', text: '[Earlier in this conversation:]' },
 *     { type: 'image', source: {...} },           // (1..N images)
 *     { type: 'text', text: '[End of earlier context.]' },
 *   ]}
 *
 * Live tail (the last `keepTail` turns + anything inside an open tool
 * sequence) stays as text. The most-recent assistant turn — the one
 * carrying Opus 4.7's `thinking` signature — is always in the live tail
 * by construction (it's at index `messages.length - 1` when present).
 *
 * The synthesized user message uses `role: 'user'` because Anthropic
 * **forbids `image` blocks inside `role: 'assistant'`** (see
 * `/tmp/pxpipe-history-compression.md` line 14 and `types.ts:58`
 * comments). Self-attribution ("I previously said X") is the price.
 *
 * `thinking` blocks inside the collapsed range are dropped from the
 * rendered text — per the spec's Check 2, only the most-recent
 * assistant-with-tool_use's thinking content must round-trip bit-perfect,
 * and that turn is in the live tail by construction.
 *
 * **Cache-control**: caller controls whether the history-image carries
 * pxpipe's ephemeral breakpoint. This module returns the image blocks
 * unmarked; the caller in `transform.ts` decides placement.
 *
 * Spec source: `/tmp/pxpipe-history-compression.md` Variant C section
 * (round 3, lines 346-364 + check-3 cache-control discussion).
 */

import type { ContentBlock, ImageBlock, Message, TextBlock, ToolUseBlock, ToolResultBlock } from './types.js';
import { DENSE_CONTENT_CHARS_PER_IMAGE, DENSE_CONTENT_COLS, DENSE_RENDER_STYLE, renderTextToPngsWithCharLimit } from './render.js';
import { bytesToBase64 } from './png.js';

/** Function predicate signature for the break-even gate. Passed in by the
 *  caller (transform.ts) rather than imported here to keep `src/core/history.ts`
 *  free of a cycle with `src/core/transform.ts`. transform.ts already imports
 *  history.ts to invoke `collapseHistory`; importing back the other way would
 *  create an evaluation-order trap.
 *
 *  IMPORTANT — takes the full `text`, NOT `text.length`. The downstream
 *  `isCompressionProfitable` has two paths: a row-aware path for strings
 *  (matches renderTextToPngs() image budgeting exactly) and a looser
 *  chars-only fallback for numbers (assumes dense lines, no newlines).
 *  History text is *newline-heavy* — `--- role ---` headers, JSON args,
 *  `[tool_use]` / `[tool_result]` labels — so the chars-only estimate
 *  under-predicts image count by ~5-10× and used to let net-losers
 *  through. The 2026-05-19 production -250% savings measurement traces
 *  back to that asymmetry. Always pass the string. */
export type ProfitableFn = (text: string, cols: number) => boolean;

/** Configuration for history collapse. */
export interface HistoryCollapseOptions {
  /** Number of turns at the tail (most recent) to KEEP as text. Default 4. */
  keepTail: number;
  /** Minimum number of turns in the collapsable prefix before we attempt
   *  the rolling-window re-roll. Below this, leaving them as text costs
   *  almost nothing and the cache-amortization math doesn't work. Default 10. */
  minCollapsePrefix: number;
  /** Soft-wrap column count for the renderer. Should match the host's
   *  configured `cols` so the history image visually matches the system
   *  image. Default 100. */
  cols: number;
  /** Quantize the collapse boundary onto a fixed grid of this many
   *  messages. The collapsed prefix only advances in `collapseChunk`-sized
   *  steps, so the rendered history image stays byte-identical between
   *  steps and keeps hitting Anthropic's prompt cache instead of forcing a
   *  fresh `cache_create` (1.25x) of the whole prefix on every single turn.
   *  Set to 0 for the legacy per-turn moving boundary. Default 50. */
  collapseChunk: number;
}

export const HISTORY_DEFAULTS: HistoryCollapseOptions = {
  keepTail: 4,
  minCollapsePrefix: 10,
  cols: 100,
  collapseChunk: 50,
};

/** Per-request telemetry surfaced back to TransformInfo. */
export interface HistoryCollapseInfo {
  /** Number of turns collapsed into the history image. */
  collapsedTurns: number;
  /** Total chars of text that went into the history image. */
  collapsedChars: number;
  /** Number of PNG image blocks emitted for the history (≥1 if collapsed). */
  collapsedImages: number;
  /** Total PNG bytes emitted. */
  collapsedImageBytes: number;
  /** Total pixel area emitted (`Σ width × height`). Pairs with cold-miss
   *  cache_create tokens for empirical px/token derivation — same role as
   *  `info.imagePixels` in TransformInfo, accumulated here so the caller
   *  can fold history images into the same regression. */
  collapsedImagePixels: number;
  /** Why we didn't collapse — populated only when no collapse happened. */
  reason?:
    | 'no_history'
    | 'prefix_too_short'
    | 'no_closed_prefix'
    | 'not_profitable'
    | 'render_empty';
  /** Dropped codepoints from the history render, merged into the
   *  transform-wide map by the caller. */
  droppedChars: number;
  droppedCodepoints: Map<number, number>;
}


/**
 * Compute the largest index `i*` in `[0..messages.length - keepTail - 1]`
 * such that all `tool_use_id`s issued by assistant turns in `[0..i*]` are
 * matched by `tool_result`s also in `[0..i*]`. Returns `-1` if no such
 * boundary exists (i.e. every potential boundary has a tool_use straddling
 * into the live tail).
 *
 * Algorithm: walk left-to-right. Maintain an `openSet` of unmatched
 * tool_use_ids. After processing each message, record the current openSet
 * size. The closed-prefix boundary is the **last** index ≤ cutoff at which
 * openSet was empty AFTER processing.
 *
 * NOTE: this is robust to interleaved tool_use sequences (e.g. two parallel
 * tool calls in one assistant turn followed by two tool_results in the
 * next user turn). The openSet tracking handles that correctly.
 */
export function findClosedPrefixBoundary(
  messages: Message[],
  cutoffExclusive: number,
): number {
  if (cutoffExclusive <= 0) return -1;
  const openSet = new Set<string>();
  let lastClosed = -1;
  const limit = Math.min(cutoffExclusive, messages.length);
  for (let i = 0; i < limit; i++) {
    const msg = messages[i]!;
    if (!Array.isArray(msg.content)) {
      // Plain string content — no tool blocks possible. Just close-or-stay.
      if (openSet.size === 0) lastClosed = i;
      continue;
    }
    if (msg.role === 'assistant') {
      for (const blk of msg.content) {
        if (blk && (blk as ToolUseBlock).type === 'tool_use') {
          const id = (blk as ToolUseBlock).id;
          if (typeof id === 'string') openSet.add(id);
        }
      }
    } else if (msg.role === 'user') {
      for (const blk of msg.content) {
        if (blk && (blk as ToolResultBlock).type === 'tool_result') {
          const id = (blk as ToolResultBlock).tool_use_id;
          if (typeof id === 'string') openSet.delete(id);
        }
      }
    }
    if (openSet.size === 0) lastClosed = i;
  }
  return lastClosed;
}

/**
 * Linearise a content-block array to a single string for OCR. Drops
 * `thinking` blocks (Opus 4.7+ only requires bit-perfect on the most-recent
 * assistant-with-tool_use, which is in the live tail by construction).
 * Tool-use input args and tool-result content are included so the model
 * has full context. Inline images and tool_result images are reduced to a
 * `[image]` placeholder — embedding them in the history image would
 * double-encode for no benefit.
 */
export function blocksToText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const blk of content) {
    if (!blk || typeof blk !== 'object') continue;
    const t = (blk as { type?: string }).type;
    switch (t) {
      case 'text':
        parts.push((blk as TextBlock).text);
        break;
      case 'tool_use': {
        const tu = blk as ToolUseBlock;
        // Render as a labelled block so the model can re-attribute. Args
        // are serialised COMPACT (no 2-space indent) — pretty-printing
        // bloats the history text ~5× via per-field newlines, which
        // multiplies image cost since the renderer is row-aware and
        // every JSON field gets its own row. Compact JSON wraps at
        // `cols` like normal text, packing ~15.6k chars per single-col
        // image at the 7×10 cell instead of one short line per field.
        let argsStr: string;
        try {
          argsStr = JSON.stringify(tu.input);
        } catch {
          argsStr = String(tu.input);
        }
        parts.push(`[tool_use ${tu.name}]\n${argsStr}`);
        break;
      }
      case 'tool_result': {
        const tr = blk as ToolResultBlock;
        const inner = tr.content;
        let innerText: string;
        if (typeof inner === 'string') {
          innerText = inner;
        } else if (Array.isArray(inner)) {
          const subParts: string[] = [];
          for (const sub of inner) {
            if (!sub || typeof sub !== 'object') continue;
            if ((sub as TextBlock).type === 'text') {
              subParts.push((sub as TextBlock).text);
            } else if ((sub as ImageBlock).type === 'image') {
              subParts.push('[image]');
            }
          }
          innerText = subParts.join('\n');
        } else {
          innerText = '';
        }
        const errMark = tr.is_error === true ? ' (error)' : '';
        parts.push(`[tool_result${errMark}]\n${innerText}`);
        break;
      }
      case 'image':
        parts.push('[image]');
        break;
      // 'thinking' and any other block type → drop silently.
      default:
        break;
    }
  }
  return parts.join('\n\n');
}

/**
 * Serialize messages `[0..upToExclusive]` to a single OCR-friendly text
 * blob. Each turn is prefixed with `--- role ---` so the model can parse
 * the conversation back out. Empty turns are skipped.
 */
export function messagesToHistoryText(
  messages: Message[],
  upToExclusive: number,
): string {
  const out: string[] = [];
  for (let i = 0; i < upToExclusive; i++) {
    const m = messages[i]!;
    const body = blocksToText(m.content);
    if (!body.trim()) continue;
    const tag = m.role === 'assistant' ? 'assistant' : 'user';
    out.push(`--- ${tag} ---\n${body}`);
  }
  return out.join('\n\n');
}

/**
 * Attempt to collapse a closed-prefix run of `messages` into one synthetic
 * user message containing 1+ history images. Returns the rewritten
 * messages array (a new array; original is not mutated) and telemetry.
 *
 * On any "do not collapse" path (no prefix, too few turns, not profitable,
 * empty render), returns the original messages unchanged with a reason.
 *
 * Caller is responsible for cache_control placement on the returned image
 * blocks — this function returns them with NO `cache_control` set.
 */
export async function collapseHistory(
  messages: Message[],
  isProfitable: ProfitableFn,
  opts: Partial<HistoryCollapseOptions> = {},
): Promise<{ messages: Message[]; info: HistoryCollapseInfo }> {
  const o: HistoryCollapseOptions = { ...HISTORY_DEFAULTS, ...opts };
  const info: HistoryCollapseInfo = {
    collapsedTurns: 0,
    collapsedChars: 0,
    collapsedImages: 0,
    collapsedImageBytes: 0,
    collapsedImagePixels: 0,
    droppedChars: 0,
    droppedCodepoints: new Map(),
  };
  if (!messages || messages.length === 0) {
    info.reason = 'no_history';
    return { messages: messages ?? [], info };
  }
  // The live tail must contain at least `keepTail` messages. The boundary
  // search cuts off at `len - keepTail` so the tail is always preserved.
  //
  // Quantize that cutoff onto a fixed grid of `collapseChunk` messages.
  // A moving boundary re-renders the history image — and changes its PNG
  // bytes — on every turn, which misses Anthropic's prompt cache and
  // forces a full `cache_create` (1.25x) of the whole prefix every turn.
  // Snapping to a grid keeps the collapsed prefix — and thus the rendered
  // image — byte-identical for `collapseChunk` turns at a stretch, so the
  // history image caches like Claude Code's native byte-stable history.
  const rawCutoff = messages.length - o.keepTail;
  // Snap the cutoff to the grid, but never below `minCollapsePrefix`. A
  // conversation shorter than one full `collapseChunk` would otherwise
  // floor straight to 0 and skip history compression entirely. Flooring
  // at `minCollapsePrefix` instead keeps the boundary — and therefore the
  // rendered image — byte-stable (the prefix is append-only, so its first
  // `minCollapsePrefix` messages never change) while still collapsing
  // short histories. Clamp to `rawCutoff` so a floor can never reach past
  // the live tail when `rawCutoff < minCollapsePrefix`.
  const cutoff =
    o.collapseChunk > 0
      ? Math.min(
          rawCutoff,
          Math.max(
            o.minCollapsePrefix,
            Math.floor(rawCutoff / o.collapseChunk) * o.collapseChunk,
          ),
        )
      : rawCutoff;
  const boundary = findClosedPrefixBoundary(messages, cutoff);
  if (boundary < 0) {
    info.reason = 'no_closed_prefix';
    return { messages, info };
  }
  // boundary is the last index INCLUDED in the collapse. Need at least
  // `minCollapsePrefix` turns to bother (cache-amortization math from
  // round-3 only works at scale; collapsing 2-3 turns is net cost).
  const collapseLen = boundary + 1;
  if (collapseLen < o.minCollapsePrefix) {
    info.reason = 'prefix_too_short';
    return { messages, info };
  }
  // Serialize and gate on break-even.
  const text = messagesToHistoryText(messages, collapseLen);
  if (!text || text.length === 0) {
    info.reason = 'render_empty';
    return { messages, info };
  }
  // Row-aware: pass the string, not its length. See ProfitableFn jsdoc.
  if (!isProfitable(text, o.cols)) {
    info.reason = 'not_profitable';
    info.collapsedChars = text.length; // surface what we DIDN'T compress
    return { messages, info };
  }
  // Render. No cache_control here — caller decides placement.
  // Dense history is user-visible context, not the static system-slab cache
  // anchor. Render it with the readable dense profile instead of the 313-col
  // full-canvas profile; otherwise lockfiles/code/config collapse into pixel mush.
  const imgs = await renderTextToPngsWithCharLimit(text, DENSE_CONTENT_COLS, DENSE_CONTENT_CHARS_PER_IMAGE, DENSE_RENDER_STYLE);
  if (imgs.length === 0) {
    info.reason = 'render_empty';
    return { messages, info };
  }
  const imageBlocks: ImageBlock[] = [];
  for (const img of imgs) {
    imageBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: bytesToBase64(img.png),
      },
    });
    info.collapsedImageBytes += img.png.length;
    info.collapsedImagePixels += img.width * img.height;
    info.droppedChars += img.droppedChars;
    for (const [cp, n] of img.droppedCodepoints) {
      info.droppedCodepoints.set(cp, (info.droppedCodepoints.get(cp) ?? 0) + n);
    }
  }
  // Build the synthetic user message.
  const syntheticContent: ContentBlock[] = [
    { type: 'text', text: '[Earlier in this conversation:]' },
    ...imageBlocks,
    { type: 'text', text: '[End of earlier context.]' },
  ];
  const syntheticUser: Message = {
    role: 'user',
    content: syntheticContent,
  };
  const tail = messages.slice(collapseLen);
  info.collapsedTurns = collapseLen;
  info.collapsedChars = text.length;
  info.collapsedImages = imageBlocks.length;
  return { messages: [syntheticUser, ...tail], info };
}
