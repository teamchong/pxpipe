/**
 * GPT history-image compression.
 *
 * The static system+tool slab is small (~30k chars); the bulk of a GPT agent
 * request is the conversation transcript, which OpenCode resends in full every
 * turn — the Responses API is driven statelessly here (no `previous_response_id`),
 * so turns 1..N-1 are re-sent as plain text on turn N. pxpipe collapses the OLD
 * closed-tool-call prefix of that transcript into 1-N PNG images and keeps the
 * recent tail as text.
 *
 * OpenAI prompt-caching is automatic and prefix-based: no `cache_control`
 * breakpoints, no 1.25× write premium, cached reads at ~0.1×. The collapse
 * boundary is snapped to a chunk grid so the history image stays byte-identical
 * across turns and keeps hitting that automatic cache (the same flap-avoidance
 * trick src/core/history.ts uses for Anthropic).
 *
 * This mirrors src/core/history.ts but operates on Responses `input` items and
 * Chat `messages` rather than Anthropic Message blocks. The two formats differ
 * enough (function_call/function_call_output vs tool_calls/tool role) that a
 * shared block type isn't worth it; instead each format is lowered to a common
 * HistoryTurn list and the planner/renderer are shared.
 */

import {
  renderTextToPngs,
  reflow,

  neutralizeSentinel,
  type RenderedImage,
  type RenderStyle,
} from './render.js';
import { appendIdsBlock } from './factsheet.js';

import { DEFAULT_GPT_PROFILE, GPT_MAX_HEIGHT_PX } from './gpt-model-profiles.js';
import { countTokens as o200kCountTokens } from 'gpt-tokenizer/encoding/o200k_base';

/** Portrait-strip width for GPT history images. Mirrors GPT_STRIP_COLS in
 *  openai.ts (kept local to avoid a circular import): ≤768px wide so OpenAI
 *  doesn't downscale dense text below its OCR-legibility floor. The 384-col
 *  Anthropic dense profile would be scaled to fit OpenAI's 768px box and become
 *  illegible — that profile is Anthropic-only. */
const GPT_HISTORY_COLS = 152;

// GPT vision latency grows with physical image count/bytes, not just billed tokens.
// Long OpenCode sessions can otherwise turn old history into 80+ images: token-cheap
// but slow enough that gpt-5.5 times out before first token. When this cap trips,
// callers leave the old history as text rather than dropping or de-prioritizing it.
const GPT_HISTORY_MAX_IMAGES = 16;

/** Break-even gate predicate, injected to avoid a circular import with openai.ts.
 *  Receives the full string (not length) so the renderer's row-aware image-count
 *  estimate sees real newlines — history text is newline-heavy. */
export type GptProfitableFn = (text: string, cols: number) => boolean;

