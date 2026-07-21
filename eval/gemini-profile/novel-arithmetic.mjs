// Gemini 3.6 Flash novel arithmetic benchmark suite.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTextToPngs } from '../../dist/core/render.js';
import { resolveGeminiProfile } from '../../dist/core/gemini-model-profiles.js';
import { factSheetText } from '../../dist/core/factsheet.js';
import { visionTokensForModel } from '../../dist/core/openai.js';
import { callGemini } from './gemini-client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.MODEL || 'gemini-3.6-flash';
const LIVE = process.env.LIVE === '1';
const N = Math.max(1, Number(process.env.N || 100));
const SEED = Number(process.env.SEED || 20260711);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 5));
const TIMEOUT = Number(process.env.TIMEOUT_MS || 180000);
const profile = resolveGeminiProfile();
const RESULT = join(HERE, `novel-arithmetic-results.json`);

function lcg(seed) { let s = seed >>> 0; return () => s = (Math.imul(s, 1664525) + 1013904223) >>> 0; }
function ri(r, a, b) { return a + (r() % (b - a + 1)); }
function num(text) { const m = String(text ?? '').match(/ANSWER:\s*(-?\d+)/i); return m ? Number(m[1]) : NaN; }

function problems(n, seed) {
  const r = lcg(seed), out = [];
  for (let i = 0; i < n; i++) {
    const k = r() % 4;
    let question, answer;
    if (k === 0) {
      const a = ri(r, 1000, 9999), b = ri(r, 1000, 9999), c = ri(r, 1000, 9999);
      question = `A factory produced ${a} units on Monday, ${b} units on Tuesday, and ${c} units on Wednesday. How many units did it produce in total over the three days?`;
      answer = a + b + c;
    } else if (k === 1) {
      const a = ri(r, 3000, 9999), b = ri(r, 100, 999), c = ri(r, 100, 999);
      question = `A reservoir contains ${a} gallons of water. ${b} gallons are pumped out, and later ${c} gallons flow in. How many gallons are in the reservoir now?`;
      answer = a - b + c;
    } else if (k === 2) {
      const a = ri(r, 11, 99), b = ri(r, 11, 99), c = ri(r, 100, 999);
      question = `A warehouse has ${a} shelves, each holding ${b} boxes, plus ${c} loose boxes. How many boxes are there in total?`;
      answer = a * b + c;
    } else {
      const a = ri(r, 5000, 9999), b = ri(r, 1000, 4999);
      question = `A stadium has ${a} seats. ${b} are already sold. How many seats remain unsold?`;
      answer = a - b;
    }
    out.push({ i, kind: k, question, answer });
  }
  return out;
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function w() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, w));
  return out;
}

const ps = problems(N, SEED);
console.log(`novel arithmetic · model=${MODEL} · live=${LIVE} · N=${N}`);

if (!LIVE) {
  console.log('Dry run only. Exiting.');
  process.exit(0);
}

const rows = await pool(ps, CONCURRENCY, async (p) => {
  const ask = "Solve the math word problem. Show brief reasoning and end with exactly 'ANSWER: <number>'.";
  const imgs = await renderTextToPngs(p.question, profile.stripCols, profile.style, profile.maxHeightPx);
  const urls = imgs.map((im) => ({ type: 'input_image', image_url: `data:image/png;base64,${Buffer.from(im.png).toString('base64')}` }));
  const imageTokens = imgs.reduce((n, im) => n + visionTokensForModel(MODEL, im.width, im.height), 0);
  
  let text, pure, prod;
  try { text = await callGemini({ model: MODEL, content: [{ type: 'input_text', text: `${ask}\n\n${p.question}` }], maxOutputTokens: 256, timeoutMs: TIMEOUT }); } catch (e) { text = { text: '', error: String(e.message || e) }; }
  try { pure = await callGemini({ model: MODEL, content: [...urls, { type: 'input_text', text: `The problem is in the image. ${ask}` }], maxOutputTokens: 256, timeoutMs: TIMEOUT }); } catch (e) { pure = { text: '', error: String(e.message || e) }; }
  try {
    const fs = factSheetText(p.question, profile.factSheetFormat);
    prod = await callGemini({ model: MODEL, content: [...urls, ...(fs ? [{ type: 'input_text', text: fs }] : []), { type: 'input_text', text: `The problem is in the image; use the exact-number factsheet if present. ${ask}` }], maxOutputTokens: 256, timeoutMs: TIMEOUT });
  } catch (e) { prod = { text: '', error: String(e.message || e) }; }
  
  const textGot = num(text.text), pureGot = num(pure.text), prodGot = num(prod.text);
  const row = { ...p, imageTokens, textGot, pureGot, prodGot, textOk: textGot === p.answer, pureOk: pureGot === p.answer, prodOk: prodGot === p.answer, textUsage: text.usage || null, pureUsage: pure.usage || null, prodUsage: prod.usage || null, textError: text.error || null, pureError: pure.error || null, prodError: prod.error || null };
  console.log(`q${p.i} text=${row.textOk ? 'Y' : 'N'}(${textGot}) pure=${row.pureOk ? 'Y' : 'N'}(${pureGot}) prod=${row.prodOk ? 'Y' : 'N'}(${prodGot}) gold=${p.answer}`);
  return row;
});

const count = (k) => rows.filter((r) => r[k]).length;
const summary = {
  generatedAt: new Date().toISOString(),
  model: MODEL,
  live: true,
  n: N,
  seed: SEED,
  recipe: { cols: profile.stripCols, maxH: profile.maxHeightPx, style: profile.style, factsheet: true },
  textCorrect: count('textOk'),
  pureCorrect: count('pureOk'),
  prodCorrect: count('prodOk'),
  textPct: 100 * count('textOk') / N,
  purePct: 100 * count('pureOk') / N,
  prodPct: 100 * count('prodOk') / N,
  rows
};
writeFileSync(RESULT, JSON.stringify(summary, null, 2));
console.log(`\nSUMMARY text ${summary.textCorrect}/${N} (${summary.textPct}%) · pure ${summary.pureCorrect}/${N} (${summary.purePct}%) · prod ${summary.prodCorrect}/${N} (${summary.prodPct}%)`);
