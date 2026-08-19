import { describe, expect, it, afterEach } from 'vitest';
import { resolveGptProfile, isMisresolvedModelId } from '../src/core/gpt-model-profiles.js';
import { visionTokens, patchTokensForTier } from '../src/core/vision-cost.js';
import { visionTokensForModel } from '../src/core/openai.js';
import { openAICacheReadRate, openAIOutputRate } from '../src/core/openai-savings.js';
import { isPxpipeSupportedModel } from '../src/core/applicability.js';

/**
 * The image-cost path must be DATA-driven: every provider difference is a
 * `vision` regime on the profile, and `visionTokens` is the only interpreter.
 * These tests pin that, because the failure mode is silent — a model priced
 * with another family's formula still returns a plausible number, and the gate
 * then trades real tokens for imagined savings.
 */
describe('vision cost is resolved from the profile, not from the model id', () => {
  const cases: Array<{
    model: string;
    regime: string;
    tier?: string;
    cacheReadRate: number;
    outputRate: number;
  }> = [
    { model: 'claude-opus-5', regime: 'patch28', tier: 'high-res', cacheReadRate: 0.1, outputRate: 5 },
    { model: 'claude-3-5-sonnet', regime: 'patch28', tier: 'standard', cacheReadRate: 0.1, outputRate: 5 },
    { model: 'gemini-3.6-flash', regime: 'flat', cacheReadRate: 0.25, outputRate: 4 },
    { model: 'grok-4.5', regime: 'mpix', cacheReadRate: 0.25, outputRate: 3 },
    { model: 'gpt-5.6-sol', regime: 'patch', cacheReadRate: 0.1, outputRate: 8 },
    { model: 'gpt-5.5', regime: 'patch', cacheReadRate: 0.1, outputRate: 8 },
    { model: 'gpt-5-mini', regime: 'patch', cacheReadRate: 0.1, outputRate: 8 },
    { model: 'gpt-4.1-mini', regime: 'patch', cacheReadRate: 0.5, outputRate: 4 },
    { model: 'gpt-5', regime: 'tile', cacheReadRate: 0.1, outputRate: 8 },
    { model: 'gpt-4o', regime: 'tile', cacheReadRate: 0.5, outputRate: 4 },
    { model: 'o3', regime: 'tile', cacheReadRate: 0.5, outputRate: 4 },
  ];

  it.each(cases)('$model prices via its own regime and list-price ratios', (c) => {
    const p = resolveGptProfile(c.model);
    expect(p.vision.regime).toBe(c.regime);
    expect(p.visionTier).toBe(c.tier);
    expect(openAICacheReadRate(c.model)).toBe(c.cacheReadRate);
    expect(openAIOutputRate(c.model)).toBe(c.outputRate);
    // The public per-model helper is exactly the profile interpreter.
    for (const [w, h] of [[1568, 728], [764, 512], [768, 1932]] as const) {
      expect(visionTokensForModel(c.model, w, h)).toBe(visionTokens(p, w, h));
    }
  });

  it('keeps each family on its documented formula', () => {
    // Anthropic 28-px patches (56 x 26 grid), tier downscale applied.
    expect(visionTokensForModel('claude-opus-5', 1568, 728)).toBe(56 * 26);
    expect(visionTokensForModel('claude-opus-5', 1568, 728)).toBe(patchTokensForTier('high-res', 1568, 728));
    // Standard tier downscales the tall page; high-res does not.
    expect(visionTokensForModel('claude-3-5-sonnet', 768, 1932))
      .toBeLessThan(visionTokensForModel('claude-opus-5', 768, 1932));
    // Gemini: flat, with the measured production canvas as an exact override.
    expect(visionTokensForModel('gemini-3.6-flash', 1568, 728)).toBe(1078);
    expect(visionTokensForModel('gemini-3.6-flash', 1568, 727)).toBe(1120);
    // Grok: measured tokens per megapixel.
    expect(visionTokensForModel('grok-4.5', 1000, 1000)).toBe(1000);
    // OpenAI 32-px patches, uncapped for Sol.
    expect(visionTokensForModel('gpt-5.6-sol', 768, 1932)).toBe(Math.ceil(768 / 32) * Math.ceil(1932 / 32));
    // OpenAI legacy tiles after the 2048/768 downscale.
    expect(visionTokensForModel('gpt-4o', 768, 1932)).toBe(85 + 170 * (2 * 4));
  });

  it("no family shares another family's cost for the same page", () => {
    const page = [1568, 728] as const;
    const costs = ['claude-opus-5', 'gemini-3.6-flash', 'grok-4.5', 'gpt-5.6-sol', 'gpt-4o']
      .map((m) => visionTokensForModel(m, page[0], page[1]));
    expect(new Set(costs).size).toBe(costs.length);
  });
});

