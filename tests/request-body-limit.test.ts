/**
 * INBOUND request-body ceiling.
 *
 * Transformable routes have to hold the whole body in memory, so without a limit
 * the caller decides how much the proxy allocates. The Node host binds loopback
 * by default, but HOST can expose it, and a Worker is publicly reachable by
 * construction: one long-running chunked POST was enough to walk the process out
 * of memory.
 *
 * The header is not the bound. A chunked sender omits content-length entirely and
 * a wrong value costs nothing to send, so these tests drive the honest case, the
 * silent case and the lying case, and require the same answer from all three.
 *
 * Routes pxpipe only labels are held to a different contract: they carry uploads
 * and audio, so they must never be rejected, and their body must reach the
 * upstream byte-for-byte even though a bounded prefix was read off it.
 *
 * Run just this file:  pnpm vitest run tests/request-body-limit.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProxy, DEFAULT_MAX_REQUEST_BYTES, type ProxyConfig, type ProxyEvent } from '../src/core/proxy.js';

let ambientPxpipeModels: string | undefined;
beforeAll(() => {
  ambientPxpipeModels = process.env.PXPIPE_MODELS;
  process.env.PXPIPE_MODELS = 'claude-fable-5';
});
afterAll(() => {
  if (ambientPxpipeModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = ambientPxpipeModels;
});

interface Upstream {
  calls: number;
  bodies: string[];
  restore: () => void;
}

function mockUpstream(): Upstream {
  const real = globalThis.fetch;
  const state: Upstream = {
    calls: 0,
    bodies: [],
    restore: () => {
      globalThis.fetch = real;
    },
  };
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const r = input instanceof Request ? input : new Request(String(input), init);
    // The count_tokens baseline probe is a side request, not a forward. Counting
    // it would make every "did we forward?" assertion read one too high.
    if (new URL(r.url).pathname.endsWith('/count_tokens')) {
      return new Response(JSON.stringify({ input_tokens: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    state.calls += 1;
    state.bodies.push(await r.text());
    return new Response(
      JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: {} }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return state;
}

/** A body delivered in chunks, as a chunked sender does: no content-length. */
function chunkedBody(payload: string, chunkBytes = 512): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(payload);
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + chunkBytes));
      at += chunkBytes;
    },
  });
}

/** A JSON request body padded to exactly `totalBytes`. */
function jsonOfSize(totalBytes: number, model = 'claude-fable-5'): string {
  const skeleton = JSON.stringify({ model, messages: [{ role: 'user', content: '' }] });
  const padding = totalBytes - skeleton.length;
  if (padding < 0) throw new Error(`cannot fit a request in ${totalBytes} bytes`);
  return JSON.stringify({ model, messages: [{ role: 'user', content: 'x'.repeat(padding) }] });
}

/** `fire()` dispatches onRequest without awaiting it, so the event lands a tick
 *  after the response resolves. Poll briefly rather than assuming ordering. */
async function settledEvents(events: ProxyEvent[], want = 1): Promise<ProxyEvent[]> {
  for (let i = 0; i < 50 && events.length < want; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return events;
}

function post(path: string, body: BodyInit, headers: Record<string, string> = {}): Request {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  };
  if (body instanceof ReadableStream) {
    // Required by spec when the body is a stream.
    (init as RequestInit & { duplex: string }).duplex = 'half';
  }
  return new Request(`http://127.0.0.1:47821${path}`, init);
}

const LIMIT = 4096;

function proxyWithLimit(
  maxRequestBytes: number | undefined,
  events?: ProxyEvent[],
): ReturnType<typeof createProxy> {
  const config: ProxyConfig = {
    upstream: 'https://upstream.invalid',
    openAIUpstream: 'https://openai.invalid',
    transform: { compress: false },
    ...(maxRequestBytes === undefined ? {} : { maxRequestBytes }),
    ...(events ? { onRequest: (e: ProxyEvent) => void events.push(e) } : {}),
  };
  return createProxy(config);
}

