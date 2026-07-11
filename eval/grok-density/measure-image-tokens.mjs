// Empirical Grok image-token billing. Compare usage.input_tokens for text-only
// vs same prompt + one rendered PNG at several geometries.
import { renderTextToPngs } from '../../dist/core/render.js';

const MODEL = process.env.GROK_DENSITY_MODEL || 'grok-4.5';
const base = (process.env.OPENAI_BASE_URL || '').replace(/\/$/, '');
const url = base.endsWith('/responses') ? base : `${base}/responses`;
const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('OPENAI_API_KEY required');

const session =
  'token cache key a3f9c1e0b7d2 field tokenLedgerShard path src/core/anthropic-vision.ts port 47821\n'.repeat(40);
const ask = 'Reply with exactly: OK';

async function call(content) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      max_output_tokens: 16,
      input: [{ role: 'user', content }],
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.usage || {};
}

const textOnly = await call([{ type: 'input_text', text: ask }]);
console.log('text-only', textOnly);

const cases = [
  ['prod_5x8_768xH', { cellWBonus: 0, cellHBonus: 0, aa: true }, 152, 1932],
  ['pad_7x10', { cellWBonus: 2, cellHBonus: 2, aa: true }, 108, 1932],
  ['pad_9x12', { cellWBonus: 4, cellHBonus: 4, aa: true }, 84, 1932],
  ['narrow_100cols', { cellWBonus: 0, cellHBonus: 0, aa: true }, 100, 1932],
  ['short_H1024', { cellWBonus: 0, cellHBonus: 0, aa: true }, 152, 1024],
];

for (const [label, style, cols, H] of cases) {
  const imgs = await renderTextToPngs(session, cols, style, H);
  const content = [
    ...imgs.map((im) => ({
      type: 'input_image',
      image_url: 'data:image/png;base64,' + Buffer.from(im.png).toString('base64'),
      detail: 'original',
    })),
    { type: 'input_text', text: ask },
  ];
  const usage = await call(content);
  const dims = imgs.map((i) => `${i.width}x${i.height}`);
  const pixels = imgs.reduce((n, i) => n + i.width * i.height, 0);
  const input = usage.input_tokens ?? null;
  const cached = usage.input_tokens_details?.cached_tokens ?? null;
  const delta = input != null && textOnly.input_tokens != null ? input - textOnly.input_tokens : null;
  console.log(
    JSON.stringify({
      label,
      dims,
      pages: imgs.length,
      pixels,
      input_tokens: input,
      cached_tokens: cached,
      text_only_input: textOnly.input_tokens,
      image_delta_tokens: delta,
      tokens_per_mpix: delta != null ? Number(((delta / pixels) * 1e6).toFixed(2)) : null,
    }),
  );
}