export interface GptHistoryOptions {
  /** Trailing items kept as live text (never collapsed). */
  keepTail: number;
  /** Minimum collapsible items in [protectedPrefix..boundary]; below this the
   *  cache-amortization math doesn't pay (imaging a tiny prefix is net cost). */
  minCollapsePrefix: number;
  /** Minimum collapsed-text size in o200k TOKENS (not chars). OpenAI caches the
   *  text transcript at ~0.1× already and bills images by vision tokens, so the
   *  break-even is a token comparison — 8000 chars of dense JSON tokenizes very
   *  differently from 8000 chars of prose. Below this, imaging a tiny prefix is
   *  net cost. */
  minCollapseTokens: number;
  /** Soft-wrap columns for the dense renderer. */
  cols: number;
  /** Advance the collapse boundary in steps of this many items so the rendered
   *  PNG stays byte-identical across turns and keeps hitting the prompt cache.
   *  0 = per-item moving boundary (cache-hostile; tests only). */
  collapseChunk: number;
  /** Render the collapse range as independent image chunks of this many turns on
   *  an ABSOLUTE grid anchored at protectedPrefix. A completed chunk's bytes are
   *  fixed by its turn range alone, so old chunks stay byte-identical (cache_read
   *  forever) as the conversation grows — only the newest partial chunk
   *  re-renders. 0 = render the whole range as one blob (legacy, non-append-only). */
  freezeChunk: number;
  /** Target size of one frozen image SECTION, in o200k tokens. The collapse range
   *  is cut into sections by walking turns from protectedPrefix and sealing a
   *  section each time its cumulative token count crosses this target. A sealed
   *  section's bytes are a pure function of its turn range (independent of where
   *  the conversation currently ends), so it stays byte-identical — and OpenAI
   *  prefix-cache-hits — as the conversation grows. Leftover tail turns that don't
   *  fill a whole section are left UNCOLLAPSED (live text) until they do. Chosen so
   *  each section renders to roughly one ≤6000px image, well under gpt-5.x's
   *  10,000-patch `detail:original` budget. Turn size, not turn count, drives this. */
  sectionTokens: number;
  /** Max rendered image height in px (per-model; from the GPT profile). Threaded
   *  into renderTextToPngs so history pages split at the same height the gate prices. */
  maxHeightPx: number;
  /** Glyph density from the model profile. Empty = production 5x8. */
  style: RenderStyle;
  /** Hard cap on GPT history image count. This is a TRUE cap, not a threshold:
   *  collapse the oldest completed sections until the next section would exceed
   *  the cap, then leave the remaining history as ordinary text. Prevents 80+
   *  image gpt-5.5 requests without dropping context or live tool state. */
  maxImages: number;
  /** Reflow the transcript before rendering: pack soft-wrapped lines and mark
   *  every hard newline with the ↵ sentinel — same treatment as the static
   *  slab. History text is newline-heavy (role headers, JSON args), so without
   *  this each short line wastes a full render row and no ↵ marker appears.
   *  The returned `text` (o200k baseline + cache byte-stability) stays the
   *  ORIGINAL, un-reflowed transcript. */
  reflow: boolean;
  /** Append IDS block for pure-image exact recall (isolated ID rows). Default on. */
  idsBlock: boolean;
}

export const GPT_HISTORY_DEFAULTS: GptHistoryOptions = {
  keepTail: 6,
  minCollapsePrefix: 10,
  minCollapseTokens: 2000,
  cols: GPT_HISTORY_COLS,
  collapseChunk: 10,
  freezeChunk: 10,
  sectionTokens: 2000,
  // GPT path: OpenAI's resize bounds (2048-bbox / 768 short side) permit the tall
  // strip — do NOT re-link to render.ts MAX_HEIGHT_PX (Anthropic's 1568/1.15 MP clamp).
  maxHeightPx: GPT_MAX_HEIGHT_PX,
  style: DEFAULT_GPT_PROFILE.style,
  maxImages: GPT_HISTORY_MAX_IMAGES,
  reflow: true,
  idsBlock: true,
};

/** One conversation item lowered to a renderable unit. */
export interface HistoryTurn {
  /** Serialized text (with role header / tool markers). Empty = skip (e.g. reasoning). */
  text: string;
  /** Tool-call ids this item opens (function_call / assistant tool_calls). */
  openIds: string[];
  /** Tool-call ids this item closes (function_call_output / tool message). */
  closeIds: string[];
  /** Item we can't safely serialize (unknown kind, item_reference) — a hard
   *  barrier: never collapse across it, since dropping it could lose state. */
  opaque: boolean;
  /** Raw body when this item is a real USER request (role==='user', not a tool
   *  result). The planner pins the MOST RECENT such turn as legible text instead
   *  of imaging it, so the live ask is never OCR-only. undefined = not a user turn. */
  userText?: string;
}