describe('the ceiling is enforced on the body, not on its declared size', () => {
  it('forwards a body of exactly the limit, byte for byte', async () => {
    const up = mockUpstream();
    try {
      const payload = jsonOfSize(LIMIT);
      expect(new TextEncoder().encode(payload).byteLength).toBe(LIMIT);
      const res = await proxyWithLimit(LIMIT)(post('/v1/messages', payload));
      expect(res.status).toBe(200);
      expect(up.calls).toBe(1);
      expect(up.bodies[0]).toBe(payload);
    } finally {
      up.restore();
    }
  });

  it('refuses one byte over the limit and never calls upstream', async () => {
    const up = mockUpstream();
    try {
      const res = await proxyWithLimit(LIMIT)(post('/v1/messages', jsonOfSize(LIMIT + 1)));
      expect(res.status).toBe(413);
      expect(up.calls).toBe(0);
    } finally {
      up.restore();
    }
  });

  it('refuses a chunked body with no content-length at all', async () => {
    const up = mockUpstream();
    try {
      const res = await proxyWithLimit(LIMIT)(
        post('/v1/messages', chunkedBody(jsonOfSize(LIMIT * 4))),
      );
      expect(res.status).toBe(413);
      expect(up.calls).toBe(0);
    } finally {
      up.restore();
    }
  });

  it('refuses a body that under-declares its own length', async () => {
    const up = mockUpstream();
    try {
      // The header says 10 bytes. The stream delivers four times the limit. A
      // proxy that trusted the header would allocate all of it.
      const res = await proxyWithLimit(LIMIT)(
        post('/v1/messages', chunkedBody(jsonOfSize(LIMIT * 4)), { 'content-length': '10' }),
      );
      expect(res.status).toBe(413);
      expect(up.calls).toBe(0);
    } finally {
      up.restore();
    }
  });

  it('rejects an over-declared length without calling upstream', async () => {
    const up = mockUpstream();
    try {
      const res = await proxyWithLimit(LIMIT)(
        post('/v1/messages', jsonOfSize(LIMIT + 1), { 'content-length': String(LIMIT * 100) }),
      );
      expect(res.status).toBe(413);
      expect(up.calls).toBe(0);
    } finally {
      up.restore();
    }
  });
});

describe('the refusal is shaped like the provider it stands in for', () => {
  it('uses the Anthropic error envelope on a Messages route', async () => {
    const up = mockUpstream();
    try {
      const res = await proxyWithLimit(LIMIT)(post('/v1/messages', jsonOfSize(LIMIT + 1)));
      expect(res.status).toBe(413);
      expect(res.headers.get('content-type')).toContain('application/json');
      const parsed = (await res.json()) as { type?: string; error?: { type?: string } };
      expect(parsed.type).toBe('error');
      expect(parsed.error?.type).toBe('request_too_large');
    } finally {
      up.restore();
    }
  });

  it('uses the OpenAI error envelope on a chat-completions route', async () => {
    const up = mockUpstream();
    try {
      const body = JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'x'.repeat(LIMIT) }] });
      const res = await proxyWithLimit(LIMIT)(post('/v1/chat/completions', body));
      expect(res.status).toBe(413);
      const parsed = (await res.json()) as { type?: string; error?: { type?: string } };
      expect(parsed.type).toBeUndefined();
      expect(parsed.error?.type).toBe('request_too_large');
    } finally {
      up.restore();
    }
  });
});

describe('label-only routes are bounded but never rejected', () => {
  it('streams an oversized upload through untouched', async () => {
    const up = mockUpstream();
    try {
      // Four times the ceiling on a route pxpipe does not transform. Rejecting it
      // would break uploads; buffering it would be the same defect under a
      // different route name.
      const payload = 'y'.repeat(LIMIT * 4);
      const res = await proxyWithLimit(LIMIT)(post('/v1/files', chunkedBody(payload)));
      expect(res.status).toBe(200);
      expect(up.calls).toBe(1);
      expect(up.bodies[0]).toBe(payload);
    } finally {
      up.restore();
    }
  });

  it('still reads the model label off a small body and forwards it intact', async () => {
    const up = mockUpstream();
    const events: ProxyEvent[] = [];
    try {
      const payload = JSON.stringify({ model: 'some-labelled-model', input: 'hello' });
      const res = await proxyWithLimit(LIMIT, events)(post('/v1/files', chunkedBody(payload)));
      expect(res.status).toBe(200);
      expect(up.bodies[0]).toBe(payload);
      expect((await settledEvents(events)).at(-1)?.model).toBe('some-labelled-model');
    } finally {
      up.restore();
    }
  });
});

describe('an unusable limit falls back to the default instead of to none', () => {
  it.each([[0], [-1], [1.5], [Number.NaN]])('ignores %s', async (bad) => {
    const up = mockUpstream();
    try {
      // Well under the 16 MiB default, so acceptance proves the default applied
      // rather than the broken value being read as "unlimited".
      const res = await proxyWithLimit(bad)(post('/v1/messages', jsonOfSize(LIMIT)));
      expect(res.status).toBe(200);
      expect(up.calls).toBe(1);
    } finally {
      up.restore();
    }
  });

  it('exports a default that is a positive whole number of bytes', () => {
    expect(Number.isSafeInteger(DEFAULT_MAX_REQUEST_BYTES)).toBe(true);
    expect(DEFAULT_MAX_REQUEST_BYTES).toBeGreaterThan(0);
  });
});
