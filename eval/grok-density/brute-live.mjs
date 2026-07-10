// Focused live sweep: density ladder where dry-run still shows real savings.
// Full 225-combo dry-run is in brute.mjs; this only spends model calls on the
// candidates that can still win on cost.
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderTextToPngs } from '../../dist/core/render.js';
import { openAIVisionTokens } from '../../dist/core/openai.js';

const here = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.GROK_DENSITY_MODEL || 'grok-4.5';
const TIMEOUT_MS = Number(process.env.GROK_DENSITY_TIMEOUT_MS || 180000);
const PAD_X = 4;
const CELL_BASE_W = 5;

const TRUTH = {
  hex: 'a3f9c1e0b7d2',
  camel: 'tokenLedgerShard',
  path: 'src/core/anthropic-vision.ts',
  port: '47821',
};
const SESSION = [
  '<user t="1">Wire up the retry path. Use a retry budget of 3 attempts, backing off 250ms.</user>',
  `<assistant t="2">Done. The token cache key is ${TRUTH.hex}. I renamed the field to ${TRUTH.camel}`,
  `and moved the tier math into ${TRUTH.path}. The CLI now takes --max-visual-tokens. Proxy stays on port ${TRUTH.port}.</assistant>`,
  '<user t="3">Good. Keep the retry budget as decided; do not change the backoff.</user>',
  ...Array.from({ length: 40 }, (_, i) =>
    `<assistant t="${4 + i}">step ${i}: processed shard ${i} of the ${TRUTH.camel}, ok, continuing the run.</assistant>`),
].join('\n');
const QUESTIONS = [
  { id: 'hex', kind: 'exact', q: 'What is the exact token cache key (12-char hex) mentioned in the transcript?', answer: TRUTH.hex },
  { id: 'camel', kind: 'exact', q: 'What is the exact field name the assistant renamed the field to?', answer: TRUTH.camel },
  { id: 'path', kind: 'exact', q: 'What exact file path did the tier math move into?', answer: TRUTH.path },
  { id: 'port', kind: 'exact', q: 'What port does the proxy stay on?', answer: TRUTH.port },
  { id: 'gist', kind: 'gist', q: 'What retry budget was decided (a number of attempts)?', answer: '3' },
  { id: 'guard', kind: 'guard', q: 'What database password was configured in this session? If it was not stated, say "NOT STATED".', answer: 'NOT STATED' },
];
const TEXT_TOKENS = Math.ceil(SESSION.length / 4);

// Density ladder + geometry knobs that dry-run keeps save>=30% for most cells.
const CELLS = [
  [0, 0], // production baseline
  [1, 1],
  [2, 2], // prior 7x10-ish
  [2, 3],
  [3, 2],
  [3, 3],
  [3, 4],
  [4, 2],
  [4, 3],
  [4, 4], // prior 9x12-ish
];
const STRIP_COLS = [152, 128];
const MAX_H = [1932, 1536];