export interface GptCollapsePlan {
  /** Rendered history images BEFORE the pinned user turn (or ALL images when no
   *  turn was pinned). Empty when no collapse happened. */
  images: RenderedImage[];
  /** Rendered history images AFTER the pinned user turn. Empty unless a pin split
   *  the range. Total imaged = images ∪ imagesAfter. */
  imagesAfter: RenderedImage[];
  /** Raw text of the most-recent user request, kept legible (NOT imaged) and
   *  spliced between `images` and `imagesAfter`. undefined = nothing pinned. */
  pinText?: string;
  /** The collapsed transcript text that was rendered (for o200k token counting). */
  text: string;
  /** Inclusive start index into the original item array. */
  start: number;
  /** Exclusive end index. Caller splices [start, endExclusive) → one synthetic item. */
  endExclusive: number;
  collapsedTurns: number;
  collapsedChars: number;
  reason?:
    | 'prefix_too_short'
    | 'no_closed_prefix'
    | 'below_min_tokens'
    | 'not_profitable'
    | 'too_many_images'
    | 'render_empty';
  droppedChars: number;
  droppedCodepoints: Map<number, number>;
}

function safeJson(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return String(v ?? '');
  }
}

/** Last index i in [from, cutoffExclusive) where every opened tool-call id has a
 *  matching close. Returns from-1 (no collapse) if none. Stops at the first
 *  opaque barrier so unknown items are never swept into the image. */
function findClosedBoundary(
  turns: HistoryTurn[],
  cutoffExclusive: number,
  from: number,
): number {
  const open = new Set<string>();
  let lastClosed = from - 1;
  const limit = Math.min(cutoffExclusive, turns.length);
  for (let i = from; i < limit; i++) {
    const t = turns[i]!;
    if (t.opaque) break;
    for (const id of t.openIds) open.add(id);
    for (const id of t.closeIds) open.delete(id);
    if (open.size === 0) lastClosed = i;
  }
  return lastClosed;
}

/** True if [from, toExclusive) opens no tool call it doesn't also close (and hits
 *  no opaque barrier). Used to confirm the pinned user turn sits at a tool-closed
 *  boundary so force-sealing the section before it can't orphan a function call. */
function isClosedPrefix(turns: HistoryTurn[], from: number, toExclusive: number): boolean {
  const open = new Set<string>();
  for (let i = from; i < toExclusive; i++) {
    const t = turns[i]!;
    if (t.opaque) return false;
    for (const id of t.openIds) open.add(id);
    for (const id of t.closeIds) open.delete(id);
  }
  return open.size === 0;
}

/** Join turn texts over [from, toExclusive), skipping empties and `skip` (the
 *  pinned turn, which is emitted as text rather than imaged). */
function joinTurns(turns: HistoryTurn[], from: number, toExclusive: number, skip: number): string {
  const parts: string[] = [];
  for (let i = from; i < toExclusive; i++) {
    if (i === skip) continue;
    const s = turns[i]!.text;
    if (s && s.length > 0) parts.push(s);
  }
  return parts.join('\n\n');
}

/**
 * Plan + render a history collapse over pre-lowered turns. Pure w.r.t. the input
 * (caller does the splice and builds the format-specific synthetic item).
 */
