/**
 * Gateway-prefixed OpenAI wire shapes must be recognized as OpenAI-shaped.
 *
 * Regression: `/compat/chat/completions` (Cloudflare AI Gateway's
 * OpenAI-compatible route — how non-Anthropic models reach pxpipe) and
 * `/grok/chat/completions` matched neither isOpenAIChatPath nor
 * isOpenAIResponsesPath, so the proxy skipped the parse block entirely: the
 * emitted event carried no `model` and defaulted to `anthropic` accounting.
 * The dashboard rendered those rows as endpoint "completions" with Model,
 * Sent as, As text, Sent and Saved all blank. Observed in the wild across 70
 * `/compat/chat/completions` and 306 `/grok/chat/completions` events.
 *
 * These are wire-shape tests only — they must not move upstream routing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';

let ambientPxpipeModels: string | undefined;
beforeAll(() => {
  ambientPxpipeModels = process.env.PXPIPE_MODELS;
  // Deliberately narrow: none of the ids below are in scope, so every request
  // here is a passthrough. Telemetry must still be complete.
  process.env.PXPIPE_MODELS = 'claude-fable-5';
});
afterAll(() => {
  if (ambientPxpipeModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = ambientPxpipeModels;
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const UPSTREAM = 'https://upstream.example.test';

/** Captures the outbound URL and answers with a minimal OpenAI-shaped body. */
function stubUpstream(cap: { url?: string }) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    cap.url = String(input);
    return new Response(
      JSON.stringify({
        id: 'chatcmpl_1',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}

async function post(path: string, body: unknown): Promise<ProxyEvent> {
  let captured: ProxyEvent | undefined;
  const proxy = createProxy({
    upstream: UPSTREAM,
    onRequest: (e) => {
      captured = e;
    },
  });
  await proxy(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer fake-key' },
      body: JSON.stringify(body),
    }),
  );
  await new Promise((r) => setTimeout(r, 0));
  if (!captured) throw new Error(`no event emitted for ${path}`);
  return captured;
}

const CHAT_BODY = { model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }] };

describe('gateway-prefixed chat/completions is OpenAI-shaped', () => {
  it.each([
    '/v1/chat/completions',
    '/openai/v1/chat/completions',
    '/compat/chat/completions',
    '/grok/chat/completions',
  ])('records model and openai accounting on %s', async (path) => {
    const cap: { url?: string } = {};
    stubUpstream(cap);
    const ev = await post(path, CHAT_BODY);
    expect(ev.model).toBe('kimi-k3');
    expect(ev.accountingProvider).toBe('openai');
  });

  it.each(['/v1/responses', '/openai/responses', '/grok/v1/responses', '/compat/responses'])(
    'records model and openai accounting on %s',
    async (path) => {
      const cap: { url?: string } = {};
      stubUpstream(cap);
      const ev = await post(path, { model: 'kimi-k3', input: 'hi' });
      expect(ev.model).toBe('kimi-k3');
      expect(ev.accountingProvider).toBe('openai');
    },
  );

  it('leaves an out-of-scope model uncompressed', async () => {
    const cap: { url?: string } = {};
    stubUpstream(cap);
    const ev = await post('/compat/chat/completions', CHAT_BODY);
    expect(ev.info?.compressed).toBe(false);
    expect(ev.info?.reason).toBe('unsupported_model');
  });

  it('does not move upstream routing for a provider-prefixed path', async () => {
    const cap: { url?: string } = {};
    stubUpstream(cap);
    await post('/compat/chat/completions', CHAT_BODY);
    // Same base + same path as before the wire-shape widening.
    expect(cap.url).toBe(`${UPSTREAM}/compat/chat/completions`);
  });

  // Recording the model and transforming the body are separate decisions. The
  // model lives in the body, so it is read for any POST regardless of path —
  // otherwise an unrecognized path produces a dashboard row with every column
  // blank. Treating the path as a transformable wire shape is still strict.
  it('records the model but does not transform an unrecognized path', async () => {
    const cap: { url?: string } = {};
    stubUpstream(cap);
    const ev = await post('/compat/chat/completions/extra', CHAT_BODY);
    expect(ev.model).toBe('kimi-k3');
    expect(ev.info?.compressed).toBeFalsy();
  });

  it('does not treat a two-segment prefix as a provider prefix', async () => {
    const cap: { url?: string } = {};
    stubUpstream(cap);
    const ev = await post('/a/b/chat/completions', CHAT_BODY);
    expect(ev.model).toBe('kimi-k3');
    expect(ev.info?.compressed).toBeFalsy();
    // Routing is untouched: no provider prefix was recognized here.
    expect(cap.url).toBe(`${UPSTREAM}/a/b/chat/completions`);
  });
});

/**
 * The model sniff on unrecognized POST paths buffers the body. That route also
 * carries uploads, so the buffering is gated: JSON only, and not past a
 * declared size cap. When the gate declines, the row's Model is blank — the
 * pre-existing behavior — and the body must still reach upstream untouched.
 */
describe('model sniff on unrecognized paths is gated', () => {
  async function postRaw(
    path: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<{ ev: ProxyEvent; sentBody: string | undefined }> {
    let captured: ProxyEvent | undefined;
    let sentBody: string | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = init?.body === undefined || init?.body === null
        ? undefined
        : typeof init.body === 'string'
          ? init.body
          : new TextDecoder().decode(await new Response(init.body as BodyInit).arrayBuffer());
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const proxy = createProxy({
      upstream: UPSTREAM,
      onRequest: (e) => {
        captured = e;
      },
    });
    await proxy(new Request(`http://localhost${path}`, { method: 'POST', headers, body }));
    await new Promise((r) => setTimeout(r, 0));
    if (!captured) throw new Error(`no event emitted for ${path}`);
    return { ev: captured, sentBody };
  }

  const BODY = JSON.stringify(CHAT_BODY);

  it('sniffs a JSON body with no declared length (chunked clients omit it)', async () => {
    const { ev, sentBody } = await postRaw(
      '/some/unknown/path',
      { 'content-type': 'application/json' },
      BODY,
    );
    expect(ev.model).toBe('kimi-k3');
    expect(sentBody).toBe(BODY);
  });

  it('skips a non-JSON body and forwards it unchanged', async () => {
    const { ev, sentBody } = await postRaw(
      '/some/unknown/path',
      { 'content-type': 'application/octet-stream' },
      BODY,
    );
    expect(ev.model).toBeUndefined();
    expect(sentBody).toBe(BODY);
  });

  it('skips a JSON body declaring a length past the cap', async () => {
    const { ev, sentBody } = await postRaw(
      '/some/unknown/path',
      { 'content-type': 'application/json', 'content-length': String((1 << 20) + 1) },
      BODY,
    );
    expect(ev.model).toBeUndefined();
    expect(sentBody).toBe(BODY);
  });
});
