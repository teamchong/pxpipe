import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';
import { isThreadContinuation } from '../src/core/measurement.js';
import { toTrackEvent } from '../src/core/tracker.js';

// A server-side thread continue carries only the delta. Upstream bills the
// server-held thread on top (cache_read), so count_tokens on the delta is not a
// counterfactual for the whole request. Pairing them reported large "negative
// savings" on every passthrough continue; the row must be marked 'partial'.

let ambientPxpipeModels: string | undefined;
beforeAll(() => {
  ambientPxpipeModels = process.env.PXPIPE_MODELS;
  process.env.PXPIPE_MODELS = 'claude-fable-5,gpt-5.6-sol,gemini-3.6-flash';
});
afterAll(() => {
  if (ambientPxpipeModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = ambientPxpipeModels;
});

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

const deltaMessages = [
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: 'short output' }] },
];

async function runProxy(body: Record<string, unknown>): Promise<ProxyEvent | undefined> {
  const real = globalThis.fetch;
  globalThis.fetch = ((req: Request | string | URL, init?: RequestInit) => {
    const r = req instanceof Request ? req : new Request(String(req), init);
    if (r.url.includes('/count_tokens')) {
      return Promise.resolve(new Response(JSON.stringify({ input_tokens: 420 }), {
        headers: { 'content-type': 'application/json' },
      }));
    }
    return Promise.resolve(new Response(JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 2, output_tokens: 1, cache_creation_input_tokens: 400, cache_read_input_tokens: 80_000 },
    }), { headers: { 'content-type': 'application/json' } }));
  }) as typeof fetch;
  let captured: ProxyEvent | undefined;
  try {
    const proxy = createProxy({ transform: {}, onRequest: (e) => { captured = e; } });
    const res = await proxy(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    globalThis.fetch = real;
  }
  return captured;
}

describe('isThreadContinuation', () => {
  it('detects thread.type === "continue"', () => {
    expect(isThreadContinuation(enc({ thread: { type: 'continue', previous_message_id: 'msg_x' }, messages: [] }))).toBe(true);
  });

  it('is false for full bodies, other thread types, and junk', () => {
    expect(isThreadContinuation(enc({ messages: [] }))).toBe(false);
    expect(isThreadContinuation(enc({ thread: { type: 'create' }, messages: [] }))).toBe(false);
    expect(isThreadContinuation(enc({ thread: 'continue' }))).toBe(false);
    expect(isThreadContinuation(new TextEncoder().encode('not json'))).toBe(false);
  });
});

describe('baseline probe on a server-side thread continue', () => {
  it('keeps the delta baseline but marks the probe partial so rollups skip it', async () => {
    const ev = await runProxy({
      model: 'claude-3-5-haiku-latest',
      thread: { type: 'continue', previous_message_id: 'msg_prev' },
      system: 'billing',
      messages: deltaMessages,
    });
    expect(ev?.info?.baselineTokens).toBe(420);
    expect(ev?.info?.baselineProbeStatus).toBe('partial');
    expect(ev?.info?.threadContinue).toBe(true);
    const track = toTrackEvent(ev!);
    expect(track.baseline_probe_status).toBe('partial');
    expect(track.thread_continue).toBe(true);
  });

  it('leaves a full (non-thread) request as ok', async () => {
    const ev = await runProxy({
      model: 'claude-3-5-haiku-latest',
      system: 'short',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(ev?.info?.baselineProbeStatus).toBe('ok');
    expect(ev?.info?.threadContinue).toBeUndefined();
    expect(toTrackEvent(ev!).thread_continue).toBeUndefined();
  });
});
