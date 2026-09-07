/**
 * Messages -> Chat Completions bridge (TDD).
 *
 * Pins the wire translation that lets Claude Code drive Kimi through
 * Cloudflare's OpenAI-compatible endpoint using the Anthropic schema it speaks.
 *
 * Run just this file:  pnpm vitest run tests/chat-bridge.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  anthropicMessagesToOpenAIChat,
  openAIChatToAnthropicMessage,
  openAIChatStreamToAnthropic,
  chatCompletionsUrl,
} from '../src/core/messages-chat-bridge.js';

const enc = (obj: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(obj));
const dec = (b: Uint8Array): any => JSON.parse(new TextDecoder().decode(b));

/** Convert an Anthropic request object to the Chat Completions object. */
function toChat(req: unknown): any {
  return dec(anthropicMessagesToOpenAIChat(enc(req)));
}

describe('chatCompletionsUrl — accepts bare host, /v1 base, or full URL', () => {
  it('uses a full /chat/completions URL verbatim (Cloudflare Workers AI shape)', () => {
    const full =
      'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1/chat/completions';
    expect(chatCompletionsUrl(full)).toBe(full);
    // Trailing slashes are trimmed, not double-suffixed.
    expect(chatCompletionsUrl(full + '/')).toBe(full);
  });

  it('appends /chat/completions to a /vN base', () => {
    expect(chatCompletionsUrl('https://api.moonshot.ai/v1')).toBe(
      'https://api.moonshot.ai/v1/chat/completions',
    );
  });

  it('appends /v1/chat/completions to a bare host', () => {
    expect(chatCompletionsUrl('https://example.test')).toBe(
      'https://example.test/v1/chat/completions',
    );
  });
});

