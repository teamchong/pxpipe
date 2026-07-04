/**
 * Anthropic image / vision INPUT-TOKEN cost model.
 *
 * Anthropic bills images by 28×28-pixel PATCHES, not by a pixel ratio: an image
 * costs `⌈width/28⌉ × ⌈height/28⌉` visual tokens, computed AFTER the image is
 * downscaled to fit the model tier's long-edge and visual-token limits.
 * (The older `(width×height)/750` figure was a ~4–5% continuous approximation of
 * this same 28²=784 px²/patch grid; it is no longer the documented formula.)
 * https://platform.claude.com/docs/en/build-with-claude/vision
 * https://platform.claude.com/docs/en/build-with-claude/vision-coordinates
 *
 * This module is the single source of truth for that math. It is the *documented
 * provider formula* only — any gate conservatism (safety margin) lives at the
 * gate, not here, so this stays honest about what Anthropic actually charges.
 */

/** One visual token per 28×28-pixel patch. Also the Qwen2-VL grid; NOT OpenAI's
 *  32-px patch / 512-px tile model — keep those on the OpenAI path only. */
export const ANTHROPIC_PATCH_PX = 28;

export interface AnthropicVisionProfile {
  readonly tier: 'high-res' | 'standard';
  /** Neither side may exceed this after downscale (px). */
  readonly maxLongEdge: number;
  /** ⌈w/28⌉×⌈h/28⌉ may not exceed this after downscale (visual tokens). */
  readonly maxVisualTokens: number;
}

/** Model bases on Anthropic's high-resolution tier (max long edge 2576 px, max
 *  4784 visual tokens). Everything else is standard (1568 px / 1568 tokens).
 *  Source: the Vision docs resolution-tier table. */
const HIGH_RES_BASES = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
] as const;

const HIGH_RES: AnthropicVisionProfile = { tier: 'high-res', maxLongEdge: 2576, maxVisualTokens: 4784 };
const STANDARD: AnthropicVisionProfile = { tier: 'standard', maxLongEdge: 1568, maxVisualTokens: 1568 };

/** Resolve a model's vision tier. Unknown/blank models fall back to the
 *  conservative (smaller) standard tier. Matches exact base or `<base>-suffix` /
 *  `<base>[variant]` so aliases (e.g. `claude-fable-5-high`, `...[1m]`) tier alike. */
export function anthropicVisionProfile(model: string | null | undefined): AnthropicVisionProfile {
  const m = (model ?? '').toLowerCase();
  const isHighRes = HIGH_RES_BASES.some((b) => m === b || m.startsWith(`${b}-`) || m.startsWith(`${b}[`));
  return isHighRes ? HIGH_RES : STANDARD;
}

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
 * Anthropic visual-token cost of an image at `width×height` for `model`'s tier.
 * Applies the documented resize — the largest aspect-preserving size that fits
 * BOTH the long-edge limit and the visual-token budget, found by binary search
 * exactly as Anthropic's reference `count_image_tokens` — then the 28-px patch
 * count.
 *
 * Note: pxpipe's own pages are always ≤ 1568×728, so the resize never fires for
 * proxy output (both tiers charge the raw patch count). The resize path is for
 * correctness as a general-purpose estimator (e.g. arbitrary export input).
 */
export function anthropicVisionTokens(
  model: string | null | undefined,
  width: number,
  height: number,
): number {
  const { maxLongEdge, maxVisualTokens } = anthropicVisionProfile(model);
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const [rw, rh] = resizedSize(w, h, maxLongEdge, maxVisualTokens);
  return patchTokens(rw, rh);
}
