import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBuildFresh, resolveGptProfile, sha256 } from './profile-render.mjs';
import { buildTasks, grade } from './tasks.mjs';
import { callModel, inferenceSettings } from './clients.mjs';
import { CORPUS_VERSION } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export async function runQuality({ defaultModel, suites = ['arithmetic', 'gist', 'hex'], modelEnv, liveEnv } = {}) {
  const model = process.env.QUALITY_MODEL || (modelEnv && process.env[modelEnv]) || process.env.MODEL || defaultModel;
  assert(model, 'Set QUALITY_MODEL to the actual model id');
  assert(suites.every(s => ['arithmetic', 'gist', 'hex'].includes(s)), 'Unknown suite');
  assert(!process.env.N || Number(process.env.N) === 100, 'Standard arithmetic N is 100; use a research harness for other N');
  assertBuildFresh();
  const live = process.env.QUALITY_LIVE === '1' || (liveEnv && process.env[liveEnv] === '1');
  const tasks = await buildTasks(model);
  const selected = tasks.filter(t => suites.includes(t.meta.suite));
  const profile = resolveGptProfile(model);
  const inference = inferenceSettings(model);
  const safeModel = model.replace(/[^a-zA-Z0-9._-]/g, '_');
  const outDir = join(HERE, 'results', safeModel);
  const out = join(outDir, 'results.json');
  mkdirSync(outDir, { recursive: true });
  const manifest = { protocol: CORPUS_VERSION, model, inference, profile,
    n: { arithmetic: 100, gist: 98, state: 18, neverStated: 16, hex: 15 },
    taskSignatures: tasks.map(t => ({ id: t.id, requestHash: t.requestHash, maxOutputTokens: t.maxOutputTokens })),
  };
  const fingerprint = sha256(JSON.stringify(manifest));
  const prior = existsSync(out) ? readJson(out) : null;
  if (prior) assert.equal(prior.fingerprint, fingerprint, 'Profile/fixture/inference settings changed: archive prior result first');
  const result = prior || { generatedAt: new Date().toISOString(), fingerprint, manifest, rows: [] };
  const reused = [];
  if (!prior && process.env.QUALITY_REUSE_FILE) {
    const file = resolve(process.env.QUALITY_REUSE_FILE);
    const old = readJson(file);
    assert.equal(old.manifest.model, model, 'Cannot reuse a different model');
    assert.equal(old.manifest.reasoning ?? old.manifest.inference?.reasoning, inference.reasoning, 'Cannot reuse different inference settings');
    // v1 did not record output caps individually; allow only its known fixed-N
    // Responses recipe. v2 stores the exact per-task inference cap.
    if (!old.manifest.taskSignatures) {
      assert.equal(inference.family, 'responses');
      assert.equal(old.manifest.maximumOutputTokens, 265216);
    }
    for (const task of selected) {
      const r = old.rows.find(r => r.id === task.id && r.requestHash === task.requestHash && !r.error && r.usage);
      const oldCap = old.manifest.taskSignatures?.find(s => s.id === task.id)?.maxOutputTokens;
      if (r && (oldCap === undefined || oldCap === task.maxOutputTokens)) {
        reused.push({ ...r, ...task.meta, ...grade(task, r.raw), reusedFrom: { file: process.env.QUALITY_REUSE_FILE, generatedAt: old.generatedAt } });
      }
    }
  }
  const done = new Set([...result.rows, ...reused].map(r => r.id));
  const pending = selected.filter(t => !done.has(t.id));
  const preflight = { model, protocol: CORPUS_VERSION, profile, inference, suites, selectedCalls: selected.length,
    reusedCalls: reused.length, alreadyRecorded: result.rows.length, newCalls: pending.length,
    estimatedNewInputTokens: pending.reduce((n, t) => n + t.estimatedInputTokens, 0),
    maximumNewOutputTokens: pending.reduce((n, t) => n + t.maxOutputTokens, 0) };
  writeFileSync(join(outDir, 'preflight.json'), JSON.stringify(preflight, null, 2) + '\n');
  console.log(JSON.stringify(preflight, null, 2));
  if (!live) return;
  result.rows.push(...reused);
  const save = () => {
    writeFileSync(`${out}.tmp`, JSON.stringify(result, null, 2) + '\n');
    renameSync(`${out}.tmp`, out);
  };
  save();
  let next = 0, failed = false;
  async function worker() {
    while (next < pending.length && !failed) {
      const task = pending[next++];
      const row = { id: task.id, ...task.meta, requestHash: task.requestHash, maxOutputTokens: task.maxOutputTokens };
      try {
        const r = await callModel({ model, content: task.content, maxOutputTokens: task.maxOutputTokens, timeoutMs: 120000 });
        Object.assign(row, { raw: r.text, usage: r.usage, ms: r.ms });
        Object.assign(row, grade(task, r.text));
      } catch (e) { row.error = String(e?.message || e); failed = true; }
      result.rows.push(row); save();
      console.log(`${row.id}: ${row.error || (row.probes ? `${row.probes.filter(p => p.ok).length}/${row.probes.length}` : row.ok ? 'PASS' : 'MISS')}`);
    }
  }
  await Promise.all(Array.from({ length: 3 }, worker));
  console.log(`Saved ${result.rows.length}/237 receipts to ${out}`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runQuality();
