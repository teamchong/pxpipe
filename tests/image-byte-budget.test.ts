/**
 * DECODED IMAGE BYTES are a second budget, and the count cap does not stand in
 * for them.
 *
 * The provider's documented limit is 100 images, and pxpipe enforced only that.
 * A long session can assemble a request that is legal by count and fails by
 * weight: production traffic degrades sharply somewhere around 20 MiB, and it
 * degrades as 500s, 502s, empty 200s and stalls, which read as flakiness rather
 * than as "too big" (#157). `/compact` traverses the same oversized path, so the
 * session cannot recover by compacting either.
 *
 * Two properties matter more than the exact ceiling:
 *
 *  - admission is atomic per semantic group. A group is imaged whole or kept as
 *    text whole, because half a group ships pages without the text they replaced;
 *  - the caller's own images are counted first and never removed. A user's
 *    screenshot outranks our compression.
 *
 * Run just this file:  pnpm vitest run tests/image-byte-budget.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collapseHistory,
} from '../src/core/history.js';
import {
  countNativeImageBytes,
  imageByteHeadroom,
  transformRequest,
} from '../src/core/transform.js';
import { resetSessionState } from '../src/core/session-state.js';
import type { Message } from '../src/core/types.js';

const big = (n: number) => 'x'.repeat(n);
const enc = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));
const dec = (b: Uint8Array): any => JSON.parse(new TextDecoder().decode(b));

/** A caller image whose decoded payload is about `bytes` long. */
function callerImage(bytes: number) {
  const b64Chars = Math.ceil(bytes / 3) * 4;
  return {
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: 'image/png' as const,
      data: 'A'.repeat(b64Chars),
    },
  };
}

function toolResult(id: string, chars = 40_000): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: `RESULT ${id}\n` + big(chars) }],
  } as unknown as Message;
}

function withSlab(messages: Message[], slabChars = 60_000) {
  return enc({
    model: 'claude-3-5-sonnet',
    system: [{ type: 'text', text: 'SLAB\n' + big(slabChars) }],
    messages,
  });
}

/** Total decoded image bytes actually on the wire, at both nesting levels. */
function wireImageBytes(msgs: any[]): number {
  let total = 0;
  const add = (b: any): void => {
    if (b?.type === 'image' && typeof b.source?.data === 'string') {
      const d = b.source.data as string;
      const pad = d.endsWith('==') ? 2 : d.endsWith('=') ? 1 : 0;
      total += Math.floor((d.length * 3) / 4) - pad;
    }
  };
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      add(b);
      if (b?.type === 'tool_result' && Array.isArray(b.content)) for (const ib of b.content) add(ib);
    }
  }
  return total;
}

describe('counting what the caller already spent', () => {
  it('sees caller images at both nesting levels', () => {
    const msgs = [
      { role: 'user', content: [callerImage(3_000)] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: [callerImage(6_000)] }],
      },
    ] as unknown as Message[];
    const counted = countNativeImageBytes(msgs);
    expect(counted).toBeGreaterThan(8_800);
    expect(counted).toBeLessThan(9_200);
  });

  it('is safe on absent, empty and string content', () => {
    expect(countNativeImageBytes(undefined)).toBe(0);
    expect(countNativeImageBytes([])).toBe(0);
    expect(countNativeImageBytes([{ role: 'user', content: 'plain' }])).toBe(0);
  });

  it('deducts caller bytes from the headroom, and never reports a deficit', () => {
    const info = { imageBytes: 100, nativeImageBytes: 400 } as any;
    expect(imageByteHeadroom(info, 1_000)).toBe(500);
    expect(imageByteHeadroom(info, 100)).toBe(0);
  });
});

