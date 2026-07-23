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
const GPT_HISTORY_MAX_IMAGES = 32;

/** Break-even gate predicate, injected to avoid a circular import with openai.ts.
 *  Receives the full string (not length) so the renderer's row-aware image-count
 *  estimate sees real newlines — history text is newline-heavy. */
export type GptProfitableFn = (
  text: string,
  cols: number,
  baselineTextTokens?: number,
) => boolean;

export interface GptHistoryOptions {
  /** Trailing items kept as live text (never collapsed). */
  keepTail: number;
  /** Total Responses history-image budget. The static slab has its own images. */
  maxImages: number;
  /** Responses only: newest completed function-call/output pairs kept native.
   *  Open calls and malformed/orphan items are always native regardless of this value. */
  keepRecentPairs: number;
  /** Responses selection policy. `pairs` preserves legacy call/output-only behavior;
   *  `mixed` also images safe old user/assistant messages between protocol barriers. */
  responsesMode: 'pairs' | 'mixed';
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
  /** Reflow the transcript before rendering: pack soft-wrapped lines and mark
   *  every hard newline with the ↵ sentinel — same treatment as the static
   *  slab. History text is newline-heavy (role headers, JSON args), so without
   *  this each short line wastes a full render row and no ↵ marker appears.
   *  The returned `text` (o200k baseline + cache byte-stability) stays the
   *  ORIGINAL, un-reflowed transcript. */
  reflow: boolean;
}

