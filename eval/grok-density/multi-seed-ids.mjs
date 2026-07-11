// Multi-seed pure-image ID stability for the shipping Grok recipe.
// Production: Spleen 5x8, 152 cols, maxH 512, white AA, no grid, appendIdsBlock.
// Live: GROK_DENSITY_LIVE=1 node eval/grok-density/multi-seed-ids.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTextToPngs } from '../../dist/core/render.js';
import { resolveGptProfile } from '../../dist/core/gpt-model-profiles.js';
import { visionTokensForModel } from '../../dist/core/openai.js';
import { appendIdsBlock, factSheetText } from '../../dist/core/factsheet.js';
import {
  callResponses,
  pngsToDataUrls,
  profileStyle,
} from './lib-responses.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.GROK_DENSITY_MODEL || 'grok-4.5';
const LIVE = process.env.GROK_DENSITY_LIVE === '1';
const N = Math.max(1, Number(process.env.N || 10));
const SEED = Number(process.env.SEED || 20260711);
const TIMEOUT_MS = Number(process.env.GROK_DENSITY_TIMEOUT_MS || 180_000);
const BULK = Math.max(0, Number(process.env.BULK || 40)); // filler assistant lines
// Production Grok path always attaches a text factsheet next to images.
// Pure-image-only is opt-in for research: WITH_FACTSHEET=0
const WITH_FACTSHEET = !/^(0|false|no|off)$/i.test(String(process.env.WITH_FACTSHEET ?? '1'));

const profile = resolveGptProfile(MODEL);
const COLS = profile.stripCols;
const MAX_H = profile.maxHeightPx;
const STYLE = profileStyle(profile);

// Deterministic LCG
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

function hex12(rng) {
  let h = '';
  for (let i = 0; i < 12; i++) h += (rng() % 16).toString(16);
  return h;
}

const CAMELS = [
  'tokenLedgerShard', 'retryBudgetSeconds', 'cacheWarmCursor', 'visionPatchCap',
  'promptPrefixHash', 'imageTokenDelta', 'sessionFenceMark', 'denseGlyphPitch',
];
const PATHS = [
  'src/core/anthropic-vision.ts', 'src/core/openai-history.ts', 'src/core/factsheet.ts',
  'src/core/gpt-model-profiles.ts', 'eval/grok-density/run.mjs', 'scripts/gen-context-chart.ts',
];
const PORTS = ['47821', '8082', '3001', '8443', '9123', '18080'];

function truthForSeed(seed) {
  const rng = lcg(seed);
  return {
    hex: hex12(rng),
    camel: CAMELS[rng() % CAMELS.length],
    path: PATHS[rng() % PATHS.length],
    port: PORTS[rng() % PORTS.length],
    retry: 2 + (rng() % 5), // 2..6
  };
}

function session(t) {
  return [
    `<user t="1">Wire up the retry path. Use a retry budget of ${t.retry} attempts, backing off 250ms.</user>`,
    `<assistant t="2">Done. The token cache key is ${t.hex}. I renamed the field to ${t.camel}`,
    `and moved the tier math into ${t.path}. The CLI now takes --max-visual-tokens. Proxy stays on port ${t.port}.</assistant>`,
    `<user t="3">Good. Keep the retry budget as decided; do not change the backoff.</user>`,
    ...Array.from({ length: BULK }, (_, i) =>
      `<assistant t="${4 + i}">step ${i}: processed shard ${i} of the ${t.camel}, ok, continuing the run.</assistant>`),
  ].join('\n');
}

function questions(t) {
  return [
    { id: 'hex', kind: 'exact', q: 'What is the exact token cache key (12-char hex) mentioned in the transcript?', answer: t.hex },
    { id: 'camel', kind: 'exact', q: 'What is the exact field name the assistant renamed the field to?', answer: t.camel },
    { id: 'path', kind: 'exact', q: 'What exact file path did the tier math move into?', answer: t.path },
    { id: 'port', kind: 'exact', q: 'What port does the proxy stay on?', answer: t.port },
    { id: 'gist', kind: 'gist', q: 'What retry budget was decided (a number of attempts)?', answer: String(t.retry) },
    { id: 'guard', kind: 'guard', q: 'What database password was configured in this session? If it was not stated, say "NOT STATED".', answer: 'NOT STATED' },
  ];
}

