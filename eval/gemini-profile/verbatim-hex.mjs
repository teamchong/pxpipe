// Gemini 3.6 Flash verbatim hex evaluation suite.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callGemini } from './gemini-client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../verbatim-15');
const MODEL = process.env.MODEL || 'gemini-3.6-flash';
const LIVE = process.env.LIVE === '1';
const TIMEOUT = Number(process.env.TIMEOUT_MS || 90000);
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 80);
const trials = JSON.parse(readFileSync(join(ROOT, 'golds.json'), 'utf8'));
const RESULT = join(HERE, 'verbatim-hex-results.json');

function writeResult(rows) {
  const completed = rows.filter((r) => !r.error);
  const result = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    live: LIVE,
    correct: completed.filter((r) => r.ok).length,
    completed: completed.length,
    errors: rows.length - completed.length,
    n: trials.length,
    rows
  };
  writeFileSync(RESULT, JSON.stringify(result, null, 2));
  return result;
}

async function callImage(trial) {
  const png = readFileSync(join(ROOT, `page${trial.page}.png`));
  const content = [
    { type: 'input_image', image_url: `data:image/png;base64,${png.toString('base64')}` },
    { type: 'input_text', text: `Read the image visually. Find the JSON line whose dur_ms is exactly ${trial.dur}. Return only its id field, exactly 12 lowercase hex characters.` },
  ];
  return callGemini({ model: MODEL, content, maxOutputTokens: MAX_OUTPUT_TOKENS, timeoutMs: TIMEOUT });
}

const rows = [];
for (let i = 0; i < trials.length; i++) {
  const t = trials[i];
  let out = '', ms = null, err = null;
  process.stdout.write(`trial ${i + 1}/${trials.length} page${t.page} dur=${t.dur} ... `);
  try {
    if (LIVE) {
      const r = await callImage(t);
      out = r.text;
      ms = r.ms;
    }
  } catch (e) {
    err = String(e?.message || e);
    out = err;
  }
  const got = out.match(/[0-9a-f]{12}/i)?.[0]?.toLowerCase() || '';
  const ok = got === t.gold;
  rows.push({ ...t, got, ok, raw: out, ms, error: err });
  if (LIVE) writeResult(rows);
  console.log(`${ok ? 'HIT' : 'MISS'} gold=${t.gold} got=${got || '-'}${ms != null ? ` ${ms}ms` : ''}${err ? ` ERR ${err.slice(0, 100)}` : ''}`);
}

if (!LIVE) {
  console.log('Dry run only; no receipt written');
  process.exit(0);
}

const result = writeResult(rows);
console.log(`SUMMARY ${result.correct}/${result.completed} completed (${result.errors} errors) -> ${RESULT}`);
