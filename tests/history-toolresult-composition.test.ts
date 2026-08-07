/**
 * COMPOSITION contract between the two lossy stages.
 *
 * transformRequest has two independently correct compressions: tool_result
 * imaging and history collapse. Composed in the wrong order they lose content.
 * Once a tool_result has become image blocks, `blocksToText` - the serializer
 * the collapse feeds - renders a nested image as the literal string "[image]".
 * If that same old message is then absorbed by the collapse, the original tool
 * output reaches the wire in neither form: not as text, because the text was
 * replaced by images, and not as pixels, because the collapse replaces whole
 * messages and only renders what the serializer gave it.
 *
 * The invariant that pins the ordering, and the one asserted here, is an
 * equality: what the collapse sees must not depend on whether tool_result
 * imaging is enabled. When imaging runs first, that equality breaks by exactly
 * the size of the imaged bodies - 40k characters of tool output become seven.
 *
 * Run just this file:  pnpm vitest run tests/history-toolresult-composition.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { transformRequest } from '../src/core/transform.js';
import { blocksToText } from '../src/core/history.js';
import { resetSessionState } from '../src/core/session-state.js';
import type { Message } from '../src/core/types.js';

const big = (n: number) => 'x'.repeat(n);
const enc = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));
const dec = (b: Uint8Array): any => JSON.parse(new TextDecoder().decode(b));

const TOOL_BODY_CHARS = 40_000;
const PLAIN_TURNS = 60;
const PLAIN_TURN_CHARS = 3500;

/** One closed tool round: the assistant calls, the user returns the result. */
function toolRound(id: string, body: string): Message[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Read', input: { path: 'notes.txt' } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: body }],
    },
  ] as unknown as Message[];
}

/** N closed plain turns, long enough that the collapse gate accepts. */
function plainTurns(n: number, offset = 0, chars = PLAIN_TURN_CHARS): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      role: (i + offset) % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${i + offset}: ` + big(chars),
    });
  }
  return out;
}

/**
 * Claude Code shape with one OLD tool round deep inside the collapse window:
 *
 *   [0]      user "go"            <- slab anchor, protected prefix
 *   [1..2]   assistant/user       <- the old tool round, big enough to image
 *   [3..62]  plain closed turns   <- pushes the round deep into the collapse window
 *   tail     live region
 */
function bodyWithOldToolResult() {
  const messages: Message[] = [
    { role: 'user', content: 'go' } as Message,
    ...toolRound('t_old', 'RESULT t_old\n' + big(TOOL_BODY_CHARS)),
    ...plainTurns(PLAIN_TURNS, 3, PLAIN_TURN_CHARS),
  ];
  return enc({
    model: 'claude-3-5-sonnet',
    system: [{ type: 'text', text: 'SLAB\n' + big(80_000), cache_control: { type: 'ephemeral' } }],
    messages,
  });
}

/** Same shape plus a FRESH tool round in the live tail, which imaging must still reach. */
function bodyWithOldAndLiveToolResults() {
  const messages: Message[] = [
    { role: 'user', content: 'go' } as Message,
    ...toolRound('t_old', 'RESULT t_old\n' + big(TOOL_BODY_CHARS)),
    ...plainTurns(PLAIN_TURNS, 3),
    ...toolRound('t_live', 'RESULT t_live\n' + big(TOOL_BODY_CHARS)),
  ];
  return enc({
    model: 'claude-3-5-sonnet',
    system: [{ type: 'text', text: 'SLAB\n' + big(80_000), cache_control: { type: 'ephemeral' } }],
    messages,
  });
}

describe('blocksToText - the hazard the ordering protects against', () => {
  it('serializes a nested image to a placeholder, not to its source text', () => {
    const text = blocksToText([
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }],
      },
    ] as any);
    // This is correct behaviour for the serializer and exactly why an imaged
    // tool_result must never be handed to it.
    expect(text).toContain('[image]');
  });
});

describe('tool_result imaging composed with history collapse', () => {
  beforeEach(() => resetSessionState());

  it('gives the collapse the same view whether or not imaging is enabled', async () => {
    const withImaging = await transformRequest(bodyWithOldToolResult());
    resetSessionState();
    const withoutImaging = await transformRequest(bodyWithOldToolResult(), {
      compressToolResults: false,
    });

    expect(withImaging.info.collapsedTurns).toBe(withoutImaging.info.collapsedTurns);
    // The headline invariant: imaging must not change what history sees.
    //
    // Measured on this fixture with the stages in the losing order: 49 collapsed
    // turns either way, but 85,139 chars with imaging against 125,137 without -
    // 39,998 characters gone, the whole 40k tool body less the seven-character
    // "[image]" that replaced it. Equality is what closes that hole, and a
    // partial regression shows up here as a nonzero difference.
    expect(withImaging.info.collapsedChars).toBe(withoutImaging.info.collapsedChars);
    // Both runs must really have exercised the collapse window that holds the
    // tool round, otherwise the equality above is vacuous.
    expect(withImaging.info.collapsedChars ?? 0).toBeGreaterThan(TOOL_BODY_CHARS);
  });

  it('still images a tool_result that survives in the live region', async () => {
    const { body: out, info } = await transformRequest(bodyWithOldAndLiveToolResults());

    expect(info.collapsedTurns ?? 0).toBeGreaterThan(0);
    // Reordering must not silently disable imaging: the live round is outside the
    // collapsed prefix and is still eligible.
    expect(info.toolResultImgs ?? 0).toBeGreaterThan(0);

    const msgs = dec(out).messages as any[];
    const liveImaged = msgs.some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some(
          (b: any) =>
            b?.type === 'tool_result' &&
            b.tool_use_id === 't_live' &&
            Array.isArray(b.content) &&
            b.content.some((ib: any) => ib?.type === 'image'),
        ),
    );
    expect(liveImaged).toBe(true);
  });

  it('does not leave an orphaned tool_use without its tool_result', async () => {
    const { body: out } = await transformRequest(bodyWithOldAndLiveToolResults());
    const msgs = dec(out).messages as any[];

    const useIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const m of msgs) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b?.type === 'tool_use' && b.id) useIds.add(b.id);
        if (b?.type === 'tool_result' && b.tool_use_id) resultIds.add(b.tool_use_id);
      }
    }
    for (const id of useIds) expect(resultIds.has(id)).toBe(true);
  });
});
