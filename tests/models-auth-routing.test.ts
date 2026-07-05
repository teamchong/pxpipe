/**
 * /v1/models routing by auth style. The path exists on BOTH APIs, so the
 * proxy sniffs the auth header — but an `sk-ant-…` bearer is Anthropic by
 * construction (Claude Code subscription auth sends
 * `authorization: Bearer sk-ant-oat01-…` with no x-api-key). It must never
 * be forwarded to the OpenAI upstream. All tokens here are fake; the suite
 * never touches the network (global fetch is stubbed).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createProxy } from '../src/core/proxy.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(capture: { url?: string; headers?: Headers }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capture.url = String(input);
    capture.headers = new Headers(init?.headers);
    return new Response(JSON.stringify({ data: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('/v1/models auth-style routing', () => {
  const proxy = () => createProxy({});

  it('routes an sk-ant bearer (Claude Code OAuth) to the Anthropic upstream', async () => {
    const cap: { url?: string; headers?: Headers } = {};
    stubFetch(cap);
    await proxy()(
      new Request('http://localhost/v1/models', {
        method: 'GET',
        headers: { authorization: 'Bearer sk-ant-oat01-fake-oauth-token' },
      }),
    );
    expect(cap.url).toBe('https://api.anthropic.com/v1/models');
    // The token stays on the Anthropic leg, never crosses to api.openai.com.
    expect(cap.headers?.get('authorization')).toBe('Bearer sk-ant-oat01-fake-oauth-token');
  });

  it('still routes a non-Anthropic bearer to the OpenAI upstream', async () => {
    const cap: { url?: string; headers?: Headers } = {};
    stubFetch(cap);
    await proxy()(
      new Request('http://localhost/v1/models', {
        method: 'GET',
        headers: { authorization: 'Bearer fake-openai-key' },
      }),
    );
    expect(cap.url).toBe('https://api.openai.com/v1/models');
  });

  it('still routes x-api-key requests to the Anthropic upstream', async () => {
    const cap: { url?: string; headers?: Headers } = {};
    stubFetch(cap);
    await proxy()(
      new Request('http://localhost/v1/models', {
        method: 'GET',
        headers: { 'x-api-key': 'fake-anthropic-key' },
      }),
    );
    expect(cap.url).toBe('https://api.anthropic.com/v1/models');
  });
});
