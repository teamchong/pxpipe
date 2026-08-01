import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/worker.js';

const ctx = {} as ExecutionContext;

function request(secret?: string): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': 'client-key',
  };
  if (secret !== undefined) headers['x-pxpipe-secret'] = secret;
  return new Request('https://proxy.example/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'unsupported-test-model',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Worker caller authentication', () => {
  it('fails closed when a provider key is configured without a Worker secret', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);

    const res = await worker.fetch(request(), { ANTHROPIC_API_KEY: 'provider-key' }, ctx);

    expect(res.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rejects a missing or incorrect Worker secret before contacting upstream', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const env: Env = {
      ANTHROPIC_API_KEY: 'provider-key',
      PXPIPE_WORKER_SECRET: 'correct-secret',
    };

    expect((await worker.fetch(request(), env, ctx)).status).toBe(401);
    expect((await worker.fetch(request('wrong-secret'), env, ctx)).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('strips the Worker secret and applies the provider key upstream', async () => {
    let forwarded: Request | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      forwarded = new Request(input, init);
      return new Response(JSON.stringify({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const env: Env = {
      ANTHROPIC_API_KEY: 'provider-key',
      PXPIPE_WORKER_SECRET: 'correct-secret',
      PXPIPE_TRACK: '0',
    };

    const res = await worker.fetch(request('correct-secret'), env, ctx);

    expect(res.status).toBe(200);
    expect(forwarded?.headers.get('x-pxpipe-secret')).toBeNull();
    expect(forwarded?.headers.get('x-api-key')).toBe('provider-key');
  });
});
