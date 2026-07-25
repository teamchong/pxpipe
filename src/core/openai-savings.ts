/**
 * Cache-aware GPT/OpenAI savings math.
 *
 * This is deliberately separate from src/core/baseline.ts (Anthropic): OpenAI
 * has no `count_tokens`, no explicit cache_control breakpoints, no cache-create
 * premium, and images are billed by OpenAI's vision-token formula rather than
 * text tokens. The transform path records two GPT-specific facts per imaged
 * request:
 *
 *   imageTokens           = what the rendered images actually cost as input
 *   baselineImagedTokens  = o200k text tokens the imaged/stripped content would
 *                           have cost if left as plain text
 *
 * OpenAI usage then tells us how many prompt tokens were served from prompt
 * cache (`cached_tokens`, a subset of input_tokens). For the gpt-5 family, cached
 * input is billed at ~0.1× the normal input rate; there is no 1.25× write
 * premium like Anthropic's ephemeral cache.
 *
 * The /v1/responses path is shared by several vendors (GPT, Claude, Grok,
 * Gemini), so the price ratios below are read from the serving model's profile
 * rather than re-derived from its id here — the same profile the gate prices
 * images with, so reporting and gating can never disagree about the model.
 */

import { resolveGptProfile } from './gpt-model-profiles.js';

/** Cached-input ÷ uncached-input list-price ratio for the model serving this
 *  request. The ratio is a PROFILE field (`cacheReadRate`), so a new family is
 *  a profile entry or a PXPIPE_GPT_PROFILES override — not a regex added here,
 *  which is how the gate and the savings math previously drifted apart. */
export function openAICacheReadRate(model: string | undefined): number {
  return resolveGptProfile(model).cacheReadRate;
}

/** Output ÷ uncached-input list-price ratio, from the same profile. */
export function openAIOutputRate(model: string | undefined): number {
  return resolveGptProfile(model).outputRate;
}

/** Weighted input tokens actually paid to OpenAI this turn. `cachedTokens` is a
 * subset of `inputTokens`, not an additive bucket. */
export function computeOpenAIActualInputEff(
  inputTokens: number,
  cachedTokens: number,
  model?: string,
): number {
  if (inputTokens <= 0) return 0;
  const cached = Math.max(0, Math.min(cachedTokens || 0, inputTokens));
  const uncached = inputTokens - cached;
  return uncached + cached * openAICacheReadRate(model);
}

/** Raw token count for the unproxied GPT counterfactual: replace the rendered
 * images with the o200k text they stood in for. */
export function computeOpenAIBaselineRawTokens(
  inputTokens: number,
  imageTokens: number,
  baselineImagedTokens: number,
  nativeInjectedTokens: number = 0,
): number {
  if (inputTokens <= 0) return 0;
  const delta = (baselineImagedTokens || 0) - (imageTokens || 0);
  return Math.max(0, inputTokens + delta - Math.max(0, nativeInjectedTokens || 0));
}

/** Weighted input tokens for the unproxied GPT text counterfactual.
 *
 * We cannot ask OpenAI `count_tokens`, and the API does not expose per-block
 * cache accounting. The only honest observable is whether this request had a
 * prompt-cache hit at all (`cached_tokens > 0`). The imaged slab sits in the
 * stable prefix; when OpenAI reports cached tokens, that slab would have been
 * cached as text too, so the text↔image delta is discounted by the same cached
 * input rate. On a cold/no-cache turn, the delta is paid at the full input rate.
 */
export function computeOpenAIBaselineInputEff(
  inputTokens: number,
  cachedTokens: number,
  imageTokens: number,
  baselineImagedTokens: number,
  model?: string,
  nativeInjectedTokens: number = 0,
): number {
  const actual = computeOpenAIActualInputEff(inputTokens, cachedTokens, model);
  if (inputTokens <= 0 || imageTokens <= 0 || baselineImagedTokens <= 0) return actual;
  const delta = baselineImagedTokens - imageTokens;
  const deltaWeight = (cachedTokens || 0) > 0 ? openAICacheReadRate(model) : 1.0;
  // Synthetic native text occupies the same stable prefix as the images, so
  // apply the same observed cache weight as the replacement delta.
  return actual + (delta - Math.max(0, nativeInjectedTokens || 0)) * deltaWeight;
}
