import { describe, expect, it } from 'vitest';
import {
  buildCountTokensBodies,
  isPixelpipeSupportedGptModel,
  isPixelpipeSupportedModel,
  shouldTransformAnthropicMessages,
  transformAnthropicMessages,
  transformOpenAIChatCompletions,
} from '../src/core/index.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('public library API', () => {
  it('recognizes Fable 5 (with suffix aliases) and no other models as supported', () => {
    expect(isPixelpipeSupportedModel('claude-fable-5')).toBe(true);
    expect(isPixelpipeSupportedModel('claude-fable-5-high')).toBe(true);
    // Opus was the original measured scope (4.7+) but is disabled 2026-06-09:
    // Fable 5 reads renders at 100/100 vs Opus 4.8's 93/100 with identical
    // image billing, so the Opus read tax is no longer worth carrying.
    expect(isPixelpipeSupportedModel('claude-opus-4-8')).toBe(false);
    expect(isPixelpipeSupportedModel('claude-opus-4-7')).toBe(false);
    expect(isPixelpipeSupportedModel('claude-opus-4-6')).toBe(false);
    // Mythos 5 shares the architecture but is unmeasured (no access).
    expect(isPixelpipeSupportedModel('claude-mythos-5')).toBe(false);
    expect(isPixelpipeSupportedModel('claude-fable-50')).toBe(false);
    expect(isPixelpipeSupportedModel('claude-sonnet-4-7')).toBe(false);
    expect(isPixelpipeSupportedModel(null)).toBe(false);
  });

  it('recognizes only the GPT 5.5 family for OpenAI chat support', () => {
    expect(isPixelpipeSupportedGptModel('gpt-5.5')).toBe(true);
    expect(isPixelpipeSupportedGptModel('gpt-5.5-codex')).toBe(true);
    expect(isPixelpipeSupportedGptModel('gpt-5.5-2026-06-01')).toBe(true);
    expect(isPixelpipeSupportedGptModel('gpt-5.1')).toBe(false);
    expect(isPixelpipeSupportedGptModel('claude-opus-4-8')).toBe(false);
    expect(isPixelpipeSupportedGptModel(null)).toBe(false);
  });

  it('reports applicability with route/method/body gates', () => {
    expect(shouldTransformAnthropicMessages({
      model: 'claude-fable-5',
      method: 'POST',
      path: '/v1/messages',
      bodyBytes: 10,
    })).toEqual({ eligible: true, reason: 'eligible' });
    expect(shouldTransformAnthropicMessages({
      model: 'claude-fable-5',
      method: 'GET',
      path: '/v1/messages',
      bodyBytes: 10,
    }).reason).toBe('unsupported_method');
    expect(shouldTransformAnthropicMessages({
      model: 'claude-fable-5',
      method: 'POST',
      path: '/v1/messages/count_tokens',
      bodyBytes: 10,
    }).reason).toBe('unsupported_path');
  });

  it('builds count_tokens probe bodies from a messages body', () => {
    const body = enc.encode(JSON.stringify({
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      stream: true,
      system: [{ type: 'text', text: 'sys' }],
      tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'cached', cache_control: { type: 'ephemeral', ttl: '1h' } },
            { type: 'text', text: 'tail' },
          ],
        },
      ],
    }));

    const probes = buildCountTokensBodies(body);
    expect(probes.fullBody).toBeInstanceOf(Uint8Array);
    const full = JSON.parse(dec.decode(probes.fullBody!)) as Record<string, unknown>;
    expect(full.model).toBe('claude-opus-4-7');
    expect(full.max_tokens).toBeUndefined();
    expect(full.stream).toBeUndefined();
    expect(Array.isArray(full.messages)).toBe(true);

    expect(probes.cacheablePrefixBody).toBeInstanceOf(Uint8Array);
    const prefix = JSON.parse(dec.decode(probes.cacheablePrefixBody!)) as { messages: Array<{ content: unknown }> };
    const last = prefix.messages.at(-1)!;
    expect(Array.isArray(last.content)).toBe(true);
    expect((last.content as unknown[])).toHaveLength(1);
  });

  it('cacheable-prefix probe body pairs orphan tool_use blocks with synthetic tool_result', () => {
    const body = enc.encode(JSON.stringify({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'thinking' },
            { type: 'tool_use', id: 'toolu_orphan_a', name: 'read', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_orphan_a', content: 'result' },
            { type: 'text', text: 'next turn please', cache_control: { type: 'ephemeral' } },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_orphan_b', name: 'read', input: {} },
          ],
        },
        // tool_result for toolu_orphan_b would be in the dropped tail
      ],
    }));

    const probes = buildCountTokensBodies(body);
    expect(probes.cacheablePrefixBody).toBeInstanceOf(Uint8Array);
    const prefix = JSON.parse(dec.decode(probes.cacheablePrefixBody!)) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    // Truncation kept up to and including the cache_control-bearing block,
    // which sits in messages[2]. The cached-prefix should NOT include msg[3]
    // (the orphan tool_use), but if it did, the synthetic tool_result must
    // pair it. Either way: no orphan tool_use ids may remain unpaired.
    const allBlocks = prefix.messages.flatMap((m) =>
      Array.isArray(m.content) ? (m.content as Array<{ type?: string }>) : [],
    );
    const orphanUses = allBlocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => (b as { id?: string }).id);
    const results = new Set(
      allBlocks
        .filter((b) => b.type === 'tool_result')
        .map((b) => (b as { tool_use_id?: string }).tool_use_id),
    );
    for (const id of orphanUses) {
      expect(results.has(id)).toBe(true);
    }
  });

  it('wraps the transformer with model gating and cache ownership metadata', async () => {
    const unsupported = enc.encode(JSON.stringify({
      model: 'claude-opus-4-8',
      system: 'x'.repeat(20_000),
      messages: [{ role: 'user', content: 'hello' }],
    }));
    const skipped = await transformAnthropicMessages({ body: unsupported, model: 'claude-opus-4-8' });
    expect(skipped.applied).toBe(false);
    expect(skipped.reason).toBe('unsupported_model');
    expect(skipped.body).toBe(unsupported);

    const supported = enc.encode(JSON.stringify({
      model: 'claude-fable-5',
      system: 'Important system instruction. '.repeat(1200),
      tools: [{
        name: 'read_file',
        description: 'Read a file from disk. '.repeat(200),
        input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      }],
      messages: [{ role: 'user', content: 'hello' }],
    }));
    const transformed = await transformAnthropicMessages({ body: supported, model: 'claude-fable-5' });
    expect(transformed.applied).toBe(true);
    expect(transformed.reason).toBe('applied');
    expect(transformed.info.compressedChars).toBeGreaterThan(0);
    expect(transformed.info.imageCount).toBeGreaterThan(0);
    // Task #21: pixelpipe never adds its own cache_control markers.
    // The caller sent zero markers, so the rewritten body also has zero.
    expect(transformed.cache.ownsCacheControl).toBe(false);
    expect(transformed.cache.markerCount).toBe(0);
  });

  it('transforms GPT 5.5 chat completions using OpenAI image_url blocks', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.5',
      messages: [
        { role: 'system', content: 'System instruction. '.repeat(700) },
        { role: 'developer', content: 'Developer instruction. '.repeat(400) },
        { role: 'user', content: 'hello' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file from disk. '.repeat(100),
          parameters: {
            type: 'object',
            description: 'Long root description.',
            properties: {
              path: { type: 'string', description: 'Path to read.' },
            },
            required: ['path'],
          },
        },
      }],
    }));

    const transformed = await transformOpenAIChatCompletions(body, {
      charsPerToken: 1,
      minCompressChars: 1,
    });
    expect(transformed.info.compressed).toBe(true);
    expect(transformed.info.imageCount).toBeGreaterThan(0);
    const out = JSON.parse(dec.decode(transformed.body)) as any;
    const firstUser = out.messages.find((m: any) => m.role === 'user');
    expect(Array.isArray(firstUser.content)).toBe(true);
    expect(firstUser.content[0].type).toBe('image_url');
    expect(firstUser.content[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(out.messages[0].content).toContain('rendered into image');
    expect(out.tools[0].function.description).toBe('See rendered tool docs image.');
    expect(out.tools[0].function.parameters.description).toBeUndefined();
    expect(out.tools[0].function.parameters.properties.path.description).toBeUndefined();
  });
});
