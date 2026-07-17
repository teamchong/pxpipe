export function responsesEndpoint() {
  const base = (process.env.OPENAI_BASE_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('OPENAI_BASE_URL is required');
  const url = new URL(base);
  if (url.port === '47821') throw new Error('refuse pxpipe');
  return base.endsWith('/responses') ? base : `${base}/responses`;
}

function isKimi(model) {
  return /kimi/i.test(model);
}

function messagesEndpoint() {
  const base = (process.env.KIMI_QUALITY_BASE_URL || 'http://127.0.0.1:47821/v1').replace(/\/$/, '');
  return base.endsWith('/messages') ? base : `${base}/messages`;
}

function anthropicContent(content) {
  return content.map((part) => {
    if (part.type === 'input_text') return { type: 'text', text: part.text };
    if (part.type === 'input_image' && typeof part.image_url === 'string') {
      const match = /^data:([^;]+);base64,(.*)$/.exec(part.image_url);
      if (!match) throw new Error('Kimi eval requires base64 data images');
      return {
        type: 'image',
        source: { type: 'base64', media_type: match[1], data: match[2] },
      };
    }
    throw new Error(`unsupported Kimi eval content part: ${part.type}`);
  });
}

async function readAnthropicStream(response) {
  if (!response.body) throw new Error('Kimi eval stream has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage = null;
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n|\r/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const payload = block.split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!payload || payload === '[DONE]') continue;
      let event;
      try { event = JSON.parse(payload); } catch { continue; }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        text += event.delta.text || '';
      } else if (event.type === 'message_delta' && event.usage) {
        usage = event.usage;
      } else if (event.type === 'error') {
        throw new Error(event.error?.message || 'Kimi streaming error');
      }
    }
    if (done) break;
  }
  return { text: text.trim(), usage };
}

export function responseBody(model, content, maxOutputTokens) {
  const body = {
    model,
    stream: false,
    max_output_tokens: maxOutputTokens,
    input: [{ role: 'user', content }],
  };
  if (!/^grok-/.test(model)) {
    body.reasoning = { effort: 'none' };
  }
  body.text = { verbosity: 'low' };
  return body;
}

export async function callResponses({ model, content, maxOutputTokens, timeoutMs }) {
  if (isKimi(model)) {
    const key = process.env.KIMI_QUALITY_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
    if (!key) throw new Error('KIMI_QUALITY_API_KEY or ANTHROPIC_AUTH_TOKEN is required');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const response = await fetch(messagesEndpoint(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': key,
        },
        body: JSON.stringify({
          model: model.startsWith('claude-') ? model : `claude-${model}`,
          // K3 can spend many minutes in mandatory reasoning. Streaming keeps
          // Cloudflare's partner route alive instead of timing out near 100s.
          stream: true,
          // K3 always reasons; Moonshot's benchmark guidance requires at least
          // 16K so hidden reasoning does not consume the entire answer budget.
          max_tokens: Math.max(maxOutputTokens, Number(process.env.KIMI_QUALITY_MAX_TOKENS || 16000)),
          messages: [{ role: 'user', content: anthropicContent(content) }],
        }),
        signal: controller.signal,
      });
      if (response.ok && response.headers.get('content-type')?.includes('text/event-stream')) {
        const streamed = await readAnthropicStream(response);
        return { ...streamed, ms: Date.now() - started };
      }
      const raw = await response.text();
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`non-json HTTP ${response.status}: ${raw.slice(0, 160)}`);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${json?.error?.message || raw.slice(0, 160)}`);
      }
      const text = Array.isArray(json.content)
        ? json.content.filter((part) => part?.type === 'text').map((part) => part.text).join('')
        : '';
      return { text: text.trim(), usage: json.usage || null, ms: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is required');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(responsesEndpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(responseBody(model, content, maxOutputTokens)),
      signal: controller.signal,
    });
    const raw = await response.text();
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`non-json HTTP ${response.status}: ${raw.slice(0, 160)}`);
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${json?.error?.message || raw.slice(0, 160)}`);
    }
    if (json.status === 'incomplete') {
      throw new Error(`incomplete response: ${json.incomplete_details?.reason || 'unknown reason'}`);
    }
    let text = typeof json.output_text === 'string' ? json.output_text : '';
    if (!text && Array.isArray(json.output)) {
      for (const item of json.output) {
        if (!Array.isArray(item?.content)) continue;
        for (const part of item.content) {
          if ((part?.type === 'output_text' || part?.type === 'text') && typeof part.text === 'string') {
            text += part.text;
          }
        }
      }
    }
    return { text: text.trim(), usage: json.usage || null, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}
