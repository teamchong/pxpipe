import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseProbeRate, shouldSample } from '../src/core/probe.js';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';

/** Tiny in-process mock upstream — same shape as proxy-usage.test.ts's helper. */
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

const SAMPLE_REQ_BODY = JSON.stringify({
  model: 'claude-3-5-haiku-latest',
  messages: [{ role: 'user', content: 'hi' }],
  system: 'short',
});

const ORIGINAL_PROBE_RATE = process.env.PXPIPE_PROBE_RATE;

afterEach(() => {
  if (ORIGINAL_PROBE_RATE === undefined) delete process.env.PXPIPE_PROBE_RATE;
  else process.env.PXPIPE_PROBE_RATE = ORIGINAL_PROBE_RATE;
  vi.restoreAllMocks();
});

describe('parseProbeRate', () => {
  it('defaults to 0 (off) when unset', () => {
    expect(parseProbeRate(undefined)).toBe(0);
  });

  it('defaults to 0 for an empty string', () => {
    expect(parseProbeRate('')).toBe(0);
    expect(parseProbeRate('   ')).toBe(0);
  });

  it('defaults to 0 for "0"', () => {
    expect(parseProbeRate('0')).toBe(0);
  });

  it('clamps negative rates to 0', () => {
    expect(parseProbeRate('-1')).toBe(0);
    expect(parseProbeRate('-0.5')).toBe(0);
  });

  it('treats non-numeric input as 0', () => {
    expect(parseProbeRate('abc')).toBe(0);
    expect(parseProbeRate('NaN')).toBe(0);
  });

  it('clamps rates above 1 down to 1', () => {
    expect(parseProbeRate('2')).toBe(1);
    expect(parseProbeRate('100')).toBe(1);
  });

  it('passes through valid fractional rates', () => {
    expect(parseProbeRate('0.5')).toBe(0.5);
    expect(parseProbeRate('0.01')).toBe(0.01);
    expect(parseProbeRate('1')).toBe(1);
  });

  it('trims surrounding whitespace', () => {
    expect(parseProbeRate(' 0.3 ')).toBe(0.3);
  });
});

describe('shouldSample', () => {
  it('never samples at rate 0, regardless of Math.random', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(shouldSample(0)).toBe(false);
    spy.mockReturnValue(0.0001);
    expect(shouldSample(0)).toBe(false);
  });

  it('never samples at negative rate', () => {
    expect(shouldSample(-1)).toBe(false);
  });

  it('always samples at rate 1, regardless of Math.random', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.9999);
    expect(shouldSample(1)).toBe(true);
    spy.mockReturnValue(0);
    expect(shouldSample(1)).toBe(true);
  });

  it('always samples above rate 1', () => {
    expect(shouldSample(5)).toBe(true);
  });

  it('samples fractional rates by comparing against Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    spy.mockReturnValue(0.4);
    expect(shouldSample(0.5)).toBe(true); // 0.4 < 0.5
    spy.mockReturnValue(0.6);
    expect(shouldSample(0.5)).toBe(false); // 0.6 >= 0.5
  });
});

describe('proxy D11 post-transform probe wiring', () => {
  it('rate=0 (default/off): fires only the existing baseline probe, no D11 second call', async () => {
    delete process.env.PXPIPE_PROBE_RATE;

    const countTokensCalls: string[] = [];
    const restore = mockUpstream((req) => {
      const url = new URL(req.url);
      if (url.pathname === '/v1/messages/count_tokens') {
        countTokensCalls.push(url.pathname);
        return new Response(JSON.stringify({ input_tokens: 111 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          id: 'msg_x',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-opus-4-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      upstream: 'http://mock',
      onRequest: (e) => { captured = e; },
    });
    const res = await proxy(
      new Request('http://proxy/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    // SAMPLE_REQ_BODY has no cache_control markers, so the only count_tokens
    // traffic is the always-on PRE-transform baseline probe. Rate=0 means D11
    // must not add a second call.
    expect(countTokensCalls).toEqual(['/v1/messages/count_tokens']);
    expect(captured!.probe).toBeUndefined();
  });

  it('rate=1: fires a second count_tokens probe on the POST-transform body and records the result', async () => {
    process.env.PXPIPE_PROBE_RATE = '1';

    const seenBodies: string[] = [];
    const restore = mockUpstream(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === '/v1/messages/count_tokens') {
        seenBodies.push(await req.text());
        // First call = baseline (PRE-transform), second = D11 (POST-transform).
        const n = seenBodies.length;
        return new Response(JSON.stringify({ input_tokens: n === 1 ? 5000 : 4200 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          id: 'msg_x',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-opus-4-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 4200, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      upstream: 'http://mock',
      onRequest: (e) => { captured = e; },
    });
    const res = await proxy(
      new Request('http://proxy/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(seenBodies).toHaveLength(2);
    expect(captured!.probe).toBeDefined();
    expect(captured!.probe!.postTokens).toBe(4200);
    // Baseline (existing, unsampled) probe is untouched by D11.
    expect(captured!.info?.baselineTokens).toBe(5000);
  });

  it('client response and status are unaffected when the D11 probe upstream call fails', async () => {
    process.env.PXPIPE_PROBE_RATE = '1';

    let countTokensCalls = 0;
    const restore = mockUpstream((req) => {
      const url = new URL(req.url);
      if (url.pathname === '/v1/messages/count_tokens') {
        countTokensCalls += 1;
        // Baseline probe (1st call) succeeds; D11 probe (2nd call) fails outright.
        if (countTokensCalls === 1) {
          return new Response(JSON.stringify({ input_tokens: 999 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('boom', { status: 500 });
      }
      return new Response(
        JSON.stringify({
          id: 'msg_x',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-opus-4-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      upstream: 'http://mock',
      onRequest: (e) => { captured = e; },
    });
    const res = await proxy(
      new Request('http://proxy/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    const text = await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    // Client-visible behavior: 200, real content, untouched by the probe failure.
    expect(res.status).toBe(200);
    expect(JSON.parse(text).content[0].text).toBe('ok');

    // Event still fires; probe is present (sampled) but degrades to null, and the
    // rest of the event (status, usage) is unaffected.
    expect(captured!.status).toBe(200);
    expect(captured!.probe).toBeDefined();
    expect(captured!.probe!.postTokens).toBeNull();
    expect(captured!.usage?.input_tokens).toBe(100);
  });
});
