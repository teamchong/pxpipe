// Novel random-number arithmetic: text baseline vs Grok production image arm.
// Problems cannot be memorized (fresh random integers). Wrong image answer = misread.
//
//   pnpm run build
//   GROK_DENSITY_LIVE=1 N=20 node eval/grok-density/novel-arithmetic.mjs
//
// Full suite: N=100 (paid). Default N=20 for a cheaper pilot.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTextToPngs } from '../../dist/core/render.js';
import { resolveGptProfile } from '../../dist/core/gpt-model-profiles.js';
import { visionTokensForModel } from '../../dist/core/openai.js';
import { appendIdsBlock } from '../../dist/core/factsheet.js';
import {
  callResponses,
  pngsToDataUrls,
  profileStyle,
  extractAnswerNumber,
} from './lib-responses.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.GROK_DENSITY_MODEL || 'grok-4.5';
const LIVE = process.env.GROK_DENSITY_LIVE === '1';
const N = Math.max(1, Number(process.env.N || 20));
const SEED = Number(process.env.SEED || 20260711);
const TIMEOUT_MS = Number(process.env.GROK_DENSITY_TIMEOUT_MS || 180_000);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 2));
const WITH_IDS = process.env.NO_IDS === '1' ? false : true; // production applies IDS

const profile = resolveGptProfile(MODEL);
const COLS = profile.stripCols;
const MAX_H = profile.maxHeightPx;
const STYLE = profileStyle(profile);

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

function randInt(rng, lo, hi) {
  return lo + (rng() % (hi - lo + 1));
}

function genProblems(n, seed) {
  const rng = lcg(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const kind = rng() % 4;
    let question, answer;
    if (kind === 0) {
      const a = randInt(rng, 1000, 9999);
      const b = randInt(rng, 1000, 9999);
      const c = randInt(rng, 1000, 9999);
      question = `A factory produced ${a} units on Monday, ${b} units on Tuesday, and ${c} units on Wednesday. How many units did it produce in total over the three days?`;
      answer = a + b + c;
    } else if (kind === 1) {
      const a = randInt(rng, 3000, 9999);
      const b = randInt(rng, 100, 999);
      const c = randInt(rng, 100, 999);
      question = `A reservoir contains ${a} gallons of water. ${b} gallons are pumped out for irrigation, and later ${c} gallons of rainwater flow in. How many gallons are in the reservoir now?`;
      answer = a - b + c;
    } else if (kind === 2) {
      const a = randInt(rng, 11, 99);
      const b = randInt(rng, 11, 99);
      const c = randInt(rng, 100, 999);
      question = `A warehouse has ${a} shelves, each holding ${b} boxes, plus ${c} loose boxes on the floor. How many boxes are in the warehouse in total?`;
      answer = a * b + c;
    } else {
      const a = randInt(rng, 5000, 9999);
      const b = randInt(rng, 1000, 4999);
      question = `A stadium has ${a} seats. ${b} of them are already sold. How many seats remain unsold?`;
      answer = a - b;
    }
    out.push({ i, kind, question, answer });
  }
  return out;
}

async function askText(q) {
  const content = [{
    type: 'input_text',
    text: `Solve this math problem. Show brief reasoning, then end with exactly 'ANSWER: <number>'.\n\n${q}`,
  }];
  return callResponses({ model: MODEL, content, maxOutputTokens: 256, timeoutMs: TIMEOUT_MS });
}

