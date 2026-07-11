// Shared OpenAI-compatible Responses helpers for Grok image evals.
// Grok is evaluated on the Codex path: OPENAI_BASE_URL should be the same
// provider base Codex uses (e.g. ocproxy http://127.0.0.1:8082/v1).
// Fable/Opus stay on Claude CLI. Do not route through pxpipe — raw image reading.

export function responsesBaseUrl() {
  const base = (process.env.OPENAI_BASE_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('OPENAI_BASE_URL is required for live runs');
  return base.endsWith('/responses') ? base : `${base}/responses`;
}

export async function callResponses({ model, content, maxOutputTokens = 512, timeoutMs = 180_000 }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is required for live runs');
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(responsesBaseUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        stream: false,
        max_output_tokens: maxOutputTokens,
        input: [{ role: 'user', content }],
      }),
      signal: c.signal,
    });
    const raw = await res.text();
    let j;
    try { j = JSON.parse(raw); } catch { j = { raw }; }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${j?.error?.message || raw.slice(0, 200)}`);
    }
    let text = typeof j.output_text === 'string' ? j.output_text : '';
    if (!text && Array.isArray(j.output)) {
      for (const item of j.output) {
        if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
          if (part && (part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
            text += part.text;
          }
        }
      }
    }
    return { text: text.trim(), ms: Date.now() - t0, raw: j };
  } finally {
    clearTimeout(t);
  }
}

export function pngsToDataUrls(imgs) {
  return imgs.map((im) => `data:image/png;base64,${Buffer.from(im.png).toString('base64')}`);
}

export function profileStyle(profile) {
  return {
    font: profile.style.font,
    cellWBonus: profile.style.cellWBonus,
    cellHBonus: profile.style.cellHBonus,
    aa: profile.style.aa,
    grid: profile.style.grid,
    gridCols: profile.style.gridCols,
    colorCycle: profile.style.colorCycle,
    markerScale: profile.style.markerScale,
    markerRed: profile.style.markerRed,
    inkDilate: profile.style.inkDilate,
  };
}

export function extractAnswerNumber(out) {
  if (!out) return null;
  const m = String(out).match(/ANSWER:\s*\$?(-?[\d.,]+)/i);
  if (m) return numify(m[1]);
  const nums = String(out).match(/-?\d[\d,]*(?:\.\d+)?/g);
  return nums ? numify(nums[nums.length - 1]) : null;
}

function numify(s) {
  if (s == null) return null;
  const t = String(s).replace(/,/g, '').replace(/\$/g, '').trim().replace(/\.$/, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
