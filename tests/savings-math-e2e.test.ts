/**
 * END-TO-END savings-MATH contract through the REAL proxy.
 *
 * Cache tests (cache-stability-e2e) prove pxpipe doesn't bust the cache. THIS
 * file proves the prior question: pxpipe's gate gets the MATH right, so it never
 * makes a request MORE expensive than leaving it as text. A wrong gate is worse
 * than a cache miss — it silently inverts the product (you pay more than not
 * running pxpipe at all), with no error.
 *
 *   fake api  = the upstream output (canned response + count_tokens ground truth)
 *   our input = pxpipe's transform + gate decision, read off the onRequest event
 *
 * CRITICAL: these run with REALISTIC gate settings (transform: {} → defaults).
 * The cache tests used charsPerToken:1 to FORCE imaging — that would rig this
 * gate (text looks infinitely expensive → always images), so it is NOT used here.
 *
 * The GPT side is cross-checked against a REAL o200k tokenizer (the gpt-tokenizer
 * dep), so "the text would have cost N tokens" is ground truth, not self-report.
 *
 * Run just this file:  pnpm vitest run tests/savings-math-e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';
import { countTokens as o200k } from 'gpt-tokenizer/encoding/o200k_base';

// The GPT tests below drive 'gpt-5.6-sol', which is intentionally absent from
// the built-in default scope (Fable 5 + Grok 4.5). Pin PXPIPE_MODELS so the suite is
// deterministic regardless of the developer's shell (same convention as
// proxy-usage.test.ts) — without this, the file passes or fails depending on
// ambient env, which is exactly what broke CI.
let ambientPxpipeModels: string | undefined;
beforeAll(() => {
  ambientPxpipeModels = process.env.PXPIPE_MODELS;
  process.env.PXPIPE_MODELS = 'claude-fable-5,gpt-5.6-sol';
});
afterAll(() => {
  if (ambientPxpipeModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = ambientPxpipeModels;
});

const PROBE_TOKENS = 9999; // canned count_tokens result from the fake upstream

function fakeUpstream() {
  const main: { url: string; body: string }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(req.url).pathname;
    if (path.endsWith('/count_tokens')) {
      return new Response(JSON.stringify({ input_tokens: PROBE_TOKENS }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    main.push({ url: req.url, body: await req.clone().text() });
    if (path.includes('chat/completions')) {
      return new Response(
        JSON.stringify({
          id: 'c1',
          object: 'chat.completion',
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        id: 'm1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { main, restore: () => { globalThis.fetch = real; } };
}

/** Drive the real proxy with the DEFAULT (realistic) gate and return the onRequest
 *  event (carries info.gateEval / imageTokens / baselineImagedTokens / compressed). */
async function driveAndCapture(path: string, body: string): Promise<{ event: ProxyEvent; out: string }> {
  const cap = fakeUpstream();
  let event: ProxyEvent | undefined;
  const proxy = createProxy({
    upstream: 'http://anthropic.test',
    apiKey: 'sk-ant',
    openAIUpstream: 'https://openai.test',
    openAIApiKey: 'sk-oai',
    transform: {}, // realistic gate — DEFAULTS (charsPerToken 4, minCompressChars 2000)
    onRequest: (e) => { event = e; },
  });
  const res = await proxy(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
  );
  await res.text();
  await new Promise((r) => setTimeout(r, 30)); // let onRequest fire
  cap.restore();
  return { event: event!, out: cap.main[0]?.body ?? '' };
}

const slab = (n: number) =>
  '# CLAUDE.md\nYou are a helpful coding assistant.\n' + 'Follow the rules carefully. '.repeat(Math.ceil(n / 28));

const gptBody = (sysChars: number) =>
  JSON.stringify({
    model: 'gpt-5.6-sol',
    messages: [
      { role: 'system', content: slab(sysChars) },
      { role: 'user', content: 'hello' },
    ],
  });

const antBody = (opts: { model?: string; slabChars?: number }) =>
  JSON.stringify({
    model: opts.model ?? 'claude-fable-5',
    max_tokens: 16,
    system: opts.slabChars
      ? [{ type: 'text', text: slab(opts.slabChars), cache_control: { type: 'ephemeral' } }]
      : 'short',
    messages: [{ role: 'user', content: 'hello' }],
  });

