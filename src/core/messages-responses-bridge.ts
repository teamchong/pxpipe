/** Anthropic Messages wire compatibility for GPT models served by OpenAI Responses. */

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

function inputParts(content: unknown, location = 'message', role = 'user'): JsonObject[] {
  // Responses requires assistant-role message text to be `output_text`;
  // `input_text` is only valid for user/system. Emitting input_text under
  // role:"assistant" (any replayed assistant turn) is a 400.
  const textType = role === 'assistant' ? 'output_text' : 'input_text';
  if (typeof content === 'string') return [{ type: textType, text: content }];
  if (!Array.isArray(content)) invalidRequest(`${location} content must be a string or an array`);
  const out: JsonObject[] = [];
  for (const raw of content) {
    const part = object(raw);
    if (part?.type === 'text' && typeof part.text === 'string') {
      out.push({ type: textType, text: part.text });
    } else if (part?.type === 'image') {
      const image_url = imageUrl(part.source);
      if (!image_url) invalidRequest(`Unsupported ${location} image source`);
      out.push({ type: 'input_image', image_url, detail: 'original' });
    } else {
      invalidRequest(`Unsupported ${location} content block: ${String(part?.type ?? 'invalid')}`);
    }
  }
  return out;
}

function functionOutput(content: unknown, isError: boolean): string | JsonObject[] {
  if (typeof content === 'string') {
    return isError
      ? [{ type: 'input_text', text: '[Tool execution failed]' }, { type: 'input_text', text: content }]
      : content;
  }
  if (!Array.isArray(content)) {
    const rendered = JSON.stringify(content ?? '');
    return isError
      ? [{ type: 'input_text', text: '[Tool execution failed]' }, { type: 'input_text', text: rendered }]
      : rendered;
  }
  const pieces: JsonObject[] = [];
  if (isError) pieces.push({ type: 'input_text', text: '[Tool execution failed]' });
  for (const raw of content) {
    const part = object(raw);
    if (part?.type === 'text' && typeof part.text === 'string') {
      pieces.push({ type: 'input_text', text: part.text });
    }
    else if (part?.type === 'image') {
      const image_url = imageUrl(part.source);
      if (!image_url) invalidRequest('Unsupported tool_result image source');
      pieces.push({ type: 'input_image', image_url, detail: 'original' });
    } else {
      invalidRequest(`Unsupported tool_result content block: ${String(part?.type ?? 'invalid')}`);
    }
  }
  if (pieces.length === 1 && pieces[0]?.type === 'input_text' && !isError) {
    return String(pieces[0].text ?? '');
  }
  return pieces;
}

function mapToolChoice(value: unknown): unknown {
  const choice = object(value);
  if (!choice || typeof choice.type !== 'string') return value;
  if (choice.type === 'auto' || choice.type === 'none') return choice.type;
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool' && typeof choice.name === 'string') {
    return { type: 'function', name: choice.name };
  }
  return value;
}

