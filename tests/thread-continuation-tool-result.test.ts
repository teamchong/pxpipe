/**
 * tool_result imaging must not depend on the system slab clearing its gate.
 *
 * Claude Code >= 2.1.281 on a first-party host (pxpipe warp) uses server-side
 * threads: after the first `thread: {type:"create"}` request, every follow-up is
 * `thread: {type:"continue", previous_message_id}` carrying only the delta - no
 * `tools`, and a `system` that is just the billing line. The slab is therefore
 * empty, the request takes the below_min_chars early exit, and before this fix
 * that exit only tried history collapse (which has no closed prefix in a delta),
 * so a large tool_result in the delta went out as text.
 *
 * Run just this file:  pnpm vitest run tests/thread-continuation-tool-result.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { transformRequest } from '../src/core/transform.js';
import { resetSessionState } from '../src/core/session-state.js';

const enc = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));
const dec = (b: Uint8Array): any => JSON.parse(new TextDecoder().decode(b));

function fileBody(lines: number): string {
  let s = '';
  for (let i = 0; i < lines; i++) {
    s += `line ${i}: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod\n`;
  }
  return s;
}

/** The shape of a thread continuation, as sent by Claude Code 2.1.281+. */
function continuation(toolResult: string) {
  return {
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    thread: { type: 'continue', previous_message_id: 'msg_test_previous' },
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.281.abc; cc_entrypoint=sdk-cli;' }],
    messages: [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_test_1', content: toolResult }],
      },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ],
  };
}

describe('tool_result imaging below the slab gate', () => {
  beforeEach(() => resetSessionState());

  it('images a large tool_result in a thread continuation delta', async () => {
    const { body, info } = await transformRequest(enc(continuation(fileBody(1500))));
    expect(info.reason).toMatch(/below_min_chars/);
    expect(info.compressed).toBe(true);
    expect(info.toolResultImgs ?? 0).toBeGreaterThan(0);

    const out = dec(body);
    const tr = out.messages[0].content[0];
    expect(tr.type).toBe('tool_result');
    expect(Array.isArray(tr.content)).toBe(true);
    expect(tr.content.some((b: { type: string }) => b.type === 'image')).toBe(true);
  });

  it('leaves the request shape alone: thread, system and the absent tools field', async () => {
    const req = continuation(fileBody(1500));
    const out = dec((await transformRequest(enc(req))).body);
    expect(out.thread).toEqual(req.thread);
    expect(out.system).toEqual(req.system);
    expect('tools' in out).toBe(false);
    expect(out.messages[1]).toEqual(req.messages[1]);
  });

  it('still passes a small tool_result through byte-identical', async () => {
    const bytes = enc(continuation('a.txt  6B\nb.txt  6B'));
    const { body, info } = await transformRequest(bytes);
    expect(info.compressed).toBe(false);
    expect(new TextDecoder().decode(body)).toBe(new TextDecoder().decode(bytes));
  });
});
