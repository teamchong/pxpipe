import { describe, expect, it } from 'vitest';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';

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

// Large enough to actually render images, so transformMs reflects real render cost
// rather than a no-op classification pass — but no larger. This file runs in
// parallel with render-heavy e2e suites that sit close to the 30s testTimeout,
// and extra CPU contention here shows up as a timeout over there.
const BIG_SYSTEM = Array.from({ length: 500 }, (_, i) =>
  `[${i}] export function handler_${i}(req,res){const x=req.body?.value??${i};return res.json({ok:true,x});}`,
).join('\n');

const BODY = JSON.stringify({
  model: 'claude-opus-5', // must be in the default PXPIPE_MODELS scope or nothing compresses
  messages: [{ role: 'user', content: 'hi' }],
  system: BIG_SYSTEM,
});

const UPSTREAM_STALL_MS = 300;

async function roundTrip(force: boolean): Promise<ProxyEvent | undefined> {
  const restore = mockUpstream(async () => {
    await new Promise((r) => setTimeout(r, UPSTREAM_STALL_MS));
    return new Response(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  let captured: ProxyEvent | undefined;
  const proxy = createProxy({
    transform: force ? { charsPerToken: 1, minCompressChars: 1 } : { compress: false },
    onRequest: (e) => {
      captured = e;
    },
  });
  const res = await proxy(
    new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: BODY,
    }),
  );
  // Drain the client body so the tee finishes, then give onRequest a tick.
  await res.text();
  await new Promise((r) => setTimeout(r, 20));
  restore();
  return captured;
}

describe('transformMs', () => {
  it('charges render cost to transform and upstream latency to the remainder', async () => {
    const ev = await roundTrip(true);

    // Guard the premise: without images this would pass trivially.
    expect(ev?.info?.compressed).toBe(true);
    expect(ev!.info!.imageCount).toBeGreaterThan(0);

    expect(ev?.transformMs).toBeTypeOf('number');
    expect(ev!.transformMs!).toBeLessThanOrEqual(ev!.durationMs);
    // The stall must land on the upstream side, never be charged to transform.
    expect(ev!.durationMs - ev!.transformMs!).toBeGreaterThanOrEqual(UPSTREAM_STALL_MS - 20);
    // Rendering real images costs real time; a near-zero value means the timer
    // is measuring the wrong span.
    expect(ev!.transformMs!).toBeGreaterThan(0);
  });

  it('is still reported when the request passes through uncompressed', async () => {
    const ev = await roundTrip(false);

    expect(ev?.info?.compressed).toBe(false);
    expect(ev?.transformMs).toBeTypeOf('number');
    expect(ev!.durationMs - ev!.transformMs!).toBeGreaterThanOrEqual(UPSTREAM_STALL_MS - 20);
  });
});
