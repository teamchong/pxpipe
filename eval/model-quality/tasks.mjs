import assert from 'node:assert/strict';
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { CORPUS_VERSION, arithmeticFixtures, gistFixtures, hexFixtures } from './fixtures.mjs';
import { renderProfileFixture, sha256, textPart } from './profile-render.mjs';

export async function buildTasks(model) {
  const tasks = [];
  function add(id, content, meta, rendered, maxOutputTokens = 1024) {
    tasks.push({ id, content, meta: { ...meta, ...(rendered ? { rendering: rendered.provenance } : {}) },
      maxOutputTokens, requestHash: sha256(JSON.stringify(content)),
      estimatedInputTokens: (rendered?.imageTokens ?? 0) + content.filter(p => p.type === 'input_text').reduce((n, p) => n + countTokens(p.text), 0) });
  }
  const arithmetic = arithmeticFixtures();
  assert.equal(arithmetic.rows.length, 100);
  for (const p of arithmetic.rows) {
    const ask = "Solve the math word problem. Show brief reasoning and end with exactly 'ANSWER: <number>'.";
    const rendered = await renderProfileFixture(p.question, model);
    const meta = { suite: 'arithmetic', i: p.i, question: p.question, gold: p.answer, sourceHash: sha256(p.question) };
    add(`arithmetic-text-${p.i}`, [textPart(`${ask}\n\n${p.question}`)], { ...meta, arm: 'text' });
    add(`arithmetic-image-${p.i}`, [...rendered.parts,
      textPart(`The problem is in the image; use the exact-number factsheet if present. ${ask}`)],
      { ...meta, arm: 'production' }, rendered);
  }
  for (const f of gistFixtures()) {
    const rendered = await renderProfileFixture(f.source, model, 'history');
    const prompt = ['Read all transcript images in order. Answer every numbered question.',
      'If the transcript does not contain an answer, use exactly UNKNOWN.',
      'Return only a JSON array of strings in question order.', ...f.probes.map((p, i) => `${i + 1}. ${p.q}`)].join('\n');
    add(`gist-${f.tier}-${f.session}`, [...rendered.parts, textPart(prompt)],
      { suite: 'gist', tier: f.tier, session: f.session, probes: f.probes, sourceHash: sha256(f.source) }, rendered, 2048);
  }
  const hex = hexFixtures();
  const renderedPages = await Promise.all(hex.pages.map(source => renderProfileFixture(source, model)));
  for (const [i, t] of hex.trials.entries()) {
    const rendered = renderedPages[t.page];
    add(`hex-${i}`, [...rendered.parts, textPart(`Find the JSON line whose dur_ms is exactly ${t.dur}. Return only its id field, exactly 12 lowercase hex characters. Use the images and adjacent exact-identifier factsheet.`)],
      { suite: 'hex', ...t, sourceHash: sha256(hex.pages[t.page]), corpus: CORPUS_VERSION, seed: hex.seed }, rendered);
  }
  assert.equal(tasks.length, 237);
  const probes = tasks.filter(t => t.meta.suite === 'gist').flatMap(t => t.meta.probes);
  assert.equal(probes.filter(p => p.type !== 'unanswerable').length, 98);
  assert.equal(probes.filter(p => p.type === 'unanswerable').length, 16);
  assert.equal(tasks.filter(t => t.meta.tier === 'work3').flatMap(t => t.meta.probes).length, 18);
  assert.equal(hex.trials.length, 15);
  return tasks;
}

const norm = x => String(x ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
export function grade(task, raw) {
  const m = task.meta;
  if (m.suite === 'arithmetic') {
    const got = Number(raw.match(/ANSWER:\s*(-?\d+)/i)?.[1] ?? NaN);
    return { got: Number.isFinite(got) ? got : null, ok: got === m.gold };
  }
  if (m.suite === 'hex') {
    // Require exactly one answer, not a lucky id embedded in a list of guesses.
    const got = raw.trim().toLowerCase();
    return { got, ok: /^[0-9a-f]{12}$/.test(got) && got === m.gold };
  }
  let answers;
  try { answers = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1)); } catch {}
  assert(Array.isArray(answers) && answers.length === m.probes.length && answers.every(x => typeof x === 'string'), 'invalid probe answer array');
  return { probes: m.probes.map((p, i) => {
    const x = norm(answers[i]), g = norm(p.gold);
    const ok = p.type === 'unanswerable' ? x === 'unknown'
      : p.type === 'numeric' ? new RegExp(`(?:^|\\D)${g}(?:\\D|$)`).test(x)
      : p.type === 'negation' ? x.includes('off') && !x.includes('enabled') : x.includes(g);
    return { ...p, answer: answers[i], ok };
  }) };
}
