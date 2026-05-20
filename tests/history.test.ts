/**
 * Tests for Variant C history-image compression (task #52).
 *
 * Coverage:
 *   - `findClosedPrefixBoundary`: parallel tool calls in one assistant turn,
 *     interleaved tool_use_id close ordering, mid-flight (open) tool_use
 *     straddling the cutoff, and the boring "all closed" case.
 *   - `blocksToText`: drops `thinking` blocks, serialises `tool_use` /
 *     `tool_result` with content, emits `[image]` placeholder for nested
 *     images.
 *   - `messagesToHistoryText`: `--- role ---` framing, skips empty turns.
 *   - `collapseHistory`: full pipeline — opts handling, break-even gate,
 *     synthetic user message shape (text+image+text), live-tail preservation.
 *   - `transformRequest` end-to-end: compressHistory off (default), on with
 *     enough turns to fire, off when no closed prefix exists.
 */

import { describe, expect, it } from 'vitest';
import {
  findClosedPrefixBoundary,
  blocksToText,
  messagesToHistoryText,
  collapseHistory,
  HISTORY_DEFAULTS,
} from '../src/core/history.js';
import { transformRequest, isCompressionProfitable } from '../src/core/transform.js';
import type { Message } from '../src/core/types.js';

// A tiny helper so test fixtures are readable.
function asst(content: Message['content']): Message {
  return { role: 'assistant', content };
}
function usr(content: Message['content']): Message {
  return { role: 'user', content };
}

describe('findClosedPrefixBoundary', () => {
  it('returns -1 for empty messages', () => {
    expect(findClosedPrefixBoundary([], 0)).toBe(-1);
    expect(findClosedPrefixBoundary([], 10)).toBe(-1);
  });

  it('returns -1 when cutoff is 0 (no prefix to scan)', () => {
    const msgs: Message[] = [usr('hi'), asst('hello')];
    expect(findClosedPrefixBoundary(msgs, 0)).toBe(-1);
  });

  it('returns last index for an all-plain (no tool calls) conversation', () => {
    const msgs: Message[] = [usr('hi'), asst('hello'), usr('thanks')];
    // Cutoff exclusive=3 → scan [0..2]. All plain → all closed. Last index = 2.
    expect(findClosedPrefixBoundary(msgs, 3)).toBe(2);
  });

  it('returns the last-closed boundary, not the cutoff itself, when there are mid-flight tool_uses', () => {
    const msgs: Message[] = [
      usr('do thing'),
      asst([{ type: 'tool_use', id: 'A', name: 't', input: {} }]),
      usr([{ type: 'tool_result', tool_use_id: 'A', content: 'ok' }]),
      // turn 3 opens 'B' but never closes it within our cutoff.
      asst([{ type: 'tool_use', id: 'B', name: 't', input: {} }]),
      usr('plain text'), // no tool_result for B → B is open
    ];
    // Cutoff exclusive=5 → scan all 5 messages. After msg 2, openSet={}.
    // After msg 3, openSet={B}. After msg 4 (plain user, no tool_result),
    // openSet still {B}. Last closed index = 2.
    expect(findClosedPrefixBoundary(msgs, 5)).toBe(2);
  });

  it('handles parallel tool calls in one assistant turn', () => {
    const msgs: Message[] = [
      usr('parallel work'),
      asst([
        { type: 'tool_use', id: 'A', name: 't', input: {} },
        { type: 'tool_use', id: 'B', name: 't', input: {} },
      ]),
      usr([
        { type: 'tool_result', tool_use_id: 'B', content: 'b' },
        { type: 'tool_result', tool_use_id: 'A', content: 'a' },
      ]),
      asst('done'),
    ];
    // After msg 1: openSet={A,B}. After msg 2: openSet={} (both closed in
    // reverse order — order doesn't matter for openSet). After msg 3: still
    // closed. Last index = 3.
    expect(findClosedPrefixBoundary(msgs, 4)).toBe(3);
  });

  it('returns -1 when the very first message opens a tool_use that never closes', () => {
    const msgs: Message[] = [
      asst([{ type: 'tool_use', id: 'X', name: 't', input: {} }]),
      usr('plain text, no tool_result'),
    ];
    // openSet={X} after msg 0 and msg 1 → never closes → no closed index.
    expect(findClosedPrefixBoundary(msgs, 2)).toBe(-1);
  });

  it('respects cutoffExclusive — never scans into the live tail', () => {
    const msgs: Message[] = [
      usr('q1'),
      asst('a1'),
      usr('q2'),
      asst('a2'),
      usr('q3'),
    ];
    // Cutoff exclusive=2 → only scan [0,1]. Last closed = 1.
    expect(findClosedPrefixBoundary(msgs, 2)).toBe(1);
    // Cutoff=1 → only scan [0]. Last closed = 0.
    expect(findClosedPrefixBoundary(msgs, 1)).toBe(0);
  });
});