function score(kind, expected, got) {
  if (!got) return { ok: false, abstained: false, confab: false, refused: true };
  const g = got.toLowerCase();
  const abstained = /not stated|unknown|not safe|can't|cannot|not present|i don't know|do not know/.test(g);
  if (kind === 'guard') return { ok: abstained, abstained, confab: !abstained, refused: false };
  if (kind === 'gist') return { ok: g.includes(String(expected).toLowerCase()), abstained, confab: false, refused: false };
  return { ok: got.includes(expected), abstained, confab: !got.includes(expected) && !abstained, refused: false };
}

const rows = [];
let passN = 0;
console.log(`multi-seed IDs · model=${MODEL} · N=${N} · seed=${SEED} · live=${LIVE} · factsheet=${WITH_FACTSHEET}`);
console.log(`profile cols=${COLS} maxH=${MAX_H} style=${JSON.stringify(STYLE)}`);

for (let i = 0; i < N; i++) {
  const seed = (SEED + i * 9973) >>> 0;
  const t = truthForSeed(seed);
  const text = appendIdsBlock(session(t));
  const imgs = await renderTextToPngs(text, COLS, STYLE, MAX_H);
  const imageTokens = imgs.reduce((n, im) => n + visionTokensForModel(MODEL, im.width, im.height), 0);
  const row = {
    id: `seed_${i + 1}`,
    seed,
    truth: t,
    pages: imgs.length,
    dims: imgs.map((im) => `${im.width}x${im.height}`),
    imageTokens,
    model: null,
  };
  console.log(`\n[${row.id}] seed=${seed} pages=${imgs.length} tok=${imageTokens} hex=${t.hex} camel=${t.camel}`);

  if (LIVE) {
    const dataUrls = pngsToDataUrls(imgs);
    const m = { exactCorrect: 0, exactTotal: 0, confab: 0, gistOk: false, guardOk: false, answers: [] };
    for (const q of questions(t)) {
      try {
        const content = [
          ...dataUrls.map((u) => ({ type: 'input_image', image_url: u, detail: 'original' })),
        ];
        if (WITH_FACTSHEET) {
          const fs = factSheetText(session(t));
          if (fs) content.push({ type: 'input_text', text: fs });
        }
        content.push({
          type: 'input_text',
          text: `${q.q}\nAnswer with ONLY the exact value, or "NOT STATED" if it is not present. Prefer the factsheet if present for exact IDs. Do not guess.`,
        });
        const r = await callResponses({ model: MODEL, content, timeoutMs: TIMEOUT_MS });
        const s = score(q.kind, q.answer, r.text);
        if (q.kind === 'exact') {
          m.exactTotal++;
          if (s.ok) m.exactCorrect++;
          if (s.confab) m.confab++;
        } else if (q.kind === 'gist') m.gistOk = s.ok;
        else if (q.kind === 'guard') m.guardOk = s.ok;
        m.answers.push({ id: q.id, kind: q.kind, expected: q.answer, got: r.text, ...s, ms: r.ms });
        console.log(`  ${q.id}: ${JSON.stringify(r.text)} ok=${s.ok}`);
      } catch (err) {
        m.answers.push({ id: q.id, kind: q.kind, expected: q.answer, got: '', error: String(err.message || err) });
        console.log(`  ${q.id}: ERROR ${err.message || err}`);
        if (q.kind === 'exact') m.exactTotal++;
      }
    }
    m.pass = m.exactCorrect === 4 && m.confab === 0 && m.gistOk && m.guardOk;
    if (m.pass) passN++;
    row.model = m;
    console.log(`  → exact ${m.exactCorrect}/4 confab ${m.confab} gist ${m.gistOk} guard ${m.guardOk} ${m.pass ? '*** PASS ***' : ''}`);
  }
  rows.push(row);
  writeFileSync(join(here, 'multi-seed-ids-results.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    model: MODEL,
    live: LIVE,
    n: N,
    seed: SEED,
    recipe: { cols: COLS, maxH: MAX_H, style: STYLE, idsBlock: true, pureImage: true, factsheet: WITH_FACTSHEET },
    passN: LIVE ? passN : null,
    rows,
  }, null, 2));
}

if (LIVE) {
  console.log(`\n=== multi-seed summary: ${passN}/${N} full pass (4/4 exact, 0 confab, gist, guard) ===`);
} else {
  console.log('\nDry-run only. Re-run with GROK_DENSITY_LIVE=1 to score.');
}
