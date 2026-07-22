/**
 * Tests for GPT history-image compression (src/core/openai-history.ts):
 * turn lowering (Responses + Chat), closed-tool-call boundary detection,
 * chunk-snapped collapse boundary (cache byte-stability), and the profitability
 * / min-size gates.
 */
import { describe, expect, it } from 'vitest';
import { countTokens as o200k } from 'gpt-tokenizer/encoding/o200k_base';
import {
  planGptCollapse,
  planResponsesPairCollapse,
  chatMessagesToTurns,
  GPT_HISTORY_DEFAULTS,
  type HistoryTurn,
} from '../src/core/openai-history.js';

// Always-profitable predicate for tests that exercise the planner mechanics.
const yes = () => true;
const no = () => false;

/** Build N plain user/assistant turns, each `chars` long, no tool calls. */
function plainTurns(n: number, chars = 1000): HistoryTurn[] {
  return Array.from({ length: n }, (_, i) => ({
    text: `--- ${i % 2 === 0 ? 'user' : 'assistant'} ---\n${'x'.repeat(chars)}`,
    openIds: [],
    closeIds: [],
    opaque: false,
  }));
}

describe('chatMessagesToTurns', () => {
  it('lowers assistant tool_calls into open ids + [tool_use] text', () => {
    const turns = chatMessagesToTurns([
      {
        role: 'assistant',
        content: 'calling',
        tool_calls: [{ id: 'tc1', function: { name: 'grep', arguments: '{"q":"x"}' } }],
      },
      { role: 'tool', tool_call_id: 'tc1', content: 'match' },
    ]);
    expect(turns[0]!.openIds).toEqual(['tc1']);
    expect(turns[0]!.text).toContain('[tool_use grep]');
    expect(turns[1]!.closeIds).toEqual(['tc1']);
  });
});

describe('planGptCollapse — gates', () => {
  it('refuses when the collapsible prefix is shorter than minCollapsePrefix', async () => {
    const turns = plainTurns(8); // keepTail 6 + need 10 prefix → too short
    const plan = await planGptCollapse(turns, 0, yes);
    expect(plan.images).toHaveLength(0);
    expect(plan.reason).toBe('prefix_too_short');
  });

  it('refuses when collapsed text is below minCollapseTokens', async () => {
    // 20 tiny turns: prefix is long enough, but the o200k token count is below
    // the 2000-token floor (gate is measured in tokens, not chars).
    const turns = plainTurns(20, 5);
    const plan = await planGptCollapse(turns, 0, yes);
    expect(plan.images).toHaveLength(0);
    expect(plan.reason).toBe('below_min_tokens');
  });

  it('refuses when the gate says not profitable', async () => {
    const turns = plainTurns(40, 1000);
    const plan = await planGptCollapse(turns, 0, no);
    expect(plan.images).toHaveLength(0);
    expect(plan.reason).toBe('not_profitable');
  });

  it('collapses a large plain prefix and keeps the tail', async () => {
    const turns = plainTurns(40, 1000);
    const plan = await planGptCollapse(turns, 0, yes);
    expect(plan.images.length).toBeGreaterThan(0);
    expect(plan.start).toBe(0);
    // Tail of keepTail items stays out of the collapse.
    expect(plan.endExclusive).toBeLessThanOrEqual(40 - GPT_HISTORY_DEFAULTS.keepTail);
    expect(plan.collapsedTurns).toBe(plan.endExclusive - plan.start);
    expect(plan.text.length).toBe(plan.collapsedChars);
  });

  it('caps GPT history collapse by partially collapsing oldest sections', async () => {
    const turns = plainTurns(80, 1000);
    const plan = await planGptCollapse(turns, 0, yes, {
      collapseChunk: 0,
      sectionTokens: 100,
      maxImages: 2,
    });
    expect(plan.reason).toBeUndefined();
    expect(plan.images.length).toBeGreaterThan(0);
    expect(plan.images.length).toBeLessThanOrEqual(2);
    expect(plan.collapsedChars).toBeGreaterThan(0);
    expect(plan.endExclusive).toBeLessThan(80 - GPT_HISTORY_DEFAULTS.keepTail);
  });

  it('protects the leading prefix (slab-bearing first item)', async () => {
    const turns = plainTurns(40, 1000);
    const plan = await planGptCollapse(turns, 3, yes);
    expect(plan.start).toBe(3); // never collapses items [0..2]
  });
});

