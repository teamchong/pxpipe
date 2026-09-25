/**
 * Anthropic Messages wire compatibility for OpenAI Chat Completions upstreams.
 *
 * Lets Claude Code (which only speaks the Anthropic /v1/messages schema) drive
 * Kimi through Cloudflare's OpenAI-compatible Chat Completions endpoint. This
 * module is pure wire translation and contains no credentials.
 *
 * Mirrors messages-responses-bridge.ts, but targets /v1/chat/completions rather
 * than the Responses API.
 */

type JsonObject = Record<string, unknown>;

function invalidRequest(message: string): never {
  const error = new Error(message);
  error.name = 'MessagesBridgeInvalidRequest';
  throw error;
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function textFromBlocks(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) invalidRequest('system must be a string or an array of text blocks');
  return value.map((part) => {
    const p = object(part);
    if (p?.type !== 'text' || typeof p.text !== 'string') {
      invalidRequest(`Unsupported system content block: ${String(p?.type ?? 'invalid')}`);
    }
    return p.text;
  }).join('\n');
}

function imageUrl(source: unknown): string | undefined {
  const s = object(source);
  if (s?.type === 'base64' && typeof s.media_type === 'string' && typeof s.data === 'string') {
    return `data:${s.media_type};base64,${s.data}`;
  }
  if (s?.type === 'url' && typeof s.url === 'string' && /^https?:\/\//.test(s.url)) return s.url;
  return undefined;
}

/** Build Chat Completions content parts from an Anthropic content array/string. */
function contentParts(content: unknown, location: string): string | JsonObject[] {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) invalidRequest(`${location} content must be a string or an array`);
  const out: JsonObject[] = [];
  for (const raw of content) {
    const part = object(raw);
    if (part?.type === 'text' && typeof part.text === 'string') {
      out.push({ type: 'text', text: part.text });
    } else if (part?.type === 'image') {
      const url = imageUrl(part.source);
      if (!url) invalidRequest(`Unsupported ${location} image source`);
      out.push({ type: 'image_url', image_url: { url } });
    } else {
      invalidRequest(`Unsupported ${location} content block: ${String(part?.type ?? 'invalid')}`);
    }
  }
  // Collapse a lone text part to a plain string — the shape most providers prefer.
  if (out.length === 1 && out[0]?.type === 'text') return String(out[0].text ?? '');
  return out;
}

/** Split a tool_result into text for the Chat `tool` message and visual parts
 *  that must be sent in a following multimodal `user` message. */
function toolResultContent(content: unknown, isError: boolean): {
  text: string;
  images: JsonObject[];
} {
  const prefix = isError ? '[Tool execution failed]\n' : '';
  if (typeof content === 'string') return { text: prefix + content, images: [] };
  if (!Array.isArray(content)) {
    return { text: prefix + JSON.stringify(content ?? ''), images: [] };
  }
  const pieces: string[] = [];
  const images: JsonObject[] = [];
  for (const raw of content) {
    const part = object(raw);
    if (part?.type === 'text' && typeof part.text === 'string') pieces.push(part.text);
    else if (part?.type === 'image') {
      const url = imageUrl(part.source);
      if (!url) invalidRequest('Unsupported tool_result image source');
      images.push({ type: 'image_url', image_url: { url } });
    }
    else pieces.push(JSON.stringify(raw ?? ''));
  }
  return { text: prefix + pieces.join('\n'), images };
}

/** Map Anthropic extended-thinking config to an OpenAI `reasoning_effort` bucket.
 *  Claude Code sends `thinking: { type: 'enabled', budget_tokens: N }`; OpenAI-
 *  compatible reasoning models (Kimi, etc.) take a coarse low/medium/high knob.
 *  We use the universal three values — Kimi also accepts `max`, but staying in
 *  the standard set keeps this provider-agnostic. */
function reasoningEffort(value: unknown): string | undefined {
  const thinking = object(value);
  if (thinking?.type !== 'enabled') return undefined;
  const budget = typeof thinking.budget_tokens === 'number' ? thinking.budget_tokens : 0;
  if (budget >= 32000) return 'high';
  if (budget >= 8000) return 'medium';
  return 'low';
}

