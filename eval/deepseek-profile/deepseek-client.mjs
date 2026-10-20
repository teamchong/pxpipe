// DeepSeek V4.1 Flash Workers AI client through a local OpenAI-compatible gateway
// (e.g. a Cloudflare AI Gateway). Requires OPENAI_BASE_URL, and OPENAI_API_KEY
// or PXPIPE_GATEWAY_HEADERS when the gateway authenticates. DeepSeek V4.1 Flash
// is a reasoning model: completion tokens are spent on reasoning_content before
// content, so maxOutputTokens must leave room for both.
process.env.PXPIPE_GPT_PROFILES ??= JSON.stringify({
  'deepseek-v4.1': {
    vision: { regime: 'mpix', tokensPerMegapixel: 1000 },
    stripCols: 84,
    maxHeightPx: 768,
    style: { font: 'jetbrains-mono-14', aa: true, grid: false, gridCols: 0 },
  },
});

function getAuthToken() {
  return process.env.OPENAI_API_KEY ?? '';
}

function getExtraHeaders() {
  const raw = process.env.PXPIPE_GATEWAY_HEADERS?.trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function gatewayEndpoint() {
  const base = (process.env.OPENAI_BASE_URL ?? '').replace(/\/$/, '');
  if (!base) throw new Error('OPENAI_BASE_URL is required (point it at your gateway)');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

export function resultFilename(base, model) {
  const clean = model.replace(/^workers-ai\//, '').replace(/^@cf\//, '');
  if (
    clean === 'deepseek-ai/deepseek-v4.1-flash-1017' ||
    clean === 'deepseek-v4.1-flash-1017'
  ) {
    return `${base}-results.json`;
  }
  return `${base}-${clean.replace(/[^a-zA-Z0-9._-]+/g, '_')}-results.json`;
}

export async function callDeepSeek({
  model = '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
  content,
  maxOutputTokens = 4096,
  timeoutMs = 180000,
}) {
  const delays = [5000, 15000, 30000, 60000];
  let lastError;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, delays[attempt - 1]));
    try {
      return await callDeepSeekOnce({ model, content, maxOutputTokens, timeoutMs });
    } catch (e) {
      lastError = e;
      const msg = String(e?.message || e);
      if (!/HTTP 429|HTTP 5\d\d|terminated|fetch failed|AbortError/i.test(msg)) throw e;
    }
  }
  throw lastError;
}

async function callDeepSeekOnce({ model, content, maxOutputTokens, timeoutMs }) {
  const token = getAuthToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  const messages = [
    {
      role: 'user',
      content: content.map((part) => {
        if (part.type === 'input_text' || part.type === 'text') {
          return { type: 'text', text: part.text };
        }
        if (part.type === 'input_image' || part.type === 'image_url') {
          const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
          return { type: 'image_url', image_url: { url, detail: 'high' } };
        }
        throw new Error(`unsupported content part: ${part.type}`);
      }),
    },
  ];

  try {
    const response = await fetch(gatewayEndpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...getExtraHeaders(),
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        max_tokens: maxOutputTokens,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const raw = await response.text();
      let msg = raw;
      try {
        const j = JSON.parse(raw);
        msg = j?.error?.message || j?.message || raw;
      } catch {}
      throw new Error(`HTTP ${response.status}: ${msg}`);
    }

    if (!response.body) {
      throw new Error(`HTTP ${response.status}: empty body`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let reasoning = '';
    let usage = null;
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) text += delta.content;
          if (delta?.reasoning) reasoning += delta.reasoning;
          if (delta?.reasoning_content) reasoning += delta.reasoning_content;
          if (json.usage && (json.usage.prompt_tokens || json.usage.total_tokens)) {
            usage = json.usage;
          }
        } catch {}
      }
    }

    return {
      text: text.trim(),
      reasoning: reasoning.trim(),
      usage,
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}