export async function planGptCollapse(
  turns: HistoryTurn[],
  protectedPrefix: number,
  isProfitable: GptProfitableFn,
  opts: Partial<GptHistoryOptions> = {},
): Promise<GptCollapsePlan> {
  const o: GptHistoryOptions = { ...GPT_HISTORY_DEFAULTS, ...opts };
  const base: GptCollapsePlan = {
    images: [],
    imagesAfter: [],
    text: '',
    start: 0,
    endExclusive: 0,
    collapsedTurns: 0,
    collapsedChars: 0,
    droppedChars: 0,
    droppedCodepoints: new Map(),
  };
  const pp = Math.max(0, Math.min(protectedPrefix, turns.length));
  const rawCutoff = turns.length - o.keepTail;
  if (rawCutoff - pp < o.minCollapsePrefix) {
    return { ...base, reason: 'prefix_too_short' };
  }
  // Snap the cutoff down to a collapseChunk grid (relative to pp) so the image
  // stays byte-stable across turns. Floor at pp + minCollapsePrefix.
  const cutoff =
    o.collapseChunk > 0
      ? Math.min(
          rawCutoff,
          Math.max(
            pp + o.minCollapsePrefix,
            pp + Math.floor((rawCutoff - pp) / o.collapseChunk) * o.collapseChunk,
          ),
        )
      : rawCutoff;
  const boundary = findClosedBoundary(turns, cutoff, pp);
  if (boundary < pp) {
    return { ...base, reason: 'no_closed_prefix' };
  }
  if (boundary + 1 - pp < o.minCollapsePrefix) {
    return { ...base, reason: 'prefix_too_short' };
  }
  const rawEnd = boundary + 1;
  // Pin the LIVE request — the most-recent user turn OVERALL — as legible TEXT so it
  // is never OCR-only. Older user turns stay imaged (they must NOT look like the live
  // request; that's the snap-to-first-prompt guard). The history BEFORE and AFTER the
  // pin both stay imaged, so compression holds.
  //
  // CRITICAL: pin ONLY when the latest user turn falls INSIDE the collapse range. If
  // it sits in the kept tail (ordinary interactive turn) it is already native text —
  // pinning an OLDER in-range user turn would make the pin migrate across collapse-
  // chunk boundaries and re-image frozen history (cache churn). Restricting the pin to
  // the latest user turn means its position is fixed until the next prompt, so the
  // before/after section grid stays byte-stable across a long run. This covers exactly
  // the two shapes that need it: the autonomous single-prompt agent (pin == pp), and a
  // long current turn whose tool loop overflowed the tail (pin in the middle).
  let pinIdx = -1;
  for (let i = turns.length - 1; i >= pp; i--) {
    if (turns[i]!.userText !== undefined) { pinIdx = i; break; }
  }
  if (pinIdx >= rawEnd) pinIdx = -1; // latest user turn is in the live tail → already text
  // Only pin at a tool-closed boundary: a user turn straddled by an open tool call
  // (malformed input) would orphan the call when we seal the section before it.
  if (pinIdx >= 0 && !isClosedPrefix(turns, pp, pinIdx)) pinIdx = -1;

  // Imaged baseline EXCLUDES the pinned turn (it is emitted as text, not rendered).
  const text = joinTurns(turns, pp, rawEnd, pinIdx);
  // Floor gate in o200k TOKENS, not chars: imaging bills vision tokens and the
  // text baseline is o200k tokens, so the break-even is a token comparison.
  // NOTE: this counts the IMAGEABLE work only (pin excluded), so a small history
  // whose non-pin content is below the floor is left fully as text. That is correct,
  // not a regression: the pinned request stays legible either way, and imaging a
  // sub-floor amount of work would cost more vision tokens than it saves. Only long
  // sessions (where the bug lived) clear the floor and collapse.
  if (!text || gptCountTokens(text) < o.minCollapseTokens) {
    return { ...base, reason: 'below_min_tokens', collapsedChars: text?.length ?? 0 };
  }
  // Reflow for RENDERING ONLY: pack soft-wrapped lines and mark hard newlines
  // with the ↵ sentinel so the history image is as dense as the static slab
  // (newline-heavy transcripts otherwise burn a full row per short line and
  // show no ↵). `text` itself stays original — it backs the o200k baseline and
  // the chunk-snapped cache byte-stability, so it must not change shape here.
  const safeText = neutralizeSentinel(text);
  let renderText = o.reflow ? reflow(safeText) ?? safeText : text;
  if (o.idsBlock) renderText = appendIdsBlock(renderText);
  if (!isProfitable(renderText, o.cols)) {
    return { ...base, reason: 'not_profitable', collapsedChars: text.length };
  }
  // APPEND-ONLY, TOKEN-LENGTH sectioning. Cut the closed prefix [pp..rawEnd) into
  // sections of ~sectionTokens o200k tokens by walking turns from pp and sealing a
  // section each time its cumulative token count crosses the target. A sealed
  // section's bytes are a pure function of its turn range — independent of where
  // the conversation currently ends — so old sections stay byte-identical (OpenAI
  // prefix-cache hit) as turns are appended; only freshly-sealed sections are new.
  // Leftover tail turns that don't fill a whole section are NOT collapsed: collapse
  // ends at the last SEALED boundary so every emitted image is a frozen section.
  // (freezeChunk 0 = legacy whole-blob: one section spanning the whole range.)
  // The pinned turn force-seals the section before it and starts a fresh section
  // after it, so no image straddles the live request (history stays imaged on both
  // sides). (freezeChunk 0 = legacy whole-blob, still split around the pin.)
  const sections: Array<[number, number]> = [];
  if (o.freezeChunk <= 0) {
    if (pinIdx > pp) sections.push([pp, pinIdx]);
    const afterStart = pinIdx >= pp ? pinIdx + 1 : pp;
    if (afterStart < rawEnd) sections.push([afterStart, rawEnd]);
  } else {
    let secStart = pp;
    let acc = 0;
    // Track open tool-call ids so a section is only sealed at a TOOL-CLOSED point.
    // The token threshold can otherwise land between a function_call and its
    // function_call_output: the call gets imaged while the output stays a live
    // item, and OpenAI rejects the orphan with "No tool call found for function
    // call output" (400). The overall [pp, rawEnd) boundary being closed does NOT
    // protect the intermediate section cut — collapseEnd is the live boundary, so
    // it (and every seal) must itself be tool-closed. Anthropic doesn't hit this
    // because it collapses the whole closed prefix with no live leftover.
    const open = new Set<string>();
    for (let i = pp; i < rawEnd; i++) {
      if (i === pinIdx) {
        // Force-seal the before-pin section (open is empty here by isClosedPrefix)
        // and skip the pin so it is never imaged. If the remainder since the last
        // seal is too small to be worth its own image, MERGE it into the previous
        // before-section (a slightly oversized image) rather than emitting a sub-
        // threshold one — imaging ~200 tokens costs more in vision tokens than it
        // saves. (open is empty here, so extending the prior section can't orphan.)
        if (secStart < i) {
          const prev = sections[sections.length - 1];
          if (acc < o.sectionTokens && prev && prev[1] === secStart) {
            prev[1] = i; // extend previous before-section through the remainder
          } else {
            sections.push([secStart, i]);
          }
        }
        secStart = i + 1;
        acc = 0;
        continue;
      }
      acc += gptCountTokens(turns[i]!.text);
      for (const id of turns[i]!.openIds) open.add(id);
      for (const id of turns[i]!.closeIds) open.delete(id);
      if (acc >= o.sectionTokens && open.size === 0) {
        sections.push([secStart, i + 1]);
        secStart = i + 1;
        acc = 0;
      }
    }
    // Trailing turns [secStart, rawEnd) didn't fill a section → leave as live text.
  }
  if (sections.length === 0) {
    // Closed prefix cleared the floor but no single section sealed (only when
    // sectionTokens > the whole prefix). Treat as below-min rather than emit a
    // cache-unstable partial blob.
    return { ...base, reason: 'below_min_tokens', collapsedChars: text.length };
  }
  const maxImages = Math.max(0, Math.floor(o.maxImages));
  const rendered: Array<{ s: number; e: number; imgs: RenderedImage[] }> = [];
  let imgCount = 0;
  let collapseEnd = pp;
  for (const [s, e] of sections) {
    const sectionText = joinTurns(turns, s, e, -1);
    if (!sectionText || sectionText.length === 0) continue;
    const safeSection = neutralizeSentinel(sectionText);
    let sectionRender = o.reflow ? reflow(safeSection) ?? safeSection : sectionText;
    if (o.idsBlock) sectionRender = appendIdsBlock(sectionRender);
    // Readable portrait strips (≤768px wide) — legible to OpenAI vision, same as
    // the static slab. renderTextToPngs caps each PNG at MAX_HEIGHT_PX so a tall
    // section pages into N images, all still well under the 10,000-patch budget.
    const sectionImgs = await renderTextToPngs(sectionRender, o.cols, o.style ?? {}, o.maxHeightPx);
    if (imgCount + sectionImgs.length > maxImages) {
      // TRUE cap: keep the sections already selected, leave this and every later
      // section (and the pin, if not yet reached) as normal text in the remainder.
      break;
    }
    rendered.push({ s, e, imgs: sectionImgs });
    imgCount += sectionImgs.length;
    collapseEnd = e;
  }
  // The pin is "consumed" (emitted as text inside the synthetic) only once we have
  // collapsed PAST it. If the image cap stopped us before the pin, it survives as a
  // native user message in the untouched remainder — still legible, no work lost.
  const pinConsumed = pinIdx >= pp && collapseEnd > pinIdx;
  const imagesBefore: RenderedImage[] = [];
  const imagesAfter: RenderedImage[] = [];
  for (const r of rendered) {
    if (pinConsumed && r.s >= pinIdx + 1) imagesAfter.push(...r.imgs);
    else imagesBefore.push(...r.imgs);
  }
  if (imagesBefore.length === 0 && imagesAfter.length === 0) {
    // First section alone exceeded the cap (or cap <= 0). Fall back to text.
    return { ...base, reason: 'too_many_images', collapsedChars: text.length };
  }
  const pinText = pinConsumed ? turns[pinIdx]!.userText : undefined;
  // The collapsed transcript / o200k baseline reflects ONLY what we imaged — the
  // pin, when consumed, is text and is excluded from the imaged baseline.
  const collapsedText = joinTurns(turns, pp, collapseEnd, pinConsumed ? pinIdx : -1);
  const droppedCodepoints = new Map<number, number>();
  let droppedChars = 0;
  for (const img of [...imagesBefore, ...imagesAfter]) {
    droppedChars += img.droppedChars;
    for (const [cp, n] of img.droppedCodepoints) {
      droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + n);
    }
  }
  return {
    images: imagesBefore,
    imagesAfter,
    pinText,
    text: collapsedText,
    start: pp,
    endExclusive: collapseEnd,
    collapsedTurns: collapseEnd - pp - (pinConsumed ? 1 : 0),
    collapsedChars: collapsedText.length,
    droppedChars,
    droppedCodepoints,
  };
}