describe('planGptCollapse — closed-tool-call boundary', () => {
  it('never ends the collapse inside an open tool call', async () => {
    // 30 turns; make the turn at the would-be boundary an OPEN tool call with no
    // close until much later, forcing the boundary to retreat.
    const turns = plainTurns(30, 1000);
    // Open a tool call at index 18, close it at 25 (inside the tail-adjacent zone).
    turns[18] = { text: '[tool_use x]\n{}', openIds: ['open1'], closeIds: [], opaque: false };
    turns[25] = { text: '[tool_result]\nok', openIds: [], closeIds: ['open1'], opaque: false };
    const plan = await planGptCollapse(turns, 0, yes, { collapseChunk: 0 });
    // Boundary must be < 18 (before the unclosed call) — the open id never closes
    // within the cutoff window.
    expect(plan.endExclusive).toBeLessThanOrEqual(18);
  });

  it('stops at an opaque barrier', async () => {
    const turns = plainTurns(40, 1000);
    turns[15] = { text: '', openIds: [], closeIds: [], opaque: true };
    const plan = await planGptCollapse(turns, 0, yes, { collapseChunk: 0 });
    expect(plan.endExclusive).toBeLessThanOrEqual(15);
  });

  it('never ends the collapse between a function_call and its output (orphan 400)', async () => {
    // Regression for OpenAI 400 "No tool call found for function call output":
    // the token-based section seal must not cut between a function_call (imaged)
    // and its function_call_output (left live). Place tool-call pairs at many
    // offsets so a token-only seal would land mid-pair somewhere, then assert the
    // collapsed range [start, endExclusive) is itself tool-closed.
    // 22 turns (~424 o200k tokens each); keepTail trims the cutoff. A function_call
    // sits at 14 with its output at 15. With sectionTokens 1700 the token seal lands
    // ON the function_call: pre-fix the collapse ended at 15 (call imaged, output 16
    // left live) → the orphan 400. The closure gate must push the seal to a closed
    // point so the pair never straddles the live boundary.
    const turns: HistoryTurn[] = Array.from({ length: 22 }, (_, i) => ({
      text: `--- ${i % 2 ? 'assistant' : 'user'} ---\n` + `alpha beta gamma delta epsilon ${i} `.repeat(60),
      openIds: [],
      closeIds: [],
      opaque: false,
    }));
    turns[14] = { text: '[tool_use t]\n{}', openIds: ['call_X'], closeIds: [], opaque: false };
    turns[15] = { text: '[tool_result]\nok', openIds: [], closeIds: ['call_X'], opaque: false };
    const plan = await planGptCollapse(turns, 0, yes, { collapseChunk: 0, sectionTokens: 1700 });
    expect(plan.images.length).toBeGreaterThan(0);
    // Simulate OpenAI: every opened call id in the collapsed range must close in it.
    const open = new Set<string>();
    for (let i = plan.start; i < plan.endExclusive; i++) {
      for (const id of turns[i]!.openIds) open.add(id);
      for (const id of turns[i]!.closeIds) open.delete(id);
    }
    expect(open.size).toBe(0); // no orphan function_call imaged with its output left live
  });
});