/** Convert a Claude Code Messages request into an OpenAI Responses request. */
export function anthropicMessagesToOpenAIResponses(body: Uint8Array): Uint8Array {
  const req = JSON.parse(new TextDecoder().decode(body)) as JsonObject;
  const input: JsonObject[] = [];

  if (Array.isArray(req.messages)) {
    for (const rawMessage of req.messages) {
      const message = object(rawMessage);
      if (!message
        || (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system')) {
        invalidRequest('Each message must have a user, assistant, or system role');
      }
      // Newer Claude Code builds inject system-role messages mid-conversation
      // (e.g. system reminders); map them to Responses system input items.
      if (message.role === 'system') {
        const text = textFromBlocks(message.content);
        if (text) input.push({ role: 'system', content: [{ type: 'input_text', text }] });
        continue;
      }
      const content = message.content;
      if (!Array.isArray(content)) {
        const ordinary = inputParts(content, `${String(message.role)} message`, String(message.role));
        if (ordinary.length) input.push({ role: message.role, content: ordinary });
        continue;
      }
      let ordinary: JsonObject[] = [];
      const flushOrdinary = (): void => {
        if (ordinary.length) input.push({ role: message.role, content: ordinary });
        ordinary = [];
      };
      for (const rawPart of content) {
        const part = object(rawPart);
        if (message.role === 'assistant' && part?.type === 'tool_use'
          && typeof part.id === 'string' && typeof part.name === 'string') {
          flushOrdinary();
          input.push({
            type: 'function_call',
            call_id: part.id,
            name: part.name,
            arguments: JSON.stringify(part.input ?? {}),
          });
        } else if (message.role === 'user' && part?.type === 'tool_result'
          && typeof part.tool_use_id === 'string') {
          flushOrdinary();
          input.push({
            type: 'function_call_output',
            call_id: part.tool_use_id,
            output: functionOutput(part.content, part.is_error === true),
          });
        } else {
          ordinary.push(...inputParts([rawPart], `${String(message.role)} message`, String(message.role)));
        }
      }
      flushOrdinary();
    }
  } else invalidRequest('messages must be an array');

  const out: JsonObject = { model: req.model, input };
  const instructions = textFromBlocks(req.system);
  if (instructions) out.instructions = instructions;
  if (typeof req.max_tokens === 'number') out.max_output_tokens = req.max_tokens;
  for (const key of ['stream', 'temperature', 'top_p', 'metadata']) {
    if (req[key] !== undefined) out[key] = req[key];
  }
  if (Array.isArray(req.stop_sequences)) out.stop = req.stop_sequences;
  if (req.tool_choice !== undefined) out.tool_choice = mapToolChoice(req.tool_choice);
  const toolChoice = object(req.tool_choice);
  out.parallel_tool_calls = toolChoice?.disable_parallel_tool_use !== true;
  if (Array.isArray(req.tools)) {
    out.tools = req.tools.flatMap((raw) => {
      const tool = object(raw);
      if (!tool || typeof tool.name !== 'string') return [];
      return [{
        type: 'function',
        name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        parameters: tool.input_schema ?? { type: 'object', properties: {} },
      }];
    });
  }
  return new TextEncoder().encode(JSON.stringify(out));
}

function anthropicUsage(raw: unknown): JsonObject {
  const usage = object(raw) ?? {};
  const details = object(usage.input_tokens_details);
  const totalInput = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const cached = typeof details?.cached_tokens === 'number' ? details.cached_tokens : 0;
  return {
    input_tokens: Math.max(0, totalInput - cached),
    output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  };
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return {};
  try { return JSON.parse(value); } catch {
    throw new Error('OpenAI returned malformed function-call arguments');
  }
}

function stopReason(response: JsonObject, hasToolUse: boolean, sawRefusal = false): string {
  if (hasToolUse) return 'tool_use';
  if (sawRefusal) return 'refusal';
  const raw = typeof response.stop_reason === 'string'
    ? response.stop_reason
    : object(response.incomplete_details)?.reason;
  if ((raw === 'stop' || raw === 'completed') && typeof response.stop_sequence === 'string') {
    return 'stop_sequence';
  }
  if (raw === 'max_output_tokens' || raw === 'max_tokens') return 'max_tokens';
  if (raw === 'content_filter' || raw === 'refusal') return 'refusal';
  if (raw === 'stop_sequence' || raw === 'pause_turn') return raw;
  return 'end_turn';
}

/** Convert one completed Responses JSON object into Anthropic Messages JSON. */
export function openAIResponseToAnthropicMessage(response: unknown, fallbackModel: string): JsonObject {
  const r = object(response) ?? {};
  const content: JsonObject[] = [];
  let hasToolUse = false;
  let sawRefusal = false;
  if (Array.isArray(r.output)) {
    for (const rawItem of r.output) {
      const item = object(rawItem);
      if (item?.type === 'message' && Array.isArray(item.content)) {
        for (const rawPart of item.content) {
          const part = object(rawPart);
          if ((part?.type === 'output_text' || part?.type === 'refusal') && typeof part.text === 'string') {
            content.push({ type: 'text', text: part.text });
            if (part.type === 'refusal') sawRefusal = true;
          } else if (part?.type === 'refusal' && typeof part.refusal === 'string') {
            content.push({ type: 'text', text: part.refusal });
            sawRefusal = true;
          }
        }
      } else if (item?.type === 'function_call' && typeof item.name === 'string') {
        hasToolUse = true;
        content.push({
          type: 'tool_use',
          id: typeof item.call_id === 'string' ? item.call_id : String(item.id ?? ''),
          name: item.name,
          input: parseArguments(item.arguments),
        });
      }
    }
  }
  const id = typeof r.id === 'string' ? r.id.replace(/^resp_/, 'msg_') : 'msg_pxpipe';
  return {
    id,
    type: 'message',
    role: 'assistant',
    model: typeof r.model === 'string' ? r.model : fallbackModel,
    content,
    stop_reason: stopReason(r, hasToolUse, sawRefusal),
    stop_sequence: typeof r.stop_sequence === 'string' ? r.stop_sequence : null,
    usage: anthropicUsage(r.usage),
  };
}

function sse(event: string, data: JsonObject): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface StreamCall {
  index?: number;
  itemId?: string;
  callId?: string;
  outputIndex?: number;
  name?: string;
  arguments: string;
  started: boolean;
  stopped: boolean;
}

interface StreamState {
  started: boolean;
  terminated: boolean;
  id: string;
  model: string;
  nextIndex: number;
  textIndex?: number;
  textOpen: boolean;
  sawTextDelta: boolean;
  sawTool: boolean;
  sawRefusal: boolean;
  calls: Set<StreamCall>;
  callAliases: Map<string, StreamCall>;
  lastCall?: StreamCall;
  usage: JsonObject;
}

function streamEvent(event: string, value: JsonObject, state: StreamState): string {
  let out = '';
  const response = object(value.response);
  const ensureStart = (): void => {
    if (state.started) return;
    if (response) {
      if (typeof response.id === 'string') state.id = response.id.replace(/^resp_/, 'msg_');
      if (typeof response.model === 'string') state.model = response.model;
      if (response.usage) state.usage = anthropicUsage(response.usage);
    }
    state.started = true;
    out += sse('message_start', {
      type: 'message_start',
      message: { id: state.id, type: 'message', role: 'assistant', model: state.model,
        content: [], stop_reason: null, stop_sequence: null, usage: state.usage },
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
  const alias = (call: StreamCall, key: string | undefined): void => {
    if (key) state.callAliases.set(key, call);
  };
  const hydrateCall = (call: StreamCall, item: JsonObject, root: JsonObject): void => {
    if (typeof item.id === 'string') call.itemId = item.id;
    if (typeof item.call_id === 'string') call.callId = item.call_id;
    if (typeof item.name === 'string' && item.name) call.name = item.name;
    const oi = typeof root.output_index === 'number' ? root.output_index
      : typeof item.output_index === 'number' ? item.output_index : undefined;
    if (oi !== undefined) call.outputIndex = oi;
    alias(call, call.itemId ? `item:${call.itemId}` : undefined);
    alias(call, call.callId ? `call:${call.callId}` : undefined);
    alias(call, call.outputIndex !== undefined ? `output:${call.outputIndex}` : undefined);
  };
  const resolveCall = (root: JsonObject, item?: JsonObject): StreamCall | undefined => {
    const itemId = typeof root.item_id === 'string' ? root.item_id
      : typeof item?.id === 'string' ? item.id : undefined;
    const callId = typeof root.call_id === 'string' ? root.call_id
      : typeof item?.call_id === 'string' ? item.call_id : undefined;
    const oi = typeof root.output_index === 'number' ? root.output_index
      : typeof item?.output_index === 'number' ? item.output_index : undefined;
    return (itemId ? state.callAliases.get(`item:${itemId}`) : undefined)
      ?? (oi !== undefined ? state.callAliases.get(`output:${oi}`) : undefined)
      ?? (callId ? state.callAliases.get(`call:${callId}`) : undefined);
  };
  const hasCallIdentity = (root: JsonObject): boolean =>
    typeof root.item_id === 'string'
    || typeof root.call_id === 'string'
    || typeof root.output_index === 'number';
  const makeCall = (item: JsonObject, root: JsonObject): StreamCall => {
    const call: StreamCall = { arguments: '', started: false, stopped: false };
    hydrateCall(call, item, root);
    state.calls.add(call);
    state.lastCall = call;
    return call;
  };
  const startCall = (call: StreamCall): void => {
    if (call.started || !call.name) return;
    ensureStart(); closeText(); state.sawTool = true;
    call.index = state.nextIndex++;
    call.started = true;
    out += sse('content_block_start', {
      type: 'content_block_start', index: call.index,
      content_block: { type: 'tool_use', id: call.callId ?? call.itemId ?? '', name: call.name, input: {} },
    });
    if (call.arguments) out += sse('content_block_delta', {
      type: 'content_block_delta', index: call.index,
      delta: { type: 'input_json_delta', partial_json: call.arguments },
    });
  };
  const stopCall = (call: StreamCall): void => {
    startCall(call);
    if (!call.started || call.stopped || call.index === undefined) return;
    out += sse('content_block_stop', { type: 'content_block_stop', index: call.index });
    call.stopped = true;
  };
  const reconcileArguments = (call: StreamCall, complete: unknown): boolean => {
    if (typeof complete !== 'string' || complete.length === 0) return true;
    if (!call.arguments) {
      call.arguments = complete;
      if (call.started && call.index !== undefined) out += sse('content_block_delta', {
        type: 'content_block_delta', index: call.index,
        delta: { type: 'input_json_delta', partial_json: complete },
      });
      return true;
    }
    if (complete === call.arguments) return true;
    if (complete.startsWith(call.arguments)) {
      const suffix = complete.slice(call.arguments.length);
      call.arguments = complete;
      if (suffix && call.started && call.index !== undefined) out += sse('content_block_delta', {
        type: 'content_block_delta', index: call.index,
        delta: { type: 'input_json_delta', partial_json: suffix },
      });
      return true;
    }
    ensureStart(); closeText();
    out += sse('error', {
      type: 'error',
      error: { type: 'api_error', message: 'OpenAI returned inconsistent streamed function-call arguments' },
    });
    state.terminated = true;
    return false;
  };
  const terminalOutput = (terminal: JsonObject): void => {
    if (!Array.isArray(terminal.output)) return;
    for (let i = 0; i < terminal.output.length; i++) {
      const item = object(terminal.output[i]);
      if (item?.type === 'message' && !state.sawTextDelta && Array.isArray(item.content)) {
        const recovered = item.content.flatMap((raw) => {
          const part = object(raw);
          return (part?.type === 'output_text' || part?.type === 'refusal') && typeof part.text === 'string'
            ? [part.text] : [];
        }).join('');
        if (recovered) {
          openText(); state.sawTextDelta = true;
          out += sse('content_block_delta', {
            type: 'content_block_delta', index: state.textIndex!,
            delta: { type: 'text_delta', text: recovered },
          });
        }
      } else if (item?.type === 'function_call') {
        const root = { output_index: i };
        const call = resolveCall(root, item) ?? makeCall(item, root);
        hydrateCall(call, item, root);
        if (!reconcileArguments(call, item.arguments)) return;
        startCall(call);
      }
    }
  };

  if (event === 'response.created' || event === 'response.in_progress') ensureStart();
  else if (event === 'response.output_text.delta' && typeof value.delta === 'string') {
    openText(); state.sawTextDelta = true;
    out += sse('content_block_delta', {
      type: 'content_block_delta', index: state.textIndex!, delta: { type: 'text_delta', text: value.delta },
    });
  } else if (event === 'response.output_item.added') {
    const item = object(value.item);
    if (item?.type === 'function_call') {
      const call = resolveCall(value, item) ?? makeCall(item, value);
      hydrateCall(call, item, value); startCall(call);
    }
  } else if (event === 'response.function_call_arguments.delta' && typeof value.delta === 'string') {
    const call = resolveCall(value) ?? (!hasCallIdentity(value) ? state.lastCall : undefined);
    if (call) {
      call.arguments += value.delta;
      if (call.started && call.index !== undefined) out += sse('content_block_delta', {
        type: 'content_block_delta', index: call.index,
        delta: { type: 'input_json_delta', partial_json: value.delta },
      });
    }
  } else if (event === 'response.output_item.done') {
    const item = object(value.item);
    if (item?.type === 'message' && !state.sawTextDelta && Array.isArray(item.content)) {
      terminalOutput({ output: [item] }); closeText();
    } else if (item?.type === 'function_call') {
      const call = resolveCall(value, item) ?? makeCall(item, value);
      hydrateCall(call, item, value);
      if (!reconcileArguments(call, item.arguments)) return out;
      stopCall(call);
    }
  } else if (event === 'response.output_text.done') {
    closeText();
  } else if (event === 'response.refusal.delta' && typeof value.delta === 'string') {
    openText(); state.sawRefusal = true; state.sawTextDelta = true;
    out += sse('content_block_delta', {
      type: 'content_block_delta', index: state.textIndex!, delta: { type: 'text_delta', text: value.delta },
    });
  } else if (event === 'response.completed' || event === 'response.incomplete') {
    ensureStart();
    if (response) terminalOutput(response);
    closeText();
    for (const call of state.calls) stopCall(call);
    if (response?.usage) state.usage = anthropicUsage(response.usage);
    const reason = stopReason(response ?? {}, state.sawTool, state.sawRefusal);
    out += sse('message_delta', {
      type: 'message_delta', delta: {
        stop_reason: reason,
        stop_sequence: typeof response?.stop_sequence === 'string' ? response.stop_sequence : null,
      }, usage: state.usage,
    });
    out += sse('message_stop', { type: 'message_stop' });
    state.terminated = true;
  } else if (event === 'error' || event === 'response.failed') {
    ensureStart();
    closeText();
    for (const call of state.calls) stopCall(call);
    const failure = object(value.error) ?? object(response?.error) ?? value;
    const rawType = typeof failure.type === 'string' ? failure.type : 'api_error';
    const code = typeof failure.code === 'string' ? failure.code : '';
    const errorType = code === 'cyber_policy' || rawType === 'invalid_request'
      ? 'invalid_request_error' : rawType;
    const message = typeof failure.message === 'string' ? failure.message : code || errorType;
    out += sse('error', { type: 'error', error: { type: errorType, message } });
    state.terminated = true;
  }
  return out;
}

/** Incrementally translate Responses SSE without buffering model output. */
export function openAIResponsesStreamToAnthropic(
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let pendingCR = false;
  const state: StreamState = {
    started: false, terminated: false, id: 'msg_pxpipe', model: fallbackModel, nextIndex: 0,
    textOpen: false, sawTextDelta: false, sawTool: false, sawRefusal: false,
    calls: new Set(), callAliases: new Map(), usage: anthropicUsage(undefined),
  };
  const process = (chunk: string, controller: TransformStreamDefaultController<Uint8Array>, final = false): void => {
    let normalized = chunk;
    if (pendingCR) {
      normalized = '\r' + normalized;
      pendingCR = false;
    }
    if (!final && normalized.endsWith('\r')) {
      normalized = normalized.slice(0, -1);
      pendingCR = true;
    }
    buffer += normalized.replace(/\r\n|\r/g, '\n');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      let event = '';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (!event || data.length === 0 || data[0] === '[DONE]') continue;
      if (state.terminated) continue;
      try {
        const rendered = streamEvent(event, JSON.parse(data.join('\n')) as JsonObject, state);
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
      // Append before normalizing so a CRLF split across transport chunks is
      // still recognized as one newline.
      process(decoder.decode(chunk, { stream: true }), controller);
    },
    flush(controller) {
      process(decoder.decode() + (pendingCR ? '\r' : '') + '\n\n', controller, true);
      pendingCR = false;
      if (state.started && !state.terminated) {
        controller.enqueue(encoder.encode(sse('error', {
          type: 'error', error: { type: 'api_error', message: 'OpenAI Responses stream ended before a terminal event' },
        })));
      }
    },
  }));
}

/** Translate a successful Responses HTTP response to the Messages wire format. */
export async function openAIResponsesToAnthropicResponse(
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
    const type = code === 'cyber_policy' || rawType === 'invalid_request'
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
    return new Response(openAIResponsesStreamToAnthropic(response.body, fallbackModel), {
      status: response.status, statusText: response.statusText, headers,
    });
  }
  const converted = openAIResponseToAnthropicMessage(await response.json(), fallbackModel);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(converted), {
    status: response.status, statusText: response.statusText, headers,
  });
}
