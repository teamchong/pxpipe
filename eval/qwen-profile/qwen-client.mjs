// Qwen 3.8 Workers AI client through a local OpenAI-compatible gateway
// (e.g. a Cloudflare AI Gateway). Requires OPENAI_BASE_URL, and OPENAI_API_KEY
// when the gateway authenticates.
function getAuthToken() {
  return process.env.OPENAI_API_KEY ?? '';
}

function gatewayEndpoint() {
  const base = (process.env.OPENAI_BASE_URL ?? '').replace(/\/$/, '');
  if (!base) throw new Error('OPENAI_BASE_URL is required (point it at your gateway)');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

export function resultFilename(base, model) {
  const clean = model.replace(/^workers-ai\//, '').replace(/^@cf\//, '');
  if (clean === 'qwen/qwen3.8-27b' || clean === 'qwen3.8-27b') return `${base}-results.json`;
  return `${base}-${clean.replace(/[^a-zA-Z0-9._-]+/g, '_')}-results.json`;
}

export async function callQwen({
  model = 'workers-ai/@cf/qwen/qwen3.8-27b',
  content,
  maxOutputTokens = 2048,
  timeoutMs = 120000,
}) {
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
          return { type: 'image_url', image_url: { url } };
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
          if (json.usage) usage = json.usage;
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