describe('planGptCollapse — reflow (↵ packing)', () => {
  // Newline-heavy turns: many SHORT lines. Without reflow each short line burns
  // a full render row and no ↵ marker appears; reflow packs them into full rows
  // and marks the hard breaks with ↵ (same treatment as the static slab).
  function shortLineTurns(n: number, linesPerTurn = 50): HistoryTurn[] {
    const body = Array.from({ length: linesPerTurn }, (_, i) => `line number ${i} here`).join('\n');
    return Array.from({ length: n }, (_, i) => ({
      text: `--- ${i % 2 === 0 ? 'user' : 'assistant'} ---\n${body}`,
      openIds: [],
      closeIds: [],
      opaque: false,
    }));
  }

  const pixels = (p: { images: { width: number; height: number }[] }) =>
    p.images.reduce((s, im) => s + im.width * im.height, 0);

  it('defaults reflow on', () => {
    expect(GPT_HISTORY_DEFAULTS.reflow).toBe(true);
  });

  it('packs newline-heavy history denser with reflow on', async () => {
    const turns = shortLineTurns(40);
    const on = await planGptCollapse(turns, 0, yes, { reflow: true });
    const off = await planGptCollapse(turns, 0, yes, { reflow: false });
    expect(on.images.length).toBeGreaterThan(0);
    expect(off.images.length).toBeGreaterThan(0);
    // Reflow only changes RENDERING — boundary and source text are identical.
    expect(on.text).toBe(off.text);
    // Short lines packed into full rows → strictly fewer rendered pixels.
    expect(pixels(on)).toBeLessThan(pixels(off));
  });

  it('keeps plan.text as the original transcript (real \\n, no ↵ sentinel)', async () => {
    const turns = shortLineTurns(40);
    const plan = await planGptCollapse(turns, 0, yes, { reflow: true });
    expect(plan.text).toContain('\n');
    expect(plan.text).not.toContain('↵');
    // The o200k baseline + cache byte-stability ride on this exact byte count.
    expect(plan.text.length).toBe(plan.collapsedChars);
  });
});