function mapToolChoice(value: unknown): unknown {
  const choice = object(value);
  if (!choice || typeof choice.type !== 'string') return undefined;
  if (choice.type === 'auto' || choice.type === 'none') return choice.type;
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool' && typeof choice.name === 'string') {
    return { type: 'function', function: { name: choice.name } };
  }
  return undefined;
}

/** Convert a Claude Code Messages request into an OpenAI Chat Completions request. */
export function anthropicMessagesToOpenAIChat(body: Uint8Array, modelOverride?: string): Uint8Array {
  const req = JSON.parse(new TextDecoder().decode(body)) as JsonObject;
  const messages: JsonObject[] = [];

  const instructions = textFromBlocks(req.system);
  if (instructions) messages.push({ role: 'system', content: instructions });

  if (!Array.isArray(req.messages)) invalidRequest('messages must be an array');
  for (const rawMessage of req.messages) {
    const message = object(rawMessage);
    if (!message
      || (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system')) {
      invalidRequest('Each message must have a user, assistant, or system role');
    }
    // Newer Claude Code builds inject system-role messages mid-conversation
    // (e.g. system reminders); map them to Chat Completions system messages.
    if (message.role === 'system') {
      const text = textFromBlocks(message.content);
      if (text) messages.push({ role: 'system', content: text });
      continue;
    }
    const role = message.role as 'user' | 'assistant';
    const content = message.content;

    if (!Array.isArray(content)) {
      const parts = contentParts(content, `${role} message`);
      if (typeof parts === 'string' ? parts.length : parts.length) {
        messages.push({ role, content: parts });
      }
      continue;
    }

    if (role === 'assistant') {
      // Assistant turn: gather text/image into content, tool_use into tool_calls.
      const ordinary: JsonObject[] = [];
      const toolCalls: JsonObject[] = [];
      for (const rawPart of content) {
        const part = object(rawPart);
        if (part?.type === 'tool_use' && typeof part.id === 'string' && typeof part.name === 'string') {
          toolCalls.push({
            id: part.id,
            type: 'function',
            function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
          });
        } else if (part?.type === 'text' && typeof part.text === 'string') {
          ordinary.push({ type: 'text', text: part.text });
        } else if (part?.type === 'image') {
          const url = imageUrl(part.source);
          if (!url) invalidRequest('Unsupported assistant image source');
          ordinary.push({ type: 'image_url', image_url: { url } });
        } else if (part?.type === 'thinking' || part?.type === 'redacted_thinking') {
          // Chat Completions has no portable representation for Anthropic's
          // signed thinking history. Keep the visible answer and tool calls.
          continue;
        } else {
          invalidRequest(`Unsupported assistant content block: ${String(part?.type ?? 'invalid')}`);
        }
      }
      const msg: JsonObject = { role: 'assistant' };
      const text = ordinary.filter((p) => p.type === 'text').map((p) => String(p.text ?? '')).join('');
      const hasImage = ordinary.some((p) => p.type === 'image_url');
      msg.content = hasImage ? ordinary : (text || (toolCalls.length ? null : ''));
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
      continue;
    }

    // User turn: emit every tool response contiguously after the assistant
    // tool_calls. Chat `tool` content is text-only, so returned images move to
    // the following multimodal user message with any ordinary user content.
    const ordinary: JsonObject[] = [];
    const toolMessages: JsonObject[] = [];
    const toolImages: JsonObject[] = [];
    for (const rawPart of content) {
      const part = object(rawPart);
      if (part?.type === 'tool_result' && typeof part.tool_use_id === 'string') {
        const result = toolResultContent(part.content, part.is_error === true);
        toolMessages.push({
          role: 'tool',
          tool_call_id: part.tool_use_id,
          content: result.text,
        });
        toolImages.push(...result.images);
      } else if (part?.type === 'text' && typeof part.text === 'string') {
        ordinary.push({ type: 'text', text: part.text });
      } else if (part?.type === 'image') {
        const url = imageUrl(part.source);
        if (!url) invalidRequest('Unsupported user image source');
        ordinary.push({ type: 'image_url', image_url: { url } });
      } else {
        invalidRequest(`Unsupported user content block: ${String(part?.type ?? 'invalid')}`);
      }
    }
    messages.push(...toolMessages);
    const userParts = [...toolImages, ...ordinary];
    if (userParts.length) {
      const sole = userParts.length === 1 ? userParts[0] : undefined;
      messages.push({
        role: 'user',
        content: sole?.type === 'text' ? String(sole.text ?? '') : userParts,
      });
    }
  }

  // A blank override is treated as absent (consistent with the env-parsing
  // boundary), so the client-sent model id falls through.
  const out: JsonObject = { model: modelOverride || req.model, messages };
  if (typeof req.max_tokens === 'number') out.max_tokens = req.max_tokens;
  // top_k is in both Anthropic's schema and the Cloudflare Workers AI chat
  // schema (though not vanilla OpenAI's); forward it — unknown-field-tolerant
  // upstreams ignore it, and CF actually honors it.
  for (const key of ['stream', 'temperature', 'top_p', 'top_k', 'metadata']) {
    if (req[key] !== undefined) out[key] = req[key];
  }
  // OpenAI-compatible endpoints only report token usage on a streamed response
  // when include_usage is set. Anthropic's schema has no equivalent, so request
  // it ourselves — otherwise Claude Code sees zero usage for streaming turns.
  if (req.stream === true) out.stream_options = { include_usage: true };
  const effort = reasoningEffort(req.thinking);
  if (effort !== undefined) out.reasoning_effort = effort;
  if (Array.isArray(req.stop_sequences)) out.stop = req.stop_sequences;
  const toolChoice = mapToolChoice(req.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  if (Array.isArray(req.tools)) {
    const tools = req.tools.flatMap((raw) => {
      const tool = object(raw);
      if (!tool || typeof tool.name !== 'string') return [];
      return [{
        type: 'function',
        function: {
          name: tool.name,
          ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
          parameters: tool.input_schema ?? { type: 'object', properties: {} },
        },
      }];
    });
    if (tools.length) out.tools = tools;
  }
  return new TextEncoder().encode(JSON.stringify(out));
}

function anthropicUsage(raw: unknown): JsonObject {
  const usage = object(raw) ?? {};
  const details = object(usage.prompt_tokens_details);
  const total = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const cached = typeof details?.cached_tokens === 'number' ? details.cached_tokens : 0;
  return {
    input_tokens: Math.max(0, total - cached),
    output_tokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  };
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string' || value.trim() === '') return {};
  try { return JSON.parse(value); } catch {
    throw new Error('OpenAI returned malformed function-call arguments');
  }
}

function stopReason(finish: unknown, hasToolUse: boolean): string {
  if (hasToolUse) return 'tool_use';
  switch (finish) {
    case 'length': return 'max_tokens';
    case 'tool_calls':
    case 'function_call': return 'tool_use';
    case 'content_filter': return 'refusal';
    case 'stop': return 'end_turn';
    default: return 'end_turn';
  }
}

/** Convert one completed Chat Completions JSON object into Anthropic Messages JSON. */
export function openAIChatToAnthropicMessage(response: unknown, fallbackModel: string): JsonObject {
  const r = object(response) ?? {};
  const choice = Array.isArray(r.choices) ? object(r.choices[0]) : undefined;
  const message = object(choice?.message) ?? {};
  const content: JsonObject[] = [];
  let hasToolUse = false;

  if (typeof message.content === 'string' && message.content.length) {
    content.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const raw of message.content) {
      const part = object(raw);
      if (part?.type === 'text' && typeof part.text === 'string') {
        content.push({ type: 'text', text: part.text });
      }
    }
  }
  if (Array.isArray(message.tool_calls)) {
    for (const raw of message.tool_calls) {
      const call = object(raw);
      const fn = object(call?.function);
      if (!fn || typeof fn.name !== 'string') continue;
      hasToolUse = true;
      content.push({
        type: 'tool_use',
        id: typeof call?.id === 'string' ? call.id : `call_${content.length}`,
        name: fn.name,
        input: parseArguments(fn.arguments),
      });
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });

  const id = typeof r.id === 'string' ? r.id.replace(/^chatcmpl[-_]/, 'msg_') : 'msg_pxpipe';
  return {
    id,
    type: 'message',
    role: 'assistant',
    model: typeof r.model === 'string' ? r.model : fallbackModel,
    content,
    stop_reason: stopReason(choice?.finish_reason, hasToolUse),
    stop_sequence: null,
    usage: anthropicUsage(r.usage),
  };
}

function sse(event: string, data: JsonObject): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface StreamCall {
  index: number; // Anthropic content-block index
  started: boolean;
}

interface StreamState {
  started: boolean;
  terminated: boolean;
  id: string;
  model: string;
  nextIndex: number;
  textIndex?: number;
  textOpen: boolean;
  sawTool: boolean;
  finish?: unknown;
  usage?: JsonObject;
  // OpenAI tool_calls stream by their own `index`; map it to our block state.
  calls: Map<number, StreamCall>;
  // Key of the most recently seen tool call, so index-less continuation
  // fragments (providers that don't repeat `index`) append to the open call
  // instead of opening a spurious new block.
  lastToolKey?: number;
}

function chatStreamEvent(chunk: JsonObject, state: StreamState): string {
  let out = '';
  const ensureStart = (): void => {
    if (state.started) return;
    if (typeof chunk.id === 'string') state.id = chunk.id.replace(/^chatcmpl[-_]/, 'msg_');
    if (typeof chunk.model === 'string') state.model = chunk.model;
    state.started = true;
    out += sse('message_start', {
      type: 'message_start',
      message: {
        id: state.id, type: 'message', role: 'assistant', model: state.model,
        content: [], stop_reason: null, stop_sequence: null, usage: anthropicUsage(undefined),
      },
    });
  };
  const openText = (): void => {
    ensureStart();
    if (state.textOpen) return;
    state.textIndex = state.nextIndex++;
    state.textOpen = true;
    out += sse('content_block_start', {
      type: 'content_block_start', index: state.textIndex, content_block: { type: 'text', text: '' },
    });
  };
  const closeText = (): void => {
    if (!state.textOpen || state.textIndex === undefined) return;
    out += sse('content_block_stop', { type: 'content_block_stop', index: state.textIndex });
    state.textOpen = false;
  };

  if (chunk.usage) state.usage = anthropicUsage(chunk.usage);
  const choice = Array.isArray(chunk.choices) ? object(chunk.choices[0]) : undefined;
  if (!choice) { ensureStart(); return out; }
  if (choice.finish_reason != null) state.finish = choice.finish_reason;
  const delta = object(choice.delta) ?? {};

  if (typeof delta.content === 'string' && delta.content.length) {
    openText();
    out += sse('content_block_delta', {
      type: 'content_block_delta', index: state.textIndex,
      delta: { type: 'text_delta', text: delta.content },
    });
  }

  if (Array.isArray(delta.tool_calls)) {
    for (const raw of delta.tool_calls) {
      const tc = object(raw);
      if (!tc) continue;
      const fn = object(tc.function) ?? {};
      // Some OpenAI-compatible providers omit `index` on tool-call deltas.
      // A new call is signaled by an id/name; an args-only fragment continues
      // the most recent call. Keying index-less continuations by calls.size
      // would split them into spurious new tool_use blocks.
      let key: number;
      if (typeof tc.index === 'number') {
        key = tc.index;
      } else if (typeof tc.id === 'string' || typeof fn.name === 'string' || state.calls.size === 0) {
        key = state.calls.size; // opens a new call
      } else {
        key = state.lastToolKey ?? 0; // args-only continuation
      }
      state.lastToolKey = key;
      let call = state.calls.get(key);
      if (!call) {
        closeText();
        ensureStart();
        call = { index: state.nextIndex++, started: true };
        state.calls.set(key, call);
        state.sawTool = true;
        out += sse('content_block_start', {
          type: 'content_block_start', index: call.index,
          content_block: {
            type: 'tool_use',
            id: typeof tc.id === 'string' ? tc.id : `call_${key}`,
            name: typeof fn.name === 'string' ? fn.name : '',
            input: {},
          },
        });
      }
      if (typeof fn.arguments === 'string' && fn.arguments.length) {
        out += sse('content_block_delta', {
          type: 'content_block_delta', index: call.index,
          delta: { type: 'input_json_delta', partial_json: fn.arguments },
        });
      }
    }
  }
  return out;
}

function finalizeStream(state: StreamState): string {
  let out = '';
  if (!state.started) {
    out += sse('message_start', {
      type: 'message_start',
      message: {
        id: state.id, type: 'message', role: 'assistant', model: state.model,
        content: [], stop_reason: null, stop_sequence: null, usage: anthropicUsage(undefined),
      },
    });
    state.started = true;
  }
  if (state.textOpen && state.textIndex !== undefined) {
    out += sse('content_block_stop', { type: 'content_block_stop', index: state.textIndex });
    state.textOpen = false;
  }
  for (const call of state.calls.values()) {
    out += sse('content_block_stop', { type: 'content_block_stop', index: call.index });
  }
  out += sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason(state.finish, state.sawTool), stop_sequence: null },
    usage: state.usage ?? anthropicUsage(undefined),
  });
  out += sse('message_stop', { type: 'message_stop' });
  return out;
}

