// Live-call grok-4.5 on one rendered rung. Blind: never opens truth.json.
// Writes answers-<label>.json with per-token answer + conf.
// Run: OPENAI_BASE_URL=http://127.0.0.1:8082/v1 OPENAI_API_KEY=… \
//      node eval/grok-density/native-sweep/ask.mjs jbmono14
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callResponses } from '../../sol-profile/responses-client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const label = process.argv[2];
if (!label) { console.error('usage: ask.mjs <label>'); process.exit(2); }

const MODEL = process.env.GROK_DENSITY_MODEL || process.env.SOL_QUALITY_MODEL || 'grok-4.5';
const TIMEOUT = Number(process.env.GROK_DENSITY_TIMEOUT_MS || 240_000);
const questions = JSON.parse(readFileSync(join(here, 'questions.json'), 'utf8'));
const pngs = readdirSync(here)
  .filter((f) => f.startsWith(`${label}-p`) && f.endsWith('.png'))
  .sort((a, b) => {
    const na = Number(/-p(\d+)\.png$/.exec(a)?.[1] || 0);
    const nb = Number(/-p(\d+)\.png$/.exec(b)?.[1] || 0);
    return na - nb;
  });
if (!pngs.length) { console.error(`no PNGs for ${label}`); process.exit(1); }

const content = pngs.map((f) => ({
  type: 'input_image',
  image_url: `data:image/png;base64,${readFileSync(join(here, f)).toString('base64')}`,
  detail: 'original',
}));
const prompt = [
  'Read ALL transcript images in order. They are a dense coding-session log.',
  'Answer every numbered question with the EXACT string from the images.',
  'If you cannot read a value with high confidence, answer null (JSON null), do not guess.',
  'Return ONLY a JSON object of the form:',
  '{"hex12":{"answer":"...","conf":"high|med|low"}, ... }',
  'Keys must be exactly: ' + questions.map((q) => q.key).join(', '),
  '',
  ...questions.map((q, i) => `${i + 1}. [${q.key}] ${q.q}`),
].join('\n');
content.push({ type: 'input_text', text: prompt });

const RETRIES = Number(process.env.GROK_DENSITY_RETRIES || 3);
let r;
let lastErr;
for (let attempt = 1; attempt <= RETRIES; attempt++) {
  try {
    r = await callResponses({
      model: MODEL,
      content,
      maxOutputTokens: Number(process.env.GROK_DENSITY_MAX_OUT || 1600),
      timeoutMs: TIMEOUT,
    });
    lastErr = null;
    break;
  } catch (e) {
    lastErr = e;
    console.error(`${label}: attempt ${attempt}/${RETRIES} failed: ${e}`);
    if (attempt < RETRIES) await new Promise((res) => setTimeout(res, 2000 * attempt));
  }
}
if (lastErr) throw lastErr;

function parseObj(s) {
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

const parsed = parseObj(r.text) || {};
const out = { _rung: label, _model: MODEL, _ms: r.ms, _usage: r.usage, _raw: r.text };
for (const q of questions) {
  const cell = parsed[q.key];
  if (cell && typeof cell === 'object') {
    const ans = cell.answer === null || cell.answer === 'null' ? null : String(cell.answer);
    out[q.key] = { answer: ans, conf: String(cell.conf || 'n/a') };
  } else if (typeof cell === 'string') {
    out[q.key] = { answer: cell, conf: 'n/a' };
  } else {
    out[q.key] = { answer: null, conf: 'parse-miss' };
  }
}
const path = join(here, `answers-${label}.json`);
writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
const filled = questions.filter((q) => out[q.key].answer !== null).length;
console.log(`${label}: ${filled}/${questions.length} answered  ms=${r.ms}  → ${path}`);