describe('anthropicMessagesToOpenAIChat — request translation', () => {
  it('carries model, hoists system to a system message, and preserves user text', () => {
    const out = toChat({
      model: 'moonshotai/kimi-k3',
      system: 'You are terse.',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.model).toBe('moonshotai/kimi-k3');
    expect(out.max_tokens).toBe(256);
    expect(out.messages[0]).toEqual({ role: 'system', content: 'You are terse.' });
    expect(out.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('joins an array-form system prompt into a single string', () => {
    const out = toChat({
      model: 'm',
      system: [
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ],
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(out.messages[0]).toEqual({ role: 'system', content: 'line one\nline two' });
  });

  it('collapses a lone text block to a plain string', () => {
    const out = toChat({
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'just text' }] }],
    });
    expect(out.messages[0]).toEqual({ role: 'user', content: 'just text' });
  });

  it('maps an image block to image_url with a data URL', () => {
    const out = toChat({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
            },
          ],
        },
      ],
    });
    expect(out.messages[0].content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ]);
  });

  it('lifts assistant tool_use into OpenAI tool_calls with stringified arguments', () => {
    const out = toChat({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling' },
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SF' } },
          ],
        },
      ],
    });
    const msg = out.messages[0];
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('calling');
    expect(msg.tool_calls).toEqual([
      {
        id: 'toolu_1',
        type: 'function',
        function: { name: 'get_weather', arguments: JSON.stringify({ city: 'SF' }) },
      },
    ]);
  });

  it('omits Anthropic thinking blocks from assistant history', () => {
    const out = toChat({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'private reasoning', signature: 'sig' },
            { type: 'redacted_thinking', data: 'opaque' },
            { type: 'text', text: 'visible answer' },
            { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([
      {
        role: 'assistant',
        content: 'visible answer',
        tool_calls: [
          {
            id: 'toolu_1',
            type: 'function',
            function: { name: 'lookup', arguments: JSON.stringify({ q: 'x' }) },
          },
        ],
      },
    ]);
  });

  it('turns a user tool_result into a standalone tool message', () => {
    const out = toChat({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: '72F and sunny' },
            { type: 'text', text: 'thanks' },
          ],
        },
      ],
    });
    expect(out.messages[0]).toEqual({
      role: 'tool',
      tool_call_id: 'toolu_1',
      content: '72F and sunny',
    });
    expect(out.messages[1]).toEqual({ role: 'user', content: 'thanks' });
  });

  it('prefixes a failed tool_result so the model sees the error', () => {
    const out = toChat({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't', content: 'boom', is_error: true },
          ],
        },
      ],
    });
    expect(out.messages[0].content).toBe('[Tool execution failed]\nboom');
  });

  it('forwards tool_result images in a following multimodal user message', () => {
    const out = toChat({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [
                { type: 'text', text: 'Rendered image:' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([
      { role: 'tool', tool_call_id: 'toolu_1', content: 'Rendered image:' },
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }],
      },
    ]);
  });

  it('places returned images before the follow-up text for vision providers', () => {
    const out = toChat({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [
                { type: 'text', text: 'Image read successfully.' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
              ],
            },
            { type: 'text', text: 'What is in the image?' },
          ],
        },
      ],
    });
    expect(out.messages[1].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
      { type: 'text', text: 'What is in the image?' },
    ]);
  });

  it('keeps parallel tool responses contiguous before returned images', () => {
    const out = toChat({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QQ==' } }],
            },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: 'second result' },
          ],
        },
      ],
    });
    expect(out.messages.map((message: any) => message.role)).toEqual(['tool', 'tool', 'user']);
    expect(out.messages[0]).toMatchObject({ tool_call_id: 'toolu_1', content: '' });
    expect(out.messages[1]).toMatchObject({ tool_call_id: 'toolu_2', content: 'second result' });
    expect(out.messages[2].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QQ==' } },
    ]);
  });

  it('translates tools and tool_choice into the OpenAI function schema', () => {
    const out = toChat({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tool_choice: { type: 'tool', name: 'lookup' },
      tools: [
        {
          name: 'lookup',
          description: 'find a thing',
          input_schema: { type: 'object', properties: { q: { type: 'string' } } },
        },
      ],
    });
    expect(out.tool_choice).toEqual({ type: 'function', function: { name: 'lookup' } });
    expect(out.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'find a thing',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      },
    ]);
  });

  it('maps tool_choice:any to required and passes stop_sequences as stop', () => {
    const out = toChat({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tool_choice: { type: 'any' },
      stop_sequences: ['STOP'],
    });
    expect(out.tool_choice).toBe('required');
    expect(out.stop).toEqual(['STOP']);
  });

  it('requests stream usage so a streamed turn reports token counts', () => {
    const streamed = toChat({ model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true });
    expect(streamed.stream).toBe(true);
    expect(streamed.stream_options).toEqual({ include_usage: true });
    // Non-streaming turns must not carry stream_options.
    const buffered = toChat({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    expect(buffered.stream_options).toBeUndefined();
  });

  it('maps enabled thinking budgets to a reasoning_effort bucket', () => {
    const base = { model: 'm', messages: [{ role: 'user', content: 'x' }] };
    const low = toChat({ ...base, thinking: { type: 'enabled', budget_tokens: 4096 } });
    const medium = toChat({ ...base, thinking: { type: 'enabled', budget_tokens: 16000 } });
    const high = toChat({ ...base, thinking: { type: 'enabled', budget_tokens: 32000 } });
    expect(low.reasoning_effort).toBe('low');
    expect(medium.reasoning_effort).toBe('medium');
    expect(high.reasoning_effort).toBe('high');
    // Disabled or absent thinking leaves reasoning_effort unset.
    expect(toChat({ ...base, thinking: { type: 'disabled' } }).reasoning_effort).toBeUndefined();
    expect(toChat(base).reasoning_effort).toBeUndefined();
  });

  it('rejects a non-array messages field as an invalid request', () => {
    expect(() => anthropicMessagesToOpenAIChat(enc({ model: 'm', messages: 'nope' }))).toThrow(
      /messages must be an array/,
    );
  });

  it('maps in-conversation system-role messages (new Claude Code shape) to chat system messages', () => {
    // Newer Claude Code builds inject system reminders as role:"system" entries
    // inside `messages`, alongside user/assistant turns.
    const out = toChat({
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'system', content: [{ type: 'text', text: 'Available agent types: cdp' }] },
      ],
    });
    expect(out.messages.map((m: any) => m.role)).toEqual(['user', 'system']);
    expect(out.messages[1]).toEqual({ role: 'system', content: 'Available agent types: cdp' });
  });

  it('drops empty system-role messages and rejects unknown roles', () => {
    const out = toChat({
      model: 'm',
      messages: [
        { role: 'system', content: [] },
        { role: 'user', content: 'q' },
      ],
    });
    expect(out.messages.map((m: any) => m.role)).toEqual(['user']);
    expect(() =>
      anthropicMessagesToOpenAIChat(enc({ model: 'm', messages: [{ role: 'tool', content: 'x' }] })),
    ).toThrow(/user, assistant, or system role/);
  });
});

