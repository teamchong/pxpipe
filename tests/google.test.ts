/**
 * Unit tests for the Google AI Studio / Gemini API transformer.
 */

import { describe, expect, it } from 'vitest';
import {
  transformGoogleGenerateContent,
  parseGoogleModelFromPath,
} from '../src/core/google.js';

describe('parseGoogleModelFromPath', () => {
  it('extracts model name from Google AI Studio URL path', () => {
    expect(parseGoogleModelFromPath('/google-ai-studio/v1beta/models/gemini-3.6-flash:generateContent')).toBe('gemini-3.6-flash');
    expect(parseGoogleModelFromPath('/google-ai-studio/v1/models/gemini-3.6-flash:streamGenerateContent')).toBe('gemini-3.6-flash');
    expect(parseGoogleModelFromPath('/v1beta/models/gemini-3.6-flash:streamGenerateContent')).toBeNull();
    expect(parseGoogleModelFromPath('/foo/google-ai-studio/v1beta/models/gemini-3.6-flash:generateContent')).toBeNull();
    expect(parseGoogleModelFromPath('/google-ai-studio/v1beta/models/gemini-3.6-flash:countTokens')).toBeNull();
    expect(parseGoogleModelFromPath('/v1/messages')).toBeNull();
  });
});

describe('transformGoogleGenerateContent', () => {
  it('compresses system instruction when above profitability threshold', async () => {
    const sampleBody = {
      systemInstruction: {
        parts: [{ text: 'System instruction text for testing Google transformer. '.repeat(300) }],
      },
      contents: [{ role: 'user', parts: [{ text: 'User question' }] }],
    };
    const bodyBytes = new TextEncoder().encode(JSON.stringify(sampleBody));
    const result = await transformGoogleGenerateContent(bodyBytes, 'gemini-3.6-flash', { compress: true });

    expect(result.info.compressed).toBe(true);
    expect(result.info.imageCount).toBeGreaterThan(0);
    expect(result.info.imageTokens).toBe(1078 * result.info.imageCount);
    expect(result.info.baselineImagedTokens).toBeGreaterThan(1078);
    expect(result.info.nativeInjectedTokens).toBeGreaterThan(0);

    const outReq = JSON.parse(new TextDecoder().decode(result.body));
    expect(outReq.systemInstruction.parts[0].text).toContain('same authority and priority');
    expect(outReq.contents[0].parts[0].inlineData).toBeDefined();
    expect(outReq.contents[0].parts[0].inlineData.mimeType).toBe('image/png');
  });

  it('defers the profitability decision to the upstream countTokens probes', async () => {
    const sampleBody = {
      systemInstruction: {
        parts: [{ text: 'Short system prompt.' }],
      },
      contents: [{ role: 'user', parts: [{ text: 'User question' }] }],
    };
    const bodyBytes = new TextEncoder().encode(JSON.stringify(sampleBody));
    const result = await transformGoogleGenerateContent(bodyBytes, 'gemini-3.6-flash', { compress: true });

    expect(result.info.compressed).toBe(true);
    expect(result.info.gateEval?.profitable).toBe(true);
  });

  it.each([
    'null',
    '[]',
    '42',
    JSON.stringify({ systemInstruction: { parts: 'bad' } }),
    JSON.stringify({ systemInstruction: { parts: [null] } }),
    JSON.stringify({ systemInstruction: { parts: [{ text: 'x'.repeat(10000) }] }, contents: 'bad' }),
  ])('passes unsupported request shape through unchanged: %s', async (raw) => {
    const bytes = new TextEncoder().encode(raw);
    const result = await transformGoogleGenerateContent(bytes, 'gemini-3.6-flash', { compress: true });
    expect(new TextDecoder().decode(result.body)).toBe(raw);
    expect(result.info.compressed).toBe(false);
  });
});
