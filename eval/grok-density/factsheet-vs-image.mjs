// Prove production Grok path: 5x8 image alone fails exact IDs; 5x8 + factsheet
// (what the Responses transform actually sends) clears the Opus exact bar.
// Also re-checks a few dense style variants with factsheet attached.
//
// GROK_DENSITY_LIVE=1 node eval/grok-density/factsheet-vs-image.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTextToPngs } from '../../dist/core/render.js';
import { factSheetText } from '../../dist/core/factsheet.js';
import { visionTokensForModel } from '../../dist/core/openai.js';
import { resolveGptProfile } from '../../dist/core/gpt-model-profiles.js';

const here = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.GROK_DENSITY_MODEL || 'grok-4.5';
const TIMEOUT_MS = Number(process.env.GROK_DENSITY_TIMEOUT_MS || 180000);
const LIVE = process.env.GROK_DENSITY_LIVE === '1';
const PAD_X = 4;
const CELL_W = 5;

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

function responsesBaseUrl() {
  const base = (process.env.OPENAI_BASE_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('OPENAI_BASE_URL required');
  return base.endsWith('/responses') ? base : `${base}/responses`;
}

async function callModel(parts, question) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY required');
  const content = [
    ...parts,
    {
      type: 'input_text',
      text:
        question +
        '\nAnswer with ONLY the exact value, or "NOT STATED" if it is not present. Do not guess.',
    },
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
        input: [{ role: 'user', content }],
        max_output_tokens: 128,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const json = await res.json();
    // Responses API: output message content
    let text = '';
    for (const item of json.output || []) {
      if (item.type !== 'message') continue;
      for (const c of item.content || []) {
        if (c.type === 'output_text' && c.text) text += c.text;
      }
    }
    if (!text && typeof json.output_text === 'string') text = json.output_text;
    return { text: (text || '').trim(), ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

function scoreAnswer(kind, expected, got) {
  const g = (got || '').trim();
  const gl = g.toLowerCase();
  const el = expected.toLowerCase();
  if (kind === 'guard') {
    const abstained = /not\s*stated|not\s*present|not\s*mentioned|unknown|n\/a/i.test(g);
    const confab = !abstained && g.length > 0 && !/password/i.test(g) === false ? false : !abstained && g.length > 2;
    // confab if claims a password-like value instead of abstaining
    const confab2 = !abstained && !/not\s*stated/i.test(g);
    return { ok: abstained, abstained, confab: confab2, refused: false };
  }
  if (kind === 'gist') {
    const ok = g.includes(expected) || new RegExp(`\\b${expected}\\b`).test(g);
    return { ok, abstained: false, confab: !ok && g.length > 0, refused: false };
  }
  // exact: accept answer that contains expected, or equals after strip quotes
  const cleaned = g.replace(/^["'`]+|["'`]+$/g, '');
  const ok = cleaned === expected || cleaned.includes(expected) || gl.includes(el);
  const confab = !ok && cleaned.length > 0 && !/not\s*stated/i.test(g);
  return { ok, abstained: /not\s*stated/i.test(g), confab, refused: false };
}

async function runArm(id, style, withFactsheet) {
  const profile = resolveGptProfile(MODEL);
  const cols = profile.stripCols; // 152 production
  const maxH = profile.maxHeightPx;
  const imgs = await renderTextToPngs(SESSION, cols, {
    ...style,
    maxHeightPx: maxH,
  });
  const dataUrls = imgs.map(
    (img) => `data:image/png;base64,${Buffer.from(img.png).toString('base64')}`,
  );
  let imageTok = 0;
  for (const img of imgs) imageTok += visionTokensForModel(MODEL, img.width, img.height);
  const textTok = Math.ceil(SESSION.length / 4);
  const sheet = factSheetText(SESSION);
  const sheetTok = Math.ceil((sheet || '').length / 4);
  const dims = imgs.map((i) => `${i.width}x${i.height}`);

  const parts = [
    ...dataUrls.map((u) => ({ type: 'input_image', image_url: u, detail: 'original' })),
  ];
  if (withFactsheet && sheet) {
    parts.push({ type: 'input_text', text: sheet });
  }

  const answers = [];
  if (LIVE) {
    for (const q of QUESTIONS) {
      const { text, ms } = await callModel(parts, q.q);
      const s = scoreAnswer(q.kind, q.answer, text);
      answers.push({ id: q.id, kind: q.kind, expected: q.answer, got: text, ...s, ms });
      process.stdout.write(
        `  ${id} ${q.id}: ${s.ok ? 'OK' : 'FAIL'} got=${JSON.stringify(text).slice(0, 80)}\n`,
      );
    }
  }

  const exact = answers.filter((a) => a.kind === 'exact');
  const exactCorrect = exact.filter((a) => a.ok).length;
  const confab = answers.filter((a) => a.confab).length;
  const gistOk = answers.find((a) => a.id === 'gist')?.ok ?? null;
  const guardOk = answers.find((a) => a.id === 'guard')?.ok ?? null;
  const totalCost = imageTok + (withFactsheet ? sheetTok : 0);
  const savingsPct = Math.round((1 - totalCost / textTok) * 100);

  return {
    id,
    withFactsheet,
    style,
    cols,
    dims,
    pages: imgs.length,
    imageTokens: imageTok,
    sheetTokens: withFactsheet ? sheetTok : 0,
    textTokens: textTok,
    savingsPct,
    factSheet: sheet,
    answers,
    exactCorrect,
    exactTotal: 4,
    confab,
    gistOk,
    guardOk,
    pass:
      LIVE &&
      exactCorrect === 4 &&
      confab === 0 &&
      gistOk === true &&
      guardOk === true,
  };
}

const arms = [
  { id: '5x8_image_only', style: { cellWBonus: 0, cellHBonus: 0, aa: true }, sheet: false },
  { id: '5x8_image_plus_factsheet', style: { cellWBonus: 0, cellHBonus: 0, aa: true }, sheet: true },
  // style variants at production density + factsheet (cheap, Grok)
  { id: '5x8_grid_plus_factsheet', style: { cellWBonus: 0, cellHBonus: 0, aa: true, grid: true }, sheet: true },
  { id: '5x8_color_plus_factsheet', style: { cellWBonus: 0, cellHBonus: 0, aa: true, colorCycle: true }, sheet: true },
  // known pure-image exact packing for comparison (no sheet)
  { id: 'd4_c84_image_only', style: { cellWBonus: 4, cellHBonus: 4, aa: true }, sheet: false, colsOverride: 84 },
];

async function main() {
  console.log(`model=${MODEL} live=${LIVE}`);
  console.log(`factsheet preview: ${factSheetText(SESSION).slice(0, 200)}…`);
  const rows = [];
  for (const arm of arms) {
    console.log(`\n== ${arm.id} ==`);
    // optional cols override via temporarily not using profile cols — renderTextToPngs takes cols
    let row;
    if (arm.colsOverride) {
      const imgs = await renderTextToPngs(SESSION, arm.colsOverride, {
        ...arm.style,
        maxHeightPx: 1932,
      });
      // reuse runArm logic by temporarily patching — simpler inline:
      const dataUrls = imgs.map(
        (img) => `data:image/png;base64,${Buffer.from(img.png).toString('base64')}`,
      );
      let imageTok = 0;
      for (const img of imgs) imageTok += visionTokensForModel(MODEL, img.width, img.height);
      const textTok = Math.ceil(SESSION.length / 4);
      const parts = dataUrls.map((u) => ({ type: 'input_image', image_url: u, detail: 'original' }));
      const answers = [];
      if (LIVE) {
        for (const q of QUESTIONS) {
          const { text, ms } = await callModel(parts, q.q);
          const s = scoreAnswer(q.kind, q.answer, text);
          answers.push({ id: q.id, kind: q.kind, expected: q.answer, got: text, ...s, ms });
          process.stdout.write(
            `  ${arm.id} ${q.id}: ${s.ok ? 'OK' : 'FAIL'} got=${JSON.stringify(text).slice(0, 80)}\n`,
          );
        }
      }
      const exact = answers.filter((a) => a.kind === 'exact');
      row = {
        id: arm.id,
        withFactsheet: false,
        style: arm.style,
        cols: arm.colsOverride,
        dims: imgs.map((i) => `${i.width}x${i.height}`),
        pages: imgs.length,
        imageTokens: imageTok,
        sheetTokens: 0,
        textTokens: textTok,
        savingsPct: Math.round((1 - imageTok / textTok) * 100),
        answers,
        exactCorrect: exact.filter((a) => a.ok).length,
        exactTotal: 4,
        confab: answers.filter((a) => a.confab).length,
        gistOk: answers.find((a) => a.id === 'gist')?.ok ?? null,
        guardOk: answers.find((a) => a.id === 'guard')?.ok ?? null,
      };
      row.pass =
        LIVE &&
        row.exactCorrect === 4 &&
        row.confab === 0 &&
        row.gistOk === true &&
        row.guardOk === true;
    } else {
      row = await runArm(arm.id, arm.style, arm.sheet);
    }
    rows.push(row);
    console.log(
      `  => exact=${row.exactCorrect}/4 confab=${row.confab} gist=${row.gistOk} guard=${row.guardOk} save≈${row.savingsPct}% imgTok=${row.imageTokens} sheetTok=${row.sheetTokens} pass=${row.pass}`,
    );
  }

  const out = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    live: LIVE,
    note:
      'Production Grok keeps 5x8 images + factsheet. Image-only exact fails; image+factsheet is the shipping contract.',
    rows,
  };
  const path = join(here, 'factsheet-vs-image-results.json');
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${path}`);

  if (LIVE) {
    const prod = rows.find((r) => r.id === '5x8_image_plus_factsheet');
    const bare = rows.find((r) => r.id === '5x8_image_only');
    console.log('\n=== VERDICT ===');
    console.log(`5x8 image only:     exact ${bare?.exactCorrect}/4 confab ${bare?.confab}`);
    console.log(
      `5x8 + factsheet:    exact ${prod?.exactCorrect}/4 confab ${prod?.confab} pass=${prod?.pass}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