describe('blocksToText', () => {
  it('returns string content verbatim', () => {
    expect(blocksToText('hello world')).toBe('hello world');
  });

  it('joins text blocks with double newline', () => {
    expect(
      blocksToText([
        { type: 'text', text: 'first paragraph' },
        { type: 'text', text: 'second paragraph' },
      ]),
    ).toBe('first paragraph\n\nsecond paragraph');
  });

  it('serialises tool_use with its name and COMPACT JSON args', () => {
    // Compact JSON (no 2-space indent) keeps row counts low so the
    // history image stays small — pretty-printing inflates rows ~5×.
    const out = blocksToText([
      {
        type: 'tool_use',
        id: 'tx1',
        name: 'Read',
        input: { file_path: '/etc/hosts', limit: 50 },
      },
    ]);
    expect(out).toContain('[tool_use Read]');
    expect(out).toContain('"file_path":"/etc/hosts"');
    expect(out).toContain('"limit":50');
    // Negative: no pretty-print artefacts.
    expect(out).not.toContain('  "file_path"');
    expect(out).not.toContain('"limit": 50');
  });

  it('serialises tool_result string content', () => {
    expect(
      blocksToText([
        { type: 'tool_result', tool_use_id: 'tx1', content: 'output line one' },
      ]),
    ).toContain('[tool_result]\noutput line one');
  });

  it('marks tool_result is_error with " (error)" suffix', () => {
    expect(
      blocksToText([
        {
          type: 'tool_result',
          tool_use_id: 'tx1',
          content: 'oops',
          is_error: true,
        },
      ]),
    ).toContain('[tool_result (error)]');
  });

  it('flattens array-shaped tool_result content (text + image)', () => {
    const out = blocksToText([
      {
        type: 'tool_result',
        tool_use_id: 'tx1',
        content: [
          { type: 'text', text: 'caption' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
          },
        ],
      },
    ]);
    expect(out).toContain('caption');
    expect(out).toContain('[image]');
  });

  it('drops thinking blocks (Opus 4.7 only requires bit-perfect on most-recent turn)', () => {
    const out = blocksToText([
      // @ts-expect-error — `thinking` is a real Anthropic block but not in our
      // pared-down types union. The blocksToText switch must silently drop it.
      { type: 'thinking', thinking: 'secret reasoning trace', signature: 'sig123' },
      { type: 'text', text: 'visible answer' },
    ]);
    expect(out).toBe('visible answer');
    expect(out).not.toContain('secret reasoning');
    expect(out).not.toContain('sig123');
  });

  it('emits [image] placeholder for top-level image blocks', () => {
    expect(
      blocksToText([
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
        },
      ]),
    ).toBe('[image]');
  });
});

