/**
 * Tests for E15 (2026-07-07): the `guardLastTurns` last-K-turns guard.
 *
 * Contract being verified:
 *   - "Turn" = 1 message (matches `HISTORY_DEFAULTS.keepTail` in history.ts).
 *   - Baseline (guard disabled, `guardLastTurns: 0`): a fresh, last-message
 *     tool_result big enough to clear the profitability gate DOES get imaged —
 *     this is the naive-compression bug E15 exists to prevent.
 *   - Default (`guardLastTurns: 4`, i.e. option omitted): that same fresh
 *     tool_result stays byte-identical text, `info.passthroughReasons
 *     .guard_last_turns` is incremented, and `info.reason` is NOT
 *     'last_turns_guard' — the phase 5b/6 prevention caught it before the
 *     backstop assertion ever had to fire, so the rest of the request (the
 *     static system slab) still compresses normally (`info.compressed=true`).
 *   - Boundary correctness: in a longer conversation, a big tool_result
 *     OUTSIDE the guarded window (older than the last K messages) still gets
 *     imaged normally, while one INSIDE the window stays text — the guard is
 *     a tail window, not a blanket kill-switch.
 *   - Regression: the guard's default K=4 must not break the common
 *     single-user-message fixture shape used throughout the existing suite
 *     (keep-sharp.test.ts, render-cache.test.ts, …) — the slab-bearing first
 *     user message is always exempt (guard window starts strictly AFTER it),
 *     so a lone big tool_result on that same message still images.
 */

import { describe, expect, it } from 'vitest';
import { transformRequest } from '../src/core/transform.js';
import type { Message } from '../src/core/types.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Build a request with a large static slab (so the main compression path
 *  definitely runs, `info.compressed` can flip true) and an arbitrary
 *  multi-message conversation. */
function mkBody(messages: Message[]) {
  return enc.encode(
    JSON.stringify({
      model: 'claude-3-5-sonnet',
      system: 'x'.repeat(80_000),
      messages,
    }),
  );
}

function parse(body: Uint8Array): any {
  return JSON.parse(dec.decode(body));
}

function usr(content: Message['content']): Message {
  return { role: 'user', content };
}
function asst(content: Message['content']): Message {
  return { role: 'assistant', content };
}

/** Does this tool_result block (Anthropic shape) carry an image anywhere in
 *  its content — top-level string (no) or an image sub-block? */
function toolResultHasImage(msg: any, toolUseId: string): boolean {
  const blocks = Array.isArray(msg?.content) ? msg.content : [];
  const tr = blocks.find((b: any) => b?.type === 'tool_result' && b.tool_use_id === toolUseId);
  if (!tr) return false;
  return Array.isArray(tr.content) && tr.content.some((b: any) => b.type === 'image');
}

/** Original text still present byte-for-byte inside a tool_result block. */
function toolResultText(msg: any, toolUseId: string): string | undefined {
  const blocks = Array.isArray(msg?.content) ? msg.content : [];
  const tr = blocks.find((b: any) => b?.type === 'tool_result' && b.tool_use_id === toolUseId);
  if (!tr) return undefined;
  if (typeof tr.content === 'string') return tr.content;
  return (tr.content ?? []).find((b: any) => b.type === 'text')?.text;
}

// Big enough to clear the profitability gate (mirrors tests/keep-sharp.test.ts).
const BIG = 'x'.repeat(50_000);

/** A 5-message conversation: slab-bearing first user turn, a bit of chat,
 *  a tool_use/tool_result pair, ending with a FRESH big tool_result on the
 *  very last message. Turn count = 5, so with default K=4:
 *    tailStart = 5 - 4 = 1; slabAnchorIdx = 0 → scanFrom = max(1, 1) = 1.
 *  The last message (index 4) is inside [1..4] → guarded. */
function freshTurnConversation(): Message[] {
  return [
    usr('hi'),
    asst('hello, how can I help?'),
    usr('thanks, one more thing'),
    asst([{ type: 'tool_use', id: 'toolu_1', name: 'search', input: {} }]),
    usr([{ type: 'tool_result', tool_use_id: 'toolu_1', content: BIG }]),
  ];
}

const OPTS = { multiCol: 1, charsPerToken: 2 } as const;

