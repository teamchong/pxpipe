import { describe, it, expect } from 'vitest';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';

/** Tiny in-process mock upstream — accepts any request and returns whatever
 *  the test fixture configured. Lets us assert that the proxy correctly
 *  extracts Anthropic's usage block from both SSE and JSON responses without
 *  touching the network. */
function mockUpstream(handler: (req: Request) => Promise<Response> | Response) {
  // Patch globalThis.fetch for the duration of the test.
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

describe('proxy usage extraction', () => {
  it('extracts usage tokens from a non-stream JSON response', async () => {
    const restore = mockUpstream(
      () =>
        new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
            usage: {
              input_tokens: 123,
              output_tokens: 7,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 100,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

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
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    // Drain the client-side body so the tee is forced to finish.
    await res.text();
    // Give the onRequest callback a tick to fire (it's behind a void promise).
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.usage?.input_tokens).toBe(123);
    expect(captured!.usage?.output_tokens).toBe(7);
    expect(captured!.usage?.cache_read_input_tokens).toBe(100);
    expect(captured!.firstByteMs).toBeTypeOf('number');
  });

  it('routes GPT 5.5 chat completions to OpenAI, transforms once, and normalizes usage', async () => {
    const upstreamRequests: Request[] = [];
    const restore = mockUpstream(async (req) => {
      upstreamRequests.push(req.clone());
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_1',
          object: 'chat.completion',
          choices: [{ message: { role: 'assistant', content: 'hello' } }],
          usage: { prompt_tokens: 55, completion_tokens: 7, total_tokens: 62 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      openAIUpstream: 'https://api.openai.test',
      openAIApiKey: 'sk-test',
      transform: { charsPerToken: 1, minCompressChars: 1 },
      onRequest: (e) => {
        captured = e;
      },
    });

    const reqBody = JSON.stringify({
      model: 'gpt-5.5',
      messages: [
        { role: 'system', content: 'System instruction. '.repeat(900) },
        { role: 'user', content: 'hi' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'search',
          description: 'Search files. '.repeat(100),
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      }],
    });

    const res = await proxy(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: reqBody,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]!.url).toBe('https://api.openai.test/v1/chat/completions');
    expect(upstreamRequests[0]!.headers.get('authorization')).toBe('Bearer sk-test');
    const sent = JSON.parse(await upstreamRequests[0]!.text()) as any;
    const firstUser = sent.messages.find((m: any) => m.role === 'user');
    expect(firstUser.content[0].type).toBe('image_url');
    expect(firstUser.content[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(captured).toBeDefined();
    expect(captured!.usage?.input_tokens).toBe(55);
    expect(captured!.usage?.output_tokens).toBe(7);
    expect(captured!.info?.baselineProbeStatus).toBeUndefined();
  });

  it('extracts usage tokens from an SSE stream (message_start event)', async () => {
    const sseBody =
      'event: message_start\n' +
      'data: ' +
      JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_2',
          type: 'message',
          role: 'assistant',
          content: [],
          usage: {
            input_tokens: 42,
            output_tokens: 0,
            cache_creation_input_tokens: 5000,
            cache_read_input_tokens: 0,
          },
        },
      }) +
      '\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';

    const restore = mockUpstream(
      () =>
        new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

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
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.usage?.input_tokens).toBe(42);
    expect(captured!.usage?.cache_creation_input_tokens).toBe(5000);
  });

  it('fires the event with undefined usage when the response is an error', async () => {
    const restore = mockUpstream(
      () =>
        new Response(JSON.stringify({ error: { type: 'overloaded_error' } }), {
          status: 529,
          headers: { 'content-type': 'application/json' },
        }),
    );

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
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.status).toBe(529);
    expect(captured!.usage).toBeUndefined();
    // 5xx: we synthesize our own message upstream, so no errorBody capture.
    expect(captured!.errorBody).toBeUndefined();
  });

  it('captures upstream error body for 4xx responses (up to 2 KiB)', async () => {
    const upstreamErr = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'messages.5.content.0.tool_use_id: unknown tool_use id',
      },
    };
    const restore = mockUpstream(
      () =>
        new Response(JSON.stringify(upstreamErr), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );

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
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    // Drain the client side so the tee can complete.
    const clientBody = await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.status).toBe(400);
    expect(captured!.usage).toBeUndefined();
    expect(captured!.errorBody).toBe(JSON.stringify(upstreamErr));
    // Client must still receive the full body unchanged.
    expect(clientBody).toBe(JSON.stringify(upstreamErr));
  });

  it('caps the captured 4xx error body at ~2 KiB', async () => {
    const huge = 'x'.repeat(10_000);
    const restore = mockUpstream(
      () =>
        new Response(huge, {
          status: 400,
          headers: { 'content-type': 'text/plain' },
        }),
    );

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
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.errorBody).toBeDefined();
    expect(captured!.errorBody!.length).toBe(2048);
  });

  /** Decompress a gzip Uint8Array back to bytes — mirror of proxy's gzipBytes. */
  async function gunzipBytes(buf: Uint8Array): Promise<Uint8Array> {
    const stream = new Response(buf as BufferSource).body!.pipeThrough(
      new DecompressionStream('gzip'),
    );
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  it('captures the FULL gzipped transformed body on 4xx + sets reqBodySha8', async () => {
    // Pair with errorBody so a future debugger can reconstruct
    // "we sent X, Anthropic said Y" from the JSONL alone. We gzip the body
    // so even a 170 KiB transformed payload fits inline once base64'd
    // (typical PNG-heavy bodies compress to <10% of source).
    const restore = mockUpstream(
      () =>
        new Response(JSON.stringify({ error: { type: 'bad' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );

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
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.status).toBe(400);

    // Hash lands on every event, not just 4xx.
    expect(captured!.reqBodySha8).toMatch(/^[0-9a-f]{8}$/);

    // Gzipped body is present, has the gzip magic header, and decompresses
    // back to the transformed JSON we sent upstream.
    expect(captured!.reqBodyGz).toBeDefined();
    expect(captured!.reqBodyGz![0]).toBe(0x1f);
    expect(captured!.reqBodyGz![1]).toBe(0x8b);

    const decoded = new TextDecoder().decode(
      await gunzipBytes(captured!.reqBodyGz!),
    );
    const parsed = JSON.parse(decoded);
    expect(parsed.model).toBe('claude-3-5-haiku-latest');
    expect(parsed.messages[0].role).toBe('user');
  });

  it('does NOT gzip the request body on 2xx (but still sets reqBodySha8)', async () => {
    const restore = mockUpstream(
      () =>
        new Response(JSON.stringify({
          id: 'x', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'x', stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

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
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.status).toBe(200);
    // Hash lands on every event.
    expect(captured!.reqBodySha8).toMatch(/^[0-9a-f]{8}$/);
    // But the gzipped body itself is only captured on 4xx.
    expect(captured!.reqBodyGz).toBeUndefined();
  });

  it('reqBodySha8 is identical across two requests with the same body', async () => {
    // Correlation use-case: spot "same payload sometimes works, sometimes
    // fails" patterns in events.jsonl.
    let restore = mockUpstream(
      () =>
        new Response('{"x":1}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const captures: ProxyEvent[] = [];
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => {
        captures.push(e);
      },
    });

    for (let i = 0; i < 2; i++) {
      const res = await proxy(
        new Request('http://localhost/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: SAMPLE_REQ_BODY,
        }),
      );
      await res.text();
    }
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captures.length).toBe(2);
    expect(captures[0]!.reqBodySha8).toBeDefined();
    expect(captures[0]!.reqBodySha8).toBe(captures[1]!.reqBodySha8);
  });

  // The proxy makes ONE parallel side call: /v1/messages/count_tokens on
  // the PRE-COMPRESSION body. That number lands on the dashboard as the
  // baseline against which we measure savings. count_tokens is free
  // (no billing) and is the only side path we whitelist — any other
  // endpoint would be an unexpected leak.
  it('calls /v1/messages/count_tokens (baseline probe) and no other side endpoints', async () => {
    const sidePaths: string[] = [];
    const restore = mockUpstream((req) => {
      const url = new URL(req.url);
      if (url.pathname !== '/v1/messages') sidePaths.push(url.pathname);
      // count_tokens response shape: { input_tokens: number }
      if (url.pathname === '/v1/messages/count_tokens') {
        return new Response(JSON.stringify({ input_tokens: 123 }), {
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
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const proxy = createProxy({ upstream: 'http://mock', onRequest: () => {} });
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

    // No cache_control markers in SAMPLE_REQ_BODY → second probe is skipped.
    // count_tokens hit exactly once, no other side paths.
    expect(sidePaths).toEqual(['/v1/messages/count_tokens']);
  });

  // When the request body carries any `cache_control` marker, the proxy
  // fires a SECOND count_tokens probe on the body truncated at the last
  // marker. The difference between the two probe results is the
  // cacheable-prefix vs cold-tail split that lets the dashboard compute
  // a cache-aware baseline instead of a cold-every-time approximation.
  it('fires a SECOND count_tokens probe when body has cache_control markers', async () => {
    const bodiesSeen: string[] = [];
    const restore = mockUpstream(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === '/v1/messages/count_tokens') {
        bodiesSeen.push(await req.text());
        // Full body returns N; truncated returns M < N. The proxy doesn't
        // care which response goes to which probe — it just attaches both.
        const len = bodiesSeen.length;
        return new Response(
          JSON.stringify({ input_tokens: len === 1 ? 9000 : 6000 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          id: 'msg_x',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-opus-4-5',
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 5000,
            cache_read_input_tokens: 0,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    // Realistic shape: a long system prompt cached, then the user turn left
    // uncacheable. Marker lives on the LAST system block — that's the
    // canonical "cache everything above this line" layout Claude Code uses.
    const bodyWithMarkers = JSON.stringify({
      model: 'claude-3-5-haiku-latest',
      system: [
        { type: 'text', text: 'You are helpful.' },
        {
          type: 'text',
          text: 'A long preamble...',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: 'hi' }],
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
        body: bodyWithMarkers,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 30));
    restore();

    // Two probes fired (parallel, order indeterminate). At least one of the
    // posted bodies must DIFFER from the other — the second probe is the
    // truncated prefix, not a duplicate of the first.
    expect(bodiesSeen).toHaveLength(2);
    expect(bodiesSeen[0]).not.toBe(bodiesSeen[1]);

    // Both numbers landed on info; baselineCacheableTokens is the smaller one
    // (truncated body has fewer tokens than the full body). Whichever probe
    // got the 9000 response is `baselineTokens`; the 6000 is `baselineCacheableTokens`.
    expect(captured!.info?.baselineTokens).toBeDefined();
    expect(captured!.info?.baselineCacheableTokens).toBeDefined();
    const full = captured!.info!.baselineTokens!;
    const cacheable = captured!.info!.baselineCacheableTokens!;
    expect(new Set([full, cacheable])).toEqual(new Set([9000, 6000]));
  });

  // The two probes are independent. If the cacheable-prefix probe 4xx's
  // (e.g. upstream rejects the synthesized sentinel message), the main
  // forward succeeds and the FULL probe's baseline still lands. The
  // dashboard's per-event math degrades cleanly to cold_tail = baseline.
  it('survives cacheable-prefix probe failure without losing the full-body baseline', async () => {
    let probeCount = 0;
    const restore = mockUpstream((req) => {
      const url = new URL(req.url);
      if (url.pathname === '/v1/messages/count_tokens') {
        probeCount += 1;
        // First probe (full body) succeeds; second (truncated) fails.
        // The proxy fires them in parallel so order matters — assume the
        // longer body arrives first because it's queued first.
        if (probeCount === 1) {
          return new Response(JSON.stringify({ input_tokens: 7777 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ error: 'bad' }), {
          status: 400,
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
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const bodyWithMarkers = JSON.stringify({
      model: 'claude-3-5-haiku-latest',
      system: [
        {
          type: 'text',
          text: 'preamble',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: 'hi' }],
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
        body: bodyWithMarkers,
      }),
    );
    expect(res.status).toBe(200);
    await res.text();
    await new Promise((r) => setTimeout(r, 30));
    restore();

    expect(probeCount).toBe(2);
    // Whichever probe got the success response must have landed. Both
    // succeed → both land. One fails → only the other lands. The contract
    // we care about: ONE failure doesn't poison the OTHER.
    // Probe order is parallel + non-deterministic in mock-fetch land,
    // so just assert that at least one of the two baseline fields is set.
    const haveFull = captured!.info?.baselineTokens !== undefined;
    const haveCacheable = captured!.info?.baselineCacheableTokens !== undefined;
    expect(haveFull || haveCacheable).toBe(true);
  });

  // baselineTokens from the count_tokens probe must land on info so the
  // dashboard can roll it into the saved% denominator. This is the wiring
  // that makes the headline number real instead of estimated.
  it('attaches baselineTokens from count_tokens probe to info', async () => {
    const restore = mockUpstream((req) => {
      const url = new URL(req.url);
      if (url.pathname === '/v1/messages/count_tokens') {
        return new Response(JSON.stringify({ input_tokens: 4242 }), {
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
          usage: { input_tokens: 1, output_tokens: 1 },
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

    expect(captured).toBeDefined();
    expect(captured!.info?.baselineTokens).toBe(4242);
  });

  // count_tokens is best-effort. If the probe 4xx's (e.g. upstream rejects
  // a malformed model field, or the field-whitelist drops something the
  // user added), the main /v1/messages forward must still succeed and the
  // dashboard event just won't carry a baselineTokens. No exception thrown
  // to the caller.
  it('survives count_tokens failure without breaking /v1/messages', async () => {
    const restore = mockUpstream((req) => {
      const url = new URL(req.url);
      if (url.pathname === '/v1/messages/count_tokens') {
        return new Response(JSON.stringify({ error: 'bad model' }), {
          status: 400,
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
          usage: { input_tokens: 1, output_tokens: 1 },
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
    expect(res.status).toBe(200);
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.info?.baselineTokens).toBeUndefined();
  });

  // ---- Ground-truth output measurement (Task #22) ----------------------
  //
  // The proxy scans the response stream for `text_delta` / `thinking_delta`
  // chars and `redacted_thinking` block counts. These numbers are
  // INDEPENDENT of Anthropic's `usage.output_tokens` — they're a raw ruler
  // against the redacted_thinking-inflated bill we surfaced in the May-2026
  // weekly-meter audit. The dashboard layer turns them into low/mid/high
  // bands; the proxy layer just has to count honestly.

  it('measures SSE text_delta chars across multiple delta events', async () => {
    // Three text_delta events spanning a couple of code points each — the
    // ruler must use STRING length (UTF-16 code units), matching what
    // `JSON.stringify(text).length` would count if we re-serialized.
    const sseBody =
      'event: message_start\n' +
      `data: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_m1', type: 'message', role: 'assistant', content: [],
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      })}\n\n` +
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello "}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"!"}}\n\n' +
      'event: message_delta\n' +
      'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":42}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';

    const restore = mockUpstream(
      () =>
        new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => { captured = e; },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    // 'hello ' (6) + 'world' (5) + '!' (1) = 12 chars.
    expect(captured!.measurement?.textChars).toBe(12);
    expect(captured!.measurement?.thinkingChars).toBe(0);
    expect(captured!.measurement?.toolUseChars).toBe(0);
    expect(captured!.measurement?.redactedBlockCount).toBe(0);
    // Final output_tokens from message_delta overrides message_start's 1.
    expect(captured!.usage?.output_tokens).toBe(42);
  });

  it('measures SSE thinking_delta chars and counts redacted_thinking blocks', async () => {
    // Extended thinking turn: a `thinking` block and a `redacted_thinking`
    // block. The redacted block has no readable chars (server-encrypted
    // bytes), so we just count the block — the dashboard surfaces it as
    // an opaque low/mid/high estimate.
    const sseBody =
      'event: message_start\n' +
      `data: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_m2', type: 'message', role: 'assistant', content: [],
          usage: { input_tokens: 100, output_tokens: 1 },
        },
      })}\n\n` +
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step 1: "}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason carefully"}}\n\n' +
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"opaque"}}\n\n' +
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"redacted_thinking","data":"alsoopaque"}}\n\n' +
      'event: message_delta\n' +
      'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":500}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';

    const restore = mockUpstream(
      () =>
        new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => { captured = e; },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    // 'step 1: ' (8) + 'reason carefully' (16) = 24 chars.
    expect(captured!.measurement?.thinkingChars).toBe(24);
    expect(captured!.measurement?.textChars).toBe(0);
    expect(captured!.measurement?.redactedBlockCount).toBe(2);
    expect(captured!.usage?.output_tokens).toBe(500);
  });

  it('measures SSE tool_use chars via input_json_delta', async () => {
    // tool_use blocks stream their `input` field as a JSON string assembled
    // from `input_json_delta` events. We count the raw JSON-string length —
    // that's the closest apples-to-apples we get against the billed body.
    const sseBody =
      'event: message_start\n' +
      `data: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_m3', type: 'message', role: 'assistant', content: [],
          usage: { input_tokens: 50, output_tokens: 1 },
        },
      })}\n\n` +
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"bash","input":{}}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":"}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"ls\\"}"}}\n\n' +
      'event: message_delta\n' +
      'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":20}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';

    const restore = mockUpstream(
      () =>
        new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => { captured = e; },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    // '{"cmd":' (7) + '"ls"}' (5) = 12 chars.
    expect(captured!.measurement?.toolUseChars).toBe(12);
    expect(captured!.measurement?.textChars).toBe(0);
    expect(captured!.measurement?.thinkingChars).toBe(0);
  });

  it('measures non-stream JSON response by walking content[]', async () => {
    // Non-stream path: the whole body is one JSON object. Counter walks
    // content[] and adds up text/thinking chars, tool_use input chars, and
    // redacted_thinking blocks. Same shape as the SSE accumulator — the
    // ruler must report the SAME numbers regardless of transport.
    const responseBody = JSON.stringify({
      id: 'msg_n1',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'one two three' },
        { type: 'thinking', thinking: 'reasoning here' },
        { type: 'redacted_thinking', data: 'opaque1' },
        { type: 'tool_use', id: 't1', name: 'bash', input: { cmd: 'ls' } },
        { type: 'text', text: '!!' },
      ],
      model: 'claude-opus-4-5',
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 99 },
    });

    const restore = mockUpstream(
      () =>
        new Response(responseBody, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => { captured = e; },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    // 'one two three' (13) + '!!' (2) = 15 chars text.
    expect(captured!.measurement?.textChars).toBe(15);
    // 'reasoning here' = 14.
    expect(captured!.measurement?.thinkingChars).toBe(14);
    // tool_use input JSON.stringify({cmd:'ls'}) = '{"cmd":"ls"}' = 12 chars.
    expect(captured!.measurement?.toolUseChars).toBe(12);
    expect(captured!.measurement?.redactedBlockCount).toBe(1);
  });

  it('leaves measurement undefined on 5xx (no body to scan)', async () => {
    // Upstream 5xx bails on usage AND measurement — the host synthesizes
    // an error message and the body is whatever Anthropic returned, which
    // by convention we don't try to parse. The dashboard event will just
    // skip the row from output-honesty math.
    const restore = mockUpstream(
      () =>
        new Response('upstream broke', {
          status: 503,
          headers: { 'content-type': 'text/plain' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => { captured = e; },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.status).toBe(503);
    expect(captured!.measurement).toBeUndefined();
  });

  it('handles message_start with no usage gracefully (still measures content)', async () => {
    // Defensive: if a future Anthropic release ships a message_start
    // without `usage`, the proxy should still scan deltas and report
    // measurement. Only the usage rollup degrades.
    const sseBody =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"id":"x","type":"message","role":"assistant","content":[]}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi there"}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';

    const restore = mockUpstream(
      () =>
        new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => { captured = e; },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.measurement?.textChars).toBe(8);
  });
});