describe('messagesToHistoryText', () => {
  it('frames each turn with --- role --- and joins with blank line', () => {
    const msgs: Message[] = [usr('hi'), asst('hello')];
    const out = messagesToHistoryText(msgs, 2);
    expect(out).toContain('--- user ---\nhi');
    expect(out).toContain('--- assistant ---\nhello');
  });

  it('respects upToExclusive (does not include the live tail)', () => {
    const msgs: Message[] = [usr('q1'), asst('a1'), usr('q2')];
    const out = messagesToHistoryText(msgs, 2);
    expect(out).toContain('q1');
    expect(out).toContain('a1');
    expect(out).not.toContain('q2');
  });

  it('skips empty turns', () => {
    const msgs: Message[] = [
      usr(''),
      asst('answer'),
      usr('   \n   '), // whitespace-only
    ];
    const out = messagesToHistoryText(msgs, 3);
    expect(out).toContain('--- assistant ---\nanswer');
    // Only one section header should appear.
    expect(out.match(/^---/gm)?.length).toBe(1);
  });
});

describe('collapseHistory', () => {
  // The break-even predicate that ships with transform.ts. We pass it in so
  // history.ts stays cycle-free.
  const profitable = isCompressionProfitable;

  it('bails with reason=no_history on empty input', async () => {
    const { messages, info } = await collapseHistory([], profitable);
    expect(messages).toEqual([]);
    expect(info.reason).toBe('no_history');
    expect(info.collapsedTurns).toBe(0);
  });

  it('bails with reason=prefix_too_short when the closed prefix < minCollapsePrefix', async () => {
    const msgs: Message[] = [usr('q1'), asst('a1')];
    const { messages, info } = await collapseHistory(msgs, profitable, {
      keepTail: 0,
      minCollapsePrefix: 5,
    });
    expect(messages).toBe(msgs); // unchanged reference
    expect(info.reason).toBe('prefix_too_short');
  });

  it('bails with reason=not_profitable when collapsed text is small', async () => {
    // 12 tiny turns, all plain prose. Each turn ~30 chars → ~400 chars total
    // serialised. Well under the 10,000-char break-even.
    const msgs: Message[] = [];
    for (let i = 0; i < 12; i++) {
      msgs.push(i % 2 === 0 ? usr(`q${i}`) : asst(`a${i}`));
    }
    const { info } = await collapseHistory(msgs, profitable, {
      keepTail: 0,
      minCollapsePrefix: 5,
    });
    expect(info.reason).toBe('not_profitable');
  });

  it('collapses a long all-plain conversation into one prepended user message', async () => {
    // 12 turns, each ~1500 chars → ~18k chars total. Past break-even at cols=100.
    const msgs: Message[] = [];
    for (let i = 0; i < 12; i++) {
      const body = `turn ${i}: ` + 'x'.repeat(2500);
      msgs.push(i % 2 === 0 ? usr(body) : asst(body));
    }
    const { messages: out, info } = await collapseHistory(msgs, profitable, {
      keepTail: 2,
      minCollapsePrefix: 5,
      cols: 100,
    });
    expect(info.reason).toBe(undefined); // collapsed → no reason set
    expect(info.collapsedTurns).toBe(10); // 12 - keepTail(2)
    expect(info.collapsedImages).toBeGreaterThanOrEqual(1);
    expect(out.length).toBe(1 + 2); // 1 synthetic + 2 tail turns
    // Synthetic user message is at index 0
    expect(out[0]!.role).toBe('user');
    expect(Array.isArray(out[0]!.content)).toBe(true);
    const content = out[0]!.content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({ type: 'text', text: '[Earlier in this conversation:]' });
    expect(content[content.length - 1]).toMatchObject({
      type: 'text',
      text: '[End of earlier context.]',
    });
    // Middle blocks are image
    const imgBlocks = content.filter((c) => c.type === 'image');
    expect(imgBlocks.length).toBe(info.collapsedImages);
    // Last 2 turns are the live tail, byte-identical to the original
    expect(out[1]).toBe(msgs[10]);
    expect(out[2]).toBe(msgs[11]);
  });

  it('preserves a tool_use sequence that straddles the live-tail boundary', async () => {
    // 14 turns: 10 closed turns, then an open tool_use at index 10 that closes at index 12.
    // Per-turn body bumped to 3500 chars so the row-aware gate (numCols=1) clears
    // the per-block break-even point. The tool_use/tool_result block labels
    // add ~65 chars of header overhead that pushes a tighter fixture under
    // the boundary; 3500-char turns leave headroom.
    const msgs: Message[] = [];
    for (let i = 0; i < 10; i++) {
      const body = `turn ${i}: ` + 'x'.repeat(3500);
      msgs.push(i % 2 === 0 ? usr(body) : asst(body));
    }
    msgs.push(asst([{ type: 'tool_use', id: 'X', name: 't', input: {} }]));
    msgs.push(usr([{ type: 'tool_result', tool_use_id: 'X', content: 'r' }]));
    msgs.push(asst('after the tool')); // index 12, live tail

    // keepTail=1 means cutoff=12. boundary search over [0..11]. msg 10 opens
    // X, msg 11 closes it → openSet={} after msg 11. But wait, msg 11 is
    // INSIDE the cutoff. Last-closed = 11. collapseLen = 12.
    // That means msg 10+11 (the X open/close pair) WOULD be collapsed.
    // That's fine — they're closed within the prefix.
    const { messages: out, info } = await collapseHistory(msgs, profitable, {
      keepTail: 1,
      minCollapsePrefix: 5,
      cols: 100,
    });
    expect(info.reason).toBe(undefined);
    expect(info.collapsedTurns).toBe(12);
    // 1 synthetic prepended + 1 tail msg
    expect(out.length).toBe(2);
    expect(out[1]).toBe(msgs[12]); // tail is the post-tool assistant turn
  });

  it('refuses to collapse when an open tool_use would straddle the live-tail boundary', async () => {
    // 14 turns: 10 closed turns, then an open tool_use at index 10 that
    // closes at index 13 — but keepTail=2 puts the close INSIDE the tail.
    const msgs: Message[] = [];
    for (let i = 0; i < 10; i++) {
      const body = `turn ${i}: ` + 'x'.repeat(2500);
      msgs.push(i % 2 === 0 ? usr(body) : asst(body));
    }
    msgs.push(asst([{ type: 'tool_use', id: 'X', name: 't', input: {} }])); // 10
    msgs.push(usr('thinking out loud')); // 11
    msgs.push(asst('more thinking')); // 12
    msgs.push(usr([{ type: 'tool_result', tool_use_id: 'X', content: 'r' }])); // 13

    // keepTail=3 → cutoff=11 → scan [0..10]. After msg 10 openSet={X}.
    // boundary = last index where openSet was empty = 9.
    // collapseLen = 10, ≥ minCollapsePrefix(5) → collapses turns 0..9.
    // openSet={X} from msg 10 onward; that open turn stays in the live tail.
    const { messages: out, info } = await collapseHistory(msgs, profitable, {
      keepTail: 3,
      minCollapsePrefix: 5,
      cols: 100,
    });
    expect(info.reason).toBe(undefined);
    expect(info.collapsedTurns).toBe(10);
    // Live tail: msgs 10..13 = 4 messages. Plus 1 prepended.
    expect(out.length).toBe(5);
    // X open at out[1] (was msgs[10]), X close at out[4] (was msgs[13]) —
    // both in the live tail so the tool_use_id linkage survives.
    expect(out[1]).toBe(msgs[10]);
    expect(out[4]).toBe(msgs[13]);
  });
});

