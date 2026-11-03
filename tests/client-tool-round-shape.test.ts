import { beforeEach, describe, expect, it } from 'vitest';
import {
  parseTrustAdjacentToolRounds,
  resolveTrustAdjacentToolRoundsEnv,
  withClientToolRoundShape,
} from '../src/core/proxy.js';
import { transformRequest } from '../src/core/transform.js';
import { resetSessionState } from '../src/core/session-state.js';
import { findClosedPrefixBoundary } from '../src/core/history.js';

const CLAUDE_CODE_UA = 'claude-cli/2.1.316 (external, cli)';
const hdrs = (h: Record<string, string>) => new Headers(h);

describe('withClientToolRoundShape', () => {
  it('enables adjacent-pair splitting for Claude Code', () => {
    expect(withClientToolRoundShape({}, hdrs({ 'user-agent': CLAUDE_CODE_UA, 'x-app': 'cli' })))
      .toEqual({ separateAdjacentToolPairs: true });
    // Background sessions send x-app: cli-bg.
    expect(withClientToolRoundShape(undefined, hdrs({ 'user-agent': CLAUDE_CODE_UA, 'x-app': 'cli-bg' })))
      .toEqual({ separateAdjacentToolPairs: true });
  });

  it('leaves other clients on the conservative default', () => {
    // OpenCode serializes one parallel batch as adjacent call/result pairs,
    // so splitting there could cut a round in half.
    const opts = { compress: true };
    expect(withClientToolRoundShape(opts, hdrs({ 'user-agent': 'opencode/1.0' }))).toBe(opts);
    expect(withClientToolRoundShape(opts, null)).toBe(opts);
    expect(withClientToolRoundShape(opts, undefined)).toBe(opts);
  });

  it('does not trust a client that only copies the Claude Code User-Agent', () => {
    // A third-party tool may reuse the UA string without Claude Code's batching.
    const opts = { compress: true };
    expect(withClientToolRoundShape(opts, hdrs({ 'user-agent': CLAUDE_CODE_UA }))).toBe(opts);
    expect(withClientToolRoundShape(opts, hdrs({ 'user-agent': CLAUDE_CODE_UA, 'x-app': 'my-tool' }))).toBe(opts);
    // x-app alone is not enough either.
    expect(withClientToolRoundShape(opts, hdrs({ 'user-agent': 'node', 'x-app': 'cli' }))).toBe(opts);
  });

  it('lets an explicit host setting override header detection', () => {
    const off = { separateAdjacentToolPairs: false };
    expect(withClientToolRoundShape(off, hdrs({ 'user-agent': CLAUDE_CODE_UA, 'x-app': 'cli' }))).toBe(off);
  });
});

describe('parseTrustAdjacentToolRounds', () => {
  it('treats unset or blank as "decide from the client headers"', () => {
    expect(parseTrustAdjacentToolRounds(undefined)).toEqual({ value: undefined, invalid: false });
    expect(parseTrustAdjacentToolRounds('  ')).toEqual({ value: undefined, invalid: false });
  });

  it.each(['1', 'true', 'YES', ' on '])('forces on for %j', (raw) => {
    expect(parseTrustAdjacentToolRounds(raw)).toEqual({ value: true, invalid: false });
  });

  it.each(['0', 'false', 'No', 'off'])('forces off for %j', (raw) => {
    expect(parseTrustAdjacentToolRounds(raw)).toEqual({ value: false, invalid: false });
  });

  // A typo must be reported, not silently read as "unset": the operator
  // believes the override is active when it is not.
  it.each(['2', 'enable', 'ture'])('flags %j as invalid', (raw) => {
    expect(parseTrustAdjacentToolRounds(raw)).toEqual({ value: undefined, invalid: true });
  });
});

describe('resolveTrustAdjacentToolRoundsEnv', () => {
  // Node and the Worker both log this text, so the rule lives in one place.
  it('returns the value with no warning for recognized input', () => {
    expect(resolveTrustAdjacentToolRoundsEnv('1')).toEqual({ value: true });
    expect(resolveTrustAdjacentToolRoundsEnv('0')).toEqual({ value: false });
    expect(resolveTrustAdjacentToolRoundsEnv(undefined)).toEqual({ value: undefined });
  });

  it('falls back to header detection and explains why for unrecognized input', () => {
    const r = resolveTrustAdjacentToolRoundsEnv('maybe');
    expect(r.value).toBeUndefined();
    expect(r.warning).toContain('PXPIPE_TRUST_ADJACENT_TOOL_ROUNDS="maybe" not recognized');
  });
});

