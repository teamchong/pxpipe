import { describe, expect, it } from 'vitest';
import {
  buildBaselineCountTokensBody,
  buildCacheablePrefixCountTokensBody,
} from '../src/core/measurement.js';

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const dec = (b: Uint8Array | null) => JSON.parse(new TextDecoder().decode(b!));

// Shape of a real Claude Code 2.1.281 thread continue (wdA/281 capture).
const continueBody = {
  model: 'claude-opus-5-5',
  thread: { type: 'continue', previous_message_id: 'msg_x' },
  diagnostics: {},
  system: [{ type: 'text', text: 'sys' }],
  messages: [
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: 'big output', cache_control: { type: 'ephemeral' } }],
    },
  ],
};

describe('count_tokens bodies for server-side thread deltas', () => {
  it('pairs an orphan tool_result with a synthetic tool_use so the probe is countable', () => {
    const out = dec(buildBaselineCountTokensBody(enc(continueBody)));
    expect(out.thread).toBeUndefined();
    expect(out.diagnostics).toBeUndefined();
    expect(out.messages).toHaveLength(3);
    expect(out.messages[0]).toEqual({ role: 'user', content: 'x' });
    expect(out.messages[1].role).toBe('assistant');
    expect(out.messages[1].content).toEqual([{ type: 'tool_use', id: 'toolu_A', name: 'x', input: {} }]);
    expect(out.messages[2]).toEqual(continueBody.messages[0]);
  });

  it('also repairs the cacheable-prefix body', () => {
    const out = dec(buildCacheablePrefixCountTokensBody(enc(continueBody)));
    expect(out.messages[1].content[0].id).toBe('toolu_A');
  });

  it('leaves a full (non-thread) body untouched', () => {
    const full = {
      model: 'm',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ],
    };
    expect(dec(buildBaselineCountTokensBody(enc(full)))).toEqual(full);
  });
});
