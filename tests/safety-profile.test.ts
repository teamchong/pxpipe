import { afterEach, describe, expect, it } from 'vitest';

import {
  isPxpipeSupportedModelForScope,
} from '../src/core/applicability.js';
import {
  mergeCompressionProfileOptions,
  resolveCompressionProfile,
  shouldKeepToolResultSharp,
} from '../src/core/safety-policy.js';

const previousModels = process.env.PXPIPE_MODELS;
afterEach(() => {
  if (previousModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = previousModels;
});

describe('coding-safe profile', () => {
  it('keeps authority and live tool-result imaging disabled', () => {
    const options = mergeCompressionProfileOptions(resolveCompressionProfile('coding-safe'));
    expect(options.compress).toBe(true);
    expect(options.compressTools).toBe(false);
    expect(options.compressToolResults).toBe(false);
    expect(options.minCompressChars).toBe(Number.MAX_SAFE_INTEGER);
    expect(options.collapseHistory).toBe(true);
    expect(options.gptHistory?.keepTail).toBe(12);
  });

  it('preserves upstream behavior when the profile is unset', () => {
    expect(resolveCompressionProfile(undefined).name).toBe('aggressive');
    expect(mergeCompressionProfileOptions(resolveCompressionProfile(undefined))).toEqual({});
  });

  it('does not let caller overrides weaken the built-in semantic boundary', () => {
    const options = mergeCompressionProfileOptions(
      resolveCompressionProfile('coding-safe'),
      {
        compressTools: true,
        compressToolResults: true,
        minCompressChars: 1,
        historyAmortizationHorizon: 1,
        gptHistory: {
          keepTail: 0,
          keepRecentPairs: 0,
          minCollapsePrefix: 1,
          minCollapseTokens: 1,
        },
        keepSharp: () => false,
      },
    );
    expect(options.compressTools).toBe(false);
    expect(options.compressToolResults).toBe(false);
    expect(options.minCompressChars).toBe(Number.MAX_SAFE_INTEGER);
    expect(options.historyAmortizationHorizon).toBe(4);
    expect(options.gptHistory?.keepTail).toBe(12);
    expect(options.gptHistory?.keepRecentPairs).toBe(12);
    expect(options.gptHistory?.minCollapsePrefix).toBe(16);
    expect(options.gptHistory?.minCollapseTokens).toBe(4_000);
    expect(options.keepSharp?.({
      text: 'src/index.ts:42:7 error TS2322: Type mismatch',
      kind: 'tool_result',
    })).toBe(true);
  });

  it('allows caller overrides to tighten safe profiles', () => {
    const options = mergeCompressionProfileOptions(
      resolveCompressionProfile('balanced'),
      {
        compress: false,
        collapseHistory: false,
        historyAmortizationHorizon: 6,
        gptHistory: {
          keepTail: 14,
          keepRecentPairs: 14,
          minCollapsePrefix: 20,
          minCollapseTokens: 5_000,
        },
      },
    );
    expect(options.compress).toBe(false);
    expect(options.collapseHistory).toBe(false);
    expect(options.historyAmortizationHorizon).toBe(6);
    expect(options.gptHistory?.keepTail).toBe(14);
    expect(options.gptHistory?.keepRecentPairs).toBe(14);
    expect(options.gptHistory?.minCollapsePrefix).toBe(20);
    expect(options.gptHistory?.minCollapseTokens).toBe(5_000);
  });

  it('cannot turn passthrough back into a transform', () => {
    const options = mergeCompressionProfileOptions(
      resolveCompressionProfile('passthrough'),
      { compress: true, compressToolResults: true },
    );
    expect(options.compress).toBe(false);
  });

  it('recognizes coding-state shapes conservatively', () => {
    expect(shouldKeepToolResultSharp({ text: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@', kind: 'tool_result' })).toBe(true);
    expect(shouldKeepToolResultSharp({ text: '{"commit":"a1b2c3d4","ok":true}', kind: 'tool_result' })).toBe(true);
    expect(shouldKeepToolResultSharp({ text: 'ordinary prose without machine state', kind: 'tool_result' })).toBe(false);
  });

  it('safe scopes cannot promote experimental models through PXPIPE_MODELS', () => {
    process.env.PXPIPE_MODELS = 'claude-fable-5,gemini-3.6-flash,gpt-5.6-sol,claude-opus-5';
    expect(isPxpipeSupportedModelForScope('claude-fable-5', 'coding-safe')).toBe(true);
    expect(isPxpipeSupportedModelForScope('gemini-3.6-flash', 'coding-safe')).toBe(true);
    expect(isPxpipeSupportedModelForScope('gpt-5.6-sol', 'coding-safe')).toBe(false);
    expect(isPxpipeSupportedModelForScope('claude-opus-5', 'balanced')).toBe(false);
    expect(isPxpipeSupportedModelForScope('gpt-5.6-sol', 'aggressive')).toBe(true);
  });

  it('passthrough admits no model for transformation', () => {
    expect(isPxpipeSupportedModelForScope('claude-fable-5', 'passthrough')).toBe(false);
  });
});