describe('planGptCollapse — pin the latest user request as text', () => {
  // Turns with REAL user requests (userText set) at the given indices; the rest is
  // assistant work. Varied words so o200k token counts clear the gates realistically.
  function turnsWithUser(n: number, userIndices: number[], reps = 60): HistoryTurn[] {
    return Array.from({ length: n }, (_, i) => {
      const isUser = userIndices.includes(i);
      const body =
        (isUser ? `USER REQUEST ${i} ` : `assistant work ${i} `) +
        `alpha beta gamma delta epsilon ${i} `.repeat(reps);
      const tag = isUser ? 'user' : 'assistant';
      return {
        text: `<${tag} t="${i}">\n${body}\n</${tag}>`,
        openIds: [],
        closeIds: [],
        opaque: false,
        userText: isUser ? body : undefined,
      };
    });
  }

  it('autonomous (single user turn at the front): request kept as TEXT, work imaged', async () => {
    const turns = turnsWithUser(40, [0]);
    const plan = await planGptCollapse(turns, 0, yes);
    expect(plan.pinText).toBeDefined();
    expect(plan.pinText).toContain('USER REQUEST 0');
    // Nothing before the pin (it is the first collapsible turn); work imaged after it.
    expect(plan.images).toHaveLength(0);
    expect(plan.imagesAfter.length).toBeGreaterThan(0);
    expect(plan.start).toBe(0);
    // The pinned request is NOT part of the imaged baseline (it stays text).
    expect(plan.text).not.toContain('USER REQUEST 0');
  });

  it('interactive: pins the LATEST user turn, images history BEFORE and AFTER it', async () => {
    const turns = turnsWithUser(40, [0, 20]);
    const plan = await planGptCollapse(turns, 0, yes, { collapseChunk: 0, sectionTokens: 100, maxImages: 100 });
    // The newest user turn in range (20) is pinned; the older one (0) stays imaged.
    expect(plan.pinText).toContain('USER REQUEST 20');
    expect(plan.pinText).not.toContain('USER REQUEST 0');
    expect(plan.text).toContain('USER REQUEST 0'); // older user turn IS imaged
    expect(plan.text).not.toContain('USER REQUEST 20'); // pinned turn is NOT imaged
    // History stays imaged on BOTH sides of the live request (no compression drop).
    expect(plan.images.length).toBeGreaterThan(0);
    expect(plan.imagesAfter.length).toBeGreaterThan(0);
  });

  it('does not orphan a tool call when sealing the section around the pin', async () => {
    const turns = turnsWithUser(40, [0, 20]);
    turns[10] = { text: '[tool_use a]\n{}', openIds: ['a'], closeIds: [], opaque: false };
    turns[11] = { text: '[tool_result]\nok', openIds: [], closeIds: ['a'], opaque: false };
    turns[25] = { text: '[tool_use b]\n{}', openIds: ['b'], closeIds: [], opaque: false };
    turns[26] = { text: '[tool_result]\nok', openIds: [], closeIds: ['b'], opaque: false };
    const plan = await planGptCollapse(turns, 0, yes, { collapseChunk: 0, sectionTokens: 100, maxImages: 100 });
    expect(plan.pinText).toContain('USER REQUEST 20');
    // Every opened call id in the imaged range (pin excluded) must close in it.
    const open = new Set<string>();
    for (let i = plan.start; i < plan.endExclusive; i++) {
      for (const id of turns[i]!.openIds) open.add(id);
      for (const id of turns[i]!.closeIds) open.delete(id);
    }
    expect(open.size).toBe(0);
  });

  it('cap stopping BEFORE the pin leaves the request native (not consumed)', async () => {
    const turns = turnsWithUser(40, [0, 30]); // latest user request sits deep at 30
    const plan = await planGptCollapse(turns, 0, yes, { collapseChunk: 0, sectionTokens: 100, maxImages: 1 });
    expect(plan.images.length).toBe(1); // cap honored
    expect(plan.imagesAfter).toHaveLength(0);
    expect(plan.pinText).toBeUndefined(); // never reached the pin → it stays a native message
    expect(plan.endExclusive).toBeLessThanOrEqual(30);
  });

  it('pin is cache-stable: same request + sealed window across appended turns', async () => {
    // collapseChunk 10 snaps L=40 and L=41 to the SAME cutoff (30) → identical plan.
    const base = turnsWithUser(60, [0]);
    const a = await planGptCollapse(base.slice(0, 40), 0, yes, { collapseChunk: 10 });
    const b = await planGptCollapse(base.slice(0, 41), 0, yes, { collapseChunk: 10 });
    expect(a.pinText).toBe(b.pinText);
    expect(a.text).toBe(b.text);
    expect(a.endExclusive).toBe(b.endExclusive);
  });

  it('no pin when the only user turn is in the kept tail (interactive shape)', async () => {
    // User turn at 38 is within keepTail (last 6 of 40) → already native text, nothing to pin.
    const turns = turnsWithUser(40, [38]);
    const plan = await planGptCollapse(turns, 0, yes);
    expect(plan.pinText).toBeUndefined();
    expect(plan.imagesAfter).toHaveLength(0);
    expect(plan.images.length).toBeGreaterThan(0);
  });

  it('does NOT pin an older in-range user turn when the LATEST user turn is in the tail', async () => {
    // Ordinary interactive shape: latest request (37) is in the kept tail (native text).
    // Pinning the older in-range turn (20) would make the pin migrate across collapse
    // boundaries and re-image frozen history — so nothing is pinned, older user turns
    // (0, 20) stay imaged. Regression guard for the cache-churn finding.
    const turns = turnsWithUser(40, [0, 20, 37]);
    const plan = await planGptCollapse(turns, 0, yes, { collapseChunk: 0, sectionTokens: 100, maxImages: 100 });
    expect(plan.pinText).toBeUndefined();
    expect(plan.imagesAfter).toHaveLength(0);
    expect(plan.text).toContain('USER REQUEST 0');
    expect(plan.text).toContain('USER REQUEST 20');
  });

  it('pin position is stable as the current turn\'s tool loop grows (no re-image churn)', async () => {
    // "Long current turn": users at 0 and 20, then a growing tool loop after 20 with no
    // new user turn. The pin stays at 20 (fixed) as work is appended, so before-pin
    // content and the request stay byte-identical (frozen) while after-pin grows.
    const base = turnsWithUser(80, [0, 20]);
    const a = await planGptCollapse(base.slice(0, 50), 0, yes, { collapseChunk: 10 });
    const b = await planGptCollapse(base.slice(0, 51), 0, yes, { collapseChunk: 10 });
    expect(a.pinText).toBe(b.pinText);
    expect(a.pinText).toContain('USER REQUEST 20');
    expect(a.start).toBe(b.start);
    // Both still image history on each side of the pinned request.
    expect(a.images.length).toBeGreaterThan(0);
    expect(a.imagesAfter.length).toBeGreaterThan(0);
  });
});

