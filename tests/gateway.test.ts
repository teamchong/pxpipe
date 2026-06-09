/**
 * Cloudflare AI Gateway provider mode. All URLs and tokens here are fake —
 * the suite never touches the network (global fetch is stubbed).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createProxy, parseGatewayHeaders, resolveUpstreams } from '../src/core/proxy.js';

const FAKE_BASE = 'https://gateway.example.test/v1/acct_fake/gw_fake';
const FAKE_TOKEN = 'Bearer fake-gateway-token';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('resolveUpstreams', () => {
  it('defaults to direct upstreams without a provider', () => {
    expect(resolveUpstreams({})).toEqual({
      anthropic: 'https://api.anthropic.com',
      openai: 'https://api.openai.com',
      stripOpenAIV1: false,
    });
  });

  it('derives both family routes from one gateway base', () => {
    expect(resolveUpstreams({ provider: 'cloudflare-ai-gateway', gatewayBaseUrl: FAKE_BASE + '/' }))
      .toEqual({
        anthropic: `${FAKE_BASE}/anthropic`,
        openai: `${FAKE_BASE}/openai`,
        stripOpenAIV1: true,
      });
  });

  it('requires gatewayBaseUrl in provider mode', () => {
    expect(() => resolveUpstreams({ provider: 'cloudflare-ai-gateway' })).toThrow(
      /gatewayBaseUrl/,
    );
  });
});

describe('parseGatewayHeaders', () => {
  it('parses JSON object form', () => {
    expect(parseGatewayHeaders('{"cf-aig-authorization": "Bearer x", "x-extra": "1"}')).toEqual({
      'cf-aig-authorization': 'Bearer x',
      'x-extra': '1',
    });
  });

  it('parses k=v;k2=v2 form (values may contain =)', () => {
    expect(parseGatewayHeaders('cf-aig-authorization=Bearer a=b; x-extra=1')).toEqual({
      'cf-aig-authorization': 'Bearer a=b',
      'x-extra': '1',
    });
  });

  it('returns empty for unset', () => {
    expect(parseGatewayHeaders(undefined)).toEqual({});
    expect(parseGatewayHeaders('')).toEqual({});
  });
});

function stubFetch(capture: { url?: string; headers?: Headers }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/count_tokens')) {
      return new Response(JSON.stringify({ input_tokens: 1 }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    capture.url = url;
    capture.headers = new Headers(init?.headers);
    return new Response(
      JSON.stringify({ type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }),
      { headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}

describe('gateway end-to-end routing (stubbed fetch)', () => {
  const proxy = () =>
    createProxy({
      provider: 'cloudflare-ai-gateway',
      gatewayBaseUrl: FAKE_BASE,
      gatewayHeaders: { 'cf-aig-authorization': FAKE_TOKEN },
    });

  it('routes Anthropic /v1/messages to {base}/anthropic/v1/messages with injected headers', async () => {
    const cap: { url?: string; headers?: Headers } = {};
    stubFetch(cap);
    const res = await proxy()(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'fake-anthropic-key' },
        body: JSON.stringify({ model: 'claude-fable-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(cap.url).toBe(`${FAKE_BASE}/anthropic/v1/messages`);
    expect(cap.headers?.get('cf-aig-authorization')).toBe(FAKE_TOKEN);
    expect(cap.headers?.get('x-api-key')).toBe('fake-anthropic-key');
  });

  it('routes OpenAI /v1/chat/completions to {base}/openai/chat/completions', async () => {
    const cap: { url?: string; headers?: Headers } = {};
    stubFetch(cap);
    await proxy()(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer fake-openai-key' },
        body: JSON.stringify({ model: 'gpt-fake', messages: [{ role: 'user', content: 'hi' }] }),
      }),
    );
    expect(cap.url).toBe(`${FAKE_BASE}/openai/chat/completions`);
    expect(cap.headers?.get('cf-aig-authorization')).toBe(FAKE_TOKEN);
    expect(cap.headers?.get('authorization')).toBe('Bearer fake-openai-key');
  });

  it('routes OpenAI /v1/responses to {base}/openai/responses', async () => {
    const cap: { url?: string; headers?: Headers } = {};
    stubFetch(cap);
    await proxy()(
      new Request('http://localhost/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer fake-openai-key' },
        body: JSON.stringify({ model: 'gpt-fake', input: 'hi' }),
      }),
    );
    expect(cap.url).toBe(`${FAKE_BASE}/openai/responses`);
  });

  it('passes unrecognized Anthropic-family paths through untouched', async () => {
    const cap: { url?: string; headers?: Headers } = {};
    stubFetch(cap);
    await proxy()(
      new Request('http://localhost/v1/some/unknown?x=1', {
        method: 'GET',
        headers: { 'x-api-key': 'fake-anthropic-key' },
      }),
    );
    expect(cap.url).toBe(`${FAKE_BASE}/anthropic/v1/some/unknown?x=1`);
    expect(cap.headers?.get('cf-aig-authorization')).toBe(FAKE_TOKEN);
  });

  it('preserves streaming responses byte-for-byte', async () => {
    const sse = 'event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/count_tokens')) {
        return new Response(JSON.stringify({ input_tokens: 1 }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(sse));
            c.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof fetch;
    const res = await proxy()(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'fake-anthropic-key' },
        body: JSON.stringify({ model: 'claude-fable-5', max_tokens: 1, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      }),
    );
    expect(await res.text()).toBe(sse);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
  });
});
