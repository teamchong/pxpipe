import { describe, expect, it } from 'vitest';
import { transformRequest } from '../src/core/transform.js';
import type { Message } from '../src/core/types.js';
import { renderRecentFragment } from '../src/dashboard/fragments.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytes(value: unknown): Uint8Array {
  return enc.encode(JSON.stringify(value));
}

function denseLines(prefix: string, count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `${prefix} ${i.toString(16).padStart(6, '0')} alpha beta gamma delta`,
  ).join('\n');
}

describe('Anthropic rendered-image byte budget', () => {
  it('counts caller images and admits a slab only at the exact combined boundary', async () => {
    const nativeImage = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AQIDBA==' },
    } as const;
    const original = bytes({
      model: 'claude-fable-5',
      system: [nativeImage, { type: 'text', text: denseLines('instruction', 2500) }],
      messages: [{ role: 'user', content: 'continue' }],
    });
    const options = { collapseHistory: false } as const;
    const measured = await transformRequest(original, options);

    expect(measured.info.inputImageBytes).toBe(4);
    expect(measured.info.imageBytes).toBeGreaterThan(0);
    const exactLimit = 4 + measured.info.imageBytes;

    const exact = await transformRequest(original, { ...options, maxImageBytes: exactLimit });
    expect(exact.info.compressed).toBe(true);
    expect(exact.info.inputImageBytes).toBe(4);
    expect(exact.info.imageBytes).toBe(measured.info.imageBytes);
    expect(exact.info.imageBudgetOutcome).toBe('within_budget');

    const oneByteShort = await transformRequest(original, {
      ...options,
      maxImageBytes: exactLimit - 1,
    });
    expect(oneByteShort.body).toEqual(original);
    expect(oneByteShort.info.compressed).toBe(false);
    expect(oneByteShort.info.inputImageBytes).toBe(4);
    expect(oneByteShort.info.imageBytes).toBe(0);
    expect(oneByteShort.info.imageBudgetOutcome).toBe('degraded');
  });

  it('counts caller images in messages and nested tool results', async () => {
    const image = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AQIDBA==' },
    } as const;
    const original = bytes({
      model: 'claude-fable-5',
      system: [image, { type: 'text', text: 'short' }],
      messages: [{
        role: 'user',
        content: [image, { type: 'tool_result', tool_use_id: 'tool-1', content: [image] }],
      }],
    });

    const result = await transformRequest(original, { collapseHistory: false });
    expect(result.info.inputImageBytes).toBe(12);
  });

  it('flags caller images that already exceed the budget without deleting them', async () => {
    const image = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AQIDBA==' },
    } as const;
    const original = bytes({
      model: 'claude-fable-5',
      system: 'short',
      messages: [{ role: 'user', content: [image] }],
    });

    const result = await transformRequest(original, {
      collapseHistory: false,
      maxImageBytes: 3,
    });
    expect(result.body).toEqual(original);
    expect(result.info.inputImageBytes).toBe(4);
    expect(result.info.imageBytes).toBe(0);
    expect(result.info.imageByteBudget).toBe(3);
    expect(result.info.imageBudgetOutcome).toBe('degraded');
    expect(result.info.imageBudgetSkippedBlocks).toBeUndefined();
  });

  it('keeps an oversized static slab byte-identical as text', async () => {
    const original = bytes({
      model: 'claude-fable-5',
      system: denseLines('instruction', 2500),
      messages: [{ role: 'user', content: 'continue' }],
    });

    const result = await transformRequest(original, {
      maxImageBytes: 1,
      collapseHistory: false,
    });

    expect(result.body).toEqual(original);
    expect(result.info.compressed).toBe(false);
    expect(result.info.imageBytes).toBe(0);
    expect(result.info.imageByteBudget).toBe(1);
    expect(result.info.imageBudgetOutcome).toBe('degraded');
    expect(result.info.imageBudgetSkippedBlocks).toBe(1);
    expect(result.info.imageBudgetSkippedBytes).toBeGreaterThan(1);
    expect(result.info.passthroughReasons?.image_budget).toBe(1);
  });

  it('keeps the next tool result as text when the static slab used the budget', async () => {
    const rawToolResult = denseLines('tool output', 1800);
    const original = bytes({
      model: 'claude-fable-5',
      system: denseLines('instruction', 2500),
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: rawToolResult }],
      }],
    });
    const baseOptions = {
      collapseHistory: false,
      minToolResultChars: 1,
      charsPerToken: 1,
    } as const;
    const staticOnly = await transformRequest(original, {
      ...baseOptions,
      compressToolResults: false,
    });
    expect(staticOnly.info.imageBytes).toBeGreaterThan(0);

    const bounded = await transformRequest(original, {
      ...baseOptions,
      maxImageBytes: staticOnly.info.imageBytes,
    });
    const parsed = JSON.parse(dec.decode(bounded.body));
    const toolResult = parsed.messages
      .flatMap((message: { content?: unknown }) => Array.isArray(message.content) ? message.content : [])
      .find((block: { type?: string }) => block.type === 'tool_result');

    expect(bounded.info.compressed).toBe(true);
    expect(bounded.info.imageBytes).toBe(staticOnly.info.imageBytes);
    expect(bounded.info.imageBudgetOutcome).toBe('degraded');
    expect(bounded.info.toolResultImgs).toBeUndefined();
    expect(toolResult.content).toBe(rawToolResult);
  });

  it('leaves long history native so a compaction request has a text escape hatch', async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 15; i++) {
      const content = `turn ${i}: ${denseLines('history', 90)}`;
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content });
    }
    const original = bytes({
      model: 'claude-fable-5',
      system: 'short system text',
      messages,
    });

    const result = await transformRequest(original, { maxImageBytes: 1 });

    expect(result.body).toEqual(original);
    expect(result.info.compressed).toBe(false);
    expect(result.info.historyReason).toBe('image_budget');
    expect(result.info.imageBudgetOutcome).toBe('degraded');
    expect(result.info.imageBytes).toBe(0);
  });

  it('surfaces budget degradation in the recent-request dashboard', () => {
    const html = renderRecentFragment({
      recent: [{
        ts: Date.now() / 1000,
        method: 'POST',
        path: '/v1/messages',
        status: 200,
        compressed: false,
        image_bytes: 0,
        image_byte_budget: 18 * 1024 * 1024,
        image_budget_degraded: true,
      }],
      has_preview: false,
      preview_meta: '',
    });

    expect(html).toContain('>budget</span>');
    expect(html).toContain('stayed as text');
  });

  it('warns near the budget and exposes serialized wire size in the dashboard', () => {
    const html = renderRecentFragment({
      recent: [{
        ts: Date.now() / 1000,
        method: 'POST',
        path: '/v1/messages',
        status: 200,
        compressed: true,
        cc_added: 1,
        image_bytes: 17 * 1024 * 1024,
        input_image_bytes: 0,
        image_byte_budget: 18 * 1024 * 1024,
        serialized_request_bytes: 23 * 1024 * 1024,
      }],
      has_preview: false,
      preview_meta: '',
    });

    expect(html).toContain('>near budget</span>');
    expect(html).toContain('23.0 MiB serialized request');
  });

  it('shows budget and wire-byte details for a caller-only oversized request', () => {
    const html = renderRecentFragment({
      recent: [{
        ts: Date.now() / 1000,
        method: 'POST',
        path: '/v1/messages',
        status: 200,
        compressed: false,
        image_bytes: 0,
        input_image_bytes: 19 * 1024 * 1024,
        image_byte_budget: 18 * 1024 * 1024,
        image_budget_degraded: true,
        serialized_request_bytes: 26 * 1024 * 1024,
      }],
      has_preview: false,
      preview_meta: '',
    });

    expect(html).toContain('>budget</span>');
    expect(html).toContain('19.0 MiB of 18.0 MiB image-byte budget');
    expect(html).toContain('26.0 MiB serialized request');
  });
});
