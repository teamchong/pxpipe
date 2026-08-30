// GLM 5.3 Flash verbatim hex evaluation suite.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callGlm, resultFilename } from './glm-client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../verbatim-15');
const MODEL = process.env.MODEL || '@cf/zai-org/glm-5.3-flash';
const LIVE = process.env.LIVE === '1';
const TIMEOUT = Number(process.env.TIMEOUT_MS || 120000);
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 4096);
const trials = JSON.parse(readFileSync(join(ROOT, 'golds.json'), 'utf8'));
const RESULT = join(HERE, resultFilename('verbatim-hex', MODEL));

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
    rows,
  };
  writeFileSync(RESULT, JSON.stringify(result, null, 2) + '\n');
  return result;
}

const pageCache = new Map();
function getPagePng(page) {
  let png = pageCache.get(page);
  if (!png) {
    png = readFileSync(join(ROOT, `page${page}.png`));
    pageCache.set(page, png);
  }
  return png;
}

async function callImage(trial) {
  const png = getPagePng(trial.page);
  const content = [
    {
      type: 'input_image',
      image_url: `data:image/png;base64,${png.toString('base64')}`,
    },
    {
      type: 'input_text',
      text: `Read the image visually. Find the JSON line whose dur_ms is exactly ${trial.dur}. Return only its id field, exactly 12 lowercase hex characters.`,
    },
  ];
  return callGlm({ model: MODEL, content, maxOutputTokens: MAX_OUTPUT_TOKENS, timeoutMs: TIMEOUT });
}

const existingRows = existsSync(RESULT)
  ? JSON.parse(readFileSync(RESULT, 'utf8')).rows || []
  : [];

const rows = [...existingRows];

for (let i = 0; i < trials.length; i++) {
  const t = trials[i];
  if (i < rows.length && rows[i] && !rows[i].error && rows[i].got !== undefined) {
    console.log(`trial ${i + 1}/${trials.length} page${t.page} dur=${t.dur} (cached: ${rows[i].ok ? 'HIT' : 'MISS'})`);
    continue;
  }

  let out = '';
  let ms = null;
  let err = null;
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
  rows[i] = { ...t, got, ok, raw: out, ms, error: err };
  if (LIVE) writeResult(rows);
  console.log(`${ok ? 'HIT' : 'MISS'} gold=${t.gold} got=${got || '-'}${ms != null ? ` ${ms}ms` : ''}${err ? ` ERR ${err.slice(0, 100)}` : ''}`);
}

if (!LIVE) {
  console.log('Dry run only; no receipt written');
  process.exit(0);
}

const result = writeResult(rows);
console.log(`SUMMARY ${result.correct}/${result.completed} completed (${result.errors} errors) -> ${RESULT}`);
