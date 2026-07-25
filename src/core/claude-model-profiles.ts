import {
  MAX_HEIGHT_PX as ANTHROPIC_MAX_HEIGHT_PX,
  ANTHROPIC_SLAB_COLS as ANTHROPIC_STRIP_COLS,
} from './render.js';
import { BASE_HISTORY, BASE_STYLE } from './profile-base.js';
import type { GptModelProfile } from './gpt-model-profiles.js';

/**
 * Claude rendering + vision-cost profiles.
 *
 * Anthropic geometry (dense 312-col strips, 728 px height) and pixel billing
 * differ from GPT's 152-col / 1932 px profile: using the GPT defaults overstates
 * image cost and flips the slab gate to not_profitable, so an enabled Claude
 * model would stay text-only and the dashboard would leave As text / Saved
 * blank. resolveGptProfile therefore routes every Claude id here BEFORE the GPT
 * rule table, so no Claude model can land on a GPT or Gemini profile.
 */

/** Claude 4.7+. Billed by Anthropic's 28-px patch grid after the high-res
 *  tier downscale; `visionTier` below is the only knob that varies by release. */
export const CLAUDE_PROFILE: GptModelProfile = {
  vision: { regime: 'patch28' },
  // Anthropic list prices: cache read $0.10 / input $1.00; output $5.00 / input.
  cacheReadRate: 0.1,
  outputRate: 5,
  stripCols: ANTHROPIC_STRIP_COLS,
  maxHeightPx: ANTHROPIC_MAX_HEIGHT_PX,
  visionTier: 'high-res',
  factSheetFormat: 'full',
  history: BASE_HISTORY,
  style: { ...BASE_STYLE },
  // No maxSerializedRequestBytes: no Anthropic request-size limit has ever been
  // sourced. The 768 KiB entry that used to sit here was a guess, and live
  // traffic contradicted it outright (thousands of clean 200s well above it).
};

/** Pre-4.7 Claude: same render geometry, standard image-resolution tier. */
export const CLAUDE_LEGACY_PROFILE: GptModelProfile = {
  ...CLAUDE_PROFILE,
  visionTier: 'standard',
  style: { ...BASE_STYLE },
};

/** Every id that must be priced and rendered as Claude. */
export function isClaudeModel(model: string | null | undefined): boolean {
  const m = (model ?? '').toLowerCase();
  // `includes`, not `startsWith`: gateway ids carry a vendor prefix
  // (`anthropic/claude-opus-5`, `us.anthropic.claude-3-5-sonnet-v1:0`).
  return m.includes('claude') || m.includes('anthropic');
}

/**
 * True for Claude releases older than 4.7. Anthropic's vision docs tier the
 * pre-billing downscale by VERSION, not by model family or an enumerated list:
 *
 *   | High-resolution | Claude 4.7 and later models | 2576 px | 4784 |
 *   | Standard        | All other models            | 1568 px | 1568 |
 *
 * Reads the first version number in the id, tolerating both id orderings
 * (`claude-opus-4-8` -> 4.8, `claude-3-5-sonnet` -> 3.5) and trailing date
 * stamps. An unrecognised Claude id is treated as new: an unreleased model is
 * far likelier to be 4.7+, and high-res is the safe guess for the gate because
 * it over-estimates cost, whereas standard under-estimates it by assuming a
 * downscale the server will not perform.
 */
export function isPre47Claude(m: string): boolean {
  const v = /claude-(?:[a-z]+-)?(\d+)(?:-(\d+))?/.exec(m);
  if (!v) return false;
  const [major, minor] = [Number(v[1]), Number(v[2] ?? '0')];
  return major < 4 || (major === 4 && minor < 7);
}

/** Pick the Claude profile for an id. Only the resolution tier varies: render
 *  geometry is identical across opus/sonnet/haiku/fable. */
export function resolveClaudeProfile(m: string): GptModelProfile {
  return isPre47Claude(m) ? CLAUDE_LEGACY_PROFILE : CLAUDE_PROFILE;
}