/** o200k_base token count — gpt-5 / gpt-4o / o-series share this encoding.
 *  Used for the history collapse floor (token-, not char-based). */
function gptCountTokens(text: string): number {
  if (!text) return 0;
  try {
    return o200kCountTokens(text);
  } catch {
    return 0;
  }
}

// ---- Responses API lowering -------------------------------------------------

function responsesContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    const t = (p as { type?: string }).type;
    if (t === 'input_text' || t === 'output_text' || t === 'text' || t === 'summary_text') {
      const txt = (p as { text?: unknown }).text;
      if (typeof txt === 'string') parts.push(txt);
    } else if (t === 'input_image' || t === 'image' || t === 'output_image') {
      parts.push('[image]');
    } else if (t === 'refusal') {
      const r = (p as { refusal?: unknown }).refusal;
      if (typeof r === 'string') parts.push(r);
    }
  }
  return parts.join('\n');
}

function responsesItemToTurn(item: unknown, idx: number): HistoryTurn {
  const o = (item ?? {}) as Record<string, unknown>;
  const type = typeof o.type === 'string' ? o.type : undefined;
  if (type === 'reasoning') {
    return { text: '', openIds: [], closeIds: [], opaque: false };
  }
  if (type === 'function_call') {
    const callId =
      typeof o.call_id === 'string' ? o.call_id : typeof o.id === 'string' ? o.id : '';
    const name = typeof o.name === 'string' ? o.name : 'tool';
    const args = typeof o.arguments === 'string' ? o.arguments : safeJson(o.arguments);
    return {
      text: `[tool_use ${name}]\n${args}`,
      openIds: callId ? [callId] : [],
      closeIds: [],
      opaque: false,
    };
  }
  if (type === 'function_call_output') {
    const callId = typeof o.call_id === 'string' ? o.call_id : '';
    const out = typeof o.output === 'string' ? o.output : safeJson(o.output);
    return {
      text: `[tool_result]\n${out}`,
      openIds: [],
      closeIds: callId ? [callId] : [],
      opaque: false,
    };
  }
  const role = typeof o.role === 'string' ? o.role : undefined;
  if (role) {
    const body = responsesContentToText(o.content);
    if (!body.trim()) return { text: '', openIds: [], closeIds: [], opaque: false };
    const tag = role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : role;
    // Absolute turn index (item position) — recency anchor so the model can tell turn 1
    // from turn 60 instead of resurfacing the salient opening turn. Stable per item →
    // cache-safe (mirrors src/core/history.ts). Tool turns stay unindexed (not mistakable
    // for a live request); the index rides the conversational role tags.
    return {
      text: `<${tag} t="${idx}">\n${body}\n</${tag}>`,
      openIds: [],
      closeIds: [],
      opaque: false,
      userText: role === 'user' ? body : undefined,
    };
  }
  // Unknown item kind (e.g. item_reference) we can't safely serialize → barrier.
  return { text: '', openIds: [], closeIds: [], opaque: true };
}

