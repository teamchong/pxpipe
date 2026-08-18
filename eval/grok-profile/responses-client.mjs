export function responsesEndpoint() {
  const base = (process.env.OPENAI_BASE_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('OPENAI_BASE_URL is required');
  const url = new URL(base);
  if (url.port === '47821') throw new Error('refuse pxpipe');
  return base.endsWith('/responses') ? base : `${base}/responses`;
}

export function responseBody(model, content, maxOutputTokens) {
  return {
    model,
    stream: false,
    max_output_tokens: maxOutputTokens,
    reasoning: { effort: process.env.GROK_QUALITY_REASONING_EFFORT || 'high' },
    input: [{ role: 'user', content }],
  };
}

export async function callResponses({ model, content, maxOutputTokens, timeoutMs }) {
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
