import { describe, expect, it } from 'vitest';
import { createProxy } from '../src/core/proxy';

function mockUpstream(handler: (req: Request) => Promise<Response> | Response) {
  const real = globalThis.fetch;
  globalThis.fetch = ((req: Request | string | URL, init?: RequestInit) => {
    const r = req instanceof Request ? req : new Request(String(req), init);
    return Promise.resolve(handler(r));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

const BODY = JSON.stringify({
  model: 'gpt-5.6-sol',
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
});
const request = () =>
  new Request('http://localhost/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: BODY,
  });

/** Upstream that sends one event then wedges: bytes stop, stream never closes. */
function mockStalledUpstream() {
  const encoder = new TextEncoder();
  return mockUpstream(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"type":"response.output_text.delta","delta":"ok"}\n\n'),
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
}

const withDeadline = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<'HUNG'>((r) => setTimeout(() => r('HUNG'), ms))]);

describe('upstream stall handling', () => {
  it('errors the response stream when the upstream goes idle', async () => {
    const restore = mockStalledUpstream();
    try {
      const proxy = createProxy({
        openAIUpstream: 'http://mock',
        transform: { compress: false },
        upstreamIdleTimeoutMs: 300,
      });
      const res = await proxy(request());
      const started = Date.now();
      const outcome = await withDeadline(
        new Response(res.body)
          .text()
          .then(() => 'ended')
          .catch((e) => `errored: ${(e as Error).message}`),
        5000,
      );
      expect(outcome).not.toBe('HUNG');
      expect(String(outcome)).toContain('upstream stalled');
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      restore();
    }
  });

  it('lets a slow first chunk through: startup is not a mid-stream stall', async () => {
    // Reasoning models can sit silent after headers before the first token. Real
    // traffic has taken >120s just to reach headers, so the pre-first-chunk wait is
    // charged the headers budget, not the tighter mid-stream idle budget.
    const encoder = new TextEncoder();
    const restore = mockUpstream(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              setTimeout(() => {
                controller.enqueue(
                  encoder.encode('data: {"type":"response.output_text.delta","delta":"ok"}\n\n'),
                );
                controller.close();
              }, 600);
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    try {
      const proxy = createProxy({
        openAIUpstream: 'http://mock',
        transform: { compress: false },
        upstreamIdleTimeoutMs: 200,
        upstreamHeadersTimeoutMs: 5000,
      });
      const res = await proxy(request());
      const outcome = await withDeadline(
        new Response(res.body)
          .text()
          .then((t) => (t.includes('delta') ? 'delivered' : `unexpected: ${t}`))
          .catch((e) => `errored: ${(e as Error).message}`),
        4000,
      );
      expect(outcome).toBe('delivered');
    } finally {
      restore();
    }
  });

  it('returns 504 when response headers never arrive', async () => {
    const restore = mockUpstream(
      () =>
        new Promise<Response>(() => {
          /* never resolves */
        }),
    );
    try {
      const proxy = createProxy({
        openAIUpstream: 'http://mock',
        transform: { compress: false },
        upstreamHeadersTimeoutMs: 200,
      });
      const res = await withDeadline(proxy(request()), 5000);
      expect(res).not.toBe('HUNG');
      expect((res as Response).status).toBe(504);
      expect(await (res as Response).json()).toMatchObject({
        error: expect.stringContaining('upstream timeout'),
      });
    } finally {
      restore();
    }
  });

  it('does not hang on client disconnect and frees the in-flight slot', async () => {
    const restore = mockStalledUpstream();
    try {
      const proxy = createProxy({ openAIUpstream: 'http://mock', transform: { compress: false } });
      const first = await proxy(request());

      // Client goes away mid-stream. This must not block on the wedged upstream.
      const cancelled = await withDeadline(first.body!.cancel(), 3000);
      expect(cancelled).not.toBe('HUNG');

      await new Promise((r) => setTimeout(r, 50));
      // The retry must reach upstream rather than hitting a leaked in-flight lease.
      const retry = await withDeadline(proxy(request()), 3000);
      expect((retry as Response).status).toBe(200);
    } finally {
      restore();
    }
  });

  it('rejects an immediate duplicate but lets a late retry through', async () => {
    const restore = mockStalledUpstream();
    try {
      const proxy = createProxy({
        openAIUpstream: 'http://mock',
        transform: { compress: false },
        duplicateHoldMs: 200,
      });
      await proxy(request());

      const immediate = await proxy(request());
      expect(immediate.status).toBe(409);

      // Past the hold window the dedupe fails open, so a stalled request can no
      // longer permanently 409 the client's retries.
      await new Promise((r) => setTimeout(r, 250));
      const late = await proxy(request());
      expect(late.status).toBe(200);
    } finally {
      restore();
    }
  });
});