export function responsesItemsToTurns(items: unknown[]): HistoryTurn[] {
  return items.map((item, i) => responsesItemToTurn(item, i));
}

// ---- Chat Completions lowering ----------------------------------------------

function chatContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    const t = (p as { type?: string }).type;
    if (t === 'text') {
      const txt = (p as { text?: unknown }).text;
      if (typeof txt === 'string') parts.push(txt);
    } else if (t === 'image_url' || t === 'input_image' || t === 'image') {
      parts.push('[image]');
    }
  }
  return parts.join('\n');
}

function chatMessageToTurn(msg: unknown, idx: number): HistoryTurn {
  const o = (msg ?? {}) as Record<string, unknown>;
  const role = typeof o.role === 'string' ? o.role : '';
  const body = chatContentToText(o.content);
  if (role === 'tool') {
    const id = typeof o.tool_call_id === 'string' ? o.tool_call_id : '';
    return {
      text: `[tool_result]\n${body}`,
      openIds: [],
      closeIds: id ? [id] : [],
      opaque: false,
    };
  }
  if (role === 'assistant') {
    const openIds: string[] = [];
    const parts: string[] = [];
    if (body.trim()) parts.push(body);
    const tc = o.tool_calls;
    if (Array.isArray(tc)) {
      for (const call of tc) {
        const c = (call ?? {}) as Record<string, unknown>;
        const id = typeof c.id === 'string' ? c.id : '';
        if (id) openIds.push(id);
        const fn = c.function as Record<string, unknown> | undefined;
        const name = fn && typeof fn.name === 'string' ? fn.name : 'tool';
        const args =
          fn && typeof fn.arguments === 'string' ? fn.arguments : safeJson(fn?.arguments);
        parts.push(`[tool_use ${name}]\n${args}`);
      }
    }
    const text = parts.join('\n');
    return {
      text: text.trim() ? `<assistant t="${idx}">\n${text}\n</assistant>` : '',
      openIds,
      closeIds: [],
      opaque: false,
    };
  }
  if (!body.trim()) return { text: '', openIds: [], closeIds: [], opaque: false };
  const tag = role === 'user' ? 'user' : role || 'user';
  return {
    text: `<${tag} t="${idx}">\n${body}\n</${tag}>`,
    openIds: [],
    closeIds: [],
    opaque: false,
    userText: role === 'user' ? body : undefined,
  };
}

export function chatMessagesToTurns(messages: unknown[]): HistoryTurn[] {
  return messages.map((msg, i) => chatMessageToTurn(msg, i));
}
