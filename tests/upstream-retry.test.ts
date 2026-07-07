import { describe, it, expect } from 'vitest';
import { fetchUpstreamWithRetry } from '../src/core/proxy.js';

const noBackoff = () => 0;

describe('fetchUpstreamWithRetry', () => {
  it('retries transient transport error then succeeds', async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      if (calls < 3) throw new Error('fetch failed');
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const { res, error } = await fetchUpstreamWithRetry('http://u', {}, {
      maxAttempts: 3, backoffMs: noBackoff, fetchImpl: fake,
    });
    expect(calls).toBe(3);
    expect(error).toBeUndefined();
    expect(res).toBeDefined();
    expect(await res!.text()).toBe('ok');
  });

  it('gives up after maxAttempts, returns last error with cause', async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      throw Object.assign(new Error('fetch failed'), { cause: new Error('ECONNRESET') });
    }) as unknown as typeof fetch;
    const { res, error } = await fetchUpstreamWithRetry('http://u', {}, {
      maxAttempts: 3, backoffMs: noBackoff, fetchImpl: fake,
    });
    expect(calls).toBe(3);
    expect(res).toBeUndefined();
    expect(error?.message).toBe('fetch failed');
    expect((error as Error & { cause?: Error }).cause?.message).toBe('ECONNRESET');
  });

  it('does NOT retry when maxAttempts=1 (stream body path)', async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;
    const { error } = await fetchUpstreamWithRetry('http://u', {}, {
      maxAttempts: 1, backoffMs: noBackoff, fetchImpl: fake,
    });
    expect(calls).toBe(1);
    expect(error?.message).toBe('fetch failed');
  });

  it('does NOT retry a successful HTTP error response (4xx/5xx do not throw)', async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return new Response('too long', { status: 400 });
    }) as unknown as typeof fetch;
    const { res, error } = await fetchUpstreamWithRetry('http://u', {}, {
      maxAttempts: 3, backoffMs: noBackoff, fetchImpl: fake,
    });
    expect(calls).toBe(1); // HTTP errors are returned, not retried
    expect(error).toBeUndefined();
    expect(res!.status).toBe(400);
  });
});
