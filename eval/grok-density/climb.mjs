// Find densest Grok packing that matches the Opus bar:
//   4/4 exact, 0 confab, gist ok, guard ok
// For each font × style, binary-search density bonuses (0..4) for max savings.
// Savings use measured Grok image billing (~1000 tok/MPix).
import { spawnSync } from 'node:child_process';
import { copyFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const MODEL = process.env.GROK_DENSITY_MODEL || 'grok-4.5';
const TIMEOUT_MS = Number(process.env.GROK_DENSITY_TIMEOUT_MS || 180000);
const TOK_PER_MPIX = 1000;

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

// Density levels densest→sparsest. Index 0 is production packing.
const LEVELS = [
  { name: 'd0', w: 0, h: 0 },
  { name: 'd1', w: 1, h: 1 },
  { name: 'd2', w: 2, h: 2 },
  { name: 'd3', w: 3, h: 3 },
  { name: 'd4', w: 4, h: 4 },
];
const STYLES = [
  { name: 'aa', base: { aa: true } },
  { name: 'onebit', base: { aa: false } },
  { name: 'aa+grid', base: { aa: true, grid: true, gridCols: 1 } },
  { name: 'aa+color', base: { aa: true, colorCycle: true } },
];
const FONTS = [
  { name: 'spleen5x8', onebit: 'atlas-spleen5x8.ts', gray: 'atlas-gray-spleen5x8.ts' },
  { name: 'jbmono8', onebit: 'atlas-jbmono8.ts', gray: 'atlas-gray-jbmono8.ts' },
  { name: 'jbmono10', onebit: 'atlas-jbmono10.ts', gray: 'atlas-gray-jbmono10.ts' },
  { name: 'unifont8', onebit: 'atlas-unifont8.ts', gray: 'atlas-gray-unifont8.ts' },
  { name: 'unifont10', onebit: 'atlas-unifont10.ts', gray: 'atlas-gray-unifont10.ts' },
];

function sh(cmd) {
  const r = spawnSync(cmd, { cwd: root, env: process.env, encoding: 'utf8', shell: true });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status ?? 1;
}
function restore() {
  sh('git checkout -- src/core/atlas.ts src/core/atlas-gray.ts');
  sh('pnpm run build >/tmp/px-climb-build.log 2>&1');
}
function installFont(font) {
  const one = join(here, 'atlases', font.onebit);
  const gray = join(here, 'atlases', font.gray);
  if (!existsSync(one) || !existsSync(gray)) throw new Error(`missing ${font.name}`);
  copyFileSync(one, resolve(root, 'src/core/atlas.ts'));
  copyFileSync(gray, resolve(root, 'src/core/atlas-gray.ts'));
  if (sh('pnpm run build >/tmp/px-climb-build.log 2>&1') !== 0) throw new Error(`build failed ${font.name}`);
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
    const j = JSON.parse(await res.text());
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${j?.error?.message || ''}`);
    let text = typeof j.output_text === 'string' ? j.output_text : '';
    if (!text && Array.isArray(j.output)) {
      for (const item of j.output) {
        if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
          if (part && (part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') text += part.text;
        }
      }
    }
    return { text: text.trim(), ms: Date.now() - t0 };
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

const rows = [];
const cache = new Map(); // id -> result
const outPath = join(here, 'climb-results.json');
function checkpoint() {
  const perfect = rows.filter((r) => r.pass).sort((a, b) => b.savingsPct - a.savingsPct || a.imageTokensEst - b.imageTokensEst);
  writeFileSync(
    outPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), model: MODEL, textTokens: TEXT_TOKENS, rows, perfect, best: perfect[0] || null }, null, 2),
  );
}

async function evaluate(font, st, level, cellW0, cellH0, renderTextToPngs) {
  const dens = LEVELS[level];
  const style = { ...st.base, cellWBonus: dens.w, cellHBonus: dens.h };
  const cellW = cellW0 + dens.w;
  const cols = Math.max(8, Math.floor((768 - 8) / cellW));
  const id = `${font.name}_${st.name}_${dens.name}_c${cols}`;
  if (cache.has(id)) return cache.get(id);

  const imgs = await renderTextToPngs(SESSION, cols, style, 1932);
  const pages = imgs.map((im) => ({ png: im.png, width: im.width, height: im.height }));
  const pixels = pages.reduce((n, p) => n + p.width * p.height, 0);
  const imageTokensEst = Math.round((pixels / 1e6) * TOK_PER_MPIX);
  const savingsPct = Math.round((1 - imageTokensEst / TEXT_TOKENS) * 100);
  console.log(`\n[${id}] atlas=${cellW0}x${cellH0} dens=${dens.w}/${dens.h} dims=${pages.map((p) => p.width + 'x' + p.height).join(',')} save~${savingsPct}% imgTok~${imageTokensEst}`);

  const dataUrls = pages.map((p) => 'data:image/png;base64,' + Buffer.from(p.png).toString('base64'));
  const m = { exactCorrect: 0, exactTotal: 0, confab: 0, gistOk: false, guardOk: false, answers: [] };
  for (const q of QUESTIONS) {
    try {
      const { text, ms } = await callModel(dataUrls, q.q);
      const s = score(q.kind, q.answer, text);
      m.answers.push({ id: q.id, kind: q.kind, expected: q.answer, got: text, ...s, ms });
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
      m.answers.push({ id: q.id, kind: q.kind, error: String(err.message || err), ok: false, confab: false, refused: true });
      if (q.kind === 'exact') m.exactTotal++;
    }
  }
  const pass = m.exactCorrect === 4 && m.confab === 0 && m.gistOk && m.guardOk;
  console.log(
    `  → exact ${m.exactCorrect}/${m.exactTotal} confab ${m.confab} gist ${m.gistOk ? 'ok' : 'FAIL'} guard ${m.guardOk ? 'ok' : 'FAIL'} save~${savingsPct}% ${pass ? '*** OPUS BAR ***' : ''}`,
  );
  const row = {
    id,
    font: font.name,
    style: st.name,
    density: dens.name,
    cellWBonus: dens.w,
    cellHBonus: dens.h,
    atlasCell: `${cellW0}x${cellH0}`,
    cols,
    dims: pages.map((p) => `${p.width}x${p.height}`),
    pages: pages.length,
    pixels,
    imageTokensEst,
    savingsPct,
    model: m,
    pass,
    profile: {
      stripCols: cols,
      maxHeightPx: 1932,
      style: {
        cellWBonus: dens.w,
        cellHBonus: dens.h,
        aa: !!st.base.aa,
        grid: !!st.base.grid,
        colorCycle: !!st.base.colorCycle,
      },
      font: font.name,
    },
  };
  rows.push(row);
  cache.set(id, row);
  checkpoint();
  return row;
}

try {
  for (const font of FONTS) {
    console.log(`\n######## FONT ${font.name} ########`);
    installFont(font);
    const bust = `?f=${font.name}&t=${Date.now()}`;
    const { renderTextToPngs } = await import('../../dist/core/render.js' + bust);
    const atlas = await import('../../dist/core/atlas.js' + bust);
    const cellW0 = atlas.ATLAS_CELL_W;
    const cellH0 = atlas.ATLAS_CELL_H;
    console.log(`atlas cell ${cellW0}x${cellH0}`);

    for (const st of STYLES) {
      // Binary search densest level that passes Opus bar.
      // Probe endpoints first: densest (0) and sparsest (last).
      const loProbe = await evaluate(font, st, 0, cellW0, cellH0, renderTextToPngs);
      if (loProbe.pass) {
        console.log(`Style ${st.name}: densest d0 already passes. Done for style.`);
        continue;
      }
      const hiProbe = await evaluate(font, st, LEVELS.length - 1, cellW0, cellH0, renderTextToPngs);
      if (!hiProbe.pass) {
        console.log(`Style ${st.name}: sparsest d4 still fails Opus bar.`);
        continue;
      }
      // Binary search for minimal level index that passes.
      let lo = 0; // fails
      let hi = LEVELS.length - 1; // passes
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        const r = await evaluate(font, st, mid, cellW0, cellH0, renderTextToPngs);
        if (r.pass) hi = mid;
        else lo = mid;
      }
      console.log(`Style ${st.name}: densest Opus-bar level = ${LEVELS[hi].name}`);
    }
  }
} finally {
  console.log('\nRestoring production atlas...');
  restore();
}

const perfect = rows.filter((r) => r.pass).sort((a, b) => b.savingsPct - a.savingsPct || a.imageTokensEst - b.imageTokensEst);
console.log('\n======== SUMMARY ========');
console.log('Opus-bar hits:', perfect.length);
for (const r of perfect) console.log(`  ${r.id} save~${r.savingsPct}% imgTok~${r.imageTokensEst}`);
if (perfect[0]) {
  console.log('BEST', perfect[0].id, perfect[0].savingsPct);
  console.log('PROFILE', JSON.stringify(perfect[0].profile));
} else {
  console.log('No combo reached Opus bar.');
}
checkpoint();
