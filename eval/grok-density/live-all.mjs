// Live brute: real fonts (eval atlases) × style arms × densest packing.
// Goal: match Opus bar (4/4 exact, 0 confab, gist+guard ok) at the highest
// savings. Uses measured Grok image billing ~1000 tok/MPix for savings.
//
// Temporarily swaps src/core/atlas*.ts for each font, rebuilds dist, scores,
// then restores production atlases from git.
import { spawnSync } from 'node:child_process';
import { copyFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const MODEL = process.env.GROK_DENSITY_MODEL || 'grok-4.5';
const TIMEOUT_MS = Number(process.env.GROK_DENSITY_TIMEOUT_MS || 180000);
const TOK_PER_MPIX = 1000; // from measure-image-tokens.mjs

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

const FONTS = [
  { name: 'spleen5x8', onebit: 'atlas-spleen5x8.ts', gray: 'atlas-gray-spleen5x8.ts' },
  { name: 'jbmono8', onebit: 'atlas-jbmono8.ts', gray: 'atlas-gray-jbmono8.ts' },
  { name: 'jbmono10', onebit: 'atlas-jbmono10.ts', gray: 'atlas-gray-jbmono10.ts' },
  { name: 'unifont8', onebit: 'atlas-unifont8.ts', gray: 'atlas-gray-unifont8.ts' },
  { name: 'unifont10', onebit: 'atlas-unifont10.ts', gray: 'atlas-gray-unifont10.ts' },
];

// Style arms that do not require a different atlas size (same cell).
const STYLES = [
  { name: 'aa', style: { aa: true, cellWBonus: 0, cellHBonus: 0 } },
  { name: 'onebit', style: { aa: false, cellWBonus: 0, cellHBonus: 0 } },
  { name: 'aa+grid', style: { aa: true, grid: true, gridCols: 1, cellWBonus: 0, cellHBonus: 0 } },
  { name: 'aa+color', style: { aa: true, colorCycle: true, cellWBonus: 0, cellHBonus: 0 } },
  { name: 'aa+role', style: { aa: true, colorByRole: true, cellWBonus: 0, cellHBonus: 0 } },
  { name: 'onebit+grid', style: { aa: false, grid: true, gridCols: 1, cellWBonus: 0, cellHBonus: 0 } },
  { name: 'onebit+color', style: { aa: false, colorCycle: true, cellWBonus: 0, cellHBonus: 0 } },
  // small spacing only if needed later — included so we can climb toward Opus bar without jumping to 9x12
  { name: 'aa+w1h1', style: { aa: true, cellWBonus: 1, cellHBonus: 1 } },
  { name: 'aa+w2h2', style: { aa: true, cellWBonus: 2, cellHBonus: 2 } },
];

// Geometry: densest first (max savings). stripCols from cell width at runtime.
const GEOS = [
  { name: 'wide1932', stripPx: 768, maxHeightPx: 1932 },
  { name: 'wide1536', stripPx: 768, maxHeightPx: 1536 },
  { name: 'mid1932', stripPx: 640, maxHeightPx: 1932 },
];

function sh(cmd, env = {}) {
  const r = spawnSync(cmd, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    shell: true,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status ?? 1;
}

function restoreProdAtlas() {
  sh('git checkout -- src/core/atlas.ts src/core/atlas-gray.ts');
  sh('pnpm run build');
}

function installFont(font) {
  const one = join(here, 'atlases', font.onebit);
  const gray = join(here, 'atlases', font.gray);
  if (!existsSync(one) || !existsSync(gray)) throw new Error(`missing atlas for ${font.name}`);
  copyFileSync(one, resolve(root, 'src/core/atlas.ts'));
  // gray atlas export names differ (ATLAS_GRAY_*). The production atlas-gray.ts
  // file already uses those names. Our generator writes ATLAS_GRAY_* only in gray mode.
  copyFileSync(gray, resolve(root, 'src/core/atlas-gray.ts'));
  const st = sh('pnpm run build');
  if (st !== 0) throw new Error(`build failed for ${font.name}`);
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
    return {
      text: text.trim(),
      ms: Date.now() - t0,
      status: j.status || null,
      usage: j.usage || null,
    };
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
const outPath = join(here, 'live-all-results.json');

function checkpoint() {
  const perfect = rows
    .filter((r) => r.model && r.model.exactCorrect === 4 && r.model.confab === 0 && r.model.gistOk && r.model.guardOk)
    .sort((a, b) => b.savingsPct - a.savingsPct || a.imageTokensEst - b.imageTokensEst);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        model: MODEL,
        textTokens: TEXT_TOKENS,
        goal: 'opus-bar: 4/4 exact, 0 confab, gist+guard ok, maximize savings',
        rows,
        perfect,
        bestPerfect: perfect[0] || null,
      },
      null,
      2,
    ),
  );
}

