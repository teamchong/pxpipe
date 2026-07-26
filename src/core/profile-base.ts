import { DEFAULT_RENDER_FONT } from './render.js';
import type { GptHistoryProfile, GptRenderStyle } from './gpt-model-profiles.js';

/**
 * Shared defaults for the built-in profile tables.
 *
 * These live outside gpt-model-profiles.ts so per-provider profile files
 * (claude-model-profiles.ts, gemini-model-profiles.ts) can reuse them: those
 * files are imported BY gpt-model-profiles.ts, so importing the constants back
 * out of it would be a cycle, and the profiles are top-level consts, so the
 * cycle would be a load-time TDZ crash rather than a lint warning.
 */
/**
 * Conservative list-price ratios for families pxpipe has not priced explicitly.
 * Deliberately mid-range: an unknown model must not be reported at the most
 * favourable (gpt-5) cache discount, and must not be priced at Anthropic's.
 */
export const BASE_PRICING = {
  /** cached input ÷ uncached input */
  cacheReadRate: 0.5,
  /** output ÷ uncached input */
  outputRate: 4,
};

export const BASE_STYLE: GptRenderStyle = {
  font: DEFAULT_RENDER_FONT,
  cellWBonus: 0,
  cellHBonus: 0,
  aa: true,
  grid: false,
  gridCols: 0,
  colorCycle: false,
  markerScale: 1,
  markerRed: false,
  inkDilate: 0,
};

export const BASE_HISTORY: GptHistoryProfile = {
  // Not a provider limit — no vendor documents a per-request image count we come
  // near. This is our own latency budget: vision latency grows with physical image
  // count/bytes, not just billed tokens, and long OpenCode sessions can turn old
  // history into 80+ images — token-cheap but slow enough that the model times out
  // before first token. When the cap trips, callers leave the old history as text
  // rather than dropping or de-prioritizing it, so tripping it is never lossy.
  maxImages: 32,
  keepTail: 6,
  keepRecentPairs: 6,
  minCollapseTokens: 2000,
  responsesMode: 'pairs',
  framing: 'full',
  factSheetScope: 'per-segment',
};
