/**
 * Messages -> Responses bridge: message-role handling.
 *
 * Pins the role validation that newer Claude Code builds exercise by injecting
 * role:"system" entries inside `messages` (system reminders). The bridge must
 * map them to Responses system input items rather than rejecting the request.
 *
 * Run just this file:  pnpm vitest run tests/responses-bridge-roles.test.ts
 */
import { describe, expect, it } from 'vitest';
import { anthropicMessagesToOpenAIResponses } from '../src/core/messages-responses-bridge.js';

const enc = (obj: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(obj));
const dec = (b: Uint8Array): any => JSON.parse(new TextDecoder().decode(b));
const toResponses = (req: unknown): any => dec(anthropicMessagesToOpenAIResponses(enc(req)));

describe('anthropicMessagesToOpenAIResponses — message roles', () => {
  it('maps in-conversation system-role messages to system input items', () => {
    const out = toResponses({
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'system', content: [{ type: 'text', text: 'Available agent types: cdp' }] },
      ],
    });
    const system = out.input.filter((item: any) => item.role === 'system');
    expect(system).toEqual([
      { role: 'system', content: [{ type: 'input_text', text: 'Available agent types: cdp' }] },
    ]);
  });

  it('encodes assistant text as output_text (Responses rejects input_text under role:assistant)', () => {
    const out = toResponses({
      model: 'm',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
        { role: 'assistant', content: 'plain string reply' },
        { role: 'user', content: 'continue' },
      ],
    });
    const assistant = out.input.filter((item: any) => item.role === 'assistant');
    expect(assistant).toEqual([
      { role: 'assistant', content: [{ type: 'output_text', text: 'Hello!' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'plain string reply' }] },
    ]);
    // User text stays input_text.
    const user = out.input.filter((item: any) => item.role === 'user');
    expect(user[0].content[0].type).toBe('input_text');
  });

  it('drops empty system-role messages and rejects unknown roles', () => {
    const out = toResponses({
      model: 'm',
      messages: [
        { role: 'system', content: [] },
        { role: 'user', content: 'q' },
      ],
    });
    expect(out.input.some((item: any) => item.role === 'system')).toBe(false);
    expect(() =>
      toResponses({ model: 'm', messages: [{ role: 'tool', content: 'x' }] }),
    ).toThrow(/user, assistant, or system role/);
  });
});
