// GLM 5.3 Flash verbatim hex pilot at the native 14px geometry.
// Fixture: eval/glm-profile/14px-fixture (recovered source text re-rendered at
// JetBrains Mono 14px, 84 cols, maxH 512). Receipt schema mirrors the Qwen 14px
// pilot receipt.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callGlm } from './glm-client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '14px-fixture');
const MODEL = process.env.MODEL || '@cf/zai-org/glm-5.3-flash';
const LIVE = process.env.LIVE === '1';
const TIMEOUT = Number(process.env.TIMEOUT_MS || 120000);
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 4096);
const trials = JSON.parse(readFileSync(join(ROOT, 'golds.json'), 'utf8'));
const RESULT = join(HERE, 'verbatim-hex-14px-results.json');

const pageCache = new Map();
function getPagePng(page) {
  let png = pageCache.get(page);
  if (!png) png = readFileSync(join(ROOT, `page${page}.png`));
  pageCache.set(page, png);
  return png;
}

const existing = existsSync(RESULT) ? JSON.parse(readFileSync(RESULT, 'utf8')) : null;
const rows = existing?.rows ?? [];

for (let i = 0; i < trials.length; i++) {
  const t = trials[i];
  if (rows[i] && !rows[i].error && rows[i].got !== undefined) {
    console.log(`trial ${i + 1}/15 page${t.page} dur=${t.dur} (cached: ${rows[i].ok ? 'HIT' : 'MISS'})`);
    continue;
  }
  let out = '';
  let ms = null;
  let err = null;
  process.stdout.write(`trial ${i + 1}/15 page${t.page} dur=${t.dur} ... `);
  try {
    if (LIVE) {
      const r = await callGlm({
        model: MODEL,
        content: [
          { type: 'input_image', image_url: `data:image/png;base64,${getPagePng(t.page).toString('base64')}` },
          { type: 'input_text', text: `Read the image visually. Find the JSON line whose dur_ms is exactly ${t.dur}. Return only its id field, exactly 12 lowercase hex characters.` },
        ],
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        timeoutMs: TIMEOUT,
      });
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
  if (LIVE) writeResult();
  console.log(`${ok ? 'HIT' : 'MISS'} gold=${t.gold} got=${got || '-'}${ms != null ? ` ${ms}ms` : ''}${err ? ` ERR ${err.slice(0, 100)}` : ''}`);
}

function writeResult() {
  const completed = rows.filter((r) => !r.error);
  writeFileSync(RESULT, JSON.stringify({
    model: MODEL,
    font: 'jetbrains-mono-14',
    cols: 84,
    maxH: 512,
    generatedAt: new Date().toISOString(),
    live: LIVE,
    correct: completed.filter((r) => r.ok).length,
    completed: completed.length,
    errors: rows.length - completed.length,
    n: trials.length,
    rows,
  }, null, 2) + '\n');
}

if (!LIVE) {
  console.log('Dry run only; no receipt written');
  process.exit(0);
}

writeResult();
const completed = rows.filter((r) => !r.error);
console.log(`SUMMARY ${completed.filter((r) => r.ok).length}/${completed.length} completed -> ${RESULT}`);
