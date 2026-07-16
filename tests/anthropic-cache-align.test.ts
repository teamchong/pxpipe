/**
 * Anthropic cache-control CONTRACT (TDD).
 *
 * Encodes the invariants we agreed on for the Anthropic /v1/messages path.
 * Some of these pin behaviour that already holds; some are EXPECTED-FAIL today
 * and define the work (append-only byte-stability + mark alignment).
 *
 * Run just this file:  pnpm vitest run tests/anthropic-cache-align.test.ts
 */
import { describe, expect, it } from 'vitest';
import { collapseHistory } from '../src/core/history.js';
import { transformRequest } from '../src/core/transform.js';
import { countCacheControlMarkers } from '../src/core/measurement.js';
import type { Message } from '../src/core/types.js';

const yes = () => true;
const big = (n: number) => 'x'.repeat(n);

function asst(content: Message['content']): Message {
  return { role: 'assistant', content };
}
function usr(content: Message['content']): Message {
  return { role: 'user', content };
}
function enc(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}
function dec(b: Uint8Array): any {
  return JSON.parse(new TextDecoder().decode(b));
}
function imagesOf(msgs: Message[]): any[] {
  // the synthetic history message holds the image blocks
  const out: any[] = [];
  for (const m of msgs) {
    if (Array.isArray(m.content)) {
      for (const b of m.content as any[]) if (b?.type === 'image') out.push(b);
    }
  }
  return out;
}

/** N closed plain turns, each `chars` long. */
function convo(n: number, chars = 3500): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i++) {
    const body = `turn ${i}: ` + big(chars);
    out.push(i % 2 === 0 ? usr(body) : asst(body));
  }
  return out;
}

describe('Anthropic cache contract — invariants that should already hold', () => {
  it('never adds a cache_control marker (out count <= in count)', async () => {
    const msgs = convo(15);
    const body = enc({
      model: 'claude-3-5-sonnet',
      system: [{ type: 'text', text: big(80_000), cache_control: { type: 'ephemeral' } }],
      messages: msgs,
    });
    const inMarks = countCacheControlMarkers(body);
    const { body: out } = await transformRequest(body);
    const outMarks = countCacheControlMarkers(out);
    expect(outMarks).toBeLessThanOrEqual(inMarks);
  });

  it('relocates the single slab marker onto an IMAGE block (not lost, not duplicated)', async () => {
    const msgs = convo(15);
    const body = enc({
      model: 'claude-3-5-sonnet',
      system: [{ type: 'text', text: big(80_000), cache_control: { type: 'ephemeral' } }],
      messages: msgs,
    });
    const { body: out } = await transformRequest(body);
    expect(countCacheControlMarkers(out)).toBe(1); // exactly one, conserved
  });

  it('keeps the last 4 turns as live text (keepTail)', async () => {
    const msgs = convo(15);
    const { messages } = await collapseHistory(msgs, yes, { protectedPrefix: 1 });
    // tail = last 4 original turns, preserved verbatim at the end
    const tail = messages.slice(-4);
    expect(tail.map((m) => m.content)).toEqual(msgs.slice(-4).map((m) => m.content));
  });

  it('never splits a tool_use from its tool_result across the image boundary', async () => {
    // Put an OPEN tool_use right at the would-be boundary; closed prefix must
    // pull back so the pair is never separated.
    const msgs: Message[] = [];
    for (let i = 0; i < 11; i++) msgs.push(i % 2 ? asst(big(3500)) : usr(big(3500)));
    msgs.push(asst([{ type: 'tool_use', id: 'OPEN', name: 't', input: {} } as any]));
    msgs.push(usr('still flowing, no tool_result yet'));
    const { info } = await collapseHistory(msgs, yes, { protectedPrefix: 1, keepTail: 0, collapseChunk: 0 });
    // boundary stops before the open tool_use → it stays in the live tail
    expect(info.collapsedTurns).toBeLessThanOrEqual(11);
  });

  it('is deterministic — same input twice = identical image bytes', async () => {
    const a = await collapseHistory(convo(20), yes, { protectedPrefix: 1 });
    const b = await collapseHistory(convo(20), yes, { protectedPrefix: 1 });
    expect(JSON.stringify(imagesOf(a.messages))).toBe(JSON.stringify(imagesOf(b.messages)));
  });
});