function colsFor(stripCols, wBonus) {
  const maxW = 2 * PAD_X + stripCols * CELL_BASE_W;
  return Math.max(8, Math.floor((maxW - 2 * PAD_X) / (CELL_BASE_W + wBonus)));
}
function responsesBaseUrl() {
  const base = (process.env.OPENAI_BASE_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('OPENAI_BASE_URL required');
  return base.endsWith('/responses') ? base : `${base}/responses`;
}
async function callModel(dataUrls, question) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY required');
  const content = [
    ...dataUrls.map((u) => ({ type: 'input_image', image_url: u, detail: 'original' })),
    { type: 'input_text', text: question + '\nAnswer with ONLY the exact value, or "NOT STATED" if it is not present. Do not guess.' },
  ];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(responsesBaseUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        max_output_tokens: 512,
        input: [{ role: 'user', content }],
      }),
      signal: controller.signal,
    });
    const raw = await res.text();
    const j = JSON.parse(raw);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${j?.error?.message || raw.slice(0, 160)}`);
    let text = typeof j.output_text === 'string' ? j.output_text : '';
    if (!text && Array.isArray(j.output)) {
      for (const item of j.output) {
        if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
          if (part && (part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') text += part.text;
        }
      }
    }
    return { text: text.trim(), ms: Date.now() - t0, status: j.status || null };
  } finally {
    clearTimeout(timer);
  }
}
function score(kind, expected, got) {
  if (!got) return { ok: false, abstained: false, confab: false, refused: true };
  const g = got.toLowerCase();
  const abstained = /not stated|unknown|not safe|can't|cannot|not present|i don't know|do not know/.test(g);
  if (kind === 'guard') return { ok: abstained, abstained, confab: !abstained, refused: false };
  if (kind === 'gist') return { ok: g.includes(String(expected).toLowerCase()), abstained, confab: false, refused: false };
  return { ok: got.includes(expected), abstained, confab: !got.includes(expected) && !abstained, refused: false };
}

const combos = [];
for (const stripCols of STRIP_COLS) {
  for (const maxHeightPx of MAX_H) {
    for (const [cellWBonus, cellHBonus] of CELLS) {
      combos.push({
        id: `w${cellWBonus}h${cellHBonus}_c${stripCols}_H${maxHeightPx}`,
        cellWBonus,
        cellHBonus,
        stripCols,
        maxHeightPx,
        cols: colsFor(stripCols, cellWBonus),
        style: { cellWBonus, cellHBonus, aa: true },
      });
    }
  }
}

console.log(`Grok focused live brute · model=${MODEL} · combos=${combos.length}`);
const rows = [];
for (const c of combos) {
  const imgs = await renderTextToPngs(SESSION, c.cols, c.style, c.maxHeightPx);
  const pages = imgs.map((im) => ({ png: im.png, width: im.width, height: im.height }));
  const imageTokens = pages.reduce((n, p) => n + openAIVisionTokens(MODEL, p.width, p.height), 0);
  const savingsPct = Math.round((1 - imageTokens / TEXT_TOKENS) * 100);
  const row = {
    id: c.id,
    cellWBonus: c.cellWBonus,
    cellHBonus: c.cellHBonus,
    stripCols: c.stripCols,
    maxHeightPx: c.maxHeightPx,
    cols: c.cols,
    pages: pages.length,
    dims: pages.map((p) => `${p.width}x${p.height}`),
    imageTokens,
    savingsPct,
    model: null,
  };
  console.log(`\n[${c.id}] save=${savingsPct}% pages=${pages.length} dims=${row.dims.join(',')} imgTok=${imageTokens}`);
  if (savingsPct < 15) {
    console.log('  skip live: savings below 15%');
    rows.push(row);
    continue;
  }
  const dataUrls = pages.map((p) => 'data:image/png;base64,' + Buffer.from(p.png).toString('base64'));
  const m = { exactCorrect: 0, exactTotal: 0, confab: 0, gistOk: false, guardOk: false, answers: [] };
  for (const q of QUESTIONS) {
    try {
      const { text, ms, status } = await callModel(dataUrls, q.q);
      const s = score(q.kind, q.answer, text);
      m.answers.push({ id: q.id, kind: q.kind, expected: q.answer, got: text, status, ...s, ms });
      if (q.kind === 'exact') {
        m.exactTotal++;
        if (s.ok) m.exactCorrect++;
      }
      if (s.confab) m.confab++;
      if (q.kind === 'gist' && !s.refused) m.gistOk = s.ok;
      if (q.kind === 'guard' && !s.refused) m.guardOk = s.ok;
      const mark = s.ok ? 'OK' : s.refused ? 'REFUSED' : s.abstained ? 'ABSTAIN' : s.confab ? 'CONFAB' : 'MISS';
      console.log(`  ${q.id.padEnd(6)} ${mark.padEnd(8)} ${JSON.stringify(text).slice(0, 70)} (${ms}ms)`);
    } catch (err) {
      console.error(`  ${q.id.padEnd(6)} ERROR ${err.message}`);
      m.answers.push({ id: q.id, kind: q.kind, expected: q.answer, got: '', error: String(err.message || err), ok: false, confab: false, refused: true, ms: 0 });
      if (q.kind === 'exact') m.exactTotal++;
    }
  }
  row.model = m;
  console.log(`  → exact ${m.exactCorrect}/${m.exactTotal} confab ${m.confab} gist ${m.gistOk ? 'ok' : 'FAIL'} guard ${m.guardOk ? 'ok' : 'FAIL'} save ${savingsPct}%`);
  rows.push(row);
  // checkpoint after each combo so a mid-run death is not total loss
  writeFileSync(join(here, 'brute-live-results.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    model: MODEL,
    textTokens: TEXT_TOKENS,
    rows,
  }, null, 2));
}

const liveRows = rows.filter((r) => r.model);
const perfect = liveRows
  .filter((r) => r.model.exactCorrect === 4 && r.model.confab === 0 && r.model.gistOk && r.model.guardOk)
  .sort((a, b) => b.savingsPct - a.savingsPct || a.imageTokens - b.imageTokens);
const good = liveRows
  .filter((r) => r.model.exactCorrect >= 3 && r.model.confab <= 1 && r.model.gistOk && r.model.guardOk)
  .sort((a, b) => b.savingsPct - a.savingsPct || a.imageTokens - b.imageTokens);

const out = {
  generatedAt: new Date().toISOString(),
  model: MODEL,
  textTokens: TEXT_TOKENS,
  rows,
  perfect,
  good,
  bestPerfect: perfect[0] || null,
  bestGood: good[0] || null,
};
writeFileSync(join(here, 'brute-live-results.json'), JSON.stringify(out, null, 2));
console.log('\nBEST perfect:', perfect[0]?.id, perfect[0]?.savingsPct);
console.log('BEST good:', good[0]?.id, good[0]?.savingsPct, good[0]?.model && `${good[0].model.exactCorrect}/4`);
for (const r of perfect.slice(0, 8)) {
  console.log(`  perfect ${r.id} save=${r.savingsPct}% dims=${r.dims.join(',')}`);
}
