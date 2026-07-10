// Grok density / image-recall sweep. See README.md.
//
// Dry-run (default): renders every variant and prints token/savings accounting.
// Live (GROK_DENSITY_LIVE=1): also calls the model over OpenAI Responses and
// scores the battery. Point OPENAI_BASE_URL + OPENAI_API_KEY at a direct
// OpenAI-compatible Responses endpoint that serves the Grok model. Do not
// route this harness through pxpipe — the goal is raw image-reading quality.
//
// Run: pnpm run build && node eval/grok-density/run.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderTextToPngs } from '../../dist/core/render.js';
import { resolveGptProfile } from '../../dist/core/gpt-model-profiles.js';
import { visionTokensForModel } from '../../dist/core/openai.js';

const here = dirname(fileURLToPath(import.meta.url));

// --- Fixture: synthetic session with embedded precision-critical tokens ---
const TRUTH = {
  hex: 'a3f9c1e0b7d2',
  camel: 'tokenLedgerShard',
  path: 'src/core/anthropic-vision.ts',
  flag: '--max-visual-tokens',
  port: '47821',
  decisionKey: 'retry budget',
  decisionVal: '3 attempts',
};
const SESSION = [
  '<user t="1">Wire up the retry path. Use a retry budget of 3 attempts, backing off 250ms.</user>',
  `<assistant t="2">Done. The token cache key is ${TRUTH.hex}. I renamed the field to ${TRUTH.camel}`,
  `and moved the tier math into ${TRUTH.path}. The CLI now takes ${TRUTH.flag}. Proxy stays on port ${TRUTH.port}.</assistant>`,
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

// Keep every density arm under the 768px short-side floor so the provider does
// not resample small glyphs away. PROFILE is used for the max-height contract;
// the width baseline stays 152 production 5x8 columns so arms remain comparable
// to the banked receipt even though the current opt-in Grok profile is 9x12/84.
const MODEL = process.env.GROK_DENSITY_MODEL || 'grok-4.5';
const PROFILE = resolveGptProfile(MODEL);
const PAD_X = 4;
const CELL_BASE_W = 5;
const DENSE_BASELINE_COLS = 152;
const colsForSafe = (wBonus) => {
  const maxW = 2 * PAD_X + DENSE_BASELINE_COLS * CELL_BASE_W;
  return Math.floor((maxW - 2 * PAD_X) / (CELL_BASE_W + wBonus));
};

const VARIANTS = [
  { name: '5x8', style: { cellWBonus: 0, cellHBonus: 0, aa: true }, cols: colsForSafe(0) },
  { name: '7x10', style: { cellWBonus: 2, cellHBonus: 2, aa: true }, cols: colsForSafe(2) },
  { name: '9x12', style: { cellWBonus: 4, cellHBonus: 4, aa: true }, cols: colsForSafe(4) },
];

// Rough OpenAI o200k-ish baseline for savings display only (chars/4).
const TEXT_TOKENS = Math.ceil(SESSION.length / 4);

function imageTokensForPages(pages) {
  // Use the same vision-cost function the Responses transform uses for this model.
  return pages.reduce((n, p) => n + visionTokensForModel(MODEL, p.width, p.height), 0);
}

function responsesBaseUrl() {
  // OPENAI_BASE_URL is expected to already end in /v1 (or equivalent). Append /responses.
  const base = (process.env.OPENAI_BASE_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('OPENAI_BASE_URL is required for live runs');
  return base.endsWith('/responses') ? base : `${base}/responses`;
}

async function callModel(model, dataUrls, question) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is required for live runs');
  const content = [
    ...dataUrls.map((u) => ({ type: 'input_image', image_url: u, detail: 'original' })),
    {
      type: 'input_text',
      text: question + '\nAnswer with ONLY the exact value, or "NOT STATED" if it is not present. Do not guess.',
    },
  ];
  const t0 = Date.now();
  const payload = {
    model,
    stream: false,
    // Give always-on-thinking models room for an answer after reasoning.
    max_output_tokens: 512,
    input: [{ role: 'user', content }],
  };
  const controller = new AbortController();
  const timeoutMs = Number(process.env.GROK_DENSITY_TIMEOUT_MS || 180000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(responsesBaseUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`fetch failed: ${err && err.message ? err.message : err}`);
  } finally {
    clearTimeout(timer);
  }
  const raw = await res.text();
  let j;
  try { j = JSON.parse(raw); } catch {
    throw new Error(`Responses HTTP ${res.status}: non-JSON body ${raw.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = j?.error?.message || raw.slice(0, 300);
    throw new Error(`Responses HTTP ${res.status}: ${msg}`);
  }
  // Prefer output_text; fall back to walking output[].content for output_text parts.
  let text = typeof j.output_text === 'string' ? j.output_text : '';
  if (!text && Array.isArray(j.output)) {
    for (const item of j.output) {
      if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part && (part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
          text += part.text;
        }
      }
    }
  }
  text = text.trim();
  const status = j.status || null;
  const incomplete = j.incomplete_details?.reason || null;
  return { text, ms: Date.now() - t0, status, incomplete, rawUsage: j.usage || null };
}

function score(kind, expected, got, status) {
  // Incomplete / empty answers are not confabulations.
  if (!got) {
    const refused = status === 'incomplete' || status === 'failed';
    return { ok: false, abstained: false, confab: false, refused };
  }
  const g = got.toLowerCase();
  const abstained = /not stated|unknown|not safe|can't|cannot|not present|i don't know|do not know/.test(g);
  if (kind === 'guard') return { ok: abstained, abstained, confab: !abstained, refused: false };
  if (kind === 'gist') return { ok: g.includes(String(expected).toLowerCase()), abstained, confab: false, refused: false };
  const ok = got.includes(expected);
  return { ok, abstained, confab: !ok && !abstained, refused: false };
}

process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err);
  process.exitCode = 1;
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err);
  process.exitCode = 1;
});

const live = process.env.GROK_DENSITY_LIVE === '1' || process.env.GROK_DENSITY_LIVE === 'true';
const results = {
  generatedAt: new Date().toISOString(),
  model: MODEL,
  profile: PROFILE,
  textTokens: TEXT_TOKENS,
  live,
  variants: [],
};

console.log(`Grok density sweep · model=${MODEL} · live=${live}`);
console.log(`profile: stripCols=${PROFILE.stripCols} maxHeightPx=${PROFILE.maxHeightPx} vision=${JSON.stringify(PROFILE.vision)}`);
console.log(`text baseline ≈ ${TEXT_TOKENS} tok (chars/4)`);

for (const v of VARIANTS) {
  // Match the Responses transform: single-col portrait strip, profile max height,
  // no library multi-col packing.
  const imgs = await renderTextToPngs(SESSION, v.cols, v.style, PROFILE.maxHeightPx);
  const pages = imgs.map((im) => ({ png: im.png, width: im.width, height: im.height }));
  const imageTokens = imageTokensForPages(pages);
  const dataUrls = pages.map((p) => 'data:image/png;base64,' + Buffer.from(p.png).toString('base64'));
  const savingsPct = Math.round((1 - imageTokens / TEXT_TOKENS) * 100);
  const row = {
    variant: v.name,
    cols: v.cols,
    pages: pages.length,
    dims: pages.map((p) => `${p.width}x${p.height}`),
    imageTokens,
    savingsPct,
    model: null,
  };
  console.log(`\n[${v.name}] cols=${v.cols} ${pages.length} page(s) ${row.dims.join(',')} → ${imageTokens} img tok vs ${TEXT_TOKENS} text (${savingsPct}% saved)`);

  if (live) {
    console.log(`  calling ${MODEL} over Responses...`);
    const m = {
      exactCorrect: 0,
      exactTotal: 0,
      confab: 0,
      abstain: 0,
      refused: 0,
      gistOk: false,
      guardOk: false,
      answers: [],
    };
    for (const q of QUESTIONS) {
      let text, ms, status, incomplete;
      try {
        ({ text, ms, status, incomplete } = await callModel(MODEL, dataUrls, q.q));
      } catch (err) {
        console.error(`  ${q.id.padEnd(6)} ERROR ${err.message}`);
        m.answers.push({ id: q.id, kind: q.kind, expected: q.answer, got: '', error: String(err.message || err), ok: false, abstained: false, confab: false, refused: true, ms: 0 });
        m.refused++;
        if (q.kind === 'exact') m.exactTotal++;
        continue;
      }
      const s = score(q.kind, q.answer, text, status);
      m.answers.push({
        id: q.id,
        kind: q.kind,
        expected: q.answer,
        got: text,
        status,
        incomplete,
        ...s,
        ms,
      });
      if (q.kind === 'exact') {
        m.exactTotal++;
        if (s.ok) m.exactCorrect++;
      }
      if (s.confab) m.confab++;
      if (s.abstained) m.abstain++;
      if (s.refused) m.refused++;
      if (q.kind === 'gist' && !s.refused) m.gistOk = s.ok;
      if (q.kind === 'guard' && !s.refused) m.guardOk = s.ok;
      const mark = s.ok ? 'OK' : s.refused ? 'REFUSED' : s.abstained ? 'ABSTAIN' : s.confab ? 'CONFAB' : 'MISS';
      console.log(`  ${q.id.padEnd(6)} ${mark.padEnd(8)} got=${JSON.stringify(text).slice(0, 80)} (${ms}ms)`);
    }
    row.model = m;
    console.log(
      `  → exact ${m.exactCorrect}/${m.exactTotal} · confab ${m.confab} · gist ${m.gistOk ? 'ok' : 'FAIL'} · guard ${m.guardOk ? 'ok' : 'FAIL'}`,
    );
  }

  results.variants.push(row);
}

const outPath = join(here, 'results.json');
writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(`\nWrote ${outPath}`);
if (!live) {
  console.log('Dry-run only. Re-run with GROK_DENSITY_LIVE=1 to score model answers.');
}
