import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { transformOpenAIChatCompletions, transformOpenAIResponses } from '../src/core/openai.js';
import { transformRequest } from '../src/core/transform.js';
import { createProxy } from '../src/core/proxy.js';

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const decode = (value: Uint8Array): any => JSON.parse(new TextDecoder().decode(value));
const dense = (size: number): string => Array.from(
  { length: Math.ceil(size / 24) },
  (_, index) => `module_${index}=value_${index * 7919}`,
).join('\n').slice(0, size);
const force = { charsPerToken: 1, minCompressChars: 1 } as const;

let previousModels: string | undefined;
beforeEach(() => {
  previousModels = process.env.PXPIPE_MODELS;
  process.env.PXPIPE_MODELS = 'claude-fable-5,gpt-5.6-sol';
});
afterEach(() => {
  if (previousModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = previousModels;
  vi.unstubAllGlobals();
});

describe('provider-neutral request semantics', () => {
  it('keeps Anthropic tool schemas machine-readable and semantically exact', async () => {
    const schema = {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update'] },
        payload: {
          type: 'object',
          properties: { id: { type: 'string', pattern: '^[a-z0-9-]+$' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
      required: ['action', 'payload'],
      additionalProperties: false,
    };
    const result = await transformRequest(encode({
      model: 'claude-fable-5',
      max_tokens: 32,
      system: dense(70_000),
      tools: [{ name: 'mutate_record', description: dense(12_000), input_schema: schema }],
      messages: [{ role: 'user', content: 'Create one record.' }],
    }), force);
    const output = decode(result.body);

    expect(result.info.compressed).toBe(true);
    expect(output.tools[0].name).toBe('mutate_record');
    expect(output.tools[0].input_schema).toEqual(schema);
    expect(JSON.stringify(output.messages)).toContain('Create one record.');
  });

  it('keeps OpenAI response-format JSON Schema unchanged', async () => {
    const responseFormat = {
      type: 'json_schema',
      json_schema: {
        name: 'result',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ok', 'error'] },
            identifiers: { type: 'array', items: { type: 'string' } },
          },
          required: ['status', 'identifiers'],
          additionalProperties: false,
        },
      },
    };
    const result = await transformOpenAIChatCompletions(encode({
      model: 'gpt-5.6-sol',
      messages: [
        { role: 'system', content: dense(70_000) },
        { role: 'user', content: 'Return the requested JSON.' },
      ],
      response_format: responseFormat,
    }), force);
    const output = decode(result.body);

    expect(result.info.compressed).toBe(true);
    expect(output.response_format).toEqual(responseFormat);
    expect(JSON.stringify(output.messages)).toContain('Return the requested JSON.');
  });

  it('preserves Responses function-call/output ordering and exact call ids', async () => {
    const result = await transformOpenAIResponses(encode({
      model: 'gpt-5.6-sol',
      input: [
        { role: 'system', content: dense(60_000) },
        { type: 'function_call', call_id: 'call_exact_123', name: 'lookup', arguments: '{"id":"abc-123"}' },
        { type: 'function_call_output', call_id: 'call_exact_123', output: '{"value":7}' },
        { role: 'user', content: 'Use the tool result and answer.' },
      ],
    }), force);
    const output = decode(result.body);
    const callIndex = output.input.findIndex((item: any) => item.type === 'function_call');
    const outputIndex = output.input.findIndex((item: any) => item.type === 'function_call_output');

    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(outputIndex).toBe(callIndex + 1);
    expect(output.input[callIndex].call_id).toBe('call_exact_123');
    expect(output.input[outputIndex].call_id).toBe('call_exact_123');
    expect(output.input[outputIndex].output).toBe('{"value":7}');
    expect(JSON.stringify(output.input)).toContain('Use the tool result and answer.');
  });

  it('never recursively recompresses an existing native image', async () => {
    const nativeImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
    const result = await transformOpenAIChatCompletions(encode({
      model: 'gpt-5.6-sol',
      messages: [
        { role: 'system', content: dense(60_000) },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: nativeImage, detail: 'low' } },
            { type: 'text', text: 'Inspect the supplied image.' },
          ],
        },
      ],
    }), force);
    const output = decode(result.body);
    const serialized = JSON.stringify(output);

    expect(serialized.match(new RegExp(nativeImage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
    expect(serialized).toContain('Inspect the supplied image.');
  });
});

describe('provider-neutral response transparency', () => {
  it('does not rewrite an OpenAI-compatible model response or provider headers', async () => {
    const exactResponse = '{\n  "id":"resp-1",\n  "provider_field":{"keep":true},\n  "choices":[{"message":{"role":"assistant","content":"OK"}}]\n}';
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(exactResponse, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-provider-field': 'preserved',
        'retry-after': '17',
      },
    })));

    const proxy = createProxy({
      openAIUpstream: 'https://api.openai.test',
      openAIApiKey: 'test-key',
      openAIModels: ['gpt-5.6-sol'],
      transform: force,
    });
    const response = await proxy(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        messages: [
          { role: 'system', content: dense(60_000) },
          { role: 'user', content: 'Reply with OK.' },
        ],
      }),
    }));

    expect(await response.text()).toBe(exactResponse);
    expect(response.headers.get('x-provider-field')).toBe('preserved');
    expect(response.headers.get('retry-after')).toBe('17');
  });
});
