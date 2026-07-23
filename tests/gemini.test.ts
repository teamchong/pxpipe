/**
 * Unit tests for Gemini model profiles, identification, and vision token pricing.
 */
import { describe, expect, it } from 'vitest';
import {
  isGeminiModel,
  resolveGeminiProfile,
  geminiVisionTokens,
  GEMINI_3_6_FLASH_PROFILE,
} from '../src/core/gemini-model-profiles.js';
import { visionTokensForModel } from '../src/core/openai.js';
import { resolveGptProfile } from '../src/core/gpt-model-profiles.js';

describe('Gemini Model Profiles & Identification', () => {
  it('correctly identifies Gemini family model strings', () => {
    expect(isGeminiModel('gemini-3.6-flash')).toBe(true);
    expect(isGeminiModel('google/gemini-3.6-flash')).toBe(true);
    expect(isGeminiModel('GEMINI-PRO')).toBe(false);
    expect(isGeminiModel('gpt-5.6-sol')).toBe(false);
    expect(isGeminiModel('claude-fable-5')).toBe(false);
    expect(isGeminiModel('grok-4.5')).toBe(false);
  });

  it('resolves dedicated Gemini profile via resolveGeminiProfile and resolveGptProfile', () => {
    const prof1 = resolveGeminiProfile();
    expect(prof1).toBe(GEMINI_3_6_FLASH_PROFILE);
    expect(prof1.stripCols).toBe(312);
    expect(prof1.maxHeightPx).toBe(728);
    expect(prof1.vision.base).toBe(1078);
    expect(prof1.style.font).toBe('spleen-5x8');

    const prof2 = resolveGptProfile('google/gemini-3.6-flash');
    expect(prof2.stripCols).toBe(312);
    expect(prof2.maxHeightPx).toBe(728);
    expect(prof2.vision.base).toBe(1078);
  });

  it('uses the measured production-geometry image cost', () => {
    expect(geminiVisionTokens('gemini-3.6-flash', 1568, 728)).toBe(1078);
    expect(geminiVisionTokens('gemini-3.6-flash', 1568, 400)).toBe(1120);
    expect(geminiVisionTokens('gemini-3.6-flash', 1024, 1024)).toBe(1120);
    expect(geminiVisionTokens('gemini-3.6-flash', 768, 1932)).toBe(1120);

    expect(visionTokensForModel('gemini-3.6-flash', 1568, 728)).toBe(1078);
    expect(visionTokensForModel('google/gemini-3.6-flash', 1568, 728)).toBe(1078);
  });

  it('fails closed for unvalidated models and invalid dimensions', () => {
    expect(() => geminiVisionTokens('gemini-3.5-flash', 1568, 728)).toThrow('Unsupported Gemini');
    expect(() => geminiVisionTokens('gemini-3.6-flash', 0, 728)).toThrow('Unsupported Gemini');
  });
});