/** Incrementally translate Chat Completions SSE without buffering model output. */
export function openAIChatStreamToAnthropic(
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let pendingCR = false;
  let done = false;
  const state: StreamState = {
    started: false, terminated: false, id: 'msg_pxpipe', model: fallbackModel,
    nextIndex: 0, textOpen: false, sawTool: false, calls: new Map(),
  };
  const process = (chunk: string, controller: TransformStreamDefaultController<Uint8Array>, final = false): void => {
    let normalized = chunk;
    if (pendingCR) { normalized = '\r' + normalized; pendingCR = false; }
    if (!final && normalized.endsWith('\r')) { normalized = normalized.slice(0, -1); pendingCR = true; }
    buffer += normalized.replace(/\r\n|\r/g, '\n');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length === 0) continue;
      const payload = data.join('\n');
      if (payload === '[DONE]') { done = true; continue; }
      if (state.terminated) continue;
      try {
        const rendered = chatStreamEvent(JSON.parse(payload) as JsonObject, state);
        if (rendered) controller.enqueue(encoder.encode(rendered));
      } catch {
        controller.enqueue(encoder.encode(sse('error', {
          type: 'error', error: { type: 'api_error', message: 'OpenAI returned a malformed streaming event' },
        })));
        state.terminated = true;
      }
    }
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      process(decoder.decode(chunk, { stream: true }), controller);
    },
    flush(controller) {
      process(decoder.decode() + (pendingCR ? '\r' : '') + '\n\n', controller, true);
      pendingCR = false;
      if (!state.terminated) {
        controller.enqueue(encoder.encode(finalizeStream(state)));
      }
      void done;
    },
  }));
}

