/**
 * Anthropic image / vision INPUT-TOKEN cost model, by model id.
 *
 * Anthropic bills images by 28×28-pixel PATCHES, not by a pixel ratio: an image
 * costs `⌈width/28⌉ × ⌈height/28⌉` visual tokens, computed AFTER the image is
 * downscaled to fit the model tier's long-edge and visual-token limits.
 * (The older `(width×height)/750` figure was a ~4–5% continuous approximation of
 * this same 28²=784 px²/patch grid; it is no longer the documented formula.)
 * https://platform.claude.com/docs/en/build-with-claude/vision
 * https://platform.claude.com/docs/en/build-with-claude/vision-coordinates
 *
 * The math itself is the `patch28` regime in src/core/vision-cost.ts, which is
 * the single interpreter for EVERY provider's image pricing and is a dependency
 * leaf. This module is the Anthropic-facing, model-id-aware wrapper around it:
 * it maps an id to its resolution tier via the model profile. Gate conservatism
 * (safety margin) lives at the gate, not here, so these numbers stay honest
 * about what Anthropic actually charges.
 */

import { resolveGptProfile } from './gpt-model-profiles.js';
import { ANTHROPIC_TIERS, patchTokensForTier } from './vision-cost.js';

export {
  ANTHROPIC_PATCH_PX,
  patchTokens,
  patchTokensForTier,
  type AnthropicVisionProfile,
} from './vision-cost.js';

/** Resolve a model's vision tier. Which model sits on which tier is a property
 *  of the model profile (`visionTier` in gpt-model-profiles.ts), not a list
 *  maintained here: profile resolution already handles id aliases, `[variant]`
 *  tags, and PXPIPE_GPT_PROFILES overrides. This module owns only the geometry
 *  each tier implies. Non-Claude and blank ids have no tier and get standard. */
export function anthropicVisionProfile(model: string | null | undefined) {
  return ANTHROPIC_TIERS[resolveGptProfile(model).visionTier ?? 'standard'];
}

/** Anthropic visual-token cost of a `width×height` image for `model`'s tier. */
export function anthropicVisionTokens(
  model: string | null | undefined,
  width: number,
  height: number,
): number {
  return patchTokensForTier(anthropicVisionProfile(model).tier, width, height);
}