describe('planGptCollapse — chunk-snapped boundary (cache byte-stability)', () => {
  it('seals the same token sections as turns are appended (byte-stable window)', async () => {
    // 128 o200k tokens/turn, sectionTokens 2000 → a section seals every ~16 turns.
    // 34 and 35 turns seal the SAME single section [0..16) (the rest is leftover
    // live text), so the collapsed range — and the rendered image — is byte-identical
    // across those turns and keeps hitting OpenAI's automatic prefix cache.
    const base = plainTurns(60, 1000);
    const a = await planGptCollapse(base.slice(0, 34), 0, yes, { collapseChunk: 10 });
    const b = await planGptCollapse(base.slice(0, 35), 0, yes, { collapseChunk: 10 });
    expect(a.endExclusive).toBe(b.endExclusive);
    expect(a.text).toBe(b.text);
    // Accumulating enough turns to fill a SECOND ~2000-token section advances the
    // boundary by one whole section (not by turn count).
    const c = await planGptCollapse(base.slice(0, 52), 0, yes, { collapseChunk: 10 });
    expect(c.endExclusive).toBeGreaterThan(a.endExclusive);
  });

  it('per-item boundary (collapseChunk 0) moves with every new turn', async () => {
    const base = plainTurns(60, 1000);
    const a = await planGptCollapse(base.slice(0, 34), 0, yes, { collapseChunk: 0 });
    const b = await planGptCollapse(base.slice(0, 38), 0, yes, { collapseChunk: 0 });
    expect(b.endExclusive).toBeGreaterThan(a.endExclusive);
  });
});

describe('planGptCollapse — per-image dashboard source mapping', () => {
  it('returns source text parallel to every history image', async () => {
    const turns = Array.from({ length: 40 }, (_, i) => ({
      text: `<assistant t="${i}">source-marker-${i} ${'x'.repeat(500)}</assistant>`,
      openIds: [], closeIds: [], opaque: false,
    }));
    const plan = await planGptCollapse(turns, 0, () => true, {
      keepTail: 0,
      minCollapsePrefix: 1,
      minCollapseTokens: 1,
      collapseChunk: 0,
      freezeChunk: 0,
      sectionTokens: 1,
      maxImages: 100,
    });
    expect(plan.imageSources.length).toBe(plan.images.length);
    expect(plan.imageSourcesAfter.length).toBe(plan.imagesAfter.length);
    expect(plan.imageSources.length).toBeGreaterThan(0);
    expect(plan.imageSources[0]).toContain('source-marker-0');
  });
});



describe('GPT history defaults', () => {
  it('uses the validated 32-image Responses history budget', () => {
    expect(GPT_HISTORY_DEFAULTS.maxImages).toBe(32);
  });
});