// ===========================================================================
describe('savings math — GPT, cross-checked against the real o200k tokenizer', () => {
  it('NO NET LOSS: when it images, the images cost fewer tokens than the text they replaced', async () => {
    const { event } = await driveAndCapture('/v1/chat/completions', gptBody(60_000));
    expect(event.info?.compressed).toBe(true);
    const imageTokens = event.info!.imageTokens!;
    const baseline = event.info!.baselineImagedTokens!;
    expect(imageTokens).toBeGreaterThan(0);
    expect(baseline).toBeGreaterThan(0);
    // THE money guarantee: vision tokens added < text tokens removed.
    expect(imageTokens).toBeLessThan(baseline);
  });

  it('GROUND TRUTH: baselineImagedTokens is a real o200k token count, not a char count', async () => {
    // A chars-vs-tokens regression would inflate this ~4-5x; assert it tracks the
    // real tokenizer within a tight tolerance (matched exactly in practice).
    const sys = slab(60_000);
    const realTok = o200k(sys);
    const { event } = await driveAndCapture('/v1/chat/completions', gptBody(60_000));
    const baseline = event.info!.baselineImagedTokens!;
    expect(Math.abs(baseline - realTok)).toBeLessThanOrEqual(Math.max(5, realTok * 0.02));
  });

  it('GATE SIGN: profitable iff the gate believes images < text', async () => {
    for (const sysChars of [2_000, 20_000, 60_000]) {
      const { event } = await driveAndCapture('/v1/chat/completions', gptBody(sysChars));
      const g = event.info?.gateEval;
      if (!g) continue; // below the char floor → gate never ran
      expect(g.profitable).toBe(g.imageTokens < g.textTokens);
    }
  });

  it('DECLINES A LOSER: refuses to image content where imaging would cost more than the real text', async () => {
    // Dense long-line slab: few o200k text tokens relative to vision pages.
    // (The old 2k prose fixture is now profitable under Sol 6×11 packing — ~216
    // image vs ~500 text tokens — so it no longer exercises the decline path.)
    const sys = Array.from({ length: 80 }, (_, i) =>
      `LINE${i} ` + 'abcdefghijklmnopqrstuvwxyz'.repeat(20),
    ).join('\n');
    const realTok = o200k(sys);
    const body = JSON.stringify({
      model: 'gpt-5.6-sol',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: 'hello' },
      ],
    });
    const { event, out } = await driveAndCapture('/v1/chat/completions', body);
    expect(event.info?.compressed).toBe(false);
    expect(event.info?.gateEval?.profitable).toBe(false);
    // The would-be image cost genuinely exceeds the real text cost → declining is correct.
    expect(event.info!.gateEval!.imageTokens).toBeGreaterThan(realTok);
    // And nothing was imaged: the forwarded body has no image parts.
    expect(out).not.toContain('image_url');
  });

  it('BELOW THRESHOLD: a tiny system is forwarded byte-for-byte (no gate, no image)', async () => {
    const body = gptBody(300);
    const { event, out } = await driveAndCapture('/v1/chat/completions', body);
    expect(event.info?.compressed).toBe(false);
    expect(JSON.parse(out)).toEqual(JSON.parse(body));
  });
});

// ===========================================================================
describe('savings math — Anthropic (gate sign + count_tokens ground-truth wiring)', () => {
  it('GATE SIGN: profitable iff images+burn < text+burn (the real Anthropic inequality)', async () => {
    const { event } = await driveAndCapture('/v1/messages', antBody({ slabChars: 80_000 }));
    const g = event.info?.gateEval;
    expect(g).toBeDefined();
    const imgSide = g!.imageTokens + (g!.burnImageSide ?? 0);
    const txtSide = g!.textTokens + (g!.burnTextSide ?? 0);
    expect(g!.profitable).toBe(imgSide < txtSide);
  });

  it('DECISION: compresses a large slab, leaves a tiny system untouched', async () => {
    const big = await driveAndCapture('/v1/messages', antBody({ slabChars: 80_000 }));
    expect(big.event.info?.compressed).toBe(true);
    expect(big.event.info?.gateEval?.profitable).toBe(true);

    const tinyBody = antBody({}); // 'short' system, single short turn → nothing to image
    const tiny = await driveAndCapture('/v1/messages', tinyBody);
    expect(tiny.event.info?.compressed).toBe(false);
    expect(JSON.parse(tiny.out)).toEqual(JSON.parse(tinyBody));
  });

  it('GROUND TRUTH: baselineTokens is wired straight from the count_tokens probe', async () => {
    // The dashboard saved% denominator must be the REAL upstream token count, not
    // an estimate. The fake upstream answers count_tokens with a known value.
    const { event } = await driveAndCapture('/v1/messages', antBody({ slabChars: 80_000 }));
    expect(event.info?.baselineTokens).toBe(PROBE_TOKENS);
  });
});
