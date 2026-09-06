import { afterEach, describe, expect, it } from 'vitest';
import { resolveGptProfile } from '../src/core/gpt-model-profiles.js';
import { openAIImageDetail } from '../src/core/openai.js';

const original = process.env.PXPIPE_GPT_PROFILES;
afterEach(() => { if (original === undefined) delete process.env.PXPIPE_GPT_PROFILES; else process.env.PXPIPE_GPT_PROFILES = original; });
describe('profile-controlled outbound image detail', () => {
  it('uses original for GPT-6 and preserves other model defaults', () => {
    delete process.env.PXPIPE_GPT_PROFILES;
    expect(openAIImageDetail('gpt-6-astra')).toBe('original');
    expect(openAIImageDetail('gpt-5.6-sol')).toBe('original');
    expect(openAIImageDetail('unknown-model')).toBe('high');
  });
  it.each(['high', 'original'] as const)('uses a valid %s profile override', imageDetail => {
    process.env.PXPIPE_GPT_PROFILES = JSON.stringify({ 'gpt-6-astra': { imageDetail } });
    expect(resolveGptProfile('gpt-6-astra').imageDetail).toBe(imageDetail);
    expect(openAIImageDetail('gpt-6-astra')).toBe(imageDetail);
  });
  it('does not forward an unsupported detail value', () => {
    process.env.PXPIPE_GPT_PROFILES = JSON.stringify({ 'gpt-6-astra': { imageDetail: 'invalid' } });
    expect(openAIImageDetail('gpt-6-astra')).toBe('original');
  });
});