describe('PXPIPE_GPT_PROFILES can retune any regime without a code change', () => {
  const prev = process.env.PXPIPE_GPT_PROFILES;
  afterEach(() => {
    if (prev === undefined) delete process.env.PXPIPE_GPT_PROFILES;
    else process.env.PXPIPE_GPT_PROFILES = prev;
  });

  it('accepts the pixel, flat, and Anthropic-patch regimes', () => {
    process.env.PXPIPE_GPT_PROFILES = JSON.stringify({
      'gpt-5.6-sol': { vision: { regime: 'mpix', tokensPerMegapixel: 500 } },
      'gpt-5.5': { vision: { regime: 'flat', tokens: 900 }, cacheReadRate: 0.2, outputRate: 6 },
      'gpt-5.4': { vision: { regime: 'patch28' }, visionTier: 'high-res' },
    });
    expect(visionTokensForModel('gpt-5.6-sol', 1000, 1000)).toBe(500);
    expect(visionTokensForModel('gpt-5.5', 1568, 728)).toBe(900);
    expect(openAICacheReadRate('gpt-5.5')).toBe(0.2);
    expect(openAIOutputRate('gpt-5.5')).toBe(6);
    expect(visionTokensForModel('gpt-5.4', 1568, 728)).toBe(patchTokensForTier('high-res', 1568, 728));
  });

  it('ignores malformed regimes and rates, keeping the built-in profile', () => {
    process.env.PXPIPE_GPT_PROFILES = JSON.stringify({
      'gpt-5.6-sol': { vision: { regime: 'mpix', tokensPerMegapixel: -5 }, cacheReadRate: 0, outputRate: 'free' },
    });
    expect(resolveGptProfile('gpt-5.6-sol').vision).toEqual({ regime: 'patch', multiplier: 1 });
    expect(openAICacheReadRate('gpt-5.6-sol')).toBe(0.1);
    expect(openAIOutputRate('gpt-5.6-sol')).toBe(8);
  });
});

describe('ids that would be priced with the wrong provider formula are refused', () => {
  const prev = process.env.PXPIPE_MODELS;
  afterEach(() => {
    if (prev === undefined) delete process.env.PXPIPE_MODELS;
    else process.env.PXPIPE_MODELS = prev;
  });

  it('flags family ids that do not resolve to that family profile', () => {
    expect(isMisresolvedModelId('gemini-3.6-pro')).toBe(true);
    expect(isMisresolvedModelId('gemini-3.7-pro')).toBe(true);
    expect(isMisresolvedModelId('gemini-3.6-flash')).toBe(false);
    expect(isMisresolvedModelId('gemini-3.7-flash')).toBe(false);
    expect(isMisresolvedModelId('google/gemini-3.6-flash')).toBe(false);
    expect(isMisresolvedModelId('google/gemini-3.7-flash')).toBe(false);
    expect(isMisresolvedModelId('grok4')).toBe(true);
    expect(isMisresolvedModelId('grok-4.5')).toBe(false);
    // Claude and GPT resolvers accept every id that names them.
    expect(isMisresolvedModelId('claude-opus-9')).toBe(false);
    expect(isMisresolvedModelId('gpt-4o')).toBe(false);
  });

  it('holds even when the scope is configured broadly', () => {
    process.env.PXPIPE_MODELS = 'gemini,grok';
    expect(isPxpipeSupportedModel('gemini-3.6-pro')).toBe(false);
    expect(isPxpipeSupportedModel('gemini-3.7-pro')).toBe(false);
    expect(isPxpipeSupportedModel('gemini-3.6-flash')).toBe(true);
    expect(isPxpipeSupportedModel('gemini-3.7-flash')).toBe(true);
    expect(isPxpipeSupportedModel('grok-4.5')).toBe(true);
  });
});
