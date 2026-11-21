/**
 * Outbound gzip compression for large JSON POST bodies sent to verified
 * gzip-capable upstreams (Anthropic and Google).
 */
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProxy,
  GZIP_UPSTREAM_MIN_BYTES,
  shouldGzipUpstreamRequest,
} from '../src/core/proxy.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('shouldGzipUpstreamRequest', () => {
  const bigBody = new Uint8Array(GZIP_UPSTREAM_MIN_BYTES + 1024).fill(65);
  const jsonHeaders = new Headers({ 'content-type': 'application/json' });

  it('enables gzip for large JSON POSTs to verified Anthropic and Google hosts', () => {
    for (const url of [
      'https://api.anthropic.com/v1/messages',
      'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
      'https://cloudcode-pa.googleapis.com/v1internal:generateContent',
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:streamGenerateContent',
    ]) {
      expect(shouldGzipUpstreamRequest(url, 'POST', jsonHeaders, bigBody)).toBe(true);
    }
  });

  it('skips custom gateways, loopback servers, small bodies, non-JSON, and pre-encoded bodies', () => {
    expect(shouldGzipUpstreamRequest('https://gateway.example.com/v1/messages', 'POST', jsonHeaders, bigBody)).toBe(false);
    expect(shouldGzipUpstreamRequest('http://127.0.0.1:9999/v1/messages', 'POST', jsonHeaders, bigBody)).toBe(false);
    expect(shouldGzipUpstreamRequest('https://api.openai.com/v1/responses', 'POST', jsonHeaders, bigBody)).toBe(false);
    expect(shouldGzipUpstreamRequest('https://api.anthropic.com/v1/messages', 'GET', jsonHeaders, bigBody)).toBe(false);
    expect(
      shouldGzipUpstreamRequest('https://api.anthropic.com/v1/messages', 'POST', jsonHeaders, new Uint8Array(GZIP_UPSTREAM_MIN_BYTES - 1)),
    ).toBe(false);
    expect(
      shouldGzipUpstreamRequest('https://api.anthropic.com/v1/messages', 'POST', new Headers({ 'content-type': 'text/plain' }), bigBody),
    ).toBe(false);
    expect(
      shouldGzipUpstreamRequest(
        'https://api.anthropic.com/v1/messages',
        'POST',
        new Headers({ 'content-type': 'application/json', 'content-encoding': 'gzip' }),
        bigBody,
      ),
    ).toBe(false);
  });
});

describe('createProxy outbound gzip', () => {
  it('gzips large JSON POSTs to api.anthropic.com and preserves exact JSON payload', async () => {
    let capturedEncoding: string | null = null;
    let capturedBody: Uint8Array | undefined;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes('count_tokens')) {
        return new Response(JSON.stringify({ input_tokens: 100 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const headers = new Headers(init?.headers);
      capturedEncoding = headers.get('content-encoding');
      capturedBody = init?.body instanceof Uint8Array ? new Uint8Array(init.body) : undefined;
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 100, output_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const proxy = createProxy({
      upstream: 'https://api.anthropic.com',
      transform: { compress: true },
    });
    const bigText = Array.from(
      { length: 600 },
      (_, i) => `rule_${i}: verify module_${(i * 7) % 97} config_${(i * 13) % 89} path=/src/pkg_${i % 41}/item_${i}.ts`,
    ).join('\n');
    const reqBody = JSON.stringify({
      model: 'claude-fable-5',
      max_tokens: 64,
      system: bigText,
      messages: [{ role: 'user', content: 'Say ok' }],
    });
    const res = await proxy(
      new Request('http://127.0.0.1:47821/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'sk-test',
        },
        body: reqBody,
      }),
    );

    expect(res.status).toBe(200);
    expect(capturedEncoding).toBe('gzip');
    expect(capturedBody).toBeInstanceOf(Uint8Array);
    const inflated = gunzipSync(capturedBody!);
    expect(capturedBody!.byteLength).toBeLessThan(inflated.byteLength);
    const decoded = JSON.parse(inflated.toString('utf8')) as { model: string };
    expect(decoded.model).toBe('claude-fable-5');
  });

  it('gzips large Cloud Code PA /v1internal:streamGenerateContent payloads', async () => {
    let capturedEncoding: string | null = null;
    let capturedBody: Uint8Array | undefined;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      capturedEncoding = headers.get('content-encoding');
      capturedBody = init?.body instanceof Uint8Array ? new Uint8Array(init.body) : undefined;
      return new Response(
        'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]}}]}}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    };

    const proxy = createProxy({ transform: { compress: true } });
    const envelope = {
      project: 'test-project',
      model: 'gemini-4-neon-high',
      request: {
        systemInstruction: {
          parts: [
            {
              text: Array.from(
                { length: 600 },
                (_, i) =>
                  `gemini_rule_${i}: check service_${(i * 11) % 83} flag_${(i * 17) % 79} file=/repo/mod_${i % 37}/f_${i}.ts`,
              ).join('\n'),
            },
          ],
        },
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      },
    };
    const res = await proxy(
      new Request('http://127.0.0.1:47821/v1internal:streamGenerateContent?alt=sse', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ya29.test-token',
          host: 'daily-cloudcode-pa.googleapis.com',
        },
        body: JSON.stringify(envelope),
      }),
    );

    expect(res.status).toBe(200);
    expect(capturedEncoding).toBe('gzip');
    expect(capturedBody).toBeInstanceOf(Uint8Array);
    const decoded = JSON.parse(gunzipSync(capturedBody!).toString('utf8')) as {
      model: string;
      request: { contents: unknown[] };
    };
    expect(decoded.model).toBe('gemini-4-neon-high');
    expect(Array.isArray(decoded.request.contents)).toBe(true);
  });

  it('leaves non-verified custom gateway payloads uncompressed', async () => {
    let capturedEncoding: string | null = null;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      capturedEncoding = headers.get('content-encoding');
      return new Response(JSON.stringify({ id: 'msg_1', content: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const proxy = createProxy({
      upstream: 'https://mock-gateway.internal',
      transform: { compress: false },
    });
    const res = await proxy(
      new Request('http://127.0.0.1:47821/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
        body: JSON.stringify({
          model: 'claude-fable-5',
          max_tokens: 64,
          system: 'x'.repeat(24_000),
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(capturedEncoding).toBeNull();
  });
});
