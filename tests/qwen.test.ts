/**
 * Qwen 3.8 27B profile and the 32-image provider cap.
 * Kept out of openai-gpt5.test.ts so Qwen is not mixed with GPT fixtures.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transformOpenAIChatCompletions } from '../src/core/openai.js';
import { resolveGptProfile, isMisresolvedModelId } from '../src/core/gpt-model-profiles.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const BIG_SLAB = 'You are a coding agent with detailed instructions. '.repeat(80);
const OPENING_PROMPT_MARKER = 'OPENING_PROMPT_SHOULD_BE_HISTORY';
const LIVE_PROMPT_MARKER = 'LIVE_CURRENT_PROMPT_SHOULD_STAY_TEXT';

function buildChatMessages(turns: number): Array<Record<string, unknown>> {
  const msgs: Array<Record<string, unknown>> = [
    { role: 'system', content: BIG_SLAB },
    { role: 'user', content: `${OPENING_PROMPT_MARKER} `.repeat(40) },
  ];
  for (let i = 0; i < turns; i++) {
    const id = `call_${i}`;
    msgs.push({
      role: 'assistant',
      content: `Working on step ${i}. `.repeat(30),
      tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: `{"path":"f${i}"}` } }],
    });
    msgs.push({ role: 'tool', tool_call_id: id, content: `result ${i} `.repeat(50) });
    msgs.push({
      role: 'user',
      content: i === turns - 1
        ? `${LIVE_PROMPT_MARKER} `.repeat(20)
        : `Continue with ${i}. `.repeat(20),
    });
  }
  return msgs;
}

let ambientPxpipeModels: string | undefined;
beforeEach(() => {
  ambientPxpipeModels = process.env.PXPIPE_MODELS;
  delete process.env.PXPIPE_MODELS;
});
afterEach(() => {
  if (ambientPxpipeModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = ambientPxpipeModels;
});

describe('resolveGptProfile (Qwen)', () => {
  it('uses native 14px packing and the 32-image provider cap', () => {
    const p = resolveGptProfile('workers-ai/@cf/qwen/qwen3.8-27b');
    expect(p.stripCols).toBe(84);
    expect(p.maxHeightPx).toBe(512);
    expect(p.style.font).toBe('jetbrains-mono-14');
    expect(p.history.maxImages).toBe(32);
    expect(p.history.keepTail).toBe(1);
    expect(p.history.minCollapseTokens).toBe(0);
    expect(p.history.minCollapsePrefix).toBe(1);
    expect(p.history.responsesMode).toBe('mixed');
    expect(p.providerImageCap).toBe(32);
    expect(resolveGptProfile('qwen3.8-27b').stripCols).toBe(84);
  });

  it('refuses unmeasured Qwen variants instead of applying this profile', () => {
    for (const id of ['qwen2.5-72b-instruct', 'qwen3-30b', 'qwen-3.8-27b']) {
      expect(resolveGptProfile(id).stripCols).not.toBe(84);
      expect(isMisresolvedModelId(id)).toBe(true);
    }
  });
});

describe('Qwen provider image cap — dynamic history budget', () => {
  it('budgets history against 32 minus the images already in the request', async () => {
    const tinyPng = { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' };
    const messages = buildChatMessages(20);
    const lastMsg = messages.at(-1);
    if (!lastMsg) throw new Error('messages must not be empty');
    lastMsg.content = [
      { type: 'text', text: lastMsg.content },
      ...Array.from({ length: 24 }, () => ({ type: 'image_url', image_url: tinyPng })),
    ];
    const result = await transformOpenAIChatCompletions(
      enc.encode(JSON.stringify({ model: 'workers-ai/@cf/qwen/qwen3.8-27b', messages })),
      { charsPerToken: 1, minCompressChars: 1 },
    );
    expect(result.info.compressed).toBe(true);
    expect(result.info.historyReason).toBe('collapsed');
    expect(result.info.collapsedImages ?? 0).toBeGreaterThan(0);

    const out = JSON.parse(dec.decode(result.body)) as { messages: Array<{ role: string; content: unknown }> };
    let totalImages = 0;
    for (const m of out.messages) {
      if (Array.isArray(m.content)) {
        totalImages += (m.content as Array<{ type?: string }>).filter((p) => p.type === 'image_url').length;
      }
    }
    expect(JSON.stringify(out.messages).match(/iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ/g)?.length).toBe(24);
    expect(totalImages).toBeLessThanOrEqual(32);
  });

  it('keeps static context native when client images leave insufficient headroom', async () => {
    const tinyPng = { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' };
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: BIG_SLAB },
      {
        role: 'user',
        content: Array.from({ length: 31 }, () => ({ type: 'image_url', image_url: tinyPng })),
      },
    ];
    const body = enc.encode(JSON.stringify({ model: 'workers-ai/@cf/qwen/qwen3.8-27b', messages }));
    const result = await transformOpenAIChatCompletions(body, { minCompressChars: 1 });

    expect(result.info.compressed).toBe(false);
    expect(result.info.reason).toBe('provider_image_cap');
    expect(result.body).toEqual(body);
  });
});