describe('guardLastTurns (E15)', () => {
  it('baseline (guard disabled): a fresh last-turn tool_result gets imaged — reproduces the bug', async () => {
    const { body, info } = await transformRequest(mkBody(freshTurnConversation()), {
      ...OPTS,
      guardLastTurns: 0,
    });
    const reparsed = parse(body);
    const last = reparsed.messages[reparsed.messages.length - 1];
    expect(toolResultHasImage(last, 'toolu_1')).toBe(true);
    expect(info.compressed).toBe(true);
    expect(info.passthroughReasons?.guard_last_turns ?? 0).toBe(0);
  });

  it('default guard (K=4): the same fresh tool_result stays byte-identical text', async () => {
    const { body, info } = await transformRequest(mkBody(freshTurnConversation()), OPTS);
    const reparsed = parse(body);
    const last = reparsed.messages[reparsed.messages.length - 1];

    expect(toolResultHasImage(last, 'toolu_1')).toBe(false);
    expect(toolResultText(last, 'toolu_1')).toBe(BIG);
    expect(info.passthroughReasons?.guard_last_turns ?? 0).toBeGreaterThan(0);

    // Prevention (not the fail-open backstop) caught this — the rest of the
    // request (the static slab) still compressed normally.
    expect(info.reason).not.toBe('last_turns_guard');
    expect(info.compressed).toBe(true);
  });

  it('explicit default value (guardLastTurns: 4) behaves identically to the omitted option', async () => {
    const { body: bodyDefault } = await transformRequest(mkBody(freshTurnConversation()), OPTS);
    const { body: bodyExplicit } = await transformRequest(mkBody(freshTurnConversation()), {
      ...OPTS,
      guardLastTurns: 4,
    });
    expect(dec.decode(bodyExplicit)).toBe(dec.decode(bodyDefault));
  });

  it('boundary correctness: an older tool_result outside the window still images, a fresher one inside stays text', async () => {
    // 7 messages. With default K=4: tailStart = 7-4 = 3; slabAnchorIdx = 0 →
    // scanFrom = max(3, 1) = 3. Index 2 (< 3) is OUTSIDE the guard window;
    // index 6 (>= 3) is INSIDE it.
    const msgs: Message[] = [
      usr('hi'),
      asst([{ type: 'tool_use', id: 'toolu_old', name: 'search', input: {} }]),
      usr([{ type: 'tool_result', tool_use_id: 'toolu_old', content: BIG }]),
      asst('ok, noted'),
      usr('continuing the conversation'),
      asst([{ type: 'tool_use', id: 'toolu_new', name: 'search', input: {} }]),
      usr([{ type: 'tool_result', tool_use_id: 'toolu_new', content: BIG }]),
    ];
    const { body, info } = await transformRequest(mkBody(msgs), OPTS);
    const reparsed = parse(body);

    const oldMsg = reparsed.messages[2];
    const newMsg = reparsed.messages[reparsed.messages.length - 1];

    expect(toolResultHasImage(oldMsg, 'toolu_old')).toBe(true);
    expect(toolResultHasImage(newMsg, 'toolu_new')).toBe(false);
    expect(toolResultText(newMsg, 'toolu_new')).toBe(BIG);
    expect(info.passthroughReasons?.guard_last_turns ?? 0).toBeGreaterThan(0);
  });

  it('regression: default K=4 does not affect the common single-user-message fixture shape', async () => {
    // Mirrors tests/keep-sharp.test.ts's baseline fixture: one user message
    // carries the slab AND the tool_result. It is index 0 (the slab anchor
    // itself), which the guard always excludes — so it must still image
    // exactly as it did before E15.
    const { body, info } = await transformRequest(
      mkBody([usr([{ type: 'tool_result', tool_use_id: 'toolu_a', content: BIG }])]),
      OPTS,
    );
    const reparsed = parse(body);
    const only = reparsed.messages[0];
    expect(toolResultHasImage(only, 'toolu_a')).toBe(true);
    expect(info.compressed).toBe(true);
    expect(info.passthroughReasons?.guard_last_turns ?? 0).toBe(0);
  });

  it('K larger than the conversation guards everything (whole conversation stays text)', async () => {
    const { body, info } = await transformRequest(mkBody(freshTurnConversation()), {
      ...OPTS,
      guardLastTurns: 100,
    });
    const reparsed = parse(body);
    const last = reparsed.messages[reparsed.messages.length - 1];
    expect(toolResultHasImage(last, 'toolu_1')).toBe(false);
    expect(toolResultText(last, 'toolu_1')).toBe(BIG);
    expect(info.passthroughReasons?.guard_last_turns ?? 0).toBeGreaterThan(0);
  });
});
