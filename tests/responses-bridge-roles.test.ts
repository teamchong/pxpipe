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
import {
  anthropicMessagesToOpenAIResponses,
  openAIResponseToAnthropicMessage,
  openAIResponsesStreamToAnthropic,
} from '../src/core/messages-responses-bridge.js';

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

describe('openAIResponseToAnthropicMessage — function-call arguments', () => {
  it('treats an empty arguments string as {} instead of throwing', () => {
    // A no-arg tool call can arrive as arguments:"" — JSON.parse('') would
    // throw and fail the whole turn. Must degrade to empty input.
    const msg = openAIResponseToAnthropicMessage(
      { id: 'resp_1', model: 'gpt', output: [
        { type: 'function_call', call_id: 'c1', name: 'now', arguments: '' },
      ] },
      'fallback',
    );
    const toolUse = (msg.content as any[]).find((b) => b.type === 'tool_use');
    expect(toolUse).toMatchObject({ type: 'tool_use', id: 'c1', name: 'now', input: {} });
    expect(msg.stop_reason).toBe('tool_use');
  });
});

describe('OpenAI Responses reasoning summaries', () => {
  it('uses a completed reasoning summary when no output text is present', () => {
    const msg = openAIResponseToAnthropicMessage({
      id: 'resp_summary',
      model: 'gpt',
      output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'compact summary' }] }],
    }, 'fallback');

    expect(msg.content).toEqual([{ type: 'text', text: 'compact summary' }]);
  });

  it('uses output message text over reasoning summary in non-streaming response when both are present', () => {
    const msg = openAIResponseToAnthropicMessage({
      id: 'resp_both',
      model: 'gpt',
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'internal thought summary' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'final answer' }] },
      ],
    }, 'fallback');

    expect(msg.content).toEqual([{ type: 'text', text: 'final answer' }]);
  });

  it('streams a reasoning-summary-only response as Anthropic text', async () => {
    const source = [
      ['response.created', { response: { id: 'resp_summary', model: 'gpt' } }],
      ['response.reasoning_summary_text.delta', { delta: 'compact ' }],
      ['response.reasoning_summary_text.delta', { delta: 'summary' }],
      ['response.completed', { response: { id: 'resp_summary', model: 'gpt', output: [] } }],
    ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
    const input = new Response(source).body!;
    const output = await new Response(openAIResponsesStreamToAnthropic(input, 'fallback')).text();

    expect(output).toContain('"type":"text_delta","text":"compact summary"');
    expect(output).toContain('event: message_stop');
  });

  it('joins multiple reasoning items from a terminal streaming snapshot', async () => {
    const source = `event: response.completed\ndata: ${JSON.stringify({ response: {
      id: 'resp_summary', model: 'gpt', output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'compact ' }] },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'summary' }] },
      ],
    } })}\n\n`;
    const output = await new Response(openAIResponsesStreamToAnthropic(new Response(source).body!, 'fallback')).text();

    expect(output).toContain('"type":"text_delta","text":"compact summary"');
  });

  it('emits streamed reasoning summary before unstreamed terminal output item', async () => {
    const source = [
      ['response.reasoning_summary_text.delta', { delta: 'streamed summary' }],
      ['response.output_item.done', { item: { type: 'message', content: [{ type: 'output_text', text: 'final answer' }] } }],
      ['response.completed', { response: { id: 'resp_summary', model: 'gpt', output: [] } }],
    ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
    const output = await new Response(openAIResponsesStreamToAnthropic(new Response(source).body!, 'fallback')).text();

    expect(output).toContain('"text":"streamed summary"');
    expect(output).toContain('"text":"final answer"');
  });

  it('handles terminal output array with message before reasoning', async () => {
    const source = `event: response.completed\ndata: ${JSON.stringify({ response: {
      id: 'resp_summary', model: 'gpt', output: [
        { type: 'message', content: [{ type: 'output_text', text: 'final answer' }] },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'reasoning text' }] },
      ],
    } })}\n\n`;
    const output = await new Response(openAIResponsesStreamToAnthropic(new Response(source).body!, 'fallback')).text();

    expect(output).toContain('"text":"reasoning text"');
    expect(output).toContain('"text":"final answer"');
  });
});
