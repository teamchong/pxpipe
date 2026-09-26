import { requestFor, estimate, prepare } from './paired-request.mjs';
// Explicitly budgeted native-vs-production-path replay. No runtime settings change.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { clearRenderCache } from '../../dist/core/render.js';
import { gistFixtures } from './fixtures.mjs';
import { grade } from './tasks.mjs';
import { normalizedUsage } from './summarize.mjs';
import { assertBuildFresh, resolveGptProfile, sha256 } from './profile-render.mjs';
import { callResponsesRequest } from './responses-replay-client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const folder = join(HERE, 'paired-local'); mkdirSync(folder, { recursive: true });
const file = join(folder, 'results.json');
const live = process.env.PAIRED_LIVE === '1';
const model = 'gpt-6-astra', cap = 100000, outputCap = 768;
const profile = resolveGptProfile(model);
assertBuildFresh();
const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
const runId = previous?.runId || randomUUID();
const selected = gistFixtures().filter(f => (f.tier === 'work' && [0, 1].includes(f.session)) || (f.tier === 'work3' && f.session === 0));
assert.equal(selected.length, 3);


const tasks = [];
for (let repeat = 0; repeat < 2; repeat++) for (let i = 0; i < selected.length; i++) {
  const f = selected[i], order = (repeat + i) % 2 ? ['production', 'native'] : ['native', 'production'];
  // Keep three distinct cases; repeat the first coding and state cases within the cap.
  if (repeat === 1 && f.tier === 'work' && f.session === 1) continue;
  for (const arm of order) {
    const native = requestFor(f, arm, { model, runId, outputCap }), ready = await prepare(native, arm), estimatedInput = estimate(ready.request, ready.imageTokens);
    tasks.push({ id: `${f.tier}-${f.session}-${repeat}-${arm}`, arm, repeat, fixture: f, native,
      requestHash: sha256(JSON.stringify(ready.request)), estimatedInput, reserve: Math.ceil(estimatedInput * 1.5) + 512 + outputCap,
      images: ready.images });
  }
}
const fingerprint = sha256(JSON.stringify({ model, profile, outputCap, tasks: tasks.map(t => [t.id, t.requestHash]) }));
const result = previous || { runId, fingerprint, model, profile, reasoning: 'low', cap, outputCap, rows: [] };
assert.equal(result.fingerprint, fingerprint, 'Replay/profile changed; do not mix receipts');
assert(!result.rows.some(r => r.state === 'inflight' || r.state === 'transport-error'), 'Unknown-cost attempt exists; no automatic retry');
const pending = tasks.filter(t => !result.rows.some(r => r.id === t.id));
const spent = result.rows.reduce((sum, r) => sum + r.chargedTokens, 0);
const reserved = pending.reduce((sum, t) => sum + t.reserve, 0);
const plan = { model, calls: tasks.length, pending: pending.length, actualTokensSoFar: spent, estimatedPendingInput: pending.reduce((s, t) => s + t.estimatedInput, 0),
  maxPendingOutput: pending.length * outputCap, conservativeReservation: reserved, cap, live,
  cases: selected.map(f => ({ tier: f.tier, session: f.session, probes: f.probes.length })) };
console.log(JSON.stringify(plan));
console.log(JSON.stringify(tasks.map(t=>({id:t.id,estimatedInput:t.estimatedInput,reserve:t.reserve,images:t.images}))));
assert(spent + reserved <= cap, 'Conservative reservation exceeds approval; no calls made');
const save = () => { writeFileSync(file + '.tmp', JSON.stringify(result, null, 2) + '\n'); renameSync(file + '.tmp', file); };
save(); writeFileSync(join(folder, 'preflight.json'), JSON.stringify(plan, null, 2) + '\n');
clearRenderCache();
if (live) for (const t of pending) {
  const used = result.rows.reduce((s, r) => s + r.chargedTokens, 0);
  assert(used + t.reserve <= cap, 'Budget exhausted; no request sent');
  const ready = await prepare(t.native, t.arm);
  assert.equal(sha256(JSON.stringify(ready.request)), t.requestHash, 'Actual request drifted');
  const row = { id: t.id, arm: t.arm, repeat: t.repeat, tier: t.fixture.tier, session: t.fixture.session,
    requestHash: t.requestHash, sourceHash: sha256(t.fixture.source), images: ready.images,
    transformMs: ready.transformMs, state: 'inflight', chargedTokens: t.reserve };
  result.rows.push(row); save();
  try {
    const response = await callResponsesRequest({ request: ready.request, timeoutMs: 120000 });
    Object.assign(row, { response, totalMs: ready.transformMs + response.ms });
    assert(response.usage && Number.isFinite(response.usage.input_tokens) && Number.isFinite(response.usage.output_tokens), 'Missing actual usage; reserved budget retained');
    const usage = normalizedUsage(response.usage, 'responses');
    row.usage = usage; row.chargedTokens = usage.inputTokens + usage.outputTokens;
    row.state = 'recorded';
    if (response.status === 'completed') {
      try { row.score = grade({ meta: { suite: 'gist', probes: t.fixture.probes } }, response.text); }
      catch { row.gradingError = 'invalid answer array'; }
    } else row.gradingError = response.status;
    save();
    assert(usage.outputTokens <= outputCap && result.rows.reduce((s, r) => s + r.chargedTokens, 0) <= cap, 'Provider exceeded the declared budget; stopping');
    console.log(JSON.stringify({ id: row.id, status: response.status, correct: row.score?.probes.filter(p => p.ok).length || 0,
      probes: t.fixture.probes.length, totalMs: Math.round(row.totalMs), usage }));
  } catch (error) {
    if (row.state === 'inflight') row.state = 'transport-error';
    row.error = String(error?.message || error); save(); throw error;
  }
}