describe('separateAdjacentToolPairs reaches collapseHistory via transformRequest', () => {
  beforeEach(() => resetSessionState());

  /**
   * A pure agent tool loop: every assistant turn is a single tool_use and no
   * text-only assistant turn ever closes the round. This is the shape that kept
   * the boundary at 0 for the whole lifetime of a Claude Code subagent.
   */
  function pureToolLoop(turns: number): Uint8Array {
    const messages: unknown[] = [{ role: 'user', content: 'SESSION ANCHOR: review this diff' }];
    for (let i = 0; i < turns; i++) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { n: i } }],
      });
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: `file ${i}: ` + 'x'.repeat(3500) }],
      });
    }
    return new TextEncoder().encode(JSON.stringify({ model: 'claude-3-5-sonnet', messages }));
  }

  it('collapses a pure tool loop only when adjacent pairs are trusted', async () => {
    const off = await transformRequest(pureToolLoop(60), { separateAdjacentToolPairs: false });
    expect(off.info.collapsedTurns ?? 0).toBe(0);
    // Boundary stays at index 0 (the anchor user message), one message short
    // of minCollapsePrefix — the stuck state seen on live subagent traffic.
    expect(off.info.historyReason).toBe('prefix_too_short');
    // The mode is recorded per request so a 400 regression can be tied to it.
    expect(off.info.historySplitAdjacentPairs).toBeUndefined();

    resetSessionState();
    const on = await transformRequest(pureToolLoop(60), { separateAdjacentToolPairs: true });
    expect(on.info.historyReason).toBe('collapsed');
    expect(on.info.collapsedTurns).toBeGreaterThan(0);
    expect(on.info.historySplitAdjacentPairs).toBe(true);

    // The collapsed request must stay API-valid: roles alternate, and every
    // live tool_result answers a tool_use that is still live before it.
    const out = JSON.parse(new TextDecoder().decode(on.body)).messages as any[];
    const liveToolUses = new Set<string>();
    for (let i = 0; i < out.length; i++) {
      if (i > 0) expect(out[i].role).not.toBe(out[i - 1].role);
      if (!Array.isArray(out[i].content)) continue;
      for (const blk of out[i].content) {
        if (blk?.type === 'tool_use') liveToolUses.add(blk.id);
        if (blk?.type === 'tool_result') expect(liveToolUses.has(blk.tool_use_id)).toBe(true);
      }
    }
  });
});

describe('enabling adjacent pairs never moves a boundary backwards', () => {
  /**
   * Upgrade safety for sessions that already collapse under the old rule:
   * the split mode only adds candidate boundaries, so for the same cutoff its
   * boundary is >= the old one. Frozen chunks before the old boundary are
   * unchanged and their cache entries stay valid.
   */
  it('holds for a mixed transcript at every cutoff', () => {
    const msgs: any[] = [{ role: 'user', content: 'start' }];
    for (let r = 0; r < 6; r++) {
      // A two-call round, then a parallel batch, then a closing text reply.
      msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `a${r}`, name: 'Read', input: {} }] });
      msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `a${r}`, content: 'ok' }] });
      msgs.push({ role: 'assistant', content: [
        { type: 'tool_use', id: `b${r}`, name: 'Read', input: {} },
        { type: 'tool_use', id: `c${r}`, name: 'Read', input: {} },
      ] });
      msgs.push({ role: 'user', content: [
        { type: 'tool_result', tool_use_id: `b${r}`, content: 'ok' },
        { type: 'tool_result', tool_use_id: `c${r}`, content: 'ok' },
      ] });
      msgs.push({ role: 'assistant', content: [{ type: 'text', text: `done ${r}` }] });
      msgs.push({ role: 'user', content: `next ${r}` });
    }
    for (let cutoff = 0; cutoff <= msgs.length; cutoff++) {
      const before = findClosedPrefixBoundary(msgs, cutoff, false);
      const after = findClosedPrefixBoundary(msgs, cutoff, true);
      expect(after, `cutoff=${cutoff}`).toBeGreaterThanOrEqual(before);
    }
  });

  it('holds when a tool_use id is unusable', () => {
    const msgs: any[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
    ];
    for (let cutoff = 0; cutoff <= msgs.length; cutoff++) {
      const before = findClosedPrefixBoundary(msgs, cutoff, false);
      const after = findClosedPrefixBoundary(msgs, cutoff, true);
      expect(after, `cutoff=${cutoff}`).toBeGreaterThanOrEqual(before);
    }
  });
});