/** Translate a Chat Completions HTTP response to the Messages wire format. */
export async function openAIChatToAnthropicResponse(
  response: Response,
  fallbackModel: string,
): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  const contentType = (headers.get('content-type') ?? '').toLowerCase();
  if (!response.ok) {
    let source: JsonObject = {};
    let fallbackMessage = response.statusText || `OpenAI request failed with status ${response.status}`;
    if (response.body) {
      if (contentType.includes('json')) {
        const raw = object(await response.json()) ?? {};
        source = object(raw.error) ?? raw;
      } else {
        const text = (await response.text()).trim();
        if (text) fallbackMessage = text.slice(0, 4096);
      }
    }
    const rawType = typeof source.type === 'string' ? source.type : 'api_error';
    const code = typeof source.code === 'string' ? source.code : '';
    const type = rawType === 'invalid_request_error' || rawType === 'invalid_request'
      ? 'invalid_request_error' : rawType;
    const message = typeof source.message === 'string' ? source.message : code || fallbackMessage;
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
      status: response.status, statusText: response.statusText, headers,
    });
  }
  if (!response.body) return response;
  if (contentType.includes('text/event-stream')) {
    headers.set('content-type', 'text/event-stream; charset=utf-8');
    return new Response(openAIChatStreamToAnthropic(response.body, fallbackModel), {
      status: response.status, statusText: response.statusText, headers,
    });
  }
  const converted = openAIChatToAnthropicMessage(await response.json(), fallbackModel);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(converted), {
    status: response.status, statusText: response.statusText, headers,
  });
}

/** Build the chat-completions endpoint URL from a user-supplied base. Accepts a
 *  bare host, a `/v1` base, or the full `/chat/completions` URL. */
export function chatCompletionsUrl(base: string): string {
  const b = base.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/v\d+$/.test(b)) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}
