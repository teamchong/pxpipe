/**
 * The ONE interpreter of image (vision) input-token cost.
 *
 * Every provider difference is DATA — a `GptVisionCost` regime on the model
 * profile — never a branch on the model id. Adding a family means adding a
 * profile (or an env override), not an `if (isFoo(model))` here or at a call
 * site. Callers pass anything profile-shaped (`{ vision, visionTier }`), so the
 * gate can price a hypothetical geometry with the same code that prices a real
 * request.
 *
 * This module is a dependency leaf: it imports only types, so profile modules
 * can use it without an import cycle through model resolution.
 *
 * Anthropic's 28-px patch geometry lives here too (it is one regime among
 * several); `anthropic-vision.ts` is the documented, model-id-facing wrapper
 * around it.
 */

import type { GptVisionCost } from './gpt-model-profiles.js';

/** One visual token per 28×28-pixel patch. Also the Qwen2-VL grid; NOT OpenAI's
 *  32-px patch / 512-px tile model — keep those on the OpenAI regimes. */
export const ANTHROPIC_PATCH_PX = 28;

/** OpenAI's legacy tile model downscales to fit these boxes before tiling. */
const OPENAI_TILE_MAX_LONG_EDGE = 2048;
const OPENAI_TILE_MAX_SHORT_EDGE = 768;
const OPENAI_TILE_PX = 512;

/** OpenAI's current patch model. */
const OPENAI_PATCH_PX = 32;

export type AnthropicVisionTier = 'high-res' | 'standard';

export interface AnthropicVisionProfile {
  readonly tier: AnthropicVisionTier;
  /** Neither side may exceed this after downscale (px). */
  readonly maxLongEdge: number;
  /** ⌈w/28⌉×⌈h/28⌉ may not exceed this after downscale (visual tokens). */
  readonly maxVisualTokens: number;
}

/**
 * Anthropic's documented pre-billing downscale, tiered by model VERSION:
 *   | High-resolution | Claude 4.7 and later models | 2576 px | 4784 |
 *   | Standard        | All other models            | 1568 px | 1568 |
 */
export const ANTHROPIC_TIERS: Record<AnthropicVisionTier, AnthropicVisionProfile> = {
  'high-res': { tier: 'high-res', maxLongEdge: 2576, maxVisualTokens: 4784 },
  standard: { tier: 'standard', maxLongEdge: 1568, maxVisualTokens: 1568 },
};

/** Raw 28-px patch count for a `w×h` image, i.e. the visual-token cost when the
 *  image already fits the tier limits (no downscale). `⌈w/28⌉` inherently pads
 *  the right/bottom edge up to the next 28-px multiple, as Anthropic documents. */
export function patchTokens(width: number, height: number): number {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  return Math.ceil(w / ANTHROPIC_PATCH_PX) * Math.ceil(h / ANTHROPIC_PATCH_PX);
}

/** True when a `w×h` image fits a tier with no resize: both padded patch edges
 *  are within the long-edge limit AND the patch count is within the token
 *  budget. Mirrors the `fits` predicate in Anthropic's reference resize. */
function fitsTier(w: number, h: number, maxLongEdge: number, maxVisualTokens: number): boolean {
  return (
    Math.ceil(w / ANTHROPIC_PATCH_PX) * ANTHROPIC_PATCH_PX <= maxLongEdge &&
    Math.ceil(h / ANTHROPIC_PATCH_PX) * ANTHROPIC_PATCH_PX <= maxLongEdge &&
    patchTokens(w, h) <= maxVisualTokens
  );
}

/** Largest aspect-preserving size that fits the tier, exactly as Anthropic's
 *  reference does it: binary-search the long edge (short edge = round(long ×
 *  aspect)), recursing with a swap for portrait images. Original if it fits. */
function resizedSize(w: number, h: number, maxLongEdge: number, maxVisualTokens: number): [number, number] {
  if (fitsTier(w, h, maxLongEdge, maxVisualTokens)) return [w, h];
  if (h > w) {
    const [rh, rw] = resizedSize(h, w, maxLongEdge, maxVisualTokens);
    return [rw, rh];
  }
  // Landscape (w ≥ h): binary-search the largest long edge that still fits.
  const aspect = h / w;
  let lo = 1;
  let hi = w;
  let best = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fitsTier(mid, Math.max(1, Math.round(mid * aspect)), maxLongEdge, maxVisualTokens)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return [best, Math.max(1, Math.round(best * aspect))];
}

/**
 * Anthropic visual-token cost at `width×height` for a tier: the documented
 * resize (largest aspect-preserving size fitting BOTH the long-edge limit and
 * the visual-token budget, found by binary search exactly as Anthropic's
 * reference `count_image_tokens`), then the 28-px patch count.
 *
 * Note: pxpipe's own pages are always ≤ 1568×728, so the resize never fires for
 * proxy output (both tiers charge the raw patch count). The resize path is for
 * correctness as a general-purpose estimator (e.g. arbitrary export input).
 */
export function patchTokensForTier(
  tier: AnthropicVisionTier | undefined,
  width: number,
  height: number,
): number {
  const { maxLongEdge, maxVisualTokens } = ANTHROPIC_TIERS[tier ?? 'standard'];
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const [rw, rh] = resizedSize(w, h, maxLongEdge, maxVisualTokens);
  return patchTokens(rw, rh);
}

/** The profile fields that determine image cost. `GptModelProfile` satisfies
 *  this structurally, so a profile can be passed straight in. */
export interface VisionPricing {
  readonly vision: GptVisionCost;
  readonly visionTier?: AnthropicVisionTier;
}

/**
 * Per-image input-token cost of a `width×height` render under `pricing`.
 * This is the DOCUMENTED provider cost — any gate conservatism (safety margin)
 * is applied by the gate, so this stays honest about what is actually charged.
 */
export function visionTokens(pricing: VisionPricing, width: number, height: number): number {
  const c = pricing.vision;
  switch (c.regime) {
    case 'patch28':
      return patchTokensForTier(pricing.visionTier, width, height);
    case 'patch': {
      const rawPatches = Math.ceil(width / OPENAI_PATCH_PX) * Math.ceil(height / OPENAI_PATCH_PX);
      const patches = c.patchCap === undefined ? rawPatches : Math.min(c.patchCap, rawPatches);
      return Math.ceil(patches * c.multiplier);
    }
    case 'mpix': {
      const pixels = Math.max(0, width) * Math.max(0, height);
      return Math.max(1, Math.ceil((pixels / 1_000_000) * c.tokensPerMegapixel));
    }
    case 'flat':
      return c.exact && width === c.exact.widthPx && height === c.exact.heightPx
        ? c.exact.tokens
        : c.tokens;
    case 'tile': {
      let w = width, h = height;
      const long = Math.max(w, h);
      if (long > OPENAI_TILE_MAX_LONG_EDGE) {
        const r = OPENAI_TILE_MAX_LONG_EDGE / long;
        w = Math.floor(w * r);
        h = Math.floor(h * r);
      }
      const short = Math.min(w, h);
      if (short > OPENAI_TILE_MAX_SHORT_EDGE) {
        const r = OPENAI_TILE_MAX_SHORT_EDGE / short;
        w = Math.floor(w * r);
        h = Math.floor(h * r);
      }
      return c.base + c.perTile * (Math.ceil(w / OPENAI_TILE_PX) * Math.ceil(h / OPENAI_TILE_PX));
    }
  }
}
