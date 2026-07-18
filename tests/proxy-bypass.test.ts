import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';

// Pin the model scope so these contract tests stay independent of the developer shell.
let ambientPxpipeModels: string | undefined;
beforeAll(() => {
  ambientPxpipeModels = process.env.PXPIPE_MODELS;
  process.env.PXPIPE_MODELS = 'claude-fable-5,gpt-5.6-sol';
});
afterAll(() => {
  if (ambientPxpipeModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = ambientPxpipeModels;
});

/** Same in-process fetch patch as proxy-usage.test.ts. */
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

// Deliberately OUT of the pinned PXPIPE_MODELS scope: without bypass the
// transform path classifies this as `unsupported_model`, giving the tests a
// crisp observable for "did classification run at all".
const OUT_OF_SCOPE_BODY = JSON.stringify({
  model: 'claude-3-5-haiku-latest',
  messages: [{ role: 'user', content: 'hi' }],
  system: 'short',
});

const UPSTREAM_OK = () =>
  new Response(
    JSON.stringify({
      id: 'msg_b1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

async function roundTrip(headers: Record<string, string>) {
  const upstreamRequests: Request[] = [];
  const restore = mockUpstream(async (req) => {
    upstreamRequests.push(req.clone());
    return UPSTREAM_OK();
  });
  let captured: ProxyEvent | undefined;
  const proxy = createProxy({
    transform: {},
    onRequest: (e) => {
      captured = e;
    },
  });
  const res = await proxy(
    new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: OUT_OF_SCOPE_BODY,
    }),
  );
  // Drain the client body so the tee finishes, then give onRequest a tick.
  await res.text();
  await new Promise((r) => setTimeout(r, 20));
  restore();
  return { upstreamRequests, captured, status: res.status };
}

describe('x-pxpipe-bypass opt-out', () => {
  it('skips transform classification and forwards the body byte-for-byte', async () => {
    const { upstreamRequests, captured, status } = await roundTrip({ 'x-pxpipe-bypass': '1' });

    expect(status).toBe(200);
    expect(upstreamRequests).toHaveLength(1);
    // Body reaches the upstream untouched.
    expect(await upstreamRequests[0].text()).toBe(OUT_OF_SCOPE_BODY);
    // The pxpipe-only signal is never forwarded upstream.
    expect(upstreamRequests[0].headers.get('x-pxpipe-bypass')).toBeNull();
    // Classification never ran: no skip reason, despite the out-of-scope model.
    expect(captured?.info?.reason).toBeUndefined();
  });

  it('treats any non-falsy value as bypass', async () => {
    const { upstreamRequests, captured } = await roundTrip({ 'x-pxpipe-bypass': 'true' });
    expect(await upstreamRequests[0].text()).toBe(OUT_OF_SCOPE_BODY);
    expect(captured?.info?.reason).toBeUndefined();
  });

  it.each(['0', 'false', 'off', 'no'])('does not bypass for falsy value %j', async (v) => {
    const { upstreamRequests, captured } = await roundTrip({ 'x-pxpipe-bypass': v });
    // Transform path ran and classified the out-of-scope model.
    expect(captured?.info?.reason).toBe('unsupported_model');
    // The header is stripped regardless of its value.
    expect(upstreamRequests[0].headers.get('x-pxpipe-bypass')).toBeNull();
  });
});