describe('openAIChatToAnthropicMessage — buffered response translation', () => {
  it('wraps assistant text and normalizes id/usage/stop_reason', () => {
    const msg = openAIChatToAnthropicMessage(
      {
        id: 'chatcmpl-abc',
        model: 'moonshotai/kimi-k3',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      },
      'fallback',
    );
    expect(msg.id).toBe('msg_abc');
    expect(msg.type).toBe('message');
    expect(msg.role).toBe('assistant');
    expect(msg.model).toBe('moonshotai/kimi-k3');
    expect(msg.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(msg.stop_reason).toBe('end_turn');
    expect(msg.usage).toEqual({
      input_tokens: 10,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it('subtracts cached tokens from input and reports them as cache_read', () => {
    const msg = openAIChatToAnthropicMessage(
      {
        choices: [{ finish_reason: 'stop', message: { content: 'x' } }],
        usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } },
      },
      'fallback',
    );
    expect(msg.usage).toMatchObject({ input_tokens: 60, cache_read_input_tokens: 40 });
  });

  it('converts tool_calls into tool_use and sets stop_reason tool_use', () => {
    const msg = openAIChatToAnthropicMessage(
      {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                { id: 'call_9', function: { name: 'search', arguments: '{"q":"cats"}' } },
              ],
            },
          },
        ],
      },
      'fallback',
    );
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.content).toEqual([
      { type: 'tool_use', id: 'call_9', name: 'search', input: { q: 'cats' } },
    ]);
  });

  it('maps finish_reason length to max_tokens and falls back to the model name', () => {
    const msg = openAIChatToAnthropicMessage(
      { choices: [{ finish_reason: 'length', message: { content: 'truncated' } }] },
      'moonshotai/kimi-k3',
    );
    expect(msg.stop_reason).toBe('max_tokens');
    expect(msg.model).toBe('moonshotai/kimi-k3');
    expect(msg.id).toBe('msg_pxpipe');
  });

  it('emits an empty text block when the assistant returns no content', () => {
    const msg = openAIChatToAnthropicMessage(
      { choices: [{ finish_reason: 'stop', message: { content: '' } }] },
      'fallback',
    );
    expect(msg.content).toEqual([{ type: 'text', text: '' }]);
  });
});

describe('openAIChatStreamToAnthropic — SSE translation', () => {
  async function collect(chunks: string[]): Promise<string> {
    const src = new ReadableStream<Uint8Array>({
      start(controller) {
        const e = new TextEncoder();
        for (const c of chunks) controller.enqueue(e.encode(c));
        controller.close();
      },
    });
    const out = openAIChatStreamToAnthropic(src, 'moonshotai/kimi-k3');
    const reader = out.getReader();
    const d = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += d.decode(value, { stream: true });
    }
    return text;
  }

  it('renders a text stream as Anthropic content-block events', async () => {
    const text = await collect([
      'data: {"id":"chatcmpl-1","model":"moonshotai/kimi-k3","choices":[{"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    expect(text).toContain('event: message_start');
    expect(text).toContain('"id":"msg_1"');
    expect(text).toContain('event: content_block_start');
    expect(text).toContain('event: content_block_delta');
    expect(text).toContain('Hel');
    expect(text).toContain('lo');
    expect(text).toContain('event: content_block_stop');
    expect(text).toContain('event: message_delta');
    expect(text).toContain('event: message_stop');
  });

  it('surfaces a malformed upstream event as an Anthropic error event', async () => {
    const text = await collect(['data: {not json}\n\n']);
    expect(text).toContain('event: error');
    expect(text).toContain('api_error');
  });

  it('keeps index-less tool-call argument fragments in one tool_use block', async () => {
    // Some OpenAI-compatible providers omit `index` on tool-call deltas and
    // split arguments across chunks. A new call is signaled by id/name; the
    // args-only continuation must append to the same block, not open a second.
    const text = await collect([
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"search","arguments":"{\\"q\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"\\"cats\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const events = text.split('\n\n').filter(Boolean).map((block) => {
      const line = block.split('\n').find((l) => l.startsWith('data: '))!;
      return JSON.parse(line.slice(6)) as any;
    });
    const toolStarts = events.filter(
      (e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use',
    );
    expect(toolStarts).toHaveLength(1); // one block, not split into two
    expect(toolStarts[0].content_block.name).toBe('search');
    const args = events
      .filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta')
      .map((e) => e.delta.partial_json)
      .join('');
    expect(args).toBe('{"q":"cats"}'); // fragments concatenate to valid JSON
  });
});

describe('anthropicMessagesToOpenAIChat — model override', () => {
  it('stamps the override model id, replacing the client-sent claude-* id', () => {
    const out = dec(
      anthropicMessagesToOpenAIChat(
        enc({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'hi' }] }),
        '@cf/moonshotai/kimi-k2-instruct',
      ),
    );
    expect(out.model).toBe('@cf/moonshotai/kimi-k2-instruct');
  });

  it('preserves the client-sent model id when no override is supplied', () => {
    expect(toChat({ model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }] }).model).toBe(
      'kimi-k3',
    );
  });

  it('ignores an empty-string override (treated as absent)', () => {
    const out = dec(
      anthropicMessagesToOpenAIChat(
        enc({ model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }] }),
        '',
      ),
    );
    expect(out.model).toBe('kimi-k3');
  });
});