describe('a group that does not fit keeps its text', () => {
  beforeEach(() => resetSessionState());

  it('skips the slab whole rather than imaging part of it', async () => {
    const { body: out, info } = await transformRequest(
      withSlab([{ role: 'user', content: 'go' }]),
      { maxImageBytes: 1_000 },
    );
    // Nothing imaged at all: the slab is part of the cache prefix, so a partial
    // slab would re-key that prefix whenever the budget arithmetic moved.
    expect(info.imageCount).toBe(0);
    expect(info.reason).toMatch(/^image_bytes/);
    expect(JSON.stringify(dec(out))).toContain('SLAB');
  });

  it('keeps a tool_result as text when its pages do not fit', async () => {
    // Measured on this fixture: the slab renders to 12,683 bytes and the
    // tool_result group to about 6,358 more. A budget between the two admits the
    // slab and leaves the tool group without room, which is the case worth
    // pinning: partial admission is what must not happen.
    const { body: out, info } = await transformRequest(
      withSlab([{ role: 'user', content: 'go' }, toolResult('t1')]),
      { maxImageBytes: 15_000 },
    );
    expect(info.imageCount ?? 0).toBeGreaterThan(0); // the slab was admitted
    expect(info.toolResultImgs ?? 0).toBe(0); // the tool group was not
    expect(info.imageByteSkips ?? 0).toBeGreaterThan(0);
    // Degrading must never drop content.
    expect(JSON.stringify(dec(out).messages)).toContain('RESULT t1');
  });

  it('stays within the budget it was given', async () => {
    const limit = 15_000;
    const { body: out } = await transformRequest(
      withSlab([{ role: 'user', content: 'go' }, toolResult('t1'), toolResult('t2')]),
      { maxImageBytes: limit },
    );
    expect(wireImageBytes(dec(out).messages)).toBeLessThanOrEqual(limit);
  });
});

describe('history is trimmed before its configured geometry is degraded (#216)', () => {
  // History uses a model-specific readable profile on purpose: a misread prior
  // turn compounds. When the full collapse is too heavy, keep the oldest chunks
  // in that profile and leave the rest as text instead of swapping geometry.
  const TURNS = 100;
  const REP = 50;
  const IMAGED_SLAB_CHARS = 12_000; // above minCompressChars -> slab is imaged (site: transformRequest inline)
  const TINY_SLAB_CHARS = 50; // below minCompressChars -> slab stays text (site: runHistoryCollapseAndFinalize)
  const HUGE_BUDGET = 100 * 1024 * 1024; // never binds; used only to measure the render size
  const MODEL = 'claude-opus-5';
  const BUDGET_DIVISOR = 2;
  const NO_IMAGE_BUDGET = 1;
  const OVER_CAP_USER_TEXT_CHARS = 2_000;

  beforeEach(() => {
    resetSessionState();
    process.env.PXPIPE_MODELS = MODEL;
  });
  afterEach(() => {
    delete process.env.PXPIPE_MODELS;
  });

  /** A long collapsible history behind a slab of the given size. */
  function longHistory(model: string, slabChars: number): Uint8Array {
    const bulk =
      'commit a1b2c3d4e5f6 sha 9f8e7d6c ts 2026-07-04T14:50:50Z ratio 0.734 $30.99 Tampa-0 stock 120 reorder 40. ';
    const messages: unknown[] = [];
    for (let i = 0; i < TURNS; i++) {
      messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: bulk.repeat(REP) + ` turn ${i}` }],
      });
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: 'continue' }] });
    return enc({
      model,
      max_tokens: 1024,
      system: [{ type: 'text', text: 'S'.repeat(slabChars), cache_control: { type: 'ephemeral' } }],
      messages,
    });
  }

  async function render(slabChars: number, maxImageBytes: number) {
    resetSessionState();
    return transformRequest(longHistory(MODEL, slabChars), { model: MODEL, maxImageBytes });
  }

  // Both admission sites share the bug; exercise each. Site 2 is the inline path
  // in transformRequest (slab imaged); site 1 is runHistoryCollapseAndFinalize
  // (slab below the gate, history still collapses — the "tiny system, huge
  // messages" shape).
  for (const [siteLabel, slabChars] of [
    ['imaged-slab path', IMAGED_SLAB_CHARS],
    ['text-slab path', TINY_SLAB_CHARS],
  ] as const) {
    it(`keeps a byte-fitted prefix at the configured history geometry (${siteLabel})`, async () => {
      const full = (await render(slabChars, HUGE_BUDGET)).info;
      expect(full.historyReason, 'fixture must collapse at configured geometry').toBe('collapsed');
      const budget = Math.floor(full.imageBytes / BUDGET_DIVISOR);
      const { info } = await render(slabChars, budget);

      expect(info.historyReason).toBe('collapsed');
      expect(info.historyBudgetTrimmed).toBe(true);
      expect(info.collapsedTurns).toBeGreaterThan(0);
      expect(info.collapsedTurns).toBeLessThan(full.collapsedTurns ?? 0);
      expect(info.imageByteSkips ?? 0).toBe(0);
      expect(info.imageBytes).toBeLessThanOrEqual(budget);
      expect(info.outgoingTextChars).toBeGreaterThan(full.outgoingTextChars ?? 0);

      const historyImages = (info.imagePngs ?? []).slice(-(info.collapsedImages ?? 0));
      const fullHistoryImages = (full.imagePngs ?? []).slice(-(full.collapsedImages ?? 0));
      expect(historyImages).toEqual(fullHistoryImages.slice(0, historyImages.length));
    });
  }

  it('keeps text when even the oldest history chunk cannot fit', async () => {
    const { info } = await render(TINY_SLAB_CHARS, NO_IMAGE_BUDGET);
    expect(info.historyReason).toBe('image_bytes');
    expect(info.imageByteSkips ?? 0).toBeGreaterThan(0);
    expect(info.collapsedTurns ?? 0).toBe(0);
  });

  it('admits a marked user-only chunk when its image fits', async () => {
    const markedUser = {
      role: 'user',
      content: [{
        type: 'text',
        text: 'u'.repeat(OVER_CAP_USER_TEXT_CHARS),
        cache_control: { type: 'ephemeral' },
      }],
    } as unknown as Message;
    const messages = [markedUser, { role: 'assistant', content: 'answer' }] as Message[];
    const { info } = await collapseHistory(messages, () => true, {
      keepTail: 0,
      minCollapsePrefix: 1,
      collapseChunk: 0,
      imageByteBudget: HUGE_BUDGET,
    });

    expect(info.collapsedTurns).toBe(messages.length);
    expect(info.collapsedImages).toBeGreaterThan(0);
  });
});

