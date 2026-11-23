/**
 * An Anthropic-shaped credential must not reach the Google upstream.
 *
 * proxy.ts states the rule for the OpenAI family and gives the reason:
 * "`x-api-key` is Anthropic-only and never belongs on an OpenAI upstream", and
 * resolveOpenAIRouteAuth's rule 1 — "An Anthropic-shaped credential never
 * reaches an OpenAI upstream. That is a cross-provider credential disclosure."
 *
 * The outbound header assembly has three branches and only the OpenAI one
 * enforced it. The Google branch was an empty `else if` carrying just a comment
 * about not INJECTING Anthropic keys, so whatever arrived was forwarded as-is.
 *
 * Observed before the fix, same inbound headers on both routes:
 *
 *   route    x-api-key                     authorization
 *   OpenAI   (absent)                      (absent)
 *   Google   sk-ant-api03-…                Bearer sk-ant-oat01-…
 *
 * The fix keys on the `sk-ant-` shape only, because that shape is Anthropic by
 * construction (isCanonicalOpenAIPath relies on the same fact) and because
 * pxpipe never sets or reads a Google credential itself — the Google branch's
 * whole job is to forward what the caller sent. A Google bearer or API key in
 * those same headers must therefore survive untouched.
 *
 * Contract being verified:
 *   - An Anthropic key or OAuth bearer is dropped on a Google route.
 *   - A Google OAuth bearer and a Google API key are preserved.
 *   - The OpenAI route still scrubs everything (unchanged behaviour).
 *   - Dropping does not inject a substitute credential.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { createProxy } from '../src/core/proxy.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const GOOGLE_URL =
  'http://127.0.0.1:47821/google-ai-studio/v1beta/models/gemini-4-argon:generateContent';
const OPENAI_URL = 'http://127.0.0.1:47821/v1/chat/completions';

/** Drive one request and return the headers pxpipe actually sent upstream. */
async function sentHeaders(url: string, headers: Record<string, string>): Promise<Headers> {
  let sent: Headers | undefined;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    sent = new Headers((init?.headers ?? (input as Request).headers) as HeadersInit);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const proxy = createProxy({ googleUpstream: 'https://mock-google-gateway.internal' });
  await proxy(new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  }));
  if (!sent) throw new Error('upstream fetch was never called');
  return sent;
}

describe('Google route drops an Anthropic-shaped credential', () => {
  it('drops an Anthropic api key from x-api-key', async () => {
    const out = await sentHeaders(GOOGLE_URL, { 'x-api-key': 'sk-ant-api03-SECRET' });
    expect(out.get('x-api-key')).toBeNull();
  });

  it('drops an Anthropic subscription bearer', async () => {
    const out = await sentHeaders(GOOGLE_URL, { authorization: 'Bearer sk-ant-oat01-SECRET' });
    expect(out.get('authorization')).toBeNull();
  });

  it('drops both at once, and substitutes nothing', async () => {
    const out = await sentHeaders(GOOGLE_URL, {
      'x-api-key': 'sk-ant-api03-SECRET',
      authorization: 'Bearer sk-ant-oat01-SECRET',
    });

    expect(out.get('x-api-key')).toBeNull();
    expect(out.get('authorization')).toBeNull();
    // No credential is invented in its place, and nothing leaks into another header.
    for (const [, value] of out) expect(value).not.toContain('sk-ant-');
  });

  it('is case- and whitespace-insensitive, as the bearer test already is', async () => {
    const out = await sentHeaders(GOOGLE_URL, {
      'x-api-key': '  SK-ANT-API03-SECRET',
      authorization: 'bearer   sk-ant-oat01-SECRET',
    });

    expect(out.get('x-api-key')).toBeNull();
    expect(out.get('authorization')).toBeNull();
  });
});

describe('Google route still forwards a real Google credential', () => {
  it('preserves a Google OAuth bearer', async () => {
    const out = await sentHeaders(GOOGLE_URL, { authorization: 'Bearer ya29.a0ARrdaM-GOOGLEOAUTH' });
    expect(out.get('authorization')).toBe('Bearer ya29.a0ARrdaM-GOOGLEOAUTH');
  });

  it('preserves a Google API key in x-api-key', async () => {
    const out = await sentHeaders(GOOGLE_URL, { 'x-api-key': 'AIzaSyGOOGLEKEYVALUE' });
    expect(out.get('x-api-key')).toBe('AIzaSyGOOGLEKEYVALUE');
  });

  it('preserves an opaque gateway bearer', async () => {
    const out = await sentHeaders(GOOGLE_URL, { authorization: 'Bearer gw_opaque_token' });
    expect(out.get('authorization')).toBe('Bearer gw_opaque_token');
  });
});

describe('control: the OpenAI route is unchanged', () => {
  it('still scrubs x-api-key, the bearer and anthropic-* headers', async () => {
    const out = await sentHeaders(OPENAI_URL, {
      'x-api-key': 'sk-ant-api03-SECRET',
      authorization: 'Bearer sk-ant-oat01-SECRET',
      'anthropic-beta': 'prompt-caching-2024-07-31',
      'anthropic-version': '2023-06-01',
    });

    expect(out.get('x-api-key')).toBeNull();
    expect(out.get('authorization')).toBeNull();
    expect(out.get('anthropic-beta')).toBeNull();
    expect(out.get('anthropic-version')).toBeNull();
  });
});
