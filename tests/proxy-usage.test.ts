import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';

// Pin the model scope so these proxy-contract tests stay independent of the developer shell.
let ambientPxpipeModels: string | undefined;
beforeAll(() => {
  ambientPxpipeModels = process.env.PXPIPE_MODELS;
  process.env.PXPIPE_MODELS = 'claude-fable-5,gpt-5.6-sol,gemini-3.6-flash';
});
afterAll(() => {
  if (ambientPxpipeModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = ambientPxpipeModels;
});

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

  it('extracts Gemini usage from a streamed JSON array response', async () => {
    const restore = mockUpstream(
      () =>
        new Response(
          JSON.stringify([
            { candidates: [{ content: { parts: [{ text: 'hello' }, { text: 'thinking', thought: true }] } }] },
            {
              candidates: [{ content: { parts: [{ text: ' world' }, { functionCall: { name: 'f', args: {} } }] }, finishReason: 'STOP' }],
              usageMetadata: {
                promptTokenCount: 2048,
                candidatesTokenCount: 9,
                thoughtsTokenCount: 11,
                cachedContentTokenCount: 100,
              },
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8' } },
        ),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      upstream: 'http://ocproxy.test',
      transform: { compress: false },
      onRequest: (event) => {
        captured = event;
      },
    });
    const res = await proxy(
      new Request(
        'http://localhost/google-ai-studio/v1beta/models/gemini-3.6-flash:streamGenerateContent',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
        },
      ),
    );
    await res.text();
    await new Promise((resolve) => setTimeout(resolve, 20));
    restore();

    expect(captured?.model).toBe('gemini-3.6-flash');
    expect(captured?.accountingProvider).toBe('google');
    expect(captured?.usage?.input_tokens).toBe(2048);
    expect(captured?.usage?.output_tokens).toBe(20);
    expect(captured?.usage?.cached_tokens).toBe(100);
    expect(captured?.measurement?.textChars).toBe(11);
    expect(captured?.measurement?.thinkingChars).toBe(8);
    expect(captured?.measurement?.toolUseChars).toBeGreaterThan(0);
    expect(captured?.stopReason).toBe('STOP');
  });

  it('uses Gemini countTokens for the gate and measured text baseline', async () => {
    const upstreamRequests: Request[] = [];
    const restore = mockUpstream(async (req) => {
      upstreamRequests.push(req.clone());
      if (req.url.includes(':countTokens')) {
        const body = await req.clone().json() as {
          generateContentRequest?: { model?: string; contents?: unknown; systemInstruction?: unknown };
        };
        expect(body.generateContentRequest?.model).toBe('models/gemini-3.6-flash');
        expect(body.generateContentRequest?.contents).toBeDefined();
        return new Response(JSON.stringify({
          totalTokens: JSON.stringify(body.generateContentRequest).includes('inlineData') ? 120 : 400,
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    });
    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      upstream: 'http://ocproxy.test',
      transform: { compress: true },
      onRequest: (event) => { captured = event; },
    });
    const body = JSON.stringify({
      model: 'gemini-body-must-not-win',
      systemInstruction: { parts: [{ text: 'System instruction. '.repeat(300) }] },
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    const res = await proxy(new Request(
      'http://localhost/google-ai-studio/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse&key=test',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body },
    ));
    await res.text();
    await new Promise((resolve) => setTimeout(resolve, 20));
    restore();

    expect(upstreamRequests.filter((req) => req.url.includes(':countTokens'))).toHaveLength(2);
    expect(upstreamRequests[0]!.url).toContain(':countTokens?key=test');
    expect(upstreamRequests[0]!.url).not.toContain('alt=sse');
    expect(captured?.accountingProvider).toBe('google');
    expect(captured?.info?.compressed).toBe(true);
    expect(captured?.info?.baselineTokens).toBe(400);
    expect(captured?.info?.baselineImagedTokens).toBeGreaterThan(0);
    expect(captured?.info?.baselineImagedTokens).not.toBe(400);
    expect(captured?.info?.nativeInjectedTokens).toBeGreaterThan(0);
    expect(captured?.info?.baselineProbeStatus).toBe('ok');
  });

  it('fails Gemini compression closed when countTokens validation fails', async () => {
    const forwardedBodies: string[] = [];
    const restore = mockUpstream(async (req) => {
      if (req.url.includes(':countTokens')) return new Response('no', { status: 503 });
      forwardedBodies.push(await req.clone().text());
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    });
    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      upstream: 'http://ocproxy.test',
      transform: { compress: true },
      onRequest: (event) => { captured = event; },
    });
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: 'System instruction. '.repeat(300) }] },
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    const res = await proxy(new Request(
      'http://localhost/google-ai-studio/v1beta/models/gemini-3.6-flash:generateContent',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body },
    ));
    await res.text();
    await new Promise((resolve) => setTimeout(resolve, 20));
    restore();

    expect(forwardedBodies).toHaveLength(1);
    expect(forwardedBodies[0]).not.toContain('inlineData');
    expect(captured?.info?.compressed).toBe(false);
    expect(captured?.info?.reason).toBe('count_tokens_failed');
    expect(captured?.info?.baselineProbeStatus).toBe('failed');
    expect(captured?.info?.imagePngs).toBeUndefined();
    expect(captured?.info?.imageDims).toBeUndefined();
    expect(captured?.info?.compressedChars).toBe(0);
    expect(captured?.info?.bucketChars).toBeUndefined();
  });

  it('does not apply the 3.6 Flash profile to an unvalidated Gemini alias', async () => {
    const upstreamRequests: Request[] = [];
    const restore = mockUpstream(async (req) => {
      upstreamRequests.push(req.clone());
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    });
    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      upstream: 'http://ocproxy.test',
      transform: { compress: true },
      onRequest: (event) => { captured = event; },
    });
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: 'System instruction. '.repeat(300) }] },
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    const res = await proxy(new Request(
      'http://localhost/google-ai-studio/v1beta/models/gemini-3.6-flash-preview:generateContent',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body },
    ));
    await res.text();
    await new Promise((resolve) => setTimeout(resolve, 20));
    restore();

    expect(upstreamRequests).toHaveLength(1);
    expect(await upstreamRequests[0]!.text()).toBe(body);
    expect(captured?.info?.compressed).toBe(false);
    expect(captured?.info?.reason).toBe('unsupported_model');
  });

  it('classifies bypassed Gemini traffic as Google without probing', async () => {
    const upstreamRequests: Request[] = [];
    const restore = mockUpstream(async (req) => {
      upstreamRequests.push(req.clone());
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    });
    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      upstream: 'http://ocproxy.test',
      onRequest: (event) => { captured = event; },
    });
    const body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
    const res = await proxy(new Request(
      'http://localhost/google-ai-studio/v1beta/models/gemini-3.6-flash:generateContent',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pxpipe-bypass': '1' },
        body,
      },
    ));
    await res.text();
    await new Promise((resolve) => setTimeout(resolve, 20));
    restore();

    expect(upstreamRequests).toHaveLength(1);
    expect(await upstreamRequests[0]!.text()).toBe(body);
    expect(captured?.model).toBe('gemini-3.6-flash');
    expect(captured?.accountingProvider).toBe('google');
  });

  it('never calls Anthropic count_tokens for Sol Responses', async () => {
    const upstreamRequests: Request[] = [];
    const restore = mockUpstream(async (req) => {
      upstreamRequests.push(req.clone());
      return new Response(JSON.stringify({
        id: 'resp_sol_1', object: 'response', status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 400, output_tokens: 8, input_tokens_details: { cached_tokens: 300 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const proxy = createProxy({
      openAIUpstream: 'https://api.openai.test', openAIApiKey: 'sk-test',
      transform: { charsPerToken: 1, minCompressChars: 1 },
    });
    const body = JSON.stringify({
      model: 'gpt-5.6-sol',
      instructions: 'System instruction. '.repeat(900),
      input: [{ role: 'user', content: 'hi' }],
    });
    const res = await proxy(new Request('http://localhost/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    }));
    await res.text();
    restore();
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]!.url).toBe('https://api.openai.test/v1/responses');
    expect(upstreamRequests.some((r) => r.url.includes('/count_tokens'))).toBe(false);
  });

  it('transforms OpenCode /anthropic/messages (no /v1) and records the model', async () => {
    const upstreamRequests: Request[] = [];
    const restore = mockUpstream(async (req) => {
      upstreamRequests.push(req.clone());
      const url = req.url;
      if (url.endsWith('/count_tokens')) {
        return new Response(JSON.stringify({ input_tokens: 9000 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          usage: { input_tokens: 120, output_tokens: 7, cache_read_input_tokens: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      upstream: 'http://ocproxy.test',
      apiKey: 'sk-anthropic-test',
      transform: { charsPerToken: 1, minCompressChars: 1 },
      onRequest: (e) => {
        captured = e;
      },
    });

    const reqBody = JSON.stringify({
      model: 'claude-fable-5',
      max_tokens: 1,
      system: 'System instruction. '.repeat(900),
      messages: [{ role: 'user', content: 'hi' }],
    });

    const res = await proxy(
      new Request('http://localhost/anthropic/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-anthropic-test' },
        body: reqBody,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    const main = upstreamRequests.find((r) => r.url === 'http://ocproxy.test/anthropic/messages');
    expect(main).toBeDefined();
    expect(captured?.model).toBe('claude-fable-5');
    expect(captured?.info?.compressed).toBe(true);
    // count_tokens probe mirrors the request path under the same prefix.
    expect(
      upstreamRequests.some((r) => r.url === 'http://ocproxy.test/anthropic/messages/count_tokens'),
    ).toBe(true);
  });

  it('bridges Claude Code Messages + Sol to transformed OpenAI Responses', async () => {
    const upstreamRequests: Request[] = [];
    const restore = mockUpstream(async (req) => {
      upstreamRequests.push(req.clone());
      return new Response(JSON.stringify({
        id: 'resp_sol', object: 'response', status: 'completed', model: 'gpt-5.6-sol',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
          { type: 'function_call', call_id: 'call_2', name: 'search', arguments: '{"query":"needle"}' },
        ],
        usage: { input_tokens: 420, output_tokens: 17, input_tokens_details: { cached_tokens: 300 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      upstream: 'http://anthropic.test', apiKey: 'sk-anthropic',
      openAIUpstream: 'https://api.openai.test', openAIApiKey: 'sk-openai',
      openAIModels: ['gpt-5.6-sol'],
      transform: { charsPerToken: 1, minCompressChars: 1 },
      onRequest: (e) => { captured = e; },
    });
    const body = JSON.stringify({
      model: 'claude-gpt-5.6-sol', max_tokens: 16,
      system: 'System instruction. '.repeat(900),
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'inspect this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
        ] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'search', input: { query: 'old' } }] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'old result' },
          { type: 'text', text: 'continue after the result' },
        ] },
      ],
      tools: [{
        name: 'search', description: 'Search files. '.repeat(100),
        input_schema: { type: 'object', properties: { query: { type: 'string', description: 'needle' } } },
      }],
    });
    const res = await proxy(new Request('http://localhost/v1/messages', {
      method: 'POST', headers: {
        'content-type': 'application/json', 'x-api-key': 'client-anthropic',
        'anthropic-version': '2023-06-01', 'anthropic-beta': 'tools-2024-04-04',
      }, body,
    }));
    const received = await res.json() as any;
    await new Promise((r) => setTimeout(r, 20));
    restore();
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]!.url).toBe('https://api.openai.test/v1/responses');
    expect(upstreamRequests[0]!.headers.get('authorization')).toBe('Bearer sk-openai');
    expect(upstreamRequests[0]!.headers.has('x-api-key')).toBe(false);
    expect(upstreamRequests[0]!.headers.has('anthropic-version')).toBe(false);
    expect(upstreamRequests[0]!.headers.has('anthropic-beta')).toBe(false);
    expect(upstreamRequests.some((r) => r.url.includes('/count_tokens'))).toBe(false);
    const sent = JSON.parse(await upstreamRequests[0]!.text()) as any;
    expect(sent.model).toBe('gpt-5.6-sol');
    expect(sent.max_output_tokens).toBe(16);
    expect(sent.tools[0]).toMatchObject({ type: 'function', name: 'search' });
    expect(sent.input).toContainEqual(expect.objectContaining({
      type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"query":"old"}',
    }));
    expect(sent.input).toContainEqual(expect.objectContaining({
      type: 'function_call_output', call_id: 'call_1', output: 'old result',
    }));
    const outputIndex = sent.input.findIndex((item: any) => item.type === 'function_call_output');
    const continuationIndex = sent.input.findIndex((item: any) => item.role === 'user'
      && item.content?.some((part: any) => part.text === 'continue after the result'));
    expect(outputIndex).toBeLessThan(continuationIndex);
    expect(sent.input.some((item: any) => Array.isArray(item.content)
      && item.content.some((part: any) => part.type === 'input_image'))).toBe(true);
    expect(received).toMatchObject({
      type: 'message', role: 'assistant', model: 'gpt-5.6-sol', stop_reason: 'tool_use',
      usage: {
        input_tokens: 120, output_tokens: 17,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 300,
      },
    });
    expect(received.content).toEqual([
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: 'call_2', name: 'search', input: { query: 'needle' } },
    ]);
    expect(captured?.accountingProvider).toBe('openai');
    expect(captured?.usage).toMatchObject({
      input_tokens: 420, output_tokens: 17, cached_tokens: 300,
      cache_read_input_tokens: 300,
    });
    expect(captured?.stopReason).toBe('tool_use');
    expect(captured?.info?.compressed).toBe(true);
    expect(captured?.info?.firstImageWidth).toBe(768);
    expect(captured?.info?.baselineProbeStatus).toBeUndefined();
  });

  it('incrementally bridges streaming Responses text/tools/usage to Messages SSE', async () => {
    const upstreamRequests: Request[] = [];
    const response = { id: 'resp_stream', model: 'gpt-5.6-sol', status: 'in_progress' };
    const terminal = {
      ...response, status: 'completed',
      usage: { input_tokens: 90, output_tokens: 11, input_tokens_details: { cached_tokens: 40 } },
    };
    const upstreamSse = [
      ['response.created', { type: 'response.created', response }],
      ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'hello ' }],
      ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'world' }],
      ['response.output_text.done', { type: 'response.output_text.done', text: 'hello world' }],
      ['response.output_item.added', { type: 'response.output_item.added', item: {
        type: 'function_call', id: 'fc_1', call_id: 'call_stream', name: 'search', arguments: '',
      } }],
      ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', delta: '{"query":' }],
      ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', delta: '"x"}' }],
      ['response.output_item.done', { type: 'response.output_item.done', item: {
        type: 'function_call', call_id: 'call_stream', name: 'search', arguments: '{"query":"x"}',
      } }],
      ['response.completed', { type: 'response.completed', response: terminal }],
    ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
    const restore = mockUpstream((req) => {
      upstreamRequests.push(req.clone());
      return new Response(upstreamSse, { headers: { 'content-type': 'text/event-stream' } });
    });
    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      openAIUpstream: 'https://api.openai.test', openAIApiKey: 'sk-stream',
      openAIModels: ['gpt-5.6-sol'],
      transform: { compress: false }, onRequest: (e) => { captured = e; },
    });
    const res = await proxy(new Request('http://localhost/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'anthropic-client' },
      body: JSON.stringify({
        model: 'gpt-5.6-sol', stream: true, max_tokens: 64,
        messages: [{ role: 'user', content: 'use the tool' }],
        tools: [{ name: 'search', input_schema: { type: 'object', properties: { query: { type: 'string' } } } }],
      }),
    }));
    const received = await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]!.url).toBe('https://api.openai.test/v1/responses');
    expect(upstreamRequests[0]!.headers.get('authorization')).toBe('Bearer sk-stream');
    expect(upstreamRequests[0]!.headers.has('x-api-key')).toBe(false);
    expect(JSON.parse(await upstreamRequests[0]!.text())).toMatchObject({ stream: true, max_output_tokens: 64 });
    expect(received).toContain('event: message_start');
    expect(received).toContain('"type":"text_delta","text":"hello "');
    expect(received).toContain('"type":"tool_use","id":"call_stream","name":"search","input":{}');
    expect(received).toContain('"type":"input_json_delta","partial_json":"{\\"query\\":"');
    expect(received).toContain('"stop_reason":"tool_use"');
    expect(received).toContain('event: message_stop');
    expect(captured?.accountingProvider).toBe('openai');
    expect(captured?.usage).toMatchObject({
      input_tokens: 90, output_tokens: 11, cached_tokens: 40,
      cache_read_input_tokens: 40,
    });
    expect(captured?.stopReason).toBe('tool_use');
  });

  it('keeps structured tool-result images and never leaks Messages bearer auth', async () => {
    let upstream: Request | undefined;
    const restore = mockUpstream((req) => {
      upstream = req.clone();
      return new Response(JSON.stringify({
        id: 'resp_1', status: 'completed', model: 'gpt-5.6-sol', output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    });
    const proxy = createProxy({ openAIUpstream: 'https://api.openai.test', openAIModels: ['gpt-5.6-sol'], transform: { compress: false } });
    await (await proxy(new Request('http://localhost/v1/messages', {
      method: 'POST', headers: {
        'content-type': 'application/json', authorization: 'Bearer anthropic-secret',
      }, body: JSON.stringify({
        model: 'gpt-5.6-sol', messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', is_error: true, content: [
            { type: 'text', text: 'failed' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
          ] }] },
        ],
      }),
    }))).text();
    restore();
    expect(upstream?.headers.has('authorization')).toBe(false);
    const sent = JSON.parse(await upstream!.text());
    const output = sent.input.find((item: any) => item.type === 'function_call_output').output;
    expect(output).toEqual([
      { type: 'input_text', text: '[Tool execution failed]' },
      { type: 'input_text', text: 'failed' },
      { type: 'input_image', image_url: 'data:image/png;base64,YWJj', detail: 'original' },
    ]);
  });

  it('forwards Messages tool-result images through the Chat Completions upstream', async () => {
    let upstream: Request | undefined;
    const restore = mockUpstream((req) => {
      upstream = req.clone();
      return new Response(JSON.stringify({
        id: 'chatcmpl_vision', model: 'moonshotai/kimi-k3',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'PXPIPE-NONCE' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }), { headers: { 'content-type': 'application/json' } });
    });
    const proxy = createProxy({
      cloudflareUpstream: 'https://api.cloudflare.test/ai/v1',
      cloudflareApiKey: 'cf-test',
      cloudflareModels: ['moonshotai/kimi-k3'],
      transform: { compress: false },
    });
    const response = await proxy(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer anthropic-secret' },
      body: JSON.stringify({
        model: 'claude-moonshotai/kimi-k3', max_tokens: 128,
        messages: [
          { role: 'assistant', content: [
            { type: 'tool_use', id: 'toolu_image', name: 'read', input: { path: 'nonce.png' } },
          ] },
          { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'toolu_image', content: [
              { type: 'text', text: 'Image read successfully.' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
            ] },
            { type: 'text', text: 'Return the visible nonce.' },
          ] },
        ],
      }),
    }));
    const converted = await response.json() as any;
    restore();

    expect(upstream?.url).toBe('https://api.cloudflare.test/ai/v1/chat/completions');
    expect(upstream?.headers.get('authorization')).toBe('Bearer cf-test');
    const sent = JSON.parse(await upstream!.text());
    expect(sent.model).toBe('moonshotai/kimi-k3');
    expect(sent.messages).toEqual([
      {
        role: 'assistant', content: null,
        tool_calls: [{
          id: 'toolu_image', type: 'function',
          function: { name: 'read', arguments: '{"path":"nonce.png"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'toolu_image', content: 'Image read successfully.' },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } },
        { type: 'text', text: 'Return the visible nonce.' },
      ] },
    ]);
    expect(converted.content).toEqual([{ type: 'text', text: 'PXPIPE-NONCE' }]);
  });

  it('rejects Messages blocks that the Responses bridge cannot preserve', async () => {
    let called = false;
    const restore = mockUpstream(() => {
      called = true;
      return new Response('{}');
    });
    const proxy = createProxy({ openAIUpstream: 'https://openai.test', openAIModels: ['gpt-5.6-sol'], transform: { compress: false } });
    const res = await proxy(new Request('http://localhost/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'text', data: 'secret' } }] }],
      }),
    }));
    const body = await res.json() as any;
    restore();
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
    expect(body.error.message).toContain('document');
    expect(called).toBe(false);
  });

  it('routes by the top-level model rather than a nested metadata model', async () => {
    const requests: Request[] = [];
    const restore = mockUpstream((req) => {
      requests.push(req.clone());
      return new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-fable-5',
        content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    });
    const proxy = createProxy({ upstream: 'https://anthropic.test', openAIUpstream: 'https://openai.test', transform: { compress: false } });
    await (await proxy(new Request('http://localhost/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        metadata: { model: 'gpt-5.6-sol' }, model: 'claude-fable-5',
        messages: [{ role: 'user', content: 'secret' }],
      }),
    }))).text();
    restore();
    expect(requests.some((request) => request.url === 'https://anthropic.test/v1/messages')).toBe(true);
    expect(requests.some((request) => request.url.includes('/v1/responses'))).toBe(false);
  });

  it('routes a scope-listed Kimi model to Cloudflare, not the Responses bridge', async () => {
    // Scope alone must not classify a model as GPT: kimi is listed here, yet
    // it has to take the Chat Completions bridge because its NAME is not
    // GPT/Grok-shaped. Regression for the shared-PXPIPE_MODELS routing hole.
    const prior = process.env.PXPIPE_MODELS;
    process.env.PXPIPE_MODELS = 'claude-fable-5,gpt-5.6-sol,moonshotai/kimi-k3';
    let upstream: Request | undefined;
    const restore = mockUpstream((req) => {
      upstream = req.clone();
      return new Response(JSON.stringify({
        id: 'chatcmpl_1', model: 'moonshotai/kimi-k3',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    });
    const proxy = createProxy({
      openAIUpstream: 'https://openai.test',
      cloudflareUpstream: 'https://kimi.test/v1', cloudflareApiKey: 'tok_kimi',
      cloudflareModels: ['moonshotai/kimi-k3'],
      transform: { compress: false },
    });
    const res = await proxy(new Request('http://localhost/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'moonshotai/kimi-k3', max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }));
    const body = await res.json() as any;
    restore();
    if (prior === undefined) delete process.env.PXPIPE_MODELS;
    else process.env.PXPIPE_MODELS = prior;
    expect(upstream?.url).toBe('https://kimi.test/v1/chat/completions');
    expect(upstream?.headers.get('authorization')).toBe('Bearer tok_kimi');
    const sent = JSON.parse(await upstream!.text());
    expect(sent.model).toBe('moonshotai/kimi-k3');
    expect(Array.isArray(sent.messages)).toBe(true);
    expect(sent.input).toBeUndefined(); // Responses-bridge shape must not leak in.
    expect(body).toMatchObject({ type: 'message', role: 'assistant' });
  });

  it('advertises a reversible Claude-safe id for gateway model discovery', async () => {
    const proxy = createProxy({
      cloudflareUpstream: 'https://kimi.test/v1',
      cloudflareModels: ['moonshotai/kimi-k3'],
    });
    const res = await proxy(new Request('http://localhost/v1/models?limit=1000'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [{
        id: 'claude-moonshotai/kimi-k3',
        type: 'model',
        display_name: 'Kimi K3 (Cloudflare)',
        created_at: '1970-01-01T00:00:00Z',
      }],
      has_more: false,
      first_id: 'claude-moonshotai/kimi-k3',
      last_id: 'claude-moonshotai/kimi-k3',
    });
  });

  it('uses normal upstream discovery when Cloudflare has no configured model', async () => {
    let upstreamUrl = '';
    const restore = mockUpstream(async (req) => {
      upstreamUrl = req.url;
      return new Response(JSON.stringify({ data: [{ id: 'claude-fable-5' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const proxy = createProxy({ cloudflareUpstream: 'https://chat.test/v1' });
    expect(await (await proxy(new Request('http://localhost/v1/models'))).json()).toEqual({
      data: [{ id: 'claude-fable-5' }],
    });
    restore();
    expect(upstreamUrl).toBe('https://api.anthropic.com/v1/models');
  });

  it('advertises OpenAI and Cloudflare routed models together', async () => {
    const proxy = createProxy({
      openAIModels: ['gpt-5.6-sol'],
      cloudflareUpstream: 'https://chat.test/v1',
      cloudflareModels: ['moonshotai/kimi-k3'],
    });
    const body = await (await proxy(new Request('http://localhost/v1/models'))).json() as any;
    expect(body.data.map((model: any) => model.id)).toEqual([
      'claude-gpt-5.6-sol',
      'claude-moonshotai/kimi-k3',
    ]);
  });

  it('uses the resolved Kimi model for compression eligibility and telemetry', async () => {
    const prior = process.env.PXPIPE_MODELS;
    process.env.PXPIPE_MODELS = 'moonshotai/kimi-k3';
    let sent: any;
    let captured: ProxyEvent | undefined;
    const restore = mockUpstream(async (req) => {
      sent = JSON.parse(await req.text());
      return new Response(JSON.stringify({
        id: 'chatcmpl_3', model: 'moonshotai/kimi-k3',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    });
    const proxy = createProxy({
      cloudflareUpstream: 'https://kimi.test/v1',
      cloudflareModels: ['moonshotai/kimi-k3'],
      transform: { compress: true, minCompressChars: 1 },
      onRequest: (event) => { captured = event; },
    });
    const res = await proxy(new Request('http://localhost/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-moonshotai/kimi-k3', max_tokens: 64,
        system: 'Long system context. '.repeat(200),
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }));
    await res.text();
    await new Promise((resolve) => setTimeout(resolve, 20));
    restore();
    if (prior === undefined) delete process.env.PXPIPE_MODELS;
    else process.env.PXPIPE_MODELS = prior;
    expect(sent.model).toBe('moonshotai/kimi-k3');
    expect(captured?.model).toBe('moonshotai/kimi-k3');
    expect(captured?.info?.reason).not.toBe('unsupported_model');
  });

  it('decodes the selected gateway id to the configured Cloudflare model', async () => {
    let sentModel = '';
    const restore = mockUpstream(async (req) => {
      sentModel = JSON.parse(await req.text()).model;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    });
    const proxy = createProxy({
      cloudflareUpstream: 'https://chat.test/v1',
      cloudflareModels: ['moonshotai/kimi-k3'],
      transform: { compress: false },
    });
    await (await proxy(new Request('http://localhost/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-moonshotai/kimi-k3',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }))).text();
    restore();
    expect(sentModel).toBe('moonshotai/kimi-k3');
  });

  it('routes OpenAI, Cloudflare, and Anthropic simultaneously', async () => {
    const seen: Request[] = [];
    const restore = mockUpstream(async (req) => {
      seen.push(req.clone());
      if (req.url.includes('/chat/completions')) {
        const model = JSON.parse(await req.clone().text()).model;
        return new Response(JSON.stringify({
          id: 'chatcmpl_scoped', model,
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (req.url.includes('/responses')) {
        return new Response(JSON.stringify({
          id: 'resp_scoped', status: 'completed', model: 'custom-codex', output: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        id: 'msg_scoped', type: 'message', role: 'assistant', model: 'custom-claude',
        content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    });
    const proxy = createProxy({
      upstream: 'https://anthropic.test',
      openAIUpstream: 'https://openai.test',
      cloudflareUpstream: 'https://cloudflare.test/ai/v1',
      cloudflareApiKey: 'tok_cf',
      openAIModels: ['custom-codex'],
      cloudflareModels: ['moonshotai/kimi-k3'],
      transform: { compress: false },
    });
    for (const model of [
      'claude-fable-5', 'custom-codex', 'moonshotai/kimi-k3',
    ]) {
      await (await proxy(new Request('http://localhost/v1/messages', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
      }))).text();
    }
    restore();
    expect(seen.some((req) => req.url === 'https://anthropic.test/v1/messages')).toBe(true);
    expect(seen.some((req) => req.url === 'https://openai.test/v1/responses')).toBe(true);
    const cloudflareRequest = seen.find((req) => req.url.includes('cloudflare.test'))!;
    expect(cloudflareRequest.url).toBe('https://cloudflare.test/ai/v1/chat/completions');
    expect(cloudflareRequest.headers.get('authorization')).toBe('Bearer tok_cf');
    expect(JSON.parse(await cloudflareRequest.text()).model).toBe('moonshotai/kimi-k3');
  });

  it('gives Cloudflare precedence over OpenAI for overlapping model scopes', async () => {
    let upstream = '';
    const restore = mockUpstream((req) => {
      upstream = req.url;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      }), { headers: { 'content-type': 'application/json' } });
    });
    const proxy = createProxy({
      openAIModels: ['shared/model'],
      cloudflareModels: ['shared/model'],
      cloudflareUpstream: 'https://cloudflare.test/ai/v1',
      transform: { compress: false },
    });
    await (await proxy(new Request('http://localhost/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'shared/model', messages: [{ role: 'user', content: 'hi' }] }),
    }))).text();
    restore();
    expect(upstream).toBe('https://cloudflare.test/ai/v1/chat/completions');
  });

  it('requires the Cloudflare scope to have a Cloudflare upstream', () => {
    expect(() => createProxy({ cloudflareModels: ['moonshotai/kimi-k3'] }))
      .toThrow('cloudflareModels requires a Cloudflare chat upstream');
  });

  it('correlates interleaved parallel tool deltas and recovers sparse terminal calls', async () => {
    const response = { id: 'resp_parallel', model: 'gpt-5.6-sol', status: 'in_progress' };
    const events = [
      ['response.created', { response }],
      ['response.output_item.added', { output_index: 0, item: { type: 'function_call', id: 'item_a', call_id: 'call_a', name: 'a' } }],
      ['response.output_item.added', { output_index: 1, item: { type: 'function_call', id: 'item_b', call_id: 'call_b', name: 'b' } }],
      ['response.function_call_arguments.delta', { item_id: 'item_b', delta: '{"b":' }],
      ['response.function_call_arguments.delta', { item_id: 'item_a', delta: '{"a":1}' }],
      ['response.function_call_arguments.delta', { item_id: 'item_b', delta: '2}' }],
      ['response.completed', { response: { ...response, status: 'completed', output: [
        { type: 'function_call', id: 'item_a', call_id: 'call_a', name: 'a', arguments: '{"a":1}' },
        { type: 'function_call', id: 'item_b', call_id: 'call_b', name: 'b', arguments: '{"b":2}' },
        { type: 'function_call', id: 'item_c', call_id: 'call_c', name: 'c', arguments: '{"c":3}' },
      ], usage: { input_tokens: 4, output_tokens: 2 } } }],
    ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...(data as object) })}\n\n`).join('');
    const restore = mockUpstream(() => new Response(events, { headers: { 'content-type': 'text/event-stream' } }));
    const proxy = createProxy({ openAIUpstream: 'https://openai.test', openAIModels: ['gpt-5.6-sol'], transform: { compress: false } });
    const out = await (await proxy(new Request('http://localhost/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', stream: true, messages: [{ role: 'user', content: 'go' }] }),
    }))).text();
    restore();
    expect(out).toContain('"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}');
    expect(out).toContain('"index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"b\\":"}');
    expect(out).toContain('"index":1,"delta":{"type":"input_json_delta","partial_json":"2}"}');
    expect(out).toContain('"type":"tool_use","id":"call_c","name":"c"');
    expect(out).toContain('"partial_json":"{\\"c\\":3}"');
  });

  it('recovers missing argument suffixes and parses bare-CR Responses SSE', async () => {
    const response = { id: 'resp_cr', model: 'gpt-5.6-sol', status: 'in_progress' };
    const events = [
      ['response.created', { response }],
      ['response.output_item.added', { output_index: 0, item: {
        type: 'function_call', id: 'item_a', call_id: 'call_a', name: 'a',
      } }],
      ['response.function_call_arguments.delta', { item_id: 'item_a', delta: '{"a":' }],
      ['response.output_item.done', { output_index: 0, item: {
        type: 'function_call', id: 'item_a', call_id: 'call_a', name: 'a', arguments: '{"a":1}',
      } }],
      ['response.completed', { response: {
        ...response, status: 'completed', usage: { input_tokens: 2, output_tokens: 1 },
      } }],
    ].map(([event, data]) => `event: ${event}\rdata: ${JSON.stringify({ type: event, ...(data as object) })}\r\r`).join('');
    const restore = mockUpstream(() => new Response(events, { headers: { 'content-type': 'text/event-stream' } }));
    const proxy = createProxy({ openAIUpstream: 'https://openai.test', openAIModels: ['gpt-5.6-sol'], transform: { compress: false } });
    const out = await (await proxy(new Request('http://localhost/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', stream: true, messages: [{ role: 'user', content: 'go' }] }),
    }))).text();
    restore();
    expect(out).toContain('"partial_json":"{\\"a\\":"');
    expect(out).toContain('"partial_json":"1}"');
    expect(out).toContain('event: message_stop');
  });

  it('errors instead of finalizing inconsistent streamed tool arguments', async () => {
    const response = { id: 'resp_bad_args', model: 'gpt-5.6-sol', status: 'in_progress' };
    const events = [
      ['response.created', { response }],
      ['response.output_item.added', { item: { type: 'function_call', id: 'item_a', call_id: 'call_a', name: 'a' } }],
      ['response.function_call_arguments.delta', { item_id: 'item_a', delta: '{"wrong":1}' }],
      ['response.output_item.done', { item: {
        type: 'function_call', id: 'item_a', call_id: 'call_a', name: 'a', arguments: '{"right":1}',
      } }],
    ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...(data as object) })}\n\n`).join('');
    const restore = mockUpstream(() => new Response(events, { headers: { 'content-type': 'text/event-stream' } }));
    const proxy = createProxy({ openAIUpstream: 'https://openai.test', openAIModels: ['gpt-5.6-sol'], transform: { compress: false } });
    const out = await (await proxy(new Request('http://localhost/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', stream: true, messages: [{ role: 'user', content: 'go' }] }),
    }))).text();
    restore();
    expect(out).toContain('event: error');
    expect(out).toContain('inconsistent streamed function-call arguments');
    expect(out).not.toContain('event: message_stop');
  });

  it('maps upstream JSON and streaming failures to Anthropic errors', async () => {
    let call = 0;
    const restore = mockUpstream(() => {
      call++;
      if (call === 1) return new Response(JSON.stringify({
        error: { type: 'invalid_request', code: 'cyber_policy', message: 'blocked' },
      }), { status: 400, headers: { 'content-type': 'application/json' } });
      const data = JSON.stringify({
        type: 'response.failed', response: { error: { type: 'server_error', message: 'upstream broke' } },
      });
      return new Response(`event: response.failed\ndata: ${data}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    });
    const proxy = createProxy({ openAIUpstream: 'https://openai.test', openAIModels: ['gpt-5.6-sol'], transform: { compress: false } });
    const make = (stream: boolean) => new Request('http://localhost/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', stream, messages: [{ role: 'user', content: 'go' }] }),
    });
    const json = await (await proxy(make(false))).json() as any;
    const streamed = await (await proxy(make(true))).text();
    restore();
    expect(json).toEqual({ type: 'error', error: { type: 'invalid_request_error', message: 'blocked' } });
    expect(streamed).toContain('event: error');
    expect(streamed).toContain('"type":"server_error","message":"upstream broke"');
  });

  it('closes streamed text before opening a tool and wraps plain-text failures', async () => {
    let call = 0;
    const response = { id: 'resp_order', model: 'gpt-5.6-sol', status: 'in_progress' };
    const events = [
      ['response.created', { response }],
      ['response.output_text.delta', { delta: 'text' }],
      ['response.output_item.added', { item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'tool' } }],
      ['response.completed', { response: { ...response, status: 'completed', usage: {} } }],
    ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...(data as object) })}\n\n`).join('');
    const restore = mockUpstream(() => {
      call++;
      return call === 1
        ? new Response(events, { headers: { 'content-type': 'text/event-stream' } })
        : new Response('gateway exploded', { status: 502, headers: { 'content-type': 'text/plain' } });
    });
    const proxy = createProxy({ openAIUpstream: 'https://openai.test', openAIModels: ['gpt-5.6-sol'], transform: { compress: false } });
    const request = (stream: boolean) => new Request('http://localhost/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', stream, messages: [{ role: 'user', content: 'go' }] }),
    });
    const streamed = await (await proxy(request(true))).text();
    const failedRes = await proxy(request(false));
    const failed = await failedRes.json() as any;
    restore();
    const textStop = streamed.indexOf('"type":"content_block_stop","index":0');
    const toolStart = streamed.indexOf('"type":"tool_use"');
    expect(textStop).toBeGreaterThanOrEqual(0);
    expect(toolStart).toBeGreaterThan(textStop);
    expect(failedRes.status).toBe(502);
    expect(failed).toEqual({ type: 'error', error: { type: 'api_error', message: 'gateway exploded' } });
  });

  it('routes GPT 5.6 Sol chat completions to OpenAI, transforms once, and normalizes usage', async () => {
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
      model: 'gpt-5.6-sol',
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

    // OpenAI/Sol must never use Anthropic's /count_tokens endpoint. Its
    // counterfactual is local o200k tokenization in src/core/openai.ts.
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests.some((r) => r.url.includes('/count_tokens'))).toBe(false);
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

  it('transforms provider-prefixed OpenAI chat but forwards through the generic upstream', async () => {
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

    const proxy = createProxy({
      upstream: 'http://ocproxy.test',
      openAIUpstream: 'https://api.openai.test',
      transform: { charsPerToken: 1, minCompressChars: 1 },
    });

    const reqBody = JSON.stringify({
      model: 'gpt-5.6-sol',
      messages: [
        { role: 'system', content: 'System instruction. '.repeat(900) },
        { role: 'user', content: 'hi' },
      ],
    });

    const res = await proxy(
      new Request('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer local-token' },
        body: reqBody,
      }),
    );
    await res.text();
    restore();

    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]!.url).toBe('http://ocproxy.test/openai/v1/chat/completions');
    expect(upstreamRequests[0]!.headers.get('authorization')).toBe('Bearer local-token');
    const sent = JSON.parse(await upstreamRequests[0]!.text()) as any;
    const firstUser = sent.messages.find((m: any) => m.role === 'user');
    expect(firstUser.content[0].type).toBe('image_url');
  });

  it('transforms OpenCode /openai/responses requests and records the model', async () => {
    const upstreamRequests: Request[] = [];
    const restore = mockUpstream(async (req) => {
      upstreamRequests.push(req.clone());
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          object: 'response',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }],
          usage: { input_tokens: 55, output_tokens: 7, total_tokens: 62 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      upstream: 'http://ocproxy.test',
      openAIUpstream: 'https://api.openai.test',
      transform: { charsPerToken: 1, minCompressChars: 1 },
      onRequest: (e) => {
        captured = e;
      },
    });

    const reqBody = JSON.stringify({
      model: 'gpt-5.6-sol',
      instructions: 'System instruction. '.repeat(900),
      input: [{ role: 'user', content: 'hi' }],
    });

    const res = await proxy(
      new Request('http://localhost/openai/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer local-token' },
        body: reqBody,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]!.url).toBe('http://ocproxy.test/openai/responses');
    expect(upstreamRequests[0]!.headers.get('authorization')).toBe('Bearer local-token');
    const sent = JSON.parse(await upstreamRequests[0]!.text()) as any;
    const firstUser = sent.input.find((m: any) => m.role === 'user');
    expect(firstUser.content[0].type).toBe('input_image');
    expect(firstUser.content[0].image_url).toMatch(/^data:image\/png;base64,/);
    expect(captured?.model).toBe('gpt-5.6-sol');
    expect(captured?.accountingProvider).toBe('openai');
    expect(captured?.info?.compressed).toBe(true);
    // OpenCode reaches the Responses transformer directly. Sol's production
    // profile supplies the validated 768px-wide monochrome renderer.
    expect(captured?.info?.firstImageWidth).toBe(768);
    expect(captured?.info?.firstImageHeight).toBeLessThanOrEqual(1932);
    expect(captured?.info?.imageTokens ?? 0).toBeGreaterThan(0);
    expect(captured?.info?.baselineImagedTokens ?? 0).toBeGreaterThan(
      captured?.info?.imageTokens ?? 0,
    );
    expect(captured?.info?.baselineProbeStatus).toBeUndefined();
    expect(captured?.info?.firstUserSha8).toMatch(/^[0-9a-f]{8}$/);
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
      captureErrorReqBody: true,
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
      captureErrorReqBody: true,
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

  it('captures the FULL gzipped transformed body on 4xx (opt-in) + sets reqBodySha8', async () => {
    // Pair with errorBody so a future debugger can reconstruct
    // "we sent X, Anthropic said Y" from the JSONL alone. We gzip the body
    // so even a 170 KiB transformed payload fits inline once base64'd
    // (typical PNG-heavy bodies compress to <10% of source).
    // captureErrorReqBody is off by default (privacy, issue #69); this test
    // opts in explicitly.
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
      captureErrorReqBody: true,
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

  it('does NOT capture the 4xx request body by default (privacy, issue #69)', async () => {
    // Either side of a custom gateway error may echo prompts or credentials,
    // so both request and upstream error-body persistence are opt-in only.
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

    expect(captured!.status).toBe(400);
    expect(captured!.reqBodySha8).toMatch(/^[0-9a-f]{8}$/); // hash still lands
    expect(captured!.reqBodyGz).toBeUndefined(); // but not the raw body
    expect(captured!.errorBody).toBeUndefined();
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

  it('extracts stop_reason from the SSE message_delta event', async () => {
    const sseBody =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"id":"x","type":"message","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":1}}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
      'event: message_delta\n' +
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":9}}\n\n' +
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
    expect(captured!.stopReason).toBe('end_turn');
    // message_delta output_tokens must win over message_start's placeholder 1.
    expect(captured!.usage?.output_tokens).toBe(9);
  });

  it('extracts stop_reason "refusal" from a non-stream JSON response', async () => {
    const restore = mockUpstream(
      () =>
        new Response(
          JSON.stringify({
            id: 'msg_r',
            type: 'message',
            role: 'assistant',
            content: [],
            stop_reason: 'refusal',
            usage: { input_tokens: 5, output_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
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
    expect(captured!.stopReason).toBe('refusal');
  });

  it('extracts OpenAI choices[].finish_reason from a JSON body', async () => {
    const restore = mockUpstream(
      () =>
        new Response(
          JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '' },
                finish_reason: 'content_filter',
              },
            ],
            usage: { prompt_tokens: 11, completion_tokens: 3 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
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
    expect(captured!.stopReason).toBe('content_filter');
  });

  it('leaves stopReason undefined when the stream never ships one', async () => {
    const sseBody =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"id":"x","type":"message","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":1}}}\n\n' +
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
    expect(captured!.stopReason).toBeUndefined();
  });
});