try {
  for (const font of FONTS) {
    console.log(`\n######## FONT ${font.name} ########`);
    installFont(font);
    // dynamic import after rebuild
    const { renderTextToPngs } = await import('../../dist/core/render.js?font=' + font.name + '&t=' + Date.now());
    const { ATLAS_CELL_W, ATLAS_CELL_H } = await import('../../dist/core/atlas.js?font=' + font.name + '&t=' + Date.now());
    console.log(`atlas cell ${ATLAS_CELL_W}x${ATLAS_CELL_H}`);

    for (const geo of GEOS) {
      for (const st of STYLES) {
        const cellW = ATLAS_CELL_W + (st.style.cellWBonus || 0);
        const cols = Math.max(8, Math.floor((geo.stripPx - 8) / cellW));
        const id = `${font.name}_${st.name}_${geo.name}_c${cols}`;
        const imgs = await renderTextToPngs(SESSION, cols, st.style, geo.maxHeightPx);
        const pages = imgs.map((im) => ({ png: im.png, width: im.width, height: im.height }));
        const pixels = pages.reduce((n, p) => n + p.width * p.height, 0);
        const imageTokensEst = Math.round((pixels / 1e6) * TOK_PER_MPIX);
        const savingsPct = Math.round((1 - imageTokensEst / TEXT_TOKENS) * 100);
        const row = {
          id,
          font: font.name,
          style: st.name,
          geo: geo.name,
          cell: `${ATLAS_CELL_W}x${ATLAS_CELL_H}`,
          cols,
          pages: pages.length,
          dims: pages.map((p) => `${p.width}x${p.height}`),
          pixels,
          imageTokensEst,
          savingsPct,
          model: null,
        };
        console.log(`\n[${id}] save~${savingsPct}% pages=${pages.length} dims=${row.dims.join(',')} imgTok~${imageTokensEst}`);

        // Skip hopeless savings only if worse than a known perfect candidate later;
        // still score all first-pass dense candidates. Skip only if negative savings.
        if (savingsPct < 0) {
          console.log('  skip: negative savings');
          rows.push(row);
          checkpoint();
          continue;
        }

        const dataUrls = pages.map((p) => 'data:image/png;base64,' + Buffer.from(p.png).toString('base64'));
        const m = { exactCorrect: 0, exactTotal: 0, confab: 0, gistOk: false, guardOk: false, answers: [], usageImageDelta: null };
        for (const q of QUESTIONS) {
          try {
            const { text, ms, status, usage } = await callModel(dataUrls, q.q);
            const s = score(q.kind, q.answer, text);
            m.answers.push({ id: q.id, kind: q.kind, expected: q.answer, got: text, status, ...s, ms, usage });
            if (q.kind === 'exact') {
              m.exactTotal++;
              if (s.ok) m.exactCorrect++;
            }
            if (s.confab) m.confab++;
            if (q.kind === 'gist' && !s.refused) m.gistOk = s.ok;
            if (q.kind === 'guard' && !s.refused) m.guardOk = s.ok;
            if (q.id === 'hex' && usage?.input_tokens != null) m.usageInput = usage.input_tokens;
            const mark = s.ok ? 'OK' : s.refused ? 'REFUSED' : s.abstained ? 'ABSTAIN' : s.confab ? 'CONFAB' : 'MISS';
            console.log(`  ${q.id.padEnd(6)} ${mark.padEnd(8)} ${JSON.stringify(text).slice(0, 70)} (${ms}ms)`);
          } catch (err) {
            console.error(`  ${q.id.padEnd(6)} ERROR ${err.message}`);
            m.answers.push({ id: q.id, kind: q.kind, expected: q.answer, got: '', error: String(err.message || err), ok: false, confab: false, refused: true, ms: 0 });
            if (q.kind === 'exact') m.exactTotal++;
          }
        }
        row.model = m;
        const pass = m.exactCorrect === 4 && m.confab === 0 && m.gistOk && m.guardOk;
        console.log(
          `  → exact ${m.exactCorrect}/${m.exactTotal} confab ${m.confab} gist ${m.gistOk ? 'ok' : 'FAIL'} guard ${m.guardOk ? 'ok' : 'FAIL'} save~${savingsPct}% ${pass ? '*** OPUS BAR ***' : ''}`,
        );
        rows.push(row);
        checkpoint();
      }
    }
  }
} finally {
  console.log('\nRestoring production atlas...');
  restoreProdAtlas();
}

const perfect = rows
  .filter((r) => r.model && r.model.exactCorrect === 4 && r.model.confab === 0 && r.model.gistOk && r.model.guardOk)
  .sort((a, b) => b.savingsPct - a.savingsPct || a.imageTokensEst - b.imageTokensEst);
console.log('\n======== SUMMARY ========');
console.log('perfect count', perfect.length);
for (const r of perfect.slice(0, 15)) {
  console.log(`  ${r.id} save~${r.savingsPct}% imgTok~${r.imageTokensEst} dims=${r.dims.join(',')}`);
}
if (perfect[0]) console.log('BEST', perfect[0].id, perfect[0].savingsPct);
else console.log('No combo reached Opus bar yet.');
checkpoint();
