// Opus 4.8 lower-density read sweep. See README.md.
// Dry-run (no key): renders every variant and prints token/savings accounting.
// Full run (ANTHROPIC_API_KEY set): also calls the models and scores the battery.
//
// Run: pnpm exec tsx eval/opus-density/run.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderTextToImages } from '../../src/core/library.js';

const here = dirname(fileURLToPath(import.meta.url));

// Anthropic bills 28-px patches; pxpipe pages are ≤1568×728 (both tiers, no
// downscale), so the raw patch count is the exact per-image cost.
const patchTokens = (w, h) => Math.ceil(w / 28) * Math.ceil(h / 28);

// --- Fixture: one synthetic session with embedded precision-critical tokens ---
const TRUTH = {
  hex: 'a3f9c1e0b7d2',
  camel: 'tokenLedgerShard',
  path: 'src/core/anthropic-vision.ts',
  flag: '--max-visual-tokens',
  port: '47821',
  decisionKey: 'retry budget', // gist: a decision that survives lossy reads
  decisionVal: '3 attempts',
};
const SESSION = [
  '<user t="1">Wire up the retry path. Use a retry budget of 3 attempts, backing off 250ms.</user>',
  `<assistant t="2">Done. The token cache key is ${TRUTH.hex}. I renamed the field to ${TRUTH.camel}`,
  `and moved the tier math into ${TRUTH.path}. The CLI now takes ${TRUTH.flag}. Proxy stays on port ${TRUTH.port}.</assistant>`,
  '<user t="3">Good. Keep the retry budget as decided; do not change the backoff.</user>',
  // padding so the page is realistically dense
  ...Array.from({ length: 40 }, (_, i) =>
    `<assistant t="${4 + i}">step ${i}: processed shard ${i} of the ${TRUTH.camel}, ok, continuing the run.</assistant>`),
].join('\n');

const QUESTIONS = [
  { id: 'hex', kind: 'exact', q: `What is the exact token cache key (12-char hex) mentioned in the transcript?`, answer: TRUTH.hex },
  { id: 'camel', kind: 'exact', q: `What is the exact field name the assistant renamed the field to?`, answer: TRUTH.camel },
  { id: 'path', kind: 'exact', q: `What exact file path did the tier math move into?`, answer: TRUTH.path },
  { id: 'port', kind: 'exact', q: `What port does the proxy stay on?`, answer: TRUTH.port },
  { id: 'gist', kind: 'gist', q: `What retry budget was decided (a number of attempts)?`, answer: '3' },
  { id: 'guard', kind: 'guard', q: `What database password was configured in this session? If it was not stated, say "NOT STATED".`, answer: 'NOT STATED' },
];

// Fewer, wider cells → drop `cols` so the canvas stays ≤ 1568 px wide (the cap
// that keeps every page in Anthropic's linear, no-downscale billing window).
// cols = floor((1568 - 2·PAD_X) / cellW), cellW = 5 + cellWBonus, PAD_X = 4.
const colsFor = (wBonus) => Math.floor((1568 - 8) / (5 + wBonus));
const VARIANTS = [
  { name: '5x8', style: { cellWBonus: 0, cellHBonus: 0, aa: true }, cols: colsFor(0) },
  { name: '7x10', style: { cellWBonus: 2, cellHBonus: 2, aa: true }, cols: colsFor(2) },
  { name: '9x12', style: { cellWBonus: 4, cellHBonus: 4, aa: true }, cols: colsFor(4) },
];
const MODELS = ['claude-opus-4-8', 'claude-fable-5'];

const TEXT_TOKENS = Math.ceil(SESSION.length / 3.5); // rough Claude-Code-dense baseline

async function callModel(model, dataUrls, question) {
  const key = process.env.ANTHROPIC_API_KEY;
  const content = [
    ...dataUrls.map((u) => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: u.replace(/^data:image\/png;base64,/, '') },
    })),
    { type: 'text', text: question + '\nAnswer with ONLY the exact value, or "NOT STATED" if it is not present. Do not guess.' },
  ];
  const t0 = Date.now();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 128, messages: [{ role: 'user', content }] }),
  });
  const j = await res.json();
  const text = (j?.content?.[0]?.text ?? '').trim();
  return { text, ms: Date.now() - t0 };
}

function score(kind, expected, got) {
  const g = got.toLowerCase();
  const abstained = /not stated|unknown|not safe|can't|cannot|not present/.test(g);
  if (kind === 'guard') return { ok: abstained, abstained, confab: !abstained };
  if (kind === 'gist') return { ok: g.includes(String(expected).toLowerCase()), abstained, confab: false };
  // exact
  const ok = got.includes(expected);
  return { ok, abstained, confab: !ok && !abstained };
}

const results = { generatedAt: new Date().toISOString(), textTokens: TEXT_TOKENS, variants: [] };

for (const v of VARIANTS) {
  const { pages } = await renderTextToImages(SESSION, { style: v.style, cols: v.cols, reflow: true });
  const imageTokens = pages.reduce((n, p) => n + patchTokens(p.width, p.height), 0);
  const dataUrls = pages.map((p) => 'data:image/png;base64,' + Buffer.from(p.png).toString('base64'));
  const savingsPct = Math.round((1 - imageTokens / TEXT_TOKENS) * 100);
  const row = { variant: v.name, pages: pages.length, dims: pages.map((p) => `${p.width}x${p.height}`), imageTokens, savingsPct, models: {} };
  console.log(`\n[${v.name}] ${pages.length} page(s) ${row.dims.join(',')} → ${imageTokens} img tok vs ${TEXT_TOKENS} text (${savingsPct}% saved)`);

  if (process.env.ANTHROPIC_API_KEY) {
    for (const model of MODELS) {
      const m = { exactCorrect: 0, exactTotal: 0, confab: 0, abstain: 0, gistOk: false, guardOk: false, answers: [] };
      for (const q of QUESTIONS) {
        const { text, ms } = await callModel(model, dataUrls, q.q);
        const s = score(q.kind, q.answer, text);
        m.answers.push({ id: q.id, kind: q.kind, expected: q.answer, got: text, ...s, ms });
        if (q.kind === 'exact') { m.exactTotal++; if (s.ok) m.exactCorrect++; }
        if (s.confab) m.confab++;
        if (s.abstained) m.abstain++;
        if (q.kind === 'gist') m.gistOk = s.ok;
        if (q.kind === 'guard') m.guardOk = s.ok;
      }
      row.models[model] = m;
      console.log(`  ${model}: exact ${m.exactCorrect}/${m.exactTotal}, confab ${m.confab}, abstain ${m.abstain}, gist ${m.gistOk ? 'ok' : 'MISS'}, guard ${m.guardOk ? 'ok' : 'FAIL'}`);
    }
  } else {
    console.log('  (dry run — set ANTHROPIC_API_KEY to call the models and score)');
  }
  results.variants.push(row);
}

writeFileSync(join(here, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\nWrote ${join(here, 'results.json')}`);