describe('planResponsesPairCollapse — native state classification', () => {
  function pair(id: string, outputChars = 1400): Array<Record<string, unknown>> {
    return [
      { type: 'function_call', id: `fc_${id}`, call_id: id, name: 'exec_command', arguments: `{"cmd":"${id}"}` },
      { type: 'function_call_output', call_id: id, output: `${id} ${'output '.repeat(outputChars / 7)}` },
    ];
  }

  it('images only old completed pairs; recent completed and open calls stay unselected', async () => {
    const items: Array<Record<string, unknown>> = [{ role: 'user', content: 'live request' }];
    for (let i = 0; i < 18; i++) items.push(...pair(`call_${i}`));
    items.push({ type: 'reasoning', id: 'rs_live', encrypted_content: 'opaque-native-state' });
    items.push({ type: 'function_call', id: 'fc_open', call_id: 'call_open', name: 'exec_command', arguments: '{}' });

    const plan = await planResponsesPairCollapse(items, yes, {
      keepRecentPairs: 4,
      minCollapseTokens: 1,
      maxImages: 100,
      reflow: true,
    });
    expect(plan.images.length).toBeGreaterThan(0);
    expect(plan.pairState.completedPairs).toBe(18);
    expect(plan.pairState.recentCompletedPairs).toBe(4);
    expect(plan.pairState.oldCompletedPairs).toBe(14);
    expect(plan.pairState.openCalls).toBe(1);
    expect(plan.pairState.collapsedPairs).toBeGreaterThan(0);
    expect(plan.pairState.collapsedPairs).toBeLessThanOrEqual(14);
    const selected = new Set(plan.selectedIndices);
    expect(selected.has(items.findIndex((x) => x.call_id === 'call_open'))).toBe(false);
    for (let i = 14; i < 18; i++) {
      const indices = items.map((x, idx) => x.call_id === `call_${i}` ? idx : -1).filter((x) => x >= 0);
      expect(indices.every((idx) => !selected.has(idx))).toBe(true);
    }
    expect(plan.pairState.collapsedFunctionOutputTokens).toBeGreaterThan(0);
    expect(plan.pairState.collapsedFunctionOutputTokens)
      .toBeLessThanOrEqual(plan.pairState.imageableFunctionOutputTokens);
  });

  it('fills the image budget while keeping the cutoff on a complete pair', async () => {
    const items: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 80; i++) items.push(...pair(`budget_${i}`, 7000));
    const plan = await planResponsesPairCollapse(items, yes, {
      keepRecentPairs: 6, minCollapseTokens: 1, maxImages: 8, reflow: true,
    });
    expect(plan.images).toHaveLength(8);
    expect(plan.pairState.collapsedPairs).toBeGreaterThan(0);
    expect(plan.pairState.collapsedPairs).toBeLessThanOrEqual(74);
    const selected = new Set(plan.selectedIndices);
    for (let i = 0; i < items.length; i += 2) {
      expect(selected.has(i)).toBe(selected.has(i + 1));
    }
  });

  it('gates each replacement independently', async () => {
    const items: Array<Record<string, unknown>> = [
      ...pair('small', 1400),
      { role: 'assistant', content: 'native gap' },
      ...pair('large', 7000),
    ];
    const plan = await planResponsesPairCollapse(
      items,
      (text) => text.length > 5000,
      { keepRecentPairs: 0, minCollapseTokens: 1, maxImages: 100 },
    );
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]!.selectedIndices).toEqual([3, 4]);
    expect(plan.selectedIndices).toEqual([3, 4]);
  });

  it('keeps non-adjacent call/output pairs native', async () => {
    const items: Array<Record<string, unknown>> = [
      ...pair('good'),
      { type: 'function_call', call_id: 'split', name: 'read', arguments: '{}' },
      { role: 'assistant', content: 'native state between call and output' },
      { type: 'function_call_output', call_id: 'split', output: 'result' },
    ];
    const plan = await planResponsesPairCollapse(items, yes, {
      keepRecentPairs: 0, minCollapseTokens: 1, maxImages: 100,
    });
    expect(plan.selectedIndices).toEqual([0, 1]);
    expect(plan.pairState.malformedItems).toBe(2);
  });

  it('collapses OpenCode parallel call/output rounds atomically', async () => {
    const items: Array<Record<string, unknown>> = [];
    for (let round = 0; round < 6; round++) {
      for (let call = 0; call < 4; call++) {
        const id = `round_${round}_${call}`;
        items.push({
          type: 'function_call', id: `fc_${id}`, call_id: id,
          name: 'read', arguments: `{"path":"${id}"}`,
        });
      }
      for (let call = 0; call < 4; call++) {
        const id = `round_${round}_${call}`;
        items.push({
          type: 'function_call_output', call_id: id,
          output: `${id} ${'large output '.repeat(300)}`,
        });
      }
    }
    const plan = await planResponsesPairCollapse(items, yes, {
      responsesMode: 'mixed', keepRecentPairs: 4,
      minCollapseTokens: 1, maxImages: 100,
    });
    expect(plan.pairState).toMatchObject({
      completedPairs: 24,
      oldCompletedPairs: 20,
      recentCompletedPairs: 4,
      malformedItems: 0,
      collapsedPairs: 20,
    });
    const selected = new Set(plan.selectedIndices);
    for (let round = 0; round < 6; round++) {
      const roundIndices = Array.from({ length: 8 }, (_, i) => round * 8 + i);
      const selectedCount = roundIndices.filter((i) => selected.has(i)).length;
      expect([0, 8]).toContain(selectedCount);
    }
    expect(plan.pairState.collapsedFunctionOutputTokens).toBeGreaterThan(0);
  });

  it('keeps an incomplete parallel round entirely native', async () => {
    const items: Array<Record<string, unknown>> = [
      { type: 'function_call', call_id: 'a', name: 'read', arguments: '{}' },
      { type: 'function_call', call_id: 'b', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'a', output: 'a result' },
    ];
    const plan = await planResponsesPairCollapse(items, yes, {
      responsesMode: 'mixed', keepRecentPairs: 0,
      minCollapseTokens: 1, maxImages: 100,
    });
    expect(plan.selectedIndices).toEqual([]);
    expect(plan.pairState.openCalls).toBe(1);
    expect(plan.pairState.malformedItems).toBe(2);
  });

  it('keeps orphan, duplicate, reversed, and missing-id items native', async () => {
    const items: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 12; i++) items.push(...pair(`good_${i}`));
    items.push({ type: 'function_call_output', call_id: 'orphan', output: 'orphan output' });
    items.push({ type: 'function_call', call_id: 'dup', name: 'x', arguments: '{}' });
    items.push({ type: 'function_call', call_id: 'dup', name: 'x', arguments: '{}' });
    items.push({ type: 'function_call_output', call_id: 'dup', output: 'one output' });
    items.push({ type: 'function_call_output', call_id: 'reverse', output: 'first' });
    items.push({ type: 'function_call', call_id: 'reverse', name: 'x', arguments: '{}' });
    items.push({ type: 'function_call', name: 'missing', arguments: '{}' });
    const plan = await planResponsesPairCollapse(items, yes, {
      keepRecentPairs: 0, minCollapseTokens: 1, maxImages: 100,
    });
    expect(plan.pairState.orphanOutputs).toBe(1);
    expect(plan.pairState.malformedItems).toBe(6);
    const selected = new Set(plan.selectedIndices);
    for (let i = 24; i < items.length; i++) expect(selected.has(i)).toBe(false);
  });

  it('mixed mode images safe old messages with complete pairs but protects live and opaque state', async () => {
    const items: Array<Record<string, unknown>> = [
      { role: 'user', content: `old request ${'alpha '.repeat(500)}` },
      { role: 'assistant', content: `old answer ${'beta '.repeat(500)}` },
      ...pair('old_pair', 7000),
      { type: 'reasoning', id: 'reasoning_live', encrypted_content: 'must-stay-native' },
      { role: 'assistant', content: `later answer ${'gamma '.repeat(500)}` },
      { role: 'user', content: 'current live request' },
    ];
    const plan = await planResponsesPairCollapse(items, yes, {
      responsesMode: 'mixed', keepTail: 1, keepRecentPairs: 0,
      minCollapseTokens: 1, maxImages: 100,
    });
    const selected = new Set(plan.selectedIndices);
    expect(selected.has(0)).toBe(true);
    expect(selected.has(1)).toBe(true);
    expect(selected.has(2)).toBe(true);
    expect(selected.has(3)).toBe(true);
    expect(selected.has(4)).toBe(false);
    expect(selected.has(5)).toBe(true);
    expect(selected.has(6)).toBe(false);
    expect(plan.segments).toHaveLength(2);
    expect(plan.pairState.collapsedPairs).toBe(1);
    const expectedBaseline =
      o200k(String(items[0]!.content)) +
      o200k(String(items[1]!.content)) +
      o200k(JSON.stringify(items[2])) +
      o200k(String(items[3]!.output)) +
      o200k(String(items[5]!.content));
    expect(plan.baselineTokens).toBe(expectedBaseline);
    expect(plan.baselineTokens).toBeLessThan(o200k(plan.text));
  });

  it('with a one-item Sol tail, protects the latest user and newest closed pair only', async () => {
    const items: Array<Record<string, unknown>> = [
      { role: 'user', content: `old request ${'alpha '.repeat(500)}` },
      ...pair('old_pair', 7000),
      { role: 'assistant', content: `recent answer ${'beta '.repeat(500)}` },
      ...pair('recent_pair', 7000),
      { role: 'user', content: 'current live request' },
    ];
    const plan = await planResponsesPairCollapse(items, yes, {
      responsesMode: 'mixed', keepTail: 1, keepRecentPairs: 1,
      minCollapseTokens: 1, maxImages: 100,
    });
    const selected = new Set(plan.selectedIndices);
    expect(selected.has(0)).toBe(true);
    expect(selected.has(1)).toBe(true);
    expect(selected.has(2)).toBe(true);
    expect(selected.has(3)).toBe(true);
    expect(selected.has(4)).toBe(false);
    expect(selected.has(5)).toBe(false);
    expect(selected.has(6)).toBe(false);
    expect(plan.pairState).toMatchObject({
      completedPairs: 2,
      oldCompletedPairs: 1,
      recentCompletedPairs: 1,
      collapsedPairs: 1,
    });
  });

  it('mixed mode never removes a message targeted by item_reference', async () => {
    const items: Array<Record<string, unknown>> = [
      { id: 'msg_old', type: 'message', role: 'assistant', content: `old ${'text '.repeat(1000)}` },
      { type: 'item_reference', item_id: 'msg_old' },
      { role: 'assistant', content: `safe ${'text '.repeat(1000)}` },
      { role: 'user', content: 'live request' },
    ];
    const plan = await planResponsesPairCollapse(items, yes, {
      responsesMode: 'mixed', keepTail: 1, keepRecentPairs: 0,
      minCollapseTokens: 1, maxImages: 100,
    });
    expect(plan.selectedIndices).not.toContain(0);
    expect(plan.selectedIndices).not.toContain(1);
    expect(plan.selectedIndices).toContain(2);
    expect(plan.selectedIndices).not.toContain(3);
  });

  it('mixed mode keeps referenced function pairs and unknown role-bearing items native', async () => {
    const items: Array<Record<string, unknown>> = [
      { id: 'fc_ref', type: 'function_call', call_id: 'ref', name: 'read', arguments: '{}' },
      { id: 'fo_ref', type: 'function_call_output', call_id: 'ref', output: 'referenced result' },
      { type: 'item_reference', id: 'fc_ref' },
      { type: 'custom_state', role: 'assistant', content: `opaque ${'state '.repeat(1000)}` },
      { role: 'assistant', content: `safe ${'text '.repeat(1000)}` },
      { role: 'user', content: 'live request' },
    ];
    const plan = await planResponsesPairCollapse(items, yes, {
      responsesMode: 'mixed', keepTail: 1, keepRecentPairs: 0,
      minCollapseTokens: 1, maxImages: 100,
    });
    expect(plan.selectedIndices).not.toContain(0);
    expect(plan.selectedIndices).not.toContain(1);
    expect(plan.selectedIndices).not.toContain(2);
    expect(plan.selectedIndices).not.toContain(3);
    expect(plan.selectedIndices).toContain(4);
    expect(plan.selectedIndices).not.toContain(5);
  });
});
