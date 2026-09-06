import { describe, expect, it } from 'vitest';
import { resolveGptProfile } from '../src/core/gpt-model-profiles.js';
import {
  computeOpenAIActualInputEff,
  computeOpenAIBaselineInputEff,
  computeOpenAIBaselineRawTokens,
  computeOpenAICollapsePaybackReads,
} from '../src/core/openai-savings.js';

const MODEL = 'gpt-6-astra';

describe('GPT-6 evaluated profile', () => {
  it.each([MODEL, `${MODEL}[1m]`, `openai/${MODEL}`])('resolves %s consistently', model => {
    const p = resolveGptProfile(model);
    expect(p).toMatchObject({
      stripCols: 152, maxHeightPx: 1932,
      vision: { regime: 'patch', multiplier: 1.2 },
      style: { font: 'spleen-5x8' },
      factSheetFormat: 'compact', exactStaticBaseline: true,
      cacheReadRate: 0.1, cacheWriteRate: 1.25, outputRate: 5,
      history: {
        maxImages: 200, keepTail: 1, keepRecentPairs: 1,
        responsesMode: 'mixed', framing: 'compact', factSheetScope: 'per-segment',
        reflow: true, freezeChunk: 1, factSheetOverflow: 'native-opaque',
        maxCachePaybackReads: 10,
      },
    });
  });

  it('does not change the older GPT family history budget', () => {
    expect(resolveGptProfile('gpt-5.6').history.maxImages).toBe(32);
    expect(resolveGptProfile('gpt-5.6-sol').history.maxImages).toBe(64);
  });
});

describe('GPT-6 input accounting', () => {
  it('treats cache reads/writes as subsets, not additive input buckets', () => {
    expect(computeOpenAIActualInputEff(10000, 6000, MODEL, 2000)).toBe(5100);
    expect(computeOpenAIActualInputEff(10000, 15000, MODEL, 2000)).toBe(1000);
    expect(computeOpenAIActualInputEff(0, 6000, MODEL, 2000)).toBe(0);
  });

  it('subtracts native factsheet overhead from raw counterfactual savings', () => {
    expect(computeOpenAIBaselineRawTokens(10000, 2000, 8000, 500)).toBe(15500);
  });

  it('prices the replacement delta at the observed warm/cold cache rate', () => {
    expect(computeOpenAIBaselineInputEff(10000, 6000, 2000, 8000, MODEL, 500, 2000)).toBe(5650);
    expect(computeOpenAIBaselineInputEff(10000, 0, 2000, 8000, MODEL, 500, 10000)).toBe(19375);
    expect(computeOpenAIBaselineInputEff(10000, 0, 2000, 8000, MODEL, 500)).toBe(15500);
  });

  it('rejects unprofitable or slow-payback collapses without imaginary savings', () => {
    expect(computeOpenAICollapsePaybackReads(10000, 2000, MODEL)).toBe(2);
    expect(computeOpenAICollapsePaybackReads(10000, 9000, MODEL)).toBe(103);
    expect(computeOpenAICollapsePaybackReads(10000, 10000, MODEL)).toBe(Infinity);
    expect(computeOpenAICollapsePaybackReads(10000, 11000, MODEL)).toBe(Infinity);
  });
});
