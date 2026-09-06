// Local, allowlisted public export. This never uploads anything.
// Raw prompts, answers, environment, endpoints and local paths stay private.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, normalizedUsage } from './summarize.mjs';
import { buildTasks } from './tasks.mjs';
import { assertBuildFresh, sha256 } from './profile-render.mjs';

const numeric = n => {
  assert(typeof n === 'number' && Number.isFinite(n) && n >= 0, 'Public metrics must be non-negative numbers');
  return n;
};
const digest = value => {
  assert(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'Expected a SHA-256 digest');
  return value;
};
function usage(value) {
  return Object.fromEntries(['inputTokens', 'outputTokens', 'reasoningTokens', 'cachedTokens', 'cacheWriteTokens']
    .map(key => [key, numeric(value[key])]));
}

export function publicManifest(result, summary) {
  const receipts = result.rows.map(row => {
    assert(/^(?:arithmetic-(?:text|image)-\d+|gist-work[23]?-\d+|hex-\d+)$/.test(row.id), 'Unexpected public fixture id');
    const out = {
      id: row.id,
      sourceHash: digest(row.sourceHash),
      requestHash: digest(row.requestHash),
      responseHash: sha256(row.raw),
      reused: Boolean(row.reusedFrom),
      score: row.probes
        ? { correct: row.probes.filter(p => p.ok).length, n: row.probes.length }
        : { correct: row.ok ? 1 : 0, n: 1 },
      usage: usage(normalizedUsage(row.usage, summary.inference.family)),
    };
    if (row.rendering) {
      const r = row.rendering;
      assert(['content', 'history'].includes(r.recipe.purpose));
      assert(['original', 'high'].includes(r.detail));
      out.rendering = {
        profileHash: digest(r.profileHash), purpose: r.recipe.purpose, detail: r.detail,
        renderedSourceHash: digest(r.renderedSourceHash), factsheetHash: digest(r.factsheetHash),
        images: r.images.map(im => ({ width: numeric(im.width), height: numeric(im.height), sha256: digest(im.sha256) })),
      };
    }
    return out;
  });
  const scores = Object.fromEntries(['arithmeticText', 'arithmeticImage', 'gist', 'state', 'hex']
    .map(key => [key, { correct: numeric(summary[key].correct), n: numeric(summary[key].n) }]));
  scores.neverStated = { confabulated: numeric(summary.neverStated.confabulated), n: numeric(summary.neverStated.n) };
  return {
    schema: 'public-quality-receipts-v1',
    protocol: summary.protocol,
    model: summary.model,
    inference: { family: summary.inference.family, reasoning: summary.inference.reasoning },
    profileHash: digest(summary.profileHash),
    scores,
    newCalls: numeric(summary.newCalls), reusedCalls: numeric(summary.reusedCalls),
    usage: Object.fromEntries(Object.entries(summary.usage).map(([key, value]) => [key, { calls: numeric(value.calls), ...usage(value) }])),
    receipts: receipts.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertBuildFresh();
  const model = process.env.QUALITY_MODEL;
  assert(model, 'Set QUALITY_MODEL');
  const folder = join(dirname(fileURLToPath(import.meta.url)), 'results', model.replace(/[^a-zA-Z0-9._-]/g, '_'));
  const result = JSON.parse(readFileSync(join(folder, 'results.json'), 'utf8'));
  const summary = summarize(result, await buildTasks(model));
  const manifest = publicManifest(result, summary);
  // One receipt per line keeps the public review diff small and inspectable.
  const { receipts, ...header } = manifest;
  const serialized = JSON.stringify(header, null, 2).slice(0, -2)
    + ',\n  "receipts": [\n'
    + receipts.map(row => `    ${JSON.stringify(row)}`).join(',\n')
    + '\n  ]\n}\n';
  assert.deepEqual(JSON.parse(serialized), manifest);
  writeFileSync(join(folder, 'receipt-manifest.json'), serialized);
  console.log(`Exported ${manifest.receipts.length} sanitized receipts; raw data not included.`);
}
