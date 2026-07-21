// Gemini 3.6 Flash gist recall evaluation suite.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTextToPngs } from '../../dist/core/render.js';
import { resolveGptProfile } from '../../dist/core/gpt-model-profiles.js';
import { factSheetText } from '../../dist/core/factsheet.js';
import { callGemini } from './gemini-client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../gist-recall');
const MODEL = process.env.MODEL || 'gemini-3.6-flash';
const profile = resolveGptProfile(MODEL);
const LIVE = process.env.LIVE === '1';
const TIMEOUT = Number(process.env.TIMEOUT_MS || 240000);
const TIERS = [['work', 10], ['work2', 6], ['work3', 6]];

function parse(s) {
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  try { return JSON.parse(a >= 0 && b > a ? s.slice(a, b + 1) : s); } catch { return null; }
}
function norm(s) { return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' '); }
function correct(p, a) {
  const x = norm(a), g = norm(p.gold);
  if (p.type === 'unanswerable') return x === 'unknown';
  if (p.type === 'numeric') return new RegExp(`(?:^|\\D)${g}(?:\\D|$)`).test(x);
  if (p.type === 'negation') return x.includes('off') && !x.includes('enabled');
  return x.includes(g);
}

const rows = [];
for (const [dir, n] of TIERS) {
  const probes = JSON.parse(readFileSync(join(ROOT, dir, 'probes.json'), 'utf8'));
  for (let sid = 0; sid < n; sid++) {
    const ps = probes.filter((p) => p.session === sid);
    const source = readFileSync(join(ROOT, dir, `s${sid}.txt`), 'utf8');
    const imgs = await renderTextToPngs(source, profile.stripCols, profile.style, profile.maxHeightPx);
    const prompt = [
      'Read all transcript images in order. Answer every numbered question.',
      'If the transcript does not contain an answer, use exactly UNKNOWN.',
      'Return only a JSON array of strings in question order.',
      ...ps.map((p, i) => `${i + 1}. ${p.q}`)
    ].join('\n');
    let response = { output: '', usage: null };
    if (LIVE) {
      const content = imgs.map((im) => ({ type: 'input_image', image_url: `data:image/png;base64,${Buffer.from(im.png).toString('base64')}` }));
      const fs = factSheetText(source, profile.factSheetFormat);
      if (fs) content.push({ type: 'input_text', text: fs });
      content.push({ type: 'input_text', text: prompt });
      try {
        const r = await callGemini({ model: MODEL, content, maxOutputTokens: 1400, timeoutMs: TIMEOUT });
        response = { output: r.text, usage: r.usage };
      } catch (e) {
        response = { output: '', usage: null, error: String(e) };
      }
    }
    const answers = parse(response.output) || [];
    ps.forEach((p, i) => rows.push({ tier: dir, session: sid, ...p, answer: String(answers[i] ?? ''), ok: correct(p, answers[i]), raw: response.output, error: response.error || null, usage: response.usage }));
    console.log(`${dir} s${sid}: ${ps.filter((p, i) => correct(p, answers[i])).length}/${ps.length}`);
  }
}

if (!LIVE) {
  console.log('Dry run only; no receipt written');
  process.exit(0);
}

const answerable = rows.filter((r) => r.type !== 'unanswerable');
const guards = rows.filter((r) => r.type === 'unanswerable');
const state = rows.filter((r) => r.tier === 'work3');
const done = (xs) => xs.filter((r) => !r.error);

const out = {
  generatedAt: new Date().toISOString(),
  model: MODEL,
  live: LIVE,
  recipe: { cols: profile.stripCols, maxH: profile.maxHeightPx, style: profile.style, factsheet: true },
  answerable: { correct: done(answerable).filter((r) => r.ok).length, completed: done(answerable).length, n: answerable.length },
  state: { correct: done(state).filter((r) => r.ok).length, completed: done(state).length, n: state.length },
  unanswerable: { confabulated: done(guards).filter((r) => !r.ok).length, completed: done(guards).length, n: guards.length },
  rows
};

writeFileSync(join(HERE, 'gist-recall-results.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ answerable: out.answerable, state: out.state, unanswerable: out.unanswerable }, null, 2));
