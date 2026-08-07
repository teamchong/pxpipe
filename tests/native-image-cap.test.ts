/**
 * The provider's image cap is a property of the WIRE, not of pxpipe: it counts
 * the client's own images (screenshots, pasted pictures, images a tool already
 * returned) together with every image pxpipe adds. Pricing only our own is what
 * let a request carrying 100+ client images get imaged further and come back
 * 400/500 — a session the user then could not resume at all.
 *
 * These tests pin the two halves of the fix:
 *   1. `countNativeImages` sees the client's images, at both nesting levels,
 *   2. once they fill the cap, every pxpipe imaging path degrades to text
 *      instead of adding one more image block.
 *
 * Run just this file:  pnpm vitest run tests/native-image-cap.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  countNativeImages,
  imageHeadroom,
  transformRequest,
} from '../src/core/transform.js';
import { ANTHROPIC_MAX_IMAGES } from '../src/core/history.js';
import { resetSessionState } from '../src/core/session-state.js';
import type { Message } from '../src/core/types.js';

const big = (n: number) => 'x'.repeat(n);

const img = () => ({
  type: 'image' as const,
  source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'iVBORw0KGgo=' },
});

function enc(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}
function dec(b: Uint8Array): any {
  return JSON.parse(new TextDecoder().decode(b));
}

/** Every image on the wire, at both nesting levels — the number the provider counts. */
function wireImages(msgs: Message[]): number {
  let n = 0;
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as any[]) {
      if (b?.type === 'image') n++;
      else if (b?.type === 'tool_result' && Array.isArray(b.content)) {
        for (const ib of b.content) if (ib?.type === 'image') n++;
      }
    }
  }
  return n;
}

/** A user turn holding `n` client images, as Claude Code sends pasted screenshots. */
function clientImages(n: number): Message {
  return { role: 'user', content: Array.from({ length: n }, img) };
}

/** A tool_result big enough that pxpipe would normally image it. */
function toolResult(id: string, chars = 40_000): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: `RESULT ${id}\n` + big(chars) }],
  } as unknown as Message;
}

describe('countNativeImages — what the client already put on the wire', () => {
  it('counts top-level image blocks', () => {
    expect(countNativeImages([clientImages(7)])).toBe(7);
  });

  it('counts images nested inside tool_result content', () => {
    const msgs = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: [img(), { type: 'text', text: 'hi' }, img()] }],
      },
    ] as unknown as Message[];
    expect(countNativeImages(msgs)).toBe(2);
  });

  it('ignores string content and is safe on empty/absent input', () => {
    expect(countNativeImages([{ role: 'user', content: 'plain text' }])).toBe(0);
    expect(countNativeImages([])).toBe(0);
    expect(countNativeImages(undefined)).toBe(0);
  });
});

describe('imageHeadroom — the client’s images spend from the same budget', () => {
  it('subtracts ours and theirs alike', () => {
    const a = imageHeadroom({ imageCount: 0, nativeImages: 0 } as any);
    const b = imageHeadroom({ imageCount: 10, nativeImages: 0 } as any);
    const c = imageHeadroom({ imageCount: 0, nativeImages: 10 } as any);
    expect(b).toBe(a - 10);
    expect(c).toBe(a - 10); // a client image costs exactly what one of ours costs
    expect(a).toBeLessThan(ANTHROPIC_MAX_IMAGES); // safety margin is applied
  });

  it('never goes negative — an over-full request reports zero, not a deficit', () => {
    expect(imageHeadroom({ imageCount: 0, nativeImages: 500 } as any)).toBe(0);
  });
});

describe('tool_result imaging respects the client’s images', () => {
  beforeEach(() => resetSessionState());

  // Positive control. tool_result imaging only runs on the main path, so the
  // request needs a system slab above the compress gate — the same shape real
  // Claude Code traffic has.
  const withSlab = (messages: Message[]) =>
    enc({ model: 'claude-3-5-sonnet', system: [{ type: 'text', text: 'SLAB\n' + big(30_000) }], messages });

  it('images a big tool_result when the wire is empty', async () => {
    const { body: out, info } = await transformRequest(
      withSlab([{ role: 'user', content: 'go' }, toolResult('t1')]),
    );
    expect(info.nativeImages).toBe(0);
    expect(info.toolResultImgs ?? 0).toBeGreaterThan(0);
    expect(wireImages(dec(out).messages)).toBeGreaterThan(0);
  });

  it('leaves the same tool_result as text when the client already filled the cap', async () => {
    const { body: out, info } = await transformRequest(
      withSlab([clientImages(ANTHROPIC_MAX_IMAGES), toolResult('t1')]),
    );

    expect(info.nativeImages).toBe(ANTHROPIC_MAX_IMAGES);
    // Nothing was added: the only images on the wire are the client's own.
    expect(wireImages(dec(out).messages)).toBe(ANTHROPIC_MAX_IMAGES);
    expect(info.imageBudgetSkips ?? 0).toBeGreaterThan(0);
    expect(info.passthroughReasons?.image_budget ?? 0).toBeGreaterThan(0);
    // The text survived — degrading must not drop content.
    expect(JSON.stringify(dec(out).messages)).toContain('RESULT t1');
  });

  it('never exceeds the cap when the client sits just under it', async () => {
    const near = ANTHROPIC_MAX_IMAGES - 3;
    const { body: out } = await transformRequest(
      withSlab([clientImages(near), toolResult('t1'), toolResult('t2'), toolResult('t3')]),
    );
    expect(wireImages(dec(out).messages)).toBeLessThanOrEqual(ANTHROPIC_MAX_IMAGES);
  });
});

