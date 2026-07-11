import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCountTokensBodies,
  getAllowedModelBases,
  isPxpipeSupportedGptModel,
  isPxpipeSupportedModel,
  setAllowedModelBases,
  shouldTransformAnthropicMessages,
  transformAnthropicMessages,
  transformOpenAIChatCompletions,
} from '../src/core/index.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// Tests below assert DEFAULT model-scope behavior, which assumes PXPIPE_MODELS is unset.
// Snapshot and clear any ambient value (e.g. a dev shell that still exports PXPIPE_MODELS)
// before each test so the suite is deterministic regardless of the environment it runs in,
// then restore the original afterward. The per-test override cases still work: they see an
// unset var, set their own value, and clean up.
let ambientPxpipeModels: string | undefined;
beforeEach(() => {
  ambientPxpipeModels = process.env.PXPIPE_MODELS;
  delete process.env.PXPIPE_MODELS;
});
afterEach(() => {
  if (ambientPxpipeModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = ambientPxpipeModels;
});

describe('public library API', () => {
  it('recognizes Fable 5 (with suffix aliases) as the default scope; Opus is OFF by default', () => {
    expect(isPxpipeSupportedModel('claude-fable-5')).toBe(true);
    expect(isPxpipeSupportedModel('claude-fable-5-high')).toBe(true);
    // Opus 4.8 is OPT-IN, not in the default scope — same pipeline/render as
    // Fable, but it reads imaged content at a tax (FINDINGS.md 2026-06-16), so
    // the default doesn't silently compress the operator's main driver. Enable
    // it via PXPIPE_MODELS or the dashboard "compress models" chips.
    expect(isPxpipeSupportedModel('claude-opus-4-8')).toBe(false);
    // older Opus + other families are not in the default scope
    expect(isPxpipeSupportedModel('claude-opus-4-7')).toBe(false);
    expect(isPxpipeSupportedModel('claude-opus-4-6')).toBe(false);
    expect(isPxpipeSupportedModel('claude-mythos-5')).toBe(false);
    expect(isPxpipeSupportedModel('claude-fable-50')).toBe(false);
    expect(isPxpipeSupportedModel('claude-sonnet-4-7')).toBe(false);
    expect(isPxpipeSupportedModel(null)).toBe(false);
  });

  it('strips bracketed variant tags like [1m] before matching', () => {
    expect(isPxpipeSupportedModel('claude-fable-5[1m]')).toBe(true);
    expect(isPxpipeSupportedModel('claude-fable-5-high[1m]')).toBe(true);
    expect(isPxpipeSupportedModel('claude-opus-4-8[1m]')).toBe(false); // Opus opt-in, off by default
    // a non-scoped base is still rejected even with a variant tag
    expect(isPxpipeSupportedModel('claude-opus-4-7[1m]')).toBe(false);
  });

  it('honors PXPIPE_MODELS to override the default scope', () => {
    const prev = process.env.PXPIPE_MODELS;
    try {
      // narrow to Fable only
      process.env.PXPIPE_MODELS = 'claude-fable-5';
      expect(isPxpipeSupportedModel('claude-fable-5')).toBe(true);
      expect(isPxpipeSupportedModel('claude-opus-4-8')).toBe(false);
      // re-point to a different set
      process.env.PXPIPE_MODELS = 'claude-fable-5,claude-opus-4-7';
      expect(isPxpipeSupportedModel('claude-opus-4-7')).toBe(true);
      expect(isPxpipeSupportedModel('claude-opus-4-8')).toBe(false); // not in this set
    } finally {
      if (prev === undefined) delete process.env.PXPIPE_MODELS;
      else process.env.PXPIPE_MODELS = prev;
    }
  });

  it('honors the dashboard runtime override (setAllowedModelBases) over env/default', () => {
    try {
      // override takes precedence over the env/default scope
      setAllowedModelBases(['claude-fable-5', 'claude-opus-4-8']);
      expect(getAllowedModelBases()).toEqual(['claude-fable-5', 'claude-opus-4-8']);
      expect(isPxpipeSupportedModel('claude-opus-4-8')).toBe(true); // opted in at runtime
      // empty list = compress nothing
      setAllowedModelBases([]);
      expect(isPxpipeSupportedModel('claude-fable-5')).toBe(false);
      // null clears the override → back to the Fable-only default
      setAllowedModelBases(null);
      expect(isPxpipeSupportedModel('claude-fable-5')).toBe(true);
      expect(isPxpipeSupportedGptModel('grok-4.5')).toBe(false);
      expect(isPxpipeSupportedModel('claude-opus-4-8')).toBe(false);
    } finally {
      setAllowedModelBases(null); // never leak the override into other tests
    }
  });

  it('keeps GPT 5.6 Sol off by default but preserves exact opt-in aliases', () => {
    expect(isPxpipeSupportedGptModel('gpt-5')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-5.5')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-5.5-codex')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-5.6')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-5.6-sol')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-5.6-sol-codex')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-5.6-terra')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-5-mini')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-4o')).toBe(false);

    process.env.PXPIPE_MODELS = 'gpt-5.6-sol';
    expect(isPxpipeSupportedGptModel('gpt-5.6-sol')).toBe(true);
    expect(isPxpipeSupportedGptModel('gpt-5.6-sol-codex')).toBe(true);
    expect(isPxpipeSupportedGptModel('gpt-5.6-sol[1m]')).toBe(true);
    expect(isPxpipeSupportedGptModel('gpt-5.6-sol-codex[1m]')).toBe(true);
    expect(isPxpipeSupportedGptModel('gpt-5.6')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-5.6-terra')).toBe(false);
  });

  it('keeps Grok and Sol opt-in only (off by default, like Opus)', () => {
    // Grok packing + factsheet helps exact IDs, but pure-image is not Fable-
    // level and the full quality suite is incomplete — opt-in only.
    const prev = process.env.PXPIPE_MODELS;
    try {
      delete process.env.PXPIPE_MODELS;
      expect(isPxpipeSupportedGptModel('grok-4.5')).toBe(false);
      expect(isPxpipeSupportedGptModel('grok-4')).toBe(false);
      expect(isPxpipeSupportedGptModel('grok-4.20')).toBe(false);
      expect(getAllowedModelBases()).not.toContain('grok-4.5');
      expect(getAllowedModelBases()).toEqual(['claude-fable-5']);

      process.env.PXPIPE_MODELS = 'claude-fable-5,gpt-5.6-sol,grok-4.5';
      expect(isPxpipeSupportedGptModel('grok-4.5')).toBe(true);
      expect(isPxpipeSupportedGptModel('grok-4.5-fast')).toBe(true); // -suffix alias
      expect(isPxpipeSupportedGptModel('gpt-5.6-sol')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PXPIPE_MODELS;
      else process.env.PXPIPE_MODELS = prev;
    }
  });

  it('honors the single PXPIPE_MODELS scope for GPT families', () => {
    const prev = process.env.PXPIPE_MODELS;
    try {
      // Explicit Claude-only scope disables GPT imaging.
      process.env.PXPIPE_MODELS = 'claude-fable-5';
      expect(isPxpipeSupportedGptModel('gpt-5.5')).toBe(false);
      expect(isPxpipeSupportedGptModel('gpt-5.6-sol')).toBe(false);

      // Mixed CSV selects exactly those bases across families.
      process.env.PXPIPE_MODELS = 'claude-fable-5,gpt-5.6-sol';
      expect(isPxpipeSupportedGptModel('gpt-5.5')).toBe(false);
      expect(isPxpipeSupportedGptModel('gpt-5.6-sol')).toBe(true);
      expect(isPxpipeSupportedModel('claude-fable-5')).toBe(true);

      // `off` disables everything.
      process.env.PXPIPE_MODELS = 'off';
      expect(isPxpipeSupportedGptModel('gpt-5.6-sol')).toBe(false);
      expect(isPxpipeSupportedModel('claude-fable-5')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.PXPIPE_MODELS;
      else process.env.PXPIPE_MODELS = prev;
    }
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
    // Provider-prefixed routes createProxy() also transforms must be eligible
    // here too — the old endsWith('/v1/messages') check rejected /anthropic/messages.
    for (const path of ['/anthropic/v1/messages', '/anthropic/messages']) {
      expect(shouldTransformAnthropicMessages({
        model: 'claude-fable-5',
        method: 'POST',
        path,
        bodyBytes: 10,
      })).toEqual({ eligible: true, reason: 'eligible' });
    }
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
      model: 'claude-sonnet-4-6',
      system: 'x'.repeat(20_000),
      messages: [{ role: 'user', content: 'hello' }],
    }));
    const skipped = await transformAnthropicMessages({ body: unsupported, model: 'claude-sonnet-4-6' });
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
    // Task #21: pxpipe never adds its own cache_control markers.
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
    expect(out.tools[0].function.description).toBe('Read a file from disk. '.repeat(100));
    expect(out.tools[0].function.parameters.description).toBeUndefined();
    expect(out.tools[0].function.parameters.properties.path.description).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('cache_control');
  });
});