describe('transformRequest history compression (always-on)', () => {
  function bigPlain(n: number): string {
    return 'x'.repeat(n);
  }

  function mkBody(messages: Message[], systemText: string) {
    return new TextEncoder().encode(
      JSON.stringify({
        model: 'claude-3-5-sonnet',
        system: systemText,
        messages,
      }),
    );
  }

  it('compressHistory is always-on by default — input msgs are not mutated', async () => {
    // The proxy ships with compressHistory baked in. This test pins the
    // INVARIANT that even when history compression is active, the
    // caller's `messages` array is not mutated in place — the function
    // returns a new body and leaves the input object identical to its
    // pre-call serialization.
    const msgs: Message[] = [];
    for (let i = 0; i < 12; i++) {
      msgs.push(i % 2 === 0 ? usr(bigPlain(3000)) : asst(bigPlain(3000)));
    }
    const before = JSON.stringify(msgs);
    const { body } = await transformRequest(mkBody(msgs, bigPlain(80_000)));
    // Input still byte-identical to its pre-call serialization.
    expect(JSON.stringify(msgs)).toBe(before);
    // And the returned body is valid JSON we can re-parse.
    const reparsed = JSON.parse(new TextDecoder().decode(body));
    expect(Array.isArray(reparsed.messages)).toBe(true);
  });

  it('collapses a 10-closed + 4-live conversation under the default keepTail=4', async () => {
    // 14 turns total. Default keepTail=4 + minPrefix=10 means 10 turns
    // collapse into 1 synthetic prepended user + 4 live tail = 5 total.
    // Per-turn body 3500 chars puts the fixture comfortably above the
    // row-aware profitability gate (numCols=1 at the renderer means each
    // 3500-char `x` line wraps to 35 rows; 10 turns × ~36 rows = ~360 rows
    // = 3 single-col images ≪ text-cost).
    const msgs: Message[] = [];
    for (let i = 0; i < 14; i++) {
      const body = `turn ${i}: ` + bigPlain(3500);
      msgs.push(i % 2 === 0 ? usr(body) : asst(body));
    }
    const { body, info } = await transformRequest(mkBody(msgs, bigPlain(80_000)));
    expect(info.collapsedTurns).toBe(10);
    expect(info.collapsedChars).toBeGreaterThan(0);
    expect(info.collapsedImages).toBeGreaterThanOrEqual(1);
    expect(info.historyReason).toBe('collapsed');
    expect(info.imageCount).toBeGreaterThanOrEqual(1 + (info.collapsedImages ?? 0));

    const reparsed = JSON.parse(new TextDecoder().decode(body));
    expect(reparsed.messages.length).toBe(5); // 1 synthetic + 4 live tail
    expect(reparsed.messages[0].role).toBe('user');
    const content = reparsed.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toMatchObject({ type: 'text', text: '[Earlier in this conversation:]' });
    expect(content[content.length - 1]).toMatchObject({
      type: 'text',
      text: '[End of earlier context.]',
    });
  });

  it('sets historyReason=no_closed_prefix when an open tool_use precedes the tail', async () => {
    // First message opens a tool_use; nothing closes it. With default
    // keepTail=4 and 4 messages total, cutoff=0, so the boundary search
    // runs over an empty range [0..-1] and returns -1 → no_closed_prefix.
    const msgs: Message[] = [
      asst([{ type: 'tool_use', id: 'X', name: 't', input: {} }]),
      usr('plain'),
      asst('plain'),
      usr('plain'),
    ];
    const { info } = await transformRequest(mkBody(msgs, bigPlain(80_000)));
    expect(info.collapsedTurns).toBeUndefined();
    expect(info.historyReason).toBe('no_closed_prefix');
  });

  it('history-image blocks carry NO cache_control (conservative first-cut)', async () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 14; i++) {
      const body = `turn ${i}: ` + bigPlain(3500);
      msgs.push(i % 2 === 0 ? usr(body) : asst(body));
    }
    const { body, info } = await transformRequest(mkBody(msgs, bigPlain(80_000)));
    expect(info.collapsedImages).toBeGreaterThanOrEqual(1);
    const reparsed = JSON.parse(new TextDecoder().decode(body));
    const synth = reparsed.messages[0];
    const imgs = synth.content.filter((b: { type: string }) => b.type === 'image');
    for (const img of imgs) {
      expect(img.cache_control).toBeUndefined();
    }
  });
});

describe('HISTORY_DEFAULTS', () => {
  it('defaults are conservative (keepTail=4, minCollapsePrefix=10, cols=100)', () => {
    expect(HISTORY_DEFAULTS.keepTail).toBe(4);
    expect(HISTORY_DEFAULTS.minCollapsePrefix).toBe(10);
    expect(HISTORY_DEFAULTS.cols).toBe(100);
  });
});
