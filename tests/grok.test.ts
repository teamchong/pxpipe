/**
 * Grok profile, geometry, vision billing, and history collapse.
 * Kept out of openai-gpt5.test.ts so Grok is not mixed with GPT fixtures.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAIVisionTokens, visionTokensForModel, transformOpenAIChatCompletions, transformOpenAIResponses } from '../src/core/openai.js';
import { resolveGptProfile } from '../src/core/gpt-model-profiles.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const BIG_INSTRUCTIONS = 'These are detailed instructions. '.repeat(600);

let ambientPxpipeModels: string | undefined;
beforeEach(() => {
  ambientPxpipeModels = process.env.PXPIPE_MODELS;
  delete process.env.PXPIPE_MODELS;
});
afterEach(() => {
  if (ambientPxpipeModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = ambientPxpipeModels;
});

describe('resolveGptProfile (Grok)', () => {
  it('uses native 14px packing with shorter pages under 768px short side', () => {
    // Native 14px was the densest best rung on the Grok JB Mono blind sweep.
    // 84 × 9px + pad = 764px ≤ 768. No grid. maxH 512 keeps pages short.
    const p = resolveGptProfile('grok-4.5');
    expect(p.stripCols).toBe(84);
    expect(p.maxHeightPx).toBe(512);
    expect(p.minCompressTokens).toBe(500);
    // No observed xAI body limit (clean 200s past 2 MB), so no guessed cap.
    expect(p.maxSerializedRequestBytes).toBeUndefined();
    expect(p.style.font).toBe('jetbrains-mono-14');
    expect(p.style.cellWBonus).toBe(0);
    expect(p.style.cellHBonus).toBe(0);
    expect(p.style.aa).toBe(true);
    expect(p.style.grid).toBe(false);
    expect(p.style.gridCols).toBe(0);
    expect(p.style.colorCycle).toBe(false);
    expect(p.history).toMatchObject({
      responsesMode: 'mixed',
      maxImages: 32,
      keepTail: 1,
      keepRecentPairs: 1,
      minCollapseTokens: 0,
      minCollapsePrefix: 1,
      collapseChunk: 1,
      freezeChunk: 1,
      framing: 'compact',
      factSheetScope: 'combined',
    });
    expect(resolveGptProfile('grok-4').stripCols).toBe(84);
    expect(resolveGptProfile('grok-4.6').history.responsesMode).toBe('mixed');
  });

  it('renders the opt-in profile at 764px wide (no short-side resize)', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'grok-4.5',
      instructions: BIG_INSTRUCTIONS,
      input: [{ role: 'user', content: 'hello' }],
    }));
    const result = await transformOpenAIResponses(body, { charsPerToken: 1, minCompressChars: 1 });
    expect(result.info.compressed).toBe(true);
    // 84 cols × 9px + padding = 764px short-side floor.
    expect(result.info.firstImageWidth).toBe(764);
    expect(result.info.firstImageHeight ?? 0).toBeLessThanOrEqual(512);
  });
});

describe('Grok no-resize geometry', () => {
  it('keeps rendered short side at or below 768px for slab and history packing', async () => {
    const profile = resolveGptProfile('grok-4.5');
    // jetbrains-mono-14 native cell is 9×16; bonuses stay 0.
    const cellW = 9 + (profile.style.cellWBonus ?? 0);
    const stripW = 8 + profile.stripCols * cellW; // 2*PAD_X=8
    expect(stripW).toBeLessThanOrEqual(768);
    expect(profile.stripCols).toBe(84);
    expect(profile.style.font).toBe('jetbrains-mono-14');
    expect(cellW).toBe(9);
    expect(profile.maxHeightPx).toBe(512);
    expect(stripW).toBe(764);

    const body = enc.encode(JSON.stringify({
      model: 'grok-4.5',
      instructions: BIG_INSTRUCTIONS,
      input: [{ role: 'user', content: 'hello' }],
    }));
    const result = await transformOpenAIResponses(body, { charsPerToken: 1, minCompressChars: 1 });
    expect(result.info.firstImageWidth ?? 0).toBeLessThanOrEqual(768);
    expect(result.info.firstImageWidth).toBe(764);
    expect(result.info.firstImageHeight ?? 0).toBeLessThanOrEqual(512);
  });
});

describe('visionTokensForModel (Grok)', () => {
  it('prices Grok images by measured megapixel rate, not GPT tiles', () => {
    expect(visionTokensForModel('grok-4.5', 768, 336)).toBe(Math.ceil((768 * 336) / 1000));
    expect(visionTokensForModel('grok-4.5', 764, 980)).toBe(Math.ceil((764 * 980) / 1000));
    expect(visionTokensForModel('grok-4.5', 764, 980)).toBeLessThan(
      openAIVisionTokens('gpt-4o', 764, 980),
    );
  });
});

describe('Grok history compression under default gate', () => {
  it('collapses a short grok-4.6 chat/completions transcript (not just Responses)', async () => {
    // Completions used minCollapsePrefix=10, so a few huge messages never
    // imaged and the dashboard showed ~0 saved. Grok's prefix floor is 1.
    const bulk = 'window 0 train 2024-01-15 test breakout+htf @240m d10 seed 780 bars. ';
    const messages = [
      { role: 'system', content: 'You are a coding agent. '.repeat(200) },
      { role: 'user', content: bulk.repeat(80) },
      { role: 'assistant', content: bulk.repeat(80) },
      { role: 'user', content: bulk.repeat(80) },
      { role: 'assistant', content: bulk.repeat(80) },
      { role: 'user', content: 'continue' },
    ];
    const body = enc.encode(JSON.stringify({ model: 'grok-4.6', messages }));
    const result = await transformOpenAIChatCompletions(body, { minCompressChars: 1 });
    expect(result.info.compressed).toBe(true);
    expect(result.info.historyReason).toBe('collapsed');
    expect(result.info.collapsedImages ?? 0).toBeGreaterThan(0);
    expect(result.info.imageTokens ?? 0).toBeLessThan(result.info.baselineImagedTokens ?? 0);
  });

  it('images most of a large grok-4.6 completions chat, not just the slab', async () => {
    const bulk = 'window 0 train 2024-01-15 test breakout+htf @240m d10 seed 780 bars, eligibility ok. ';
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: 'You are a coding agent. '.repeat(400) },
    ];
    for (let i = 0; i < 6; i++) {
      messages.push({ role: 'user', content: bulk.repeat(80) + ` turn ${i}` });
      messages.push({ role: 'assistant', content: bulk.repeat(80) + ` reply ${i}` });
    }
    messages.push({ role: 'user', content: 'continue' });
    const body = enc.encode(JSON.stringify({ model: 'grok-4.6', messages }));
    const result = await transformOpenAIChatCompletions(body, { minCompressChars: 1 });
    expect(result.info.historyReason).toBe('collapsed');
    expect(result.info.collapsedImages ?? 0).toBeGreaterThan(1);
    const imaged = result.info.baselineImagedTokens ?? 0;
    const sent = result.info.imageTokens ?? 0;
    expect(imaged).toBeGreaterThan(sent * 2);
    expect(result.info.bucketChars?.history ?? 0).toBeGreaterThan(result.info.bucketChars?.static_slab ?? 0);
  });

  it('collapses long Grok Responses history under default charsPerToken (o200k gate)', async () => {
    const items: Array<Record<string, unknown>> = [
      { role: 'user', content: 'start the long autonomous run now please' },
    ];
    for (let i = 0; i < 10; i++) {
      const id = `call_${i}`;
      items.push({ role: 'assistant', content: `Working on step ${i}. `.repeat(40) });
      items.push({ type: 'function_call', call_id: id, name: 'read', arguments: `{"path":"src/f${i}.ts"}` });
      items.push({ type: 'function_call_output', call_id: id, output: (`result ${i} path=/tmp/out${i}.json `).repeat(60) });
    }
    const body = enc.encode(JSON.stringify({
      model: 'grok-4.6',
      instructions: 'You are a careful coding agent. '.repeat(200),
      input: items,
    }));
    const result = await transformOpenAIResponses(body, { minCompressChars: 1 });
    expect(result.info.compressed).toBe(true);
    expect(result.info.historyReason).toBe('collapsed');
    expect(result.info.collapsedImages ?? 0).toBeGreaterThan(0);
    expect(result.info.imageTokens ?? 0).toBeLessThan(result.info.baselineImagedTokens ?? 0);
    // Codex puts an assistant message between tool rounds. pairs would split
    // each round into its own run; mixed packs them so grok-4.6 actually saves.
    expect((result.info.collapsedImages ?? 0)).toBeLessThan(10);
  });

  it('collapses a large Grok history with no profile byte cap in the way', async () => {
    const items: Array<Record<string, unknown>> = [
      { role: 'user', content: 'start the long autonomous run now please' },
    ];
    for (let i = 0; i < 40; i++) {
      const id = `call_${i}`;
      items.push({ role: 'assistant', content: `Working on step ${i}. `.repeat(40) });
      items.push({ type: 'function_call', call_id: id, name: 'read', arguments: `{"path":"src/f${i}.ts"}` });
      items.push({ type: 'function_call_output', call_id: id, output: (`result ${i} path=/tmp/out${i}.json `).repeat(60) });
    }
    const body = enc.encode(JSON.stringify({
      model: 'grok-4.5',
      instructions: 'You are a careful coding agent. '.repeat(200),
      input: items,
    }));
    const result = await transformOpenAIResponses(body, { minCompressChars: 1 });
    expect(result.info.compressed).toBe(true);
    expect(result.info.historyReason).toBe('collapsed');
    expect(result.info.reason).not.toBe('serialized_request_limit');
  });

  it('passes through when an env-configured byte cap would be overshot', async () => {
    const prev = process.env.PXPIPE_GPT_PROFILES;
    process.env.PXPIPE_GPT_PROFILES = JSON.stringify({
      'grok-4.5': { maxSerializedRequestBytes: 128 * 1024 },
    });
    try {
      const items: Array<Record<string, unknown>> = [
        { role: 'user', content: 'start the long autonomous run now please' },
      ];
      for (let i = 0; i < 40; i++) {
        const id = `call_${i}`;
        items.push({ role: 'assistant', content: `Working on step ${i}. `.repeat(40) });
        items.push({ type: 'function_call', call_id: id, name: 'read', arguments: `{"path":"src/f${i}.ts"}` });
        items.push({ type: 'function_call_output', call_id: id, output: (`result ${i} path=/tmp/out${i}.json `).repeat(60) });
      }
      const body = enc.encode(JSON.stringify({
        model: 'grok-4.5',
        instructions: 'You are a careful coding agent. '.repeat(200),
        input: items,
      }));
      const result = await transformOpenAIResponses(body, { minCompressChars: 1 });
      expect(result.info.compressed).toBe(false);
      expect(result.info.reason).toBe('serialized_request_limit');
      expect(result.body.byteLength).toBe(body.byteLength);
    } finally {
      if (prev !== undefined) process.env.PXPIPE_GPT_PROFILES = prev;
      else delete process.env.PXPIPE_GPT_PROFILES;
    }
  });

  it('pages factsheet across long collapsed history so early exact ids survive', async () => {
    const earlyHex = 'a3f9c1e0b7d2';
    const items: Array<Record<string, unknown>> = [
      { role: 'user', content: `remember ${earlyHex} and path src/core/anthropic-vision.ts port 47821` },
    ];
    for (let i = 0; i < 80; i++) {
      const id = `call_${i}`;
      items.push({
        role: 'assistant',
        content: `Working on step ${i} for module src/pkg/mod${i}/handler.ts with checksum ${i.toString(16).padStart(8, '0')}ab. `.repeat(40),
      });
      items.push({ type: 'function_call', call_id: id, name: 'read', arguments: `{"path":"src/f${i}.ts"}` });
      items.push({
        type: 'function_call_output',
        call_id: id,
        output: (`result ${i} path=/tmp/out${i}.json status=ok note=step-${i}-detail `).repeat(80),
      });
    }
    const body = enc.encode(JSON.stringify({
      model: 'grok-4.5',
      instructions: 'Keep identifiers exact. '.repeat(200),
      input: items,
    }));
    const result = await transformOpenAIResponses(body, { minCompressChars: 1 });
    expect(result.info.historyReason).toBe('collapsed');
    const out = JSON.parse(dec.decode(result.body)) as { input: Array<Record<string, unknown>> };
    const serialized = JSON.stringify(out.input);
    expect(serialized).toContain(earlyHex);
    expect(serialized).toContain('47821');
  });
});