export const GPT_HISTORY_DEFAULTS: GptHistoryOptions = {
  keepTail: 6,
  keepRecentPairs: 6,
  responsesMode: 'pairs',
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

export interface ResponsesPairState {
  /** Strict adjacent call/output pairs found in the original request. */
  completedPairs: number;
  /** Newest completed pairs deliberately retained as native Responses items. */
  recentCompletedPairs: number;
  /** Older completed pairs eligible for image serialization before render caps/gates. */
  oldCompletedPairs: number;
  /** Calls with no output in this request: active/open state, always native. */
  openCalls: number;
  /** Outputs without a unique preceding call, always native. */
  orphanOutputs: number;
  /** Duplicate, reversed, or non-adjacent shapes that cannot be paired safely. */
  malformedItems: number;
  /** Original-request o200k bucket share belonging to eligible old pairs. */
  imageableFunctionCallTokens: number;
  imageableFunctionOutputTokens: number;
  /** Eligible pairs actually removed from native input and represented by images. */
  collapsedPairs: number;
  collapsedFunctionCallTokens: number;
  collapsedFunctionOutputTokens: number;
}

export interface ResponsesPairCollapseSegment {
  /** Position of the original function call. The synthetic image item is inserted here. */
  insertAt: number;
  selectedIndices: number[];
  images: RenderedImage[];
  imageSources: string[];
  text: string;
  /** Original native-content token value represented by this rendered segment. */
  baselineTokens?: number;
}

export interface ResponsesPairCollapsePlan extends GptCollapsePlan {
  /** Complete call/output replacements, each kept at its original position. */
  segments: ResponsesPairCollapseSegment[];
  selectedIndices: number[];
  pairState: ResponsesPairState;
}

export interface GptCollapsePlan {
  /** Rendered history images BEFORE the pinned user turn (or ALL images when no
   *  turn was pinned). Empty when no collapse happened. */
  images: RenderedImage[];
  /** Rendered history images AFTER the pinned user turn. Empty unless a pin split
   *  the range. Total imaged = images ∪ imagesAfter. */
  imagesAfter: RenderedImage[];
  /** Original source text parallel to images/imagesAfter. Each rendered page
   *  points to the sealed section that produced it (repeated for multipage sections). */
  imageSources: string[];
  imageSourcesAfter: string[];
  /** Raw text of the most-recent user request, kept legible (NOT imaged) and
   *  spliced between `images` and `imagesAfter`. undefined = nothing pinned. */
  pinText?: string;
  /** The collapsed transcript text that was rendered (for o200k token counting). */
  text: string;
  /** Original native-content token value when rendered framing adds synthetic text. */
  baselineTokens?: number;
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
    imageSources: [],
    imageSourcesAfter: [],
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
  const imageSources: string[] = [];
  const imageSourcesAfter: string[] = [];
  for (const r of rendered) {
    // Source preview uses the original serialized section (not reflow/IDS) so it
    // remains byte-exact. Multipage sections repeat the same source for each PNG.
    const source = joinTurns(turns, r.s, r.e, -1);
    if (pinConsumed && r.s >= pinIdx + 1) {
      imagesAfter.push(...r.imgs);
      imageSourcesAfter.push(...r.imgs.map(() => source));
    } else {
      imagesBefore.push(...r.imgs);
      imageSources.push(...r.imgs.map(() => source));
    }
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
    imageSources,
    imageSourcesAfter,
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

// ---- Responses completed-pair planning -------------------------------------

function responseCallText(item: Record<string, unknown>): string {
  const name = typeof item.name === 'string' ? item.name : 'tool';
  const args = typeof item.arguments === 'string'
    ? item.arguments
    : safeJson(item.arguments);
  return `[tool_use ${name}]\n${args}`;
}

function responseOutputText(item: Record<string, unknown>): string {
  const output = typeof item.output === 'string' ? item.output : safeJson(item.output);
  return `[tool_result]\n${output}`;
}

interface ResponsesCompletedPair {
  callIndex: number;
  outputIndex: number;
  text: string;
  callTokens: number;
  outputTokens: number;
}

/** One protocol-atomic tool round. OpenCode emits parallel tools as
 * call A, call B, …, output A, output B, …; removing only one pair would leave
 * the native round structurally incomplete. A round is therefore the smallest
 * unit the planner may select. */
interface ResponsesCompletedRound {
  pairs: ResponsesCompletedPair[];
  indices: number[];
  startIndex: number;
  endIndex: number;
  text: string;
  callTokens: number;
  outputTokens: number;
}

function responseItemType(item: unknown): string {
  const o = item as Record<string, unknown> | null;
  return o && typeof o.type === 'string' ? o.type : '';
}

function responseCallId(item: unknown): string {
  const o = item as Record<string, unknown> | null;
  return o && typeof o.call_id === 'string' ? o.call_id : '';
}

interface ResponsesMessageText {
  role: 'user' | 'assistant';
  text: string;
}

/** Return a lossless textual Responses message, or null when the item carries
 * non-text content that must stay native (images, unknown parts, empty state). */
function responseMessageText(item: unknown): ResponsesMessageText | null {
  const o = item as Record<string, unknown> | null;
  if (!o || (o.role !== 'user' && o.role !== 'assistant')) return null;
  const itemType = typeof o.type === 'string' ? o.type : '';
  if (itemType && itemType !== 'message') return null;
  let body = '';
  if (typeof o.content === 'string') {
    body = o.content;
  } else if (Array.isArray(o.content)) {
    const parts: string[] = [];
    for (const part of o.content) {
      const p = part as Record<string, unknown> | null;
      const type = p && typeof p.type === 'string' ? p.type : '';
      if (!p || !['input_text', 'output_text', 'text'].includes(type) || typeof p.text !== 'string') {
        return null;
      }
      parts.push(p.text);
    }
    body = parts.join('\n\n');
  } else {
    return null;
  }
  if (!body.trim()) return null;
  return { role: o.role, text: body };
}

function responseMessageTranscript(item: unknown, index: number): string | null {
  const msg = responseMessageText(item);
  return msg ? `<${msg.role} t="${index}">\n${msg.text}\n</${msg.role}>` : null;
}

function responseReferencedIds(items: unknown[]): Set<string> {
  const refs = new Set<string>();
  for (const item of items) {
    const o = item as Record<string, unknown> | null;
    if (!o || o.type !== 'item_reference') continue;
    for (const key of ['id', 'item_id', 'ref_id']) {
      if (typeof o[key] === 'string' && o[key]) refs.add(o[key] as string);
    }
  }
  return refs;
}

/** Classify Responses tool state without interpreting recency from raw item count.
 * Accept both adjacent pairs and protocol-atomic parallel rounds:
 * `call A, call B, output A, output B`. Unknown/intervening native items remain
 * hard barriers, and duplicate/reversed/orphan state is never selected. */
function classifyResponsesPairs(
  items: unknown[],
  keepRecentPairs: number,
): { old: ResponsesCompletedRound[]; state: ResponsesPairState } {
  const calls = new Map<string, number[]>();
  const outputs = new Map<string, number[]>();
  let missingIdItems = 0;
  for (let i = 0; i < items.length; i++) {
    const type = responseItemType(items[i]);
    if (type !== 'function_call' && type !== 'function_call_output') continue;
    const id = responseCallId(items[i]);
    if (!id) { missingIdItems++; continue; }
    const map = type === 'function_call' ? calls : outputs;
    const at = map.get(id) ?? [];
    at.push(i);
    map.set(id, at);
  }

  const pairByCallIndex = new Map<number, ResponsesCompletedPair>();
  let openCalls = 0;
  let orphanOutputs = 0;
  let malformedItems = missingIdItems;
  const ids = new Set([...calls.keys(), ...outputs.keys()]);
  for (const id of ids) {
    const cs = calls.get(id) ?? [];
    const os = outputs.get(id) ?? [];
    if (cs.length === 1 && os.length === 1 && cs[0]! < os[0]!) {
      const callIndex = cs[0]!;
      const outputIndex = os[0]!;
      const call = items[callIndex] as Record<string, unknown>;
      const output = items[outputIndex] as Record<string, unknown>;
      pairByCallIndex.set(callIndex, {
        callIndex,
        outputIndex,
        text: `${responseCallText(call)}\n${responseOutputText(output)}`,
        // Match measureResponsesComposition exactly so the share is comparable
        // to its functionCalls/functionOutputs buckets.
        callTokens: gptCountTokens(JSON.stringify(call)),
        outputTokens: gptCountTokens(
          typeof output.output === 'string' ? output.output : safeJson(output.output),
        ),
      });
    } else if (cs.length > 0 && os.length === 0) openCalls += cs.length;
    else if (os.length > 0 && cs.length === 0) orphanOutputs += os.length;
    else malformedItems += cs.length + os.length;
  }

  // Discover contiguous calls* + outputs* rounds. A candidate unique pair that
  // does not fit one of these rounds is non-adjacent protocol state and remains
  // native. This is the shape OpenCode uses for parallel tool calls.
  const completed: ResponsesCompletedRound[] = [];
  const acceptedCallIndices = new Set<number>();
  for (let i = 0; i < items.length;) {
    if (responseItemType(items[i]) !== 'function_call' || !pairByCallIndex.has(i)) {
      i++;
      continue;
    }
    const calls: ResponsesCompletedPair[] = [];
    let j = i;
    while (responseItemType(items[j]) === 'function_call' && pairByCallIndex.has(j)) {
      calls.push(pairByCallIndex.get(j)!);
      j++;
    }
    const roundOutputIndices = new Set(calls.map((pair) => pair.outputIndex));
    const outputs: number[] = [];
    // Do not absorb an output belonging to orphan/other state into this round.
    while (
      responseItemType(items[j]) === 'function_call_output'
      && roundOutputIndices.has(j)
    ) {
      outputs.push(j);
      j++;
    }
    const outputSet = new Set(outputs);
    const valid = calls.length > 0
      && outputs.length === calls.length
      && calls.every((pair) => outputSet.has(pair.outputIndex));
    if (!valid) {
      i++;
      continue;
    }
    const byOutput = [...calls].sort((a, b) => a.outputIndex - b.outputIndex);
    const indices = [
      ...calls.map((pair) => pair.callIndex),
      ...byOutput.map((pair) => pair.outputIndex),
    ];
    completed.push({
      pairs: calls,
      indices,
      startIndex: i,
      endIndex: j - 1,
      text: byOutput.map((pair) => pair.text).join('\n\n'),
      callTokens: calls.reduce((sum, pair) => sum + pair.callTokens, 0),
      outputTokens: calls.reduce((sum, pair) => sum + pair.outputTokens, 0),
    });
    for (const pair of calls) acceptedCallIndices.add(pair.callIndex);
    i = j;
  }
  for (const pair of pairByCallIndex.values()) {
    if (!acceptedCallIndices.has(pair.callIndex)) malformedItems += 2;
  }

  const keep = Math.max(0, Math.floor(keepRecentPairs));
  let recentStart = completed.length;
  let recentPairs = 0;
  while (recentStart > 0 && recentPairs < keep) {
    recentStart--;
    recentPairs += completed[recentStart]!.pairs.length;
  }
  const old = completed.slice(0, recentStart);
  const completedPairs = completed.reduce((n, round) => n + round.pairs.length, 0);
  const oldPairs = old.reduce((n, round) => n + round.pairs.length, 0);
  const imageableFunctionCallTokens = old.reduce((n, round) => n + round.callTokens, 0);
  const imageableFunctionOutputTokens = old.reduce((n, round) => n + round.outputTokens, 0);
  return {
    old,
    state: {
      completedPairs,
      recentCompletedPairs: completedPairs - oldPairs,
      oldCompletedPairs: oldPairs,
      openCalls,
      orphanOutputs,
      malformedItems,
      imageableFunctionCallTokens,
      imageableFunctionOutputTokens,
      collapsedPairs: 0,
      collapsedFunctionCallTokens: 0,
      collapsedFunctionOutputTokens: 0,
    },
  };
}

function emptyResponsesPairPlan(state: ResponsesPairState): ResponsesPairCollapsePlan {
  return {
    images: [], imagesAfter: [], imageSources: [], imageSourcesAfter: [],
    text: '', start: 0, endExclusive: 0, collapsedTurns: 0,
    collapsedChars: 0, droppedChars: 0, droppedCodepoints: new Map(),
    segments: [], selectedIndices: [], pairState: state,
  };
}

interface ResponsesMixedUnit {
  indices: number[];
  text: string;
  baselineTokens: number;
}

/** Profile-gated broad Responses planner. Safe textual messages and complete old
 * call/output pairs may share one image group only when they are contiguous.
 * Every other item is a hard barrier, preserving native protocol order/state. */
async function planResponsesMixedCollapse(
  items: unknown[],
  old: ResponsesCompletedRound[],
  state: ResponsesPairState,
  isProfitable: GptProfitableFn,
  o: GptHistoryOptions,
): Promise<ResponsesPairCollapsePlan> {
  const base = emptyResponsesPairPlan(state);
  const oldByCall = new Map(old.map((round) => [round.startIndex, round]));
  const messageIndices: number[] = [];
  const referencedIds = responseReferencedIds(items);
  let latestUserIndex = -1;
  for (let i = 0; i < items.length; i++) {
    const msg = responseMessageText(items[i]);
    if (!msg) continue;
    messageIndices.push(i);
    if (msg.role === 'user') latestUserIndex = i;
  }
  const protectedMessages = new Set(
    messageIndices.slice(-Math.max(0, Math.floor(o.keepTail))),
  );
  if (latestUserIndex >= 0) protectedMessages.add(latestUserIndex);

  const runs: ResponsesMixedUnit[][] = [];
  let current: ResponsesMixedUnit[] = [];
  const flush = (): void => {
    if (current.length > 0) runs.push(current);
    current = [];
  };
  for (let i = 0; i < items.length; i++) {
    const round = oldByCall.get(i);
    const roundReferenced = !!round && round.indices
      .map((index) => items[index] as Record<string, unknown> | null)
      .map((item) => item?.id)
      .some((id) => typeof id === 'string' && referencedIds.has(id));
    if (round && !roundReferenced) {
      current.push({
        indices: round.indices,
        text: round.text,
        baselineTokens: round.callTokens + round.outputTokens,
      });
      i = round.endIndex;
      continue;
    }
    const item = items[i] as Record<string, unknown> | null;
    const referenced = !!item && typeof item.id === 'string' && referencedIds.has(item.id);
    const text = protectedMessages.has(i) || referenced ? null : responseMessageTranscript(items[i], i);
    if (text) {
      current.push({
        indices: [i],
        text,
        baselineTokens: gptCountTokens(responseMessageText(items[i])!.text),
      });
      continue;
    }
    flush();
  }
  flush();

  const eligible = runs.flat();
  const allText = eligible.map((unit) => unit.text).join('\n\n');
  const allBaselineTokens = eligible.reduce((sum, unit) => sum + unit.baselineTokens, 0);
  if (eligible.length === 0) return { ...base, reason: 'no_closed_prefix' };
  if (allBaselineTokens < o.minCollapseTokens) {
    return { ...base, reason: 'below_min_tokens', collapsedChars: allText.length };
  }
  const maxImages = Math.max(0, Math.floor(o.maxImages));
  if (maxImages === 0) {
    return { ...base, reason: 'too_many_images', collapsedChars: allText.length };
  }

  const renderUnits = async (units: ResponsesMixedUnit[]) => {
    const source = units.map((unit) => unit.text).join('\n\n');
    const safe = neutralizeSentinel(source);
    const renderedText = o.reflow ? reflow(safe) ?? safe : safe;
    const images = await renderTextToPngs(renderedText, o.cols, o.style ?? {}, o.maxHeightPx);
    return { source, renderedText, images };
  };

  const segments: ResponsesPairCollapseSegment[] = [];
  let remainingImages = maxImages;
  let hitImageCap = false;
  for (const run of runs) {
    if (remainingImages === 0) { hitImageCap = true; break; }
    let low = 0;
    let high = run.length + 1;
    let best: Awaited<ReturnType<typeof renderUnits>> | undefined;
    while (low + 1 < high) {
      const count = Math.floor((low + high) / 2);
      const rendered = await renderUnits(run.slice(0, count));
      if (rendered.images.length > 0 && rendered.images.length <= remainingImages) {
        low = count;
        best = rendered;
      } else {
        high = count;
      }
    }
    if (!best || low === 0) { hitImageCap = true; break; }
    const selected = run.slice(0, low);
    const selectedBaselineTokens = selected.reduce((sum, unit) => sum + unit.baselineTokens, 0);
    if (!isProfitable(best.renderedText, o.cols, selectedBaselineTokens)) continue;
    const selectedIndices = selected.flatMap((unit) => unit.indices).sort((a, b) => a - b);
    segments.push({
      insertAt: selectedIndices[0]!,
      selectedIndices,
      images: best.images,
      imageSources: best.images.map(() => best.source),
      text: best.source,
      baselineTokens: selectedBaselineTokens,
    });
    remainingImages -= best.images.length;
    if (low < run.length) { hitImageCap = true; break; }
  }

  if (segments.length === 0) {
    return {
      ...base,
      reason: hitImageCap ? 'too_many_images' : 'not_profitable',
      collapsedChars: allText.length,
    };
  }
  const selectedIndices = segments.flatMap((segment) => segment.selectedIndices).sort((a, b) => a - b);
  const selectedIds = new Set(selectedIndices);
  const selectedRounds = old.filter((round) => round.indices.every((index) => selectedIds.has(index)));
  state.collapsedPairs = selectedRounds.reduce((n, round) => n + round.pairs.length, 0);
  state.collapsedFunctionCallTokens = selectedRounds.reduce((n, round) => n + round.callTokens, 0);
  state.collapsedFunctionOutputTokens = selectedRounds.reduce((n, round) => n + round.outputTokens, 0);
  const images = segments.flatMap((segment) => segment.images);
  const imageSources = segments.flatMap((segment) => segment.imageSources);
  const text = segments.map((segment) => segment.text).join('\n\n');
  const baselineTokens = segments.reduce((sum, segment) => sum + (segment.baselineTokens ?? 0), 0);
  const droppedCodepoints = new Map<number, number>();
  let droppedChars = 0;
  for (const image of images) {
    droppedChars += image.droppedChars;
    for (const [codepoint, count] of image.droppedCodepoints) {
      droppedCodepoints.set(codepoint, (droppedCodepoints.get(codepoint) ?? 0) + count);
    }
  }
  return {
    ...base,
    segments,
    images,
    imageSources,
    text,
    baselineTokens,
    start: selectedIndices[0] ?? 0,
    endExclusive: (selectedIndices.at(-1) ?? -1) + 1,
    collapsedTurns: selectedIndices.length,
    collapsedChars: text.length,
    droppedChars,
    droppedCodepoints,
    selectedIndices,
    pairState: state,
  };
}

/** Render only old, unambiguously completed Responses call/output rounds.
 * Native messages, reasoning, recent rounds, open calls, and malformed state stay
 * in place. Consecutive rounds may share pages, but no segment crosses native state. */
export async function planResponsesPairCollapse(
  items: unknown[],
  isProfitable: GptProfitableFn,
  opts: Partial<GptHistoryOptions> = {},
): Promise<ResponsesPairCollapsePlan> {
  const o: GptHistoryOptions = { ...GPT_HISTORY_DEFAULTS, ...opts };
  const { old, state } = classifyResponsesPairs(items, o.keepRecentPairs);
  if (o.responsesMode === 'mixed') {
    return planResponsesMixedCollapse(items, old, state, isProfitable, o);
  }
  const base = emptyResponsesPairPlan(state);
  if (old.length === 0) return { ...base, reason: 'no_closed_prefix' };

  const allText = old.map((pair) => pair.text).join('\n\n');
  if (!allText || gptCountTokens(allText) < o.minCollapseTokens) {
    return { ...base, reason: 'below_min_tokens', collapsedChars: allText.length };
  }

  const maxImages = Math.max(0, Math.floor(o.maxImages));
  if (maxImages === 0) {
    return { ...base, reason: 'too_many_images', collapsedChars: allText.length };
  }

  const runs: ResponsesCompletedRound[][] = [];
  for (const round of old) {
    const run = runs.at(-1);
    if (run && round.startIndex === run.at(-1)!.endIndex + 1) run.push(round);
    else runs.push([round]);
  }

  const renderPairs = async (rounds: ResponsesCompletedRound[]) => {
    const source = rounds.map((round) => round.text).join('\n\n');
    const safe = neutralizeSentinel(source);
    let renderedText = o.reflow ? reflow(safe) ?? safe : safe;
    const images = await renderTextToPngs(
      renderedText, o.cols, o.style ?? {}, o.maxHeightPx,
    );
    return { source, renderedText, images };
  };

  const segments: ResponsesPairCollapseSegment[] = [];
  let remainingImages = maxImages;
  let hitImageCap = false;
  for (const run of runs) {
    if (remainingImages === 0) { hitImageCap = true; break; }

    let low = 0;
    let high = run.length + 1;
    let best: Awaited<ReturnType<typeof renderPairs>> | undefined;
    while (low + 1 < high) {
      const count = Math.floor((low + high) / 2);
      const rendered = await renderPairs(run.slice(0, count));
      if (rendered.images.length > 0 && rendered.images.length <= remainingImages) {
        low = count;
        best = rendered;
      } else {
        high = count;
      }
    }
    if (!best || low === 0) { hitImageCap = true; break; }
    if (!isProfitable(best.renderedText, o.cols)) continue;

    const selected = run.slice(0, low);
    const selectedIndices = selected
      .flatMap((round) => round.indices)
      .sort((a, b) => a - b);
    segments.push({
      insertAt: selected[0]!.startIndex,
      selectedIndices,
      images: best.images,
      imageSources: best.images.map(() => best.source),
      text: best.source,
    });
    remainingImages -= best.images.length;
    if (low < run.length) { hitImageCap = true; break; }
  }

  if (segments.length === 0) {
    return {
      ...base,
      reason: hitImageCap ? 'too_many_images' : 'not_profitable',
      collapsedChars: allText.length,
    };
  }

  const selectedIndices = segments
    .flatMap((segment) => segment.selectedIndices)
    .sort((a, b) => a - b);
  const images = segments.flatMap((segment) => segment.images);
  const imageSources = segments.flatMap((segment) => segment.imageSources);
  const text = segments.map((segment) => segment.text).join('\n\n');
  const selectedIds = new Set(selectedIndices);
  const selectedRounds = old.filter((round) => round.indices.every((index) => selectedIds.has(index)));
  state.collapsedPairs = selectedRounds.reduce((n, round) => n + round.pairs.length, 0);
  state.collapsedFunctionCallTokens = selectedRounds.reduce((n, round) => n + round.callTokens, 0);
  state.collapsedFunctionOutputTokens = selectedRounds.reduce((n, round) => n + round.outputTokens, 0);

  const droppedCodepoints = new Map<number, number>();
  let droppedChars = 0;
  for (const image of images) {
    droppedChars += image.droppedChars;
    for (const [codepoint, count] of image.droppedCodepoints) {
      droppedCodepoints.set(codepoint, (droppedCodepoints.get(codepoint) ?? 0) + count);
    }
  }

  return {
    ...base,
    segments,
    images,
    imageSources,
    text,
    start: selectedIndices[0] ?? 0,
    endExclusive: (selectedIndices.at(-1) ?? -1) + 1,
    collapsedTurns: selectedIndices.length,
    collapsedChars: text.length,
    droppedChars,
    droppedCodepoints,
    selectedIndices,
    pairState: state,
  };
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

function responsesItemToTurn(item: unknown, idx: number): HistoryTurn {
  const o = (item ?? {}) as Record<string, unknown>;
  const type = responseItemType(item);
  const callId = responseCallId(item);
  if (type === 'function_call_output') {
    return {
      text: responseOutputText(o),
      openIds: [],
      closeIds: callId ? [callId] : [],
      opaque: false,
    };
  }
  if (type === 'function_call') {
    return {
      text: responseCallText(o),
      openIds: callId ? [callId] : [],
      closeIds: [],
      opaque: false,
    };
  }
  const msgText = responseMessageText(item);
  if (msgText) {
    const { role, text } = msgText;
    const tag = role === 'user' ? 'user' : 'assistant';
    return {
      text: `<${tag} t="${idx}">\n${text}\n</${tag}>`,
      openIds: [],
      closeIds: [],
      opaque: false,
      userText: role === 'user' ? text : undefined,
    };
  }
  return { text: '', openIds: [], closeIds: [], opaque: false };
}

export function responsesItemsToTurns(items: unknown[]): HistoryTurn[] {
  return items.map((item, i) => responsesItemToTurn(item, i));
}
