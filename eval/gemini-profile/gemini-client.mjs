// Dedicated Google AI Studio client for Gemini 3.6 Flash evaluations.

export async function callGeminiRequest({ model = 'gemini-3.6-flash', request, maxOutputTokens = 1000, timeoutMs = 120000 }) {
  const key = process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY or GEMINI_API_KEY is required');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  const cleanModel = model.replace(/^google\//, '').replace(/^claude-/, '');
  const url = `http://127.0.0.1:47821/google-ai-studio/v1beta/models/${cleanModel}:generateContent`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify({
        ...request,
        generationConfig: {
          ...request.generationConfig,
          maxOutputTokens,
        },
      }),
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
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('') || '';
    return { text: text.trim(), usage: json.usageMetadata || null, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export async function callGemini({ model = 'gemini-3.6-flash', content, maxOutputTokens = 1000, timeoutMs = 120000 }) {
  const parts = content.map((part) => {
    if (part.type === 'input_text') return { text: part.text };
    if (part.type === 'input_image' && typeof part.image_url === 'string') {
      const match = /^data:([^;]+);base64,(.*)$/.exec(part.image_url);
      if (!match) throw new Error('Gemini eval requires base64 data images');
      return {
        inlineData: { mimeType: match[1], data: match[2] },
      };
    }
    throw new Error(`unsupported Gemini content part: ${part.type}`);
  });
  return callGeminiRequest({
    model,
    request: { contents: [{ parts }] },
    maxOutputTokens,
    timeoutMs,
  });
}
