/**
 * Caller hook that decides, per block, how a text that pxpipe is about to image
 * is sent: as images (the default), kept as text, or split at caller-chosen
 * offsets into text and image segments that keep the source order.
 *
 * pxpipe owns rendering, the image caps and cache_control placement; the hook
 * owns the decision. For prompt-cache safety the hook must return the same
 * plan for the same input on every turn.
 *
 * When a hook is set it owns every image on the Anthropic Messages path: pxpipe
 * never falls back to its own image path. A failed hook, an invalid plan or a
 * split that does not fit the image budget keeps the text as text. Only an
 * explicit `image` plan uses the default path.
 */

export type SplitBlockSite = 'tool_result' | 'tool_result_part' | 'slab' | 'history';

export interface SplitSpan {
  readonly start: number;
  readonly end: number;
}

export interface SplitSegment extends SplitSpan {
  readonly kind: 'text' | 'image';
}

/** Token estimates with the geometry of the path that renders this block. */
export interface SplitCost {
  readonly imageTokens: (text: string) => number;
  readonly textTokens: (text: string) => number;
}

export interface SplitBlockInput {
  readonly site: SplitBlockSite;
  /** The block text. Segment offsets index into this string. Tool-result and slab
   *  text is whitespace-compacted (trailing spaces stripped, 3+ newlines to 2)
   *  first, so text segments carry the compacted form. */
  readonly text: string;
  /** Structural markup (history role tags and turn indexes) that the decision must ignore. */
  readonly protectedSpans: readonly SplitSpan[];
  /** Most image segments a plan may use. Fixed per site, so it does not change between turns. */
  readonly maxImageSegments: number;
  readonly cost: SplitCost;
}

export type SplitBlockPlan = (
  | { readonly kind: 'image' }
  | { readonly kind: 'text'; readonly reason: 'pending' | 'not_profitable' }
  /** Contiguous segments that cover the whole text, in order. No factsheet is sent with them. */
  | { readonly kind: 'segments'; readonly segments: readonly SplitSegment[] }
) & {
  /** Counters summed into `TransformInfo.splitStats`. */
  readonly stats?: Readonly<Record<string, number>>;
};

export type SplitBlock = (input: SplitBlockInput) => Promise<SplitBlockPlan>;

/** A hook with the site and cost bound by the render path. */
export type BoundSplitBlock = (
  text: string,
  protectedSpans: readonly SplitSpan[],
  maxImageSegments: number,
) => Promise<SplitBlockPlan>;

/** Most image segments a slab or history-chunk plan may use. Fixed, so a frozen block gets the same hook input on every turn. */
export const SPLIT_MAX_IMAGE_SEGMENTS = 8;

function isPlan(value: unknown): value is SplitBlockPlan {
  const plan = value as SplitBlockPlan | undefined;
  if (!plan || typeof plan !== 'object') return false;
  if (plan.kind === 'image') return true;
  if (plan.kind === 'text') return plan.reason === 'pending' || plan.reason === 'not_profitable';
  return plan.kind === 'segments' && Array.isArray(plan.segments);
}

/**
 * Bind site and cost to a hook. A hook that throws, rejects or returns a value
 * that is not a plan keeps the block as text.
 */
export function bindSplitBlock(
  hook: SplitBlock | undefined,
  site: SplitBlockSite,
  cost: SplitCost,
): BoundSplitBlock | undefined {
  if (!hook) return undefined;
  return async (text, protectedSpans, maxImageSegments) => {
    try {
      const plan = await hook({ site, text, protectedSpans, maxImageSegments, cost });
      return isPlan(plan) ? plan : { kind: 'text', reason: 'not_profitable', stats: { splitHookInvalid: 1 } };
    } catch {
      return { kind: 'text', reason: 'not_profitable', stats: { splitHookError: 1 } };
    }
  };
}

export function addSplitStats(
  target: { splitStats?: Record<string, number> },
  stats: Readonly<Record<string, number>> | undefined,
): void {
  if (!stats || typeof stats !== 'object') return;
  const into = (target.splitStats ??= {});
  for (const [name, value] of Object.entries(stats)) {
    if (typeof value === 'number' && Number.isFinite(value)) into[name] = (into[name] ?? 0) + value;
  }
}

/**
 * The segments of a `segments` plan, or null for any other plan. Segments that
 * do not cover the text exactly, a segment boundary inside a protected span, or
 * more than `maxImageSegments` image segments also give null, and the block
 * stays text.
 */
export function planSegments(
  text: string,
  plan: SplitBlockPlan | undefined,
  maxImageSegments: number,
  protectedSpans: readonly SplitSpan[] = [],
): readonly SplitSegment[] | null {
  if (plan?.kind !== 'segments') return null;
  let cursor = 0;
  let images = 0;
  for (const segment of plan.segments) {
    if (!segment || (segment.kind !== 'text' && segment.kind !== 'image')) return null;
    if (segment.start !== cursor || !(segment.end > segment.start)) return null;
    if (protectedSpans.some((span) => segment.end > span.start && segment.end < span.end)) return null;
    if (segment.kind === 'image') images++;
    cursor = segment.end;
  }
  if (cursor !== text.length || images > maxImageSegments) return null;
  return plan.segments;
}
