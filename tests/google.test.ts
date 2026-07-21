/**
 * Unit tests for Google AI Studio / Gemini API transformer and usage extractor.
 */

import { describe, expect, it } from 'vitest';
import {
  transformGoogleGenerateContent,
  extractGoogleUsage,
  parseGoogleModelFromPath,
} from '../src/core/google.js';

describe('parseGoogleModelFromPath', () => {
  it('extracts model name from Google AI Studio URL path', () => {
    expect(parseGoogleModelFromPath('/google-ai-studio/v1beta/models/gemini-3.6-flash:generateContent')).toBe('gemini-3.6-flash');
    expect(parseGoogleModelFromPath('/v1beta/models/gemini-3.6-flash:streamGenerateContent')).toBe('gemini-3.6-flash');
    expect(parseGoogleModelFromPath('/models/google/gemini-3.6-flash:generateContent')).toBe('google/gemini-3.6-flash');
    expect(parseGoogleModelFromPath('/v1/messages')).toBeNull();
  });
});

describe('extractGoogleUsage', () => {
  it('extracts promptTokenCount and candidatesTokenCount from JSON or SSE chunk', () => {
    const raw = JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'hello' }] } }],
      usageMetadata: {
        promptTokenCount: 1089,
        candidatesTokenCount: 42,
        totalTokenCount: 1131,
      },
    });
    const usage = extractGoogleUsage(raw);
    expect(usage).toEqual({
      input_tokens: 1089,
      output_tokens: 42,
    });
  });

  it('extracts usageMetadata from Google AI Studio stream JSON array format', () => {
    const rawArray = JSON.stringify([
      { candidates: [{ content: { parts: [{ text: 'chunk 1' }] } }] },
      {
        candidates: [{ content: { parts: [{ text: 'chunk 2' }] } }],
        usageMetadata: { promptTokenCount: 2048, candidatesTokenCount: 99 },
      },
    ]);
    const usage = extractGoogleUsage(rawArray);
    expect(usage).toEqual({
      input_tokens: 2048,
      output_tokens: 99,
    });
  });

  it('returns null on invalid JSON or missing usageMetadata', () => {
    expect(extractGoogleUsage('invalid json')).toBeNull();
    expect(extractGoogleUsage(JSON.stringify({ text: 'hi' }))).toBeNull();
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
    expect(result.info.imageTokens).toBe(1089 * result.info.imageCount);
    expect(result.info.baselineImagedTokens).toBeGreaterThan(1089);

    const outReq = JSON.parse(new TextDecoder().decode(result.body));
    expect(outReq.systemInstruction).toBeUndefined();
    expect(outReq.contents[0].parts[0].inlineData).toBeDefined();
    expect(outReq.contents[0].parts[0].inlineData.mimeType).toBe('image/png');
  });

  it('fails profitability gate for small system instructions', async () => {
    const sampleBody = {
      systemInstruction: {
        parts: [{ text: 'Short system prompt.' }],
      },
      contents: [{ role: 'user', parts: [{ text: 'User question' }] }],
    };
    const bodyBytes = new TextEncoder().encode(JSON.stringify(sampleBody));
    const result = await transformGoogleGenerateContent(bodyBytes, 'gemini-3.6-flash', { compress: true });

    expect(result.info.compressed).toBe(false);
    expect(result.info.reason).toContain('not_profitable');
  });
});