describe('the cap is quantitative, not boolean', () => {
  beforeEach(() => resetSessionState());

  // The first cut of this guard asked "is there ANY room left?" and then emitted
  // a whole multi-page slab into it: 94 client images + a 400k system slab put
  // 109 images on the wire — still a hard reject, just a rarer one. Every path
  // must fit its actual page count, not merely find a nonzero headroom.
  it.each([
    [94, 400_000],
    [90, 400_000],
    [80, 800_000],
  ])('stays at or under the cap with %i client images and a %i-char slab', async (clients, slabChars) => {
    const body = enc({
      model: 'claude-3-5-sonnet',
      system: [{ type: 'text', text: 'SLAB\n' + big(slabChars) }],
      messages: [clientImages(clients), { role: 'user', content: 'hi ' + big(200) }],
    });
    const { body: out } = await transformRequest(body);
    expect(wireImages(dec(out).messages)).toBeLessThanOrEqual(ANTHROPIC_MAX_IMAGES);
  });

  it('spends nothing at all when the slab cannot fit whole', async () => {
    const body = enc({
      model: 'claude-3-5-sonnet',
      system: [{ type: 'text', text: 'SLAB\n' + big(400_000) }],
      messages: [clientImages(90), { role: 'user', content: 'hi ' + big(200) }],
    });
    const { info } = await transformRequest(body);
    // All-or-nothing: a half-imaged slab would re-key the cache prefix on every
    // turn whose client-image count moved.
    expect(info.imageCount).toBe(0);
    expect(info.reason).toMatch(/^image_budget/);
  });
});

describe('wireImages — what the provider actually counts', () => {
  beforeEach(() => resetSessionState());

  // The render counter and the wire disagree whenever the history collapse
  // absorbs a message that already carried one of our images: the message is
  // replaced wholesale, so the image inside it is never sent. Telemetry that
  // reads imageCount therefore over-reports, and any headroom math that trusts
  // it under-uses the budget.
  it('reports the outgoing body, not the render count, on a tool-heavy shape', async () => {
    const msgs: any[] = [{ role: 'user', content: 'ANCHOR ' + big(200) }];
    for (let i = 0; i < 60; i++) {
      msgs.push({ role: 'assistant', content: `turn ${i}: ` + big(4000) });
      msgs.push(
        i % 3 === 0
          ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' + i, content: 'RES\n' + big(90_000) }] }
          : { role: 'user', content: `reply ${i}: ` + big(2000) },
      );
    }
    const { body: out, info } = await transformRequest(
      enc({ model: 'claude-opus-5', system: [{ type: 'text', text: 'SLAB\n' + big(50_000) }], messages: msgs }),
    );

    const actual = wireImages(dec(out).messages);
    expect(info.wireImages).toBe(actual);
    // This assertion used to read `imageCount > actual` — "we rendered materially
    // more than we shipped" — and on this shape it measured 95 rendered against 27
    // shipped. That gap was not a design property. It was tool_result imaging
    // running before the history collapse: 68 of those renders were thrown away
    // with the messages that absorbed them, and the tool output inside them
    // reached the wire in no form at all. With the stages ordered so the collapse
    // sees original text, the same fixture measures 92 rendered and 92 shipped.
    // A gap reappearing here now means renders are being discarded again.
    expect(info.imageCount!).toBe(actual - (info.nativeImages ?? 0));
    expect(actual).toBeLessThanOrEqual(ANTHROPIC_MAX_IMAGES);
  });

  it('agrees with the render count when nothing is absorbed', async () => {
    const { body: out, info } = await transformRequest(
      enc({
        model: 'claude-3-5-sonnet',
        system: [{ type: 'text', text: 'SLAB\n' + big(30_000) }],
        messages: [clientImages(2), { role: 'user', content: 'hi' }],
      }),
    );
    expect(info.wireImages).toBe(wireImages(dec(out).messages));
    expect(info.wireImages).toBe((info.imageCount ?? 0) + (info.nativeImages ?? 0));
  });
});
