import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGptProfile, sha256, assertBuildFresh, profileRecipe } from './profile-render.mjs';
import { buildTasks, grade } from './tasks.mjs';
import { openAIImageDetail } from '../../dist/core/openai.js';
import { CORPUS_VERSION } from './fixtures.mjs';

export function normalizedUsage(u, family) {
  if (family === 'gemini') return {
    inputTokens: u.promptTokenCount || 0,
    outputTokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
    reasoningTokens: u.thoughtsTokenCount || 0, cachedTokens: u.cachedContentTokenCount || 0,
    cacheWriteTokens: 0,
  };
  const cacheRead = u.cache_read_input_tokens || 0, cacheWrite = u.cache_creation_input_tokens || 0;
  return {
    inputTokens: (u.input_tokens ?? u.prompt_tokens ?? 0) + cacheRead + cacheWrite,
    outputTokens: u.output_tokens ?? u.completion_tokens ?? 0,
    reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedTokens: u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? cacheRead,
    cacheWriteTokens: u.input_tokens_details?.cache_write_tokens ?? cacheWrite,
  };
}

export function summarize(result, currentTasks) {
  assert.equal(result.manifest.protocol, CORPUS_VERSION, 'Legacy results cannot be labeled profile-aligned');
  assert.equal(result.rows.length, 237, 'Do not publish partial runs');
  assert.equal(new Set(result.rows.map(r => r.id)).size, 237, 'No duplicate calls');
  assert(result.rows.every(r => !r.error && r.usage), 'Errors/missing receipts must be resolved before publishing');
  assert.equal(sha256(JSON.stringify(result.manifest.profile)), sha256(JSON.stringify(resolveGptProfile(result.manifest.model))), 'Runtime profile changed; old results are now historical');
  for (const row of result.rows) {
    const sig = result.manifest.taskSignatures.find(t => t.id === row.id);
    assert(sig && sig.requestHash === row.requestHash, 'Receipt/request hash mismatch');
    if (currentTasks) {
      const current = currentTasks.find(t => t.id === row.id);
      assert(current && current.requestHash === row.requestHash, 'Current renderer/fixture payload differs from receipt');
      const graded = grade(current, row.raw);
      for (const [key, value] of Object.entries(graded)) assert.deepEqual(row[key], value, 'Stored score differs from raw-answer grading');
    }
    if (row.arm !== 'text') {
      assert(row.rendering?.recipe && row.rendering.images.length, 'Missing profile-render provenance');
      assert.equal(row.rendering.profileHash, sha256(JSON.stringify(result.manifest.profile)), 'Mixed rendering profiles');
      assert.equal(row.rendering.sourceHash, row.sourceHash, 'Mixed source fixture');
      assert.equal(row.rendering.detail, openAIImageDetail(result.manifest.model), 'Runtime image-detail policy changed');
      assert.equal(sha256(JSON.stringify(row.rendering.recipe)), sha256(JSON.stringify(profileRecipe(result.manifest.model, row.rendering.recipe.purpose))), 'Derived rendering settings changed');
    }
  }
  const score = rows => ({ correct: rows.filter(r => r.ok).length, n: rows.length });
  const gist = result.rows.filter(r => r.suite === 'gist'), probes = gist.flatMap(r => r.probes);
  const guards = probes.filter(p => p.type === 'unanswerable');
  const summary = {
    generatedAt: result.generatedAt, protocol: CORPUS_VERSION,
    model: result.manifest.model, inference: result.manifest.inference,
    profileHash: sha256(JSON.stringify(result.manifest.profile)),
    arithmeticText: score(result.rows.filter(r => r.suite === 'arithmetic' && r.arm === 'text')),
    arithmeticImage: score(result.rows.filter(r => r.suite === 'arithmetic' && r.arm === 'production')),
    gist: score(probes.filter(p => p.type !== 'unanswerable')),
    state: score(gist.filter(r => r.tier === 'work3').flatMap(r => r.probes)),
    neverStated: { confabulated: guards.filter(p => !p.ok).length, n: guards.length },
    hex: score(result.rows.filter(r => r.suite === 'hex')),
    reusedCalls: result.rows.filter(r => r.reusedFrom).length,
    newCalls: result.rows.filter(r => !r.reusedFrom).length,
    usage: {},
  };
  for (const [key, n] of Object.entries({ arithmeticText: 100, arithmeticImage: 100, gist: 98, state: 18, neverStated: 16, hex: 15 })) assert.equal(summary[key].n, n);
  for (const [name, rows] of [
    ['arithmeticText', result.rows.filter(r => r.suite === 'arithmetic' && r.arm === 'text')],
    ['arithmeticImage', result.rows.filter(r => r.suite === 'arithmetic' && r.arm === 'production')],
    ['gist', gist], ['hex', result.rows.filter(r => r.suite === 'hex')],
    ['newCallsOnly', result.rows.filter(r => !r.reusedFrom)], ['all', result.rows],
  ]) {
    const totals = { calls: rows.length, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
    for (const r of rows) for (const [k, v] of Object.entries(normalizedUsage(r.usage, result.manifest.inference.family))) totals[k] += v;
    summary.usage[name] = totals;
  }
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertBuildFresh();
  const model = process.env.QUALITY_MODEL;
  assert(model, 'Set QUALITY_MODEL');
  const folder = join(dirname(fileURLToPath(import.meta.url)), 'results', model.replace(/[^a-zA-Z0-9._-]/g, '_'));
  const summary = summarize(JSON.parse(readFileSync(join(folder, 'results.json'), 'utf8')), await buildTasks(model));
  writeFileSync(join(folder, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}
