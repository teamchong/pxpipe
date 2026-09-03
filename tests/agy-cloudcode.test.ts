import { afterEach, describe, expect, it } from 'vitest';
import { createProxy } from '../src/core/proxy.js';
import { isGoogleInferencePath, transformGoogleGenerateContent } from '../src/core/google.js';
import { matchRoute, parseRoute } from '../src/warp/route.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('Antigravity CloudCode PA inference routing', () => {
  it('identifies CloudCode PA inference paths', () => {
    expect(isGoogleInferencePath('/v1internal:streamGenerateContent')).toBe(true);
    expect(isGoogleInferencePath('/v1internal:generateContent')).toBe(true);
    expect(isGoogleInferencePath('/v1internal:loadCodeAssist')).toBe(false);
    expect(isGoogleInferencePath('/v1internal:fetchUserInfo')).toBe(false);
    expect(isGoogleInferencePath('/google-ai-studio/v1beta/models/gemini-3.6-flash:generateContent')).toBe(true);
  });

  it('matches warp default route for Antigravity streamGenerateContent', () => {
    const route = parseRoute('daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent*=http://127.0.0.1:47821');
    expect(matchRoute([route], 'daily-cloudcode-pa.googleapis.com:443', '/v1internal:streamGenerateContent?alt=sse')).not.toBeNull();
    expect(matchRoute([route], 'daily-cloudcode-pa.googleapis.com:443', '/v1internal:loadCodeAssist')).toBeNull();
  });

  it('transforms enveloped Antigravity request preserving outer fields', async () => {
    const envelope = {
      project: 'aicode-consumers',
      requestId: 'agent/test-req-123',
      model: 'gemini-3.8-flash-high',
      userAgent: 'antigravity/cli/1.0',
      requestType: 'agent',
      request: {
        systemInstruction: {
          parts: [{ text: 'System instruction text for testing Antigravity transformer. '.repeat(300) }],
        },
        contents: [{ role: 'user', parts: [{ text: 'Explain how pxpipe works.' }] }],
      },
    };

    const bodyBytes = new TextEncoder().encode(JSON.stringify(envelope));
    const result = await transformGoogleGenerateContent(bodyBytes, 'gemini-3.8-flash-high', { compress: true });

    expect(result.info.compressed).toBe(true);
    expect(result.info.imageCount).toBeGreaterThan(0);

    const transformedJson = JSON.parse(new TextDecoder().decode(result.body));
    expect(transformedJson.project).toBe('aicode-consumers');
    expect(transformedJson.requestId).toBe('agent/test-req-123');
    expect(transformedJson.model).toBe('gemini-3.8-flash-high');
    expect(transformedJson.userAgent).toBe('antigravity/cli/1.0');
    expect(transformedJson.requestType).toBe('agent');
    expect(transformedJson.request).toBeDefined();
    expect(transformedJson.request.contents[0].parts[0].inlineData).toBeDefined();
  });

  it('routes /v1internal:streamGenerateContent to daily-cloudcode-pa with auth preserved', async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Headers | undefined;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = input.toString();
      capturedHeaders = init?.headers as Headers;

      const ssePayload = [
        'data: {"response": {"candidates": [{"content": {"role": "model", "parts": [{"text": "Hello from Gemini"}]}}], "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 20, "totalTokenCount": 120}}}\n\n',
      ].join('');

      return new Response(ssePayload, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const proxy = createProxy({
      apiKey: 'sk-anthropic-secret', // Should NOT be injected into Google CloudCode
    });

    const envelope = {
      project: 'aicode-consumers',
      model: 'gemini-3.8-flash-high',
      request: {
        systemInstruction: {
          parts: [{ text: 'You are an AI assistant.' }],
        },
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      },
    };

    const req = new Request('http://127.0.0.1:47821/v1internal:streamGenerateContent?alt=sse', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ya29.test-google-token',
        'host': 'daily-cloudcode-pa.googleapis.com',
      },
      body: JSON.stringify(envelope),
    });

    const res = await proxy(req);
    expect(res.status).toBe(200);
    expect(capturedUrl).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');
    expect(capturedHeaders?.get('authorization')).toBe('Bearer ya29.test-google-token');
    expect(capturedHeaders?.get('x-api-key')).toBeNull();
  });

  it('strips port from host header and correctly matches daily-cloudcode-pa', async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString();
      return new Response('data: {}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    const proxy = createProxy();
    const req = new Request('http://127.0.0.1:47821/v1internal:streamGenerateContent?alt=sse', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'host': 'daily-cloudcode-pa.googleapis.com:443',
      },
      body: JSON.stringify({ model: 'gemini-3.8-flash-high', request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } }),
    });

    await proxy(req);
    expect(capturedUrl).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');
  });

  it('safely rejects spoofed or substring-matched hosts without SSRF', async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString();
      return new Response('data: {}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    const proxy = createProxy();
    // Path for standard Gemini models with an attacker-controlled Host header
    const req = new Request('http://127.0.0.1:47821/google-ai-studio/v1beta/models/gemini-3.8-flash-high:generateContent', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'host': 'evil-googleapis.com',
      },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    });

    await proxy(req);
    // Must NOT send to evil-googleapis.com; must use standard Generative Language endpoint
    expect(capturedUrl).toBe('https://generativelanguage.googleapis.com/google-ai-studio/v1beta/models/gemini-3.8-flash-high:generateContent');
  });

  it('respects googleUpstream config override if supplied', async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString();
      return new Response('data: {}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    const proxy = createProxy({
      googleUpstream: 'https://mock-google-gateway.internal',
    });
    const req = new Request('http://127.0.0.1:47821/v1internal:streamGenerateContent?alt=sse', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'host': 'daily-cloudcode-pa.googleapis.com',
      },
      body: JSON.stringify({ model: 'gemini-3.8-flash-high', request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } }),
    });

    await proxy(req);
    expect(capturedUrl).toBe('https://mock-google-gateway.internal/v1internal:streamGenerateContent?alt=sse');
  });
});
