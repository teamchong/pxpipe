import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const result = JSON.parse(readFileSync(join(HERE, 'results.json'), 'utf8'));
assert.equal(result.rows.length, 237, 'Do not publish partial runs');
assert.equal(new Set(result.rows.map(r => r.id)).size, 237, 'No duplicate calls');
assert(result.rows.every(r => !r.error && r.usage), 'Errors/missing receipts must be resolved before publishing');
const score = rows => ({ correct: rows.filter(r => r.ok).length, n: rows.length });
const gist = result.rows.filter(r => r.suite === 'gist');
const probes = gist.flatMap(r => r.probes);
const guards = probes.filter(p => p.type === 'unanswerable');
const summary = {
  generatedAt: result.generatedAt,
  model: result.manifest.model,
  reasoning: result.manifest.reasoning,
  arithmeticText: score(result.rows.filter(r => r.suite === 'arithmetic' && r.arm === 'text')),
  arithmeticImage: score(result.rows.filter(r => r.suite === 'arithmetic' && r.arm === 'production')),
  gist: score(probes.filter(p => p.type !== 'unanswerable')),
  state: score(gist.filter(r => r.tier === 'work3').flatMap(r => r.probes)),
  neverStated: { confabulated: guards.filter(p => !p.ok).length, n: guards.length },
  hex: score(result.rows.filter(r => r.suite === 'hex')),
  calls: result.rows.length,
  usage: {},
};
assert.equal(summary.arithmeticText.n, 100);
assert.equal(summary.arithmeticImage.n, 100);
assert.equal(summary.gist.n, 98);
assert.equal(summary.state.n, 18);
assert.equal(summary.neverStated.n, 16);
assert.equal(summary.hex.n, 15);
for (const [name, rows] of [
  ['arithmeticText', result.rows.filter(r => r.suite === 'arithmetic' && r.arm === 'text')],
  ['arithmeticImage', result.rows.filter(r => r.suite === 'arithmetic' && r.arm === 'production')],
  ['gist', gist], ['hex', result.rows.filter(r => r.suite === 'hex')], ['total', result.rows],
]) {
  const sum = fn => rows.reduce((n, r) => n + (fn(r.usage) || 0), 0);
  summary.usage[name] = {
    calls: rows.length,
    inputTokens: sum(u => u.input_tokens),
    outputTokens: sum(u => u.output_tokens),
    reasoningTokens: sum(u => u.output_tokens_details?.reasoning_tokens),
    cachedTokens: sum(u => u.input_tokens_details?.cached_tokens),
    cacheWriteTokens: sum(u => u.input_tokens_details?.cache_write_tokens),
  };
}
writeFileSync(join(HERE, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
