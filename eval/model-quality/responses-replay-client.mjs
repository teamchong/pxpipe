// Bounded direct Responses replay. Unlike the single-user-message client, this
// preserves complete historical tool items. Incomplete usage is retained.
export async function callResponsesRequest({ request, timeoutMs }) {
  if (!request || typeof request.model !== 'string' || !Array.isArray(request.input)
    || !Number.isInteger(request.max_output_tokens) || request.max_output_tokens <= 0
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Invalid bounded Responses replay');
  const base = process.env.OPENAI_BASE_URL?.replace(/\/$/, ''), key = process.env.OPENAI_API_KEY;
  if (!base || new URL(base).port === '47821' || !key) throw new Error('Replay requires a direct upstream and API key');
  const endpoint = base.endsWith('/responses') ? base : base.endsWith('/v1') ? `${base}/responses` : `${base}/v1/responses`;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs), start = Date.now();
  try {
    const response = await fetch(endpoint, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(request), signal: controller.signal });
    let json;
    try { json = JSON.parse(await response.text()); } catch { throw new Error(`Non-JSON replay response: HTTP ${response.status}`); }
    let text = typeof json.output_text === 'string' ? json.output_text : '';
    if (!text) for (const item of json.output || []) for (const part of item.content || []) {
      if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') text += part.text;
    }
    const receipt = { text: text.trim(), usage: json.usage ?? null, ms: Date.now() - start,
      status: json.status || (response.ok ? 'completed' : 'failed'), httpStatus: response.status,
      incompleteReason: json.incomplete_details?.reason ?? null };
    if (!response.ok) { const error = new Error(`Replay HTTP ${response.status}`); error.receipt = receipt; throw error; }
    return receipt;
  } finally { clearTimeout(timer); }
}