async function askImage(dataUrls) {
  const content = [
    ...dataUrls.map((u) => ({ type: 'input_image', image_url: u, detail: 'original' })),
    {
      type: 'input_text',
      text: "A math word problem is shown in the image(s). Read the problem from the image only (do not invent numbers), solve it, then end with exactly 'ANSWER: <number>'.",
    },
  ];
  return callResponses({ model: MODEL, content, maxOutputTokens: 256, timeoutMs: TIMEOUT_MS });
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

const problems = genProblems(N, SEED);
const outDir = join(here, '.work-novel');
mkdirSync(outDir, { recursive: true });

console.log(`novel arithmetic · model=${MODEL} · N=${N} · seed=${SEED} · live=${LIVE} · ids=${WITH_IDS}`);
console.log(`profile cols=${COLS} maxH=${MAX_H}`);

const rows = [];
if (!LIVE) {
  // dry-run: render only
  for (const p of problems) {
    const body = WITH_IDS ? appendIdsBlock(p.question) : p.question;
    const imgs = await renderTextToPngs(body, COLS, STYLE, MAX_H);
    const imageTokens = imgs.reduce((n, im) => n + visionTokensForModel(MODEL, im.width, im.height), 0);
    rows.push({ i: p.i, kind: p.kind, answer: p.answer, pages: imgs.length, imageTokens });
    console.log(`q${p.i} pages=${imgs.length} tok=${imageTokens} ans=${p.answer}`);
  }
  writeFileSync(join(here, 'novel-arithmetic-results.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), model: MODEL, live: false, n: N, seed: SEED, withIds: WITH_IDS,
    recipe: { cols: COLS, maxH: MAX_H, style: STYLE }, rows,
  }, null, 2));
  console.log('Dry-run only. Re-run with GROK_DENSITY_LIVE=1 to score.');
  process.exit(0);
}

// Live: sequential-ish pool for text then image to keep costs predictable
const scored = await mapPool(problems, CONCURRENCY, async (p) => {
  const body = WITH_IDS ? appendIdsBlock(p.question) : p.question;
  const imgs = await renderTextToPngs(body, COLS, STYLE, MAX_H);
  const imageTokens = imgs.reduce((n, im) => n + visionTokensForModel(MODEL, im.width, im.height), 0);
  const dataUrls = pngsToDataUrls(imgs);
  let textGot = null, imageGot = null, textOk = false, imageOk = false, textErr = null, imageErr = null, textMs = 0, imageMs = 0;
  try {
    const tr = await askText(p.question);
    textGot = extractAnswerNumber(tr.text);
    textOk = textGot === p.answer;
    textMs = tr.ms;
  } catch (e) {
    textErr = String(e.message || e);
  }
  try {
    const ir = await askImage(dataUrls);
    imageGot = extractAnswerNumber(ir.text);
    imageOk = imageGot === p.answer;
    imageMs = ir.ms;
  } catch (e) {
    imageErr = String(e.message || e);
  }
  const row = {
    i: p.i, kind: p.kind, question: p.question, answer: p.answer,
    pages: imgs.length, imageTokens,
    textOk, imageOk, textGot, imageGot, textMs, imageMs, textErr, imageErr,
  };
  console.log(
    `q${p.i} text=${textOk ? 'Y' : 'N'}(${textGot}) image=${imageOk ? 'Y' : 'N'}(${imageGot}) gold=${p.answer}` +
    (imageOk || textOk ? '' : '  ** miss **'),
  );
  return row;
});

const textCorrect = scored.filter((r) => r.textOk).length;
const imageCorrect = scored.filter((r) => r.imageOk).length;
const summary = {
  generatedAt: new Date().toISOString(),
  model: MODEL,
  live: true,
  n: N,
  seed: SEED,
  withIds: WITH_IDS,
  recipe: { cols: COLS, maxH: MAX_H, style: STYLE },
  textCorrect,
  imageCorrect,
  textPct: Number(((100 * textCorrect) / N).toFixed(1)),
  imagePct: Number(((100 * imageCorrect) / N).toFixed(1)),
  deltaPp: Number(((100 * (imageCorrect - textCorrect)) / N).toFixed(1)),
  rows: scored,
};
writeFileSync(join(here, 'novel-arithmetic-results.json'), JSON.stringify(summary, null, 2));
console.log(`\n=== novel arithmetic N=${N} model=${MODEL} ===`);
console.log(`  baseline (text)   = ${textCorrect}/${N} = ${summary.textPct}%`);
console.log(`  pxpipe (image)    = ${imageCorrect}/${N} = ${summary.imagePct}%`);
console.log(`  delta             = ${summary.deltaPp >= 0 ? '+' : ''}${summary.deltaPp} pp`);
const misses = scored.filter((r) => r.textOk && !r.imageOk);
for (const m of misses.slice(0, 20)) {
  console.log(`  image miss q${m.i}: gold=${m.answer} text=${m.textGot} image=${m.imageGot}`);
}
