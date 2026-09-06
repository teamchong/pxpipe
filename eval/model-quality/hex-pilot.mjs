// Eight-call matched pilot, NOT an N=15 result or a replacement README score.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { hexFixtures } from './fixtures.mjs';
import { renderProfileFixture, resolveGptProfile, sha256, assertBuildFresh } from './profile-render.mjs';
import { compactJsonl } from './compact-jsonl.mjs';
import { callModel } from './clients.mjs';
import { normalizedUsage } from './summarize.mjs';
assertBuildFresh();
const model = 'gpt-6-astra', live = process.env.HEX_PILOT_LIVE === '1';
const folder = join(dirname(fileURLToPath(import.meta.url)), 'pilot-local'); mkdirSync(folder, { recursive: true });
const count = countTokens, part = text => ({ type: 'input_text', text });
const fixture = hexFixtures();
const cases = [fixture.trials[0], fixture.trials.at(-1)].map(t => ({ ...t, id: t.gold, source: fixture.pages[t.page] })), variants = ['native', 'high', 'original', 'compact-native'];
const tasks = [], oldEnv = process.env.PXPIPE_GPT_PROFILES, overrides = JSON.parse(oldEnv || '{}');
try {
  for (let c = 0; c < cases.length; c++) for (let a = 0; a < variants.length; a++) {
    const f = cases[c], variant = variants[(a + c) % variants.length];
    const question = `For dur_ms=${f.dur}, return only its record id: 12 lowercase hex characters.`;
    process.env.PXPIPE_GPT_PROFILES = JSON.stringify({ ...overrides, [model]: { ...(overrides[model] || {}), imageDetail: variant === 'original' ? 'original' : 'high' } });
    let content, rendering, estimatedInput;
    if (variant === 'native' || variant === 'compact-native') {
      const source = variant === 'native' ? f.source : compactJsonl(f.source).text;
      content = [part(source), part(question)]; estimatedInput = count(source) + count(question);
    } else {
      rendering = await renderProfileFixture(f.source, model, 'content');
      assert.equal(rendering.provenance.detail, variant);
      content = [...rendering.parts, part(question)]; estimatedInput = rendering.imageTokens
        + content.reduce((n, p) => n + (p.type === 'input_text' ? count(p.text) : 0), 0);
    }
    tasks.push({ id: `case-${c + 1}-${variant}`, variant, page: f.page, dur: f.dur, gold: f.id, sourceHash: sha256(f.source),
      requestHash: sha256(JSON.stringify(content)), content, rendering: rendering?.provenance, estimatedInput, maxOutputTokens: 768 });
  }
} finally { if (oldEnv === undefined) delete process.env.PXPIPE_GPT_PROFILES; else process.env.PXPIPE_GPT_PROFILES = oldEnv; }
for (let c = 1; c <= 2; c++) {
  const high = tasks.find(t => t.id === `case-${c}-high`), original = tasks.find(t => t.id === `case-${c}-original`);
  assert.deepEqual(high.content, original.content.map(p => p.type === 'input_image' ? { ...p, detail: 'high' } : p));
}
const estimate = Math.ceil(tasks.reduce((n, t) => n + t.estimatedInput, 0));
assert.equal(tasks.length, 8); assert(estimate <= 20500, `Input estimate ${estimate} exceeds cap; no calls made`);
const fingerprint = sha256(JSON.stringify(tasks.map(t => [t.id, t.requestHash, t.maxOutputTokens])));
const file = join(folder, 'hex-pilot-results.json');
const result = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { generatedAt: new Date().toISOString(), model, reasoning: 'low', fingerprint,
  protocol: 'matched-hex-pilot-N2', profile: resolveGptProfile(model), estimatedInput: estimate, maxCalls: 8, maxOutputTokens: 6144, rows: [] };
assert.equal(result.fingerprint, fingerprint, 'Settings changed; preserve old pilot receipts separately');
console.log(JSON.stringify({ calls: 8, nPerVariant: 2, estimatedInput: estimate, maxOutputTokens: 6144, live }));
const save = () => writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
if (live) for (const t of tasks) {
  if (result.rows.some(r => r.id === t.id && r.usage && !r.error)) continue;
  const { content, ...row } = t;
  try {
    const r = await callModel({ model, content, maxOutputTokens: 768, timeoutMs: 90000 });
    Object.assign(row, { raw: r.text, ms: r.ms, usage: r.usage, ok: r.text.trim().toLowerCase() === t.gold });
  } catch (error) { row.error = String(error?.message || error); result.rows.push(row); save(); throw error; }
  result.rows.push(row); save();
  console.log(JSON.stringify({ id: row.id, ok: row.ok, ms: row.ms, usage: normalizedUsage(row.usage, 'responses') }));
}
if (result.rows.filter(r => r.usage && !r.error).length === 8) {
  const p = resolveGptProfile(model), summary = { model, nPerVariant: 2, variants: {} };
  for (const variant of variants) {
    const rows = result.rows.filter(r => r.variant === variant && !r.error && r.usage), uses = rows.map(r => normalizedUsage(r.usage, 'responses'));
    assert.equal(rows.length, 2, 'Incomplete matched arm');
    summary.variants[variant] = { correct: rows.filter(r => r.ok).length, n: rows.length,
      input: uses.reduce((n, u) => n + u.inputTokens, 0), output: uses.reduce((n, u) => n + u.outputTokens, 0),
      meanMs: rows.reduce((n, r) => n + r.ms, 0) / rows.length,
      billingEquivalent: uses.reduce((n, u) => n + u.inputTokens - u.cachedTokens - u.cacheWriteTokens
        + u.cachedTokens * p.cacheReadRate + u.cacheWriteTokens * (p.cacheWriteRate ?? 1) + u.outputTokens * p.outputRate, 0) };
  }
  writeFileSync(join(folder, 'hex-pilot-summary.json'), JSON.stringify(summary, null, 2) + '\n'); console.log(JSON.stringify(summary, null, 2));
}