describe('Anthropic cache contract — our agreed model (EXPECTED FAIL today)', () => {
  it('APPEND-ONLY: earlier history image stays byte-identical as the conversation grows past a chunk boundary', async () => {
    // Conversation P, then P + more turns that advance the collapse boundary.
    // The frozen earlier chunk's FIRST image must be byte-identical in both —
    // otherwise old cached prefix re-writes every time the boundary moves.
    const p = await collapseHistory(convo(20), yes, { protectedPrefix: 1 });
    const pPlus = await collapseHistory(convo(70), yes, { protectedPrefix: 1 });
    const firstP = imagesOf(p.messages)[0];
    const firstPlus = imagesOf(pPlus.messages)[0];
    expect(firstP).toBeDefined();
    expect(firstPlus).toBeDefined();
    expect(JSON.stringify(firstPlus)).toBe(JSON.stringify(firstP));
  });

  it('ALIGN: a caller cache_control marker placed mid-history is preserved (image boundary aligns to the mark)', async () => {
    const msgs = convo(15);
    // caller marks the END of an early segment (index 6) — a roaming breakpoint
    (msgs[6] as any).content = [
      { type: 'text', text: (msgs[6].content as string), cache_control: { type: 'ephemeral' } },
    ];
    const body = enc({
      model: 'claude-3-5-sonnet',
      system: [{ type: 'text', text: big(80_000), cache_control: { type: 'ephemeral' } }],
      messages: msgs,
    });
    const inMarks = countCacheControlMarkers(body); // 2: slab + mid-history
    const { body: out } = await transformRequest(body);
    // Contract: the mid-history mark is not silently dropped — both segments
    // remain independently cacheable, so the count is conserved (== 2), and the
    // image set has a boundary at that mark.
    expect(countCacheControlMarkers(out)).toBe(inMarks);
  });
});

describe('Anthropic cache contract — gate never produces negative savings', () => {
  it('tiny prefix is not profitable (no image emitted)', async () => {
    const msgs = convo(15, 30); // 30 chars/turn → trivially below the gate
    const { info } = await collapseHistory(msgs, (t) => t.length > 8000, { protectedPrefix: 1 });
    expect(info.reason).toBe('not_profitable');
    expect(info.collapsedImages ?? 0).toBe(0);
  });

  it('large prefix is profitable (image emitted)', async () => {
    const msgs = convo(15, 3500);
    const { info } = await collapseHistory(msgs, (t) => t.length > 8000, { protectedPrefix: 1 });
    // collapseHistory leaves `reason` undefined on success (the 'collapsed'
    // sentinel is applied later in transform.ts). Success = images emitted.
    expect(info.reason).toBeUndefined();
    expect(info.collapsedImages ?? 0).toBeGreaterThanOrEqual(1);
  });
});

describe('Anthropic cache contract — #95 scope:"global" must not survive relocation', () => {
  function emittedMarkers(req: any): any[] {
    const out: any[] = [];
    const visit = (blocks: unknown) => {
      if (!Array.isArray(blocks)) return;
      for (const b of blocks as any[]) {
        if (b && typeof b === 'object' && b.cache_control != null) out.push(b.cache_control);
        if (b && typeof b === 'object' && Array.isArray(b.content)) visit(b.content); // tool_result inner blocks
      }
    };
    visit(req.system);
    for (const m of req.messages ?? []) visit(m.content);
    return out;
  }

  it('multi-page slab: relocated marker drops scope, keeps type/ttl, never adds markers', async () => {
    const body = enc({
      model: 'claude-3-5-sonnet',
      system: [
        {
          type: 'text',
          text: big(300_000),
          cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' },
        },
      ],
      messages: convo(15),
    });
    const inMarks = countCacheControlMarkers(body);
    const { body: out } = await transformRequest(body);
    expect(countCacheControlMarkers(out)).toBeLessThanOrEqual(inMarks);

    const req = dec(out);
    const marks = emittedMarkers(req);
    // Pages 1..N-1 of a slab run are unmarked, so any surviving scope:"global"
    // violates Anthropic's every-preceding-block-globally-scoped rule → 400.
    for (const cc of marks) expect(cc.scope).toBeUndefined();
    // The marker itself is conserved (relocated, not dropped) with type/ttl intact.
    expect(marks.length).toBeGreaterThanOrEqual(1);
    expect(marks).toContainEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('marker without scope passes through relocation unchanged (identity)', async () => {
    const body = enc({
      model: 'claude-3-5-sonnet',
      system: [
        { type: 'text', text: big(80_000), cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      messages: convo(15),
    });
    const { body: out } = await transformRequest(body);
    const marks = emittedMarkers(dec(out));
    expect(marks).toContainEqual({ type: 'ephemeral', ttl: '1h' });
    for (const cc of marks) expect(cc.scope).toBeUndefined();
  });
});
