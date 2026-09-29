// Offline only. Compare preprocessing latency and require byte-identical wire
// requests; never send fixture data or benchmark calls to a provider.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

globalThis.fetch = async () => { throw new Error('Network is disabled in the offline preprocessing benchmark'); };
const current = {
  name: 'candidate',
  transform: (await import('../../dist/core/openai.js')).transformOpenAIResponses,
  cache: await import('../../dist/core/render.js'),
};
const arms = [];
if (process.env.BENCH_BASELINE_DIST) {
  arms.push({ name: 'baseline',
    transform: (await import(pathToFileURL(join(process.env.BENCH_BASELINE_DIST, 'core/openai.js')))).transformOpenAIResponses,
    cache: await import(pathToFileURL(join(process.env.BENCH_BASELINE_DIST, 'core/render.js'))),
  });
}
arms.push(current);
const source = readFileSync(new URL('../gist-recall/work/s0.txt', import.meta.url), 'utf8');
const input = [{ role: 'user', content: 'Review the synthetic fixture outputs.' }];
const rounds = Number(process.env.BENCH_ROUNDS || 36);
const coldEach = process.env.BENCH_COLD_EACH === '1';
assert(Number.isInteger(rounds) && rounds > 0 && rounds <= 128);
for (let i = 0; i < rounds; i++) input.push(
  { type: 'reasoning', encrypted_content: `opaque_fixture_${i}` },
  { type: 'custom_tool_call', call_id: `call_fixture_${i}`, name: 'fixture_read', input: `fixture ${i}`, status: 'completed' },
  { type: 'custom_tool_call_output', call_id: `call_fixture_${i}`, output: `Fixture ${i}\n${source}` },
);
const body = new TextEncoder().encode(JSON.stringify({ model: 'gpt-6-astra', input }));
const rows = [];
let reference;
for (const arm of arms) arm.cache.clearRenderCache();
for (let run = 0; run < 7; run++) {
  // Alternate ordering to reduce warm-up/load bias; run 0 is cold and excluded
  // from the warm median. The two compiled versions have independent caches.
  for (const arm of run % 2 ? [...arms].reverse() : arms) {
    if (coldEach) {
      arm.cache.clearRenderCache();
      assert.equal(arm.cache.renderCacheStats().entries, 0);
    }
    const start = performance.now(), result = await arm.transform(body);
    const ms = performance.now() - start;
    const hash = createHash('sha256').update(result.body).digest('hex');
    reference ??= hash;
    assert.equal(hash, reference, 'Outbound bytes changed; latency comparison rejected');
    rows.push({ arm: arm.name, run, ms: +ms.toFixed(2), bodyHash: hash,
      images: result.info.imageCount, nativeTokens: result.info.nativeInjectedTokens,
      cache: arm.cache.renderCacheStats() });
  }
}
const median = values => { const s = [...values].sort((a, b) => a - b), i = Math.floor(s.length / 2); return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
console.log(JSON.stringify({ fixture: `public-gist-${rounds}-custom-rounds`, rounds, cacheMode: coldEach ? 'cold-each' : 'warm-reuse', networkCalls: 0, byteIdentical: true,
  measuredMedianMs: Object.fromEntries(arms.map(a => [a.name, median(rows.filter(r => r.arm === a.name && r.run > 0).map(r => r.ms))])), rows }, null, 2));
