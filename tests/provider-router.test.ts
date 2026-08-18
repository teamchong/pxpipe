import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertProviderId,
  createProviderRouter,
  parseProviderRoute,
} from '../src/core/provider-router.js';

interface FetchCall {
  url: string;
  body: string;
  authorization: string | null;
}

function installEchoFetch(calls: FetchCall[]): void {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const request = input instanceof Request
      ? input
      : new Request(String(input), {
          ...init,
          ...(init?.body ? { duplex: 'half' as const } : {}),
        });
    const body = request.method === 'GET' || request.method === 'HEAD'
      ? ''
      : await request.text();
    calls.push({
      url: request.url,
      body,
      authorization: request.headers.get('authorization'),
    });
    return new Response(JSON.stringify({ url: request.url, body }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-upstream': new URL(request.url).hostname,
      },
    });
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provider route parsing', () => {
  it('accepts explicit provider paths and strips only the internal prefix', () => {
    expect(parseProviderRoute('/providers/openai-alt/v1/chat/completions')).toEqual({
      providerId: 'openai-alt',
      upstreamPath: '/v1/chat/completions',
    });
    expect(parseProviderRoute('/providers/anthropic/v1/messages')).toEqual({
      providerId: 'anthropic',
      upstreamPath: '/v1/messages',
    });
  });

  it('does not treat incomplete or malformed paths as valid provider routes', () => {
    expect(parseProviderRoute('/v1/messages')).toBeNull();
    expect(parseProviderRoute('/providers')).toBeNull();
    expect(parseProviderRoute('/providers/')).toBeNull();
    expect(parseProviderRoute('/providers/OpenAI/v1/chat/completions')).toBeNull();
    expect(parseProviderRoute('/providers/openai-alt')).toBeNull();
    expect(parseProviderRoute('/providers/openai-alt//v1/chat/completions')).toBeNull();
  });

  it('validates provider identifiers', () => {
    expect(() => assertProviderId('anthropic')).not.toThrow();
    expect(() => assertProviderId('openai-compatible')).not.toThrow();
    expect(() => assertProviderId('Bad_Id')).toThrow(/invalid provider id/);
    expect(() => assertProviderId('')).toThrow(/invalid provider id/);
  });
});

describe('provider router', () => {
  it('routes an explicit OpenAI provider while preserving query, body and auth', async () => {
    const calls: FetchCall[] = [];
    const observed: string[] = [];
    installEchoFetch(calls);

    const router = createProviderRouter({
      defaultProxy: { upstream: 'https://legacy.example' },
      providers: [{
        id: 'openai-alt',
        protocol: 'openai',
        proxy: {
          openAIUpstream: 'https://api.openai-alt.example',
          openAIModels: ['gpt-test'],
          onRequest: () => observed.push('provider-observer'),
        },
      }],
      onRequest: (providerId) => observed.push(`router:${providerId}`),
    });

    const raw = '{"model":"gpt-test","messages":[],"spacing":"  preserved  "}';
    const response = await router(new Request(
      'http://127.0.0.1:47821/providers/openai-alt/v1/chat/completions?trace=one',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer incoming-token',
          'content-type': 'application/json',
        },
        body: raw,
      },
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-upstream')).toBe('api.openai-alt.example');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.openai-alt.example/v1/chat/completions?trace=one');
    expect(calls[0]!.authorization).toBe('Bearer incoming-token');
    expect(calls[0]!.body).toBe(raw);
    await response.text();

    await vi.waitFor(() => {
      expect(observed).toEqual(['provider-observer', 'router:openai-alt']);
    });
  });

  it('keeps legacy unprefixed routes on the default proxy', async () => {
    const calls: FetchCall[] = [];
    installEchoFetch(calls);
    const router = createProviderRouter({
      defaultProxy: { upstream: 'https://legacy-anthropic.example' },
      providers: [],
    });

    const response = await router(new Request('http://127.0.0.1:47821/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'unsupported-test-model',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }));
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://legacy-anthropic.example/v1/messages');
  });

  it('fails unknown explicit providers closed without contacting an upstream', async () => {
    const calls: FetchCall[] = [];
    installEchoFetch(calls);
    const router = createProviderRouter({
      defaultProxy: { upstream: 'https://legacy.example' },
      providers: [],
    });

    const response = await router(new Request(
      'http://127.0.0.1:47821/providers/not-configured/v1/messages',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    ));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'unknown_provider',
      provider: 'not-configured',
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    '/providers',
    '/providers/',
    '/providers/OpenAI/v1/chat/completions',
    '/providers/openai-alt',
    '/providers/openai-alt//v1/chat/completions',
  ])('fails malformed reserved provider route %s closed', async (pathname) => {
    const calls: FetchCall[] = [];
    installEchoFetch(calls);
    const router = createProviderRouter({
      defaultProxy: { upstream: 'https://legacy.example' },
      providers: [{
        id: 'openai-alt',
        protocol: 'openai',
        proxy: { openAIUpstream: 'https://api.openai-alt.example' },
      }],
    });

    const response = await router(new Request(`http://127.0.0.1:47821${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_provider_route' });
    expect(calls).toHaveLength(0);
  });

  it('does not let query/header/body hints select an explicit provider', async () => {
    const calls: FetchCall[] = [];
    installEchoFetch(calls);
    const router = createProviderRouter({
      defaultProxy: { upstream: 'https://legacy.example' },
      providers: [{
        id: 'openai-alt',
        protocol: 'openai',
        proxy: {
          openAIUpstream: 'https://api.openai-alt.example',
          openAIModels: ['gpt-test'],
        },
      }],
    });

    const response = await router(new Request(
      'http://127.0.0.1:47821/v1/messages?provider=openai-alt',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pxpipe-provider': 'openai-alt',
        },
        body: JSON.stringify({ provider: 'openai-alt', messages: [] }),
      },
    ));
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://legacy.example/v1/messages?provider=openai-alt');
  });

  it('exposes only credential-free provider metadata', () => {
    const router = createProviderRouter({
      defaultProxy: { upstream: 'https://legacy.example', apiKey: 'default-secret' },
      providers: [{
        id: 'openai-alt',
        protocol: 'openai',
        proxy: {
          openAIUpstream: 'https://api.openai-alt.example',
          openAIApiKey: 'provider-secret',
        },
      }],
    });
    expect(router.inspect()).toEqual({
      defaultRoute: 'legacy',
      providers: [{
        id: 'openai-alt',
        protocol: 'openai',
        prefix: '/providers/openai-alt',
      }],
    });
    expect(JSON.stringify(router.inspect())).not.toContain('secret');
  });

  it('rejects duplicate provider ids', () => {
    expect(() => createProviderRouter({
      defaultProxy: { upstream: 'https://legacy.example' },
      providers: [
        { id: 'same', protocol: 'anthropic', proxy: { upstream: 'https://a.example' } },
        { id: 'same', protocol: 'openai', proxy: { openAIUpstream: 'https://b.example' } },
      ],
    })).toThrow(/duplicate provider id/);
  });
});