describe('the caller outranks us', () => {
  beforeEach(() => resetSessionState());

  it('never removes a caller image to make room', async () => {
    const before = callerImage(30_000);
    const { body: out, info } = await transformRequest(
      withSlab([
        { role: 'user', content: [before] } as unknown as Message,
        { role: 'user', content: 'go' },
      ]),
      { maxImageBytes: 32_000 },
    );
    expect(info.nativeImageBytes ?? 0).toBeGreaterThan(29_000);
    // The caller's image is still on the wire, and we added nothing on top.
    const wire = dec(out).messages;
    expect(wireImageBytes(wire)).toBeGreaterThan(29_000);
    expect(info.imageCount).toBe(0);
  });
});

describe('telemetry distinguishes the two ceilings', () => {
  beforeEach(() => resetSessionState());

  it('reports a byte skip, not a count skip, when weight is what ran out', async () => {
    const { info } = await transformRequest(
      withSlab([{ role: 'user', content: 'go' }, toolResult('t1')]),
      { maxImageBytes: 15_000 },
    );
    // Five images is far under the 100-image cap, so nothing here is a count
    // problem. The two ceilings need different fixes and must not be conflated.
    expect(info.imageByteSkips ?? 0).toBeGreaterThan(0);
    expect(info.imageBudgetSkips ?? 0).toBe(0);
  });

  it('warns before the next turn walks into the wall', async () => {
    const { info } = await transformRequest(withSlab([{ role: 'user', content: 'go' }]), {
      // The slab measures 12,683 bytes, so a 14,000-byte budget admits it at
      // about 91% full: nothing is dropped this turn, and the next one will be.
      maxImageBytes: 14_000,
    });
    expect(info.imageCount ?? 0).toBeGreaterThan(0);
    expect(info.imageBytesNearLimit).toBe(true);
  });
});
