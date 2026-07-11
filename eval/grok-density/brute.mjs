// Brute-force Grok render profiles across density, strip geometry, AND style.
// Production is a fixed 5x8 atlas (not a TrueType face), so "font" here means
// the atlas/style arms the renderer actually exposes: AA vs 1-bit, grid, color.
//
// Dry-run default. GROK_BRUTE_LIVE=1 scores recall only for combos with save>=15%.
//
//   pnpm run build
//   node eval/grok-density/brute.mjs
//   GROK_BRUTE_LIVE=1 node eval/grok-density/brute.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderTextToPngs } from '../../dist/core/render.js';
import { openAIVisionTokens } from '../../dist/core/openai.js';

const here = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.GROK_DENSITY_MODEL || 'grok-4.5';
const LIVE = process.env.GROK_BRUTE_LIVE === '1' || process.env.GROK_BRUTE_LIVE === 'true';
const TIMEOUT_MS = Number(process.env.GROK_DENSITY_TIMEOUT_MS || 180000);
const MIN_SAVE = Number(process.env.GROK_BRUTE_MIN_SAVE || 15);
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

// Style arms the renderer can actually change (atlas is fixed Unifont 5x8, not a face picker).
const STYLES = [
  { name: 'aa', style: { aa: true } },
  { name: 'onebit', style: { aa: false } },
  { name: 'aa+grid', style: { aa: true, grid: true } },
  { name: 'aa+color', style: { aa: true, colorCycle: true } },
  { name: 'aa+role', style: { aa: true, colorByRole: true } },
  { name: 'onebit+grid', style: { aa: false, grid: true } },
  { name: 'onebit+color', style: { aa: false, colorCycle: true } },
];

// Density ladder: production through large cells.
const CELLS = [
  [0, 0],
  [1, 1],
  [2, 2],
  [2, 3],
  [3, 2],
  [3, 3],
  [4, 3],
  [4, 4],
];
const STRIP_COLS = [152, 128, 100];
const MAX_H = [1932, 1536, 1024];

function colsFor(stripCols, wBonus) {
  const maxW = 2 * PAD_X + stripCols * CELL_BASE_W;
  return Math.max(8, Math.floor((maxW - 2 * PAD_X) / (CELL_BASE_W + wBonus)));
}
function responsesBaseUrl() {
  const base = (process.env.OPENAI_BASE_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('OPENAI_BASE_URL required for live');
  return base.endsWith('/responses') ? base : `${base}/responses`;
}
async function callModel(dataUrls, question) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY required for live');
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
      for (const st of STYLES) {
        combos.push({
          id: `w${cellWBonus}h${cellHBonus}_c${stripCols}_H${maxHeightPx}_${st.name}`,
          cellWBonus,
          cellHBonus,
          stripCols,
          maxHeightPx,
          styleName: st.name,
          cols: colsFor(stripCols, cellWBonus),
          style: { ...st.style, cellWBonus, cellHBonus },
        });
      }
    }
  }
}

console.log(`Grok brute · model=${MODEL} · combos=${combos.length} · live=${LIVE} · minSave=${MIN_SAVE}`);
console.log(`axes: cells=${CELLS.length} styles=${STYLES.length} stripCols=${STRIP_COLS.length} maxH=${MAX_H.length}`);
console.log(`text baseline ≈ ${TEXT_TOKENS} tok`);

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
    styleName: c.styleName,
    cols: c.cols,
    pages: pages.length,
    dims: pages.map((p) => `${p.width}x${p.height}`),
    imageTokens,
    savingsPct,
    model: null,
  };

  const liveThis = LIVE && savingsPct >= MIN_SAVE;
  if (!LIVE || liveThis) {
    console.log(`[${c.id}] save=${savingsPct}% pages=${pages.length} dims=${row.dims.join(',')} imgTok=${imageTokens}`);
  } else {
    console.log(`[skip-live ${c.id}] save=${savingsPct}%`);
  }

  if (liveThis) {
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
    // checkpoint
    writeFileSync(join(here, 'brute-results.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      model: MODEL,
      live: LIVE,
      textTokens: TEXT_TOKENS,
      rows: [...rows, row],
    }, null, 2));
  }
  rows.push(row);
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
  live: LIVE,
  textTokens: TEXT_TOKENS,
  comboCount: combos.length,
  axes: { cells: CELLS, styles: STYLES.map((s) => s.name), stripCols: STRIP_COLS, maxH: MAX_H },
  rows,
  perfect,
  good,
  bestPerfect: perfect[0] || null,
  bestGood: good[0] || null,
};
writeFileSync(join(here, 'brute-results.json'), JSON.stringify(out, null, 2));
console.log(`\nWrote ${join(here, 'brute-results.json')}`);
if (!LIVE) {
  const profitable = rows.filter((r) => r.savingsPct >= MIN_SAVE);
  console.log(`Dry-run: ${profitable.length}/${rows.length} combos save>=${MIN_SAVE}%`);
  // best savings per style at fixed production geometry, and best savings overall
  const byStyle = new Map();
  for (const r of profitable) {
    const k = r.styleName;
    if (!byStyle.has(k) || r.savingsPct > byStyle.get(k).savingsPct) byStyle.set(k, r);
  }
  console.log('Best savings per style (any density/geometry):');
  for (const [k, r] of [...byStyle.entries()].sort((a, b) => b[1].savingsPct - a[1].savingsPct)) {
    console.log(`  ${k}: ${r.id} save=${r.savingsPct}% dims=${r.dims.join(',')}`);
  }
} else {
  console.log('BEST perfect:', perfect[0]?.id, perfect[0]?.savingsPct);
  console.log('BEST good:', good[0]?.id, good[0]?.savingsPct, good[0]?.model && `${good[0].model.exactCorrect}/4`);
  for (const r of perfect.slice(0, 10)) console.log(`  perfect ${r.id} save=${r.savingsPct}%`);
}
