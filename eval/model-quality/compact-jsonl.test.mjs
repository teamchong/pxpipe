import assert from 'node:assert/strict';
import test from 'node:test';
import { compactJsonl, restoreJsonl } from './compact-jsonl.mjs';
import { callModel } from './clients.mjs';

test('compact tables preserve every value, order and surrounding line', () => {
  const rows = Array.from({ length: 10 }, (_, n) => JSON.stringify({ identifier: `abc${n}`, duration: n, status: 200, path: '/synthetic/path' }));
  const source = ['BEGIN', ...rows, 'END', ''].join('\n');
  const result = compactJsonl(source);
  assert.equal(restoreJsonl(result.chunks), source);
  assert(result.text.length < source.length);
  assert(result.text.includes('columns='));
  assert(result.text.includes('constants='));
});
test('duplicate keys, unsafe numeric spelling and noncanonical text stay intact', () => {
  for (const line of ['{"a":1,"a":2}', '{"n":9007199254740993}', '{"n":-0}', '{ "a":1 }', '{"n":1e400}', 'ordinary text']) {
    const source = Array(5).fill(line).join('\n');
    assert.equal(compactJsonl(source).text, source);
  }
});
test('special keys and nested constants round-trip without prototype mutation', () => {
  const source = Array.from({ length: 5 }, (_, n) => `{"__proto__":{"fixture":true},"constructor":"x","n":${n}}`).join('\n');
  const result = compactJsonl(source);
  assert.equal(restoreJsonl(result.chunks), source);
  assert.equal({}.fixture, undefined);
});
test('malformed client arguments fail before any network request', async () => {
  await assert.rejects(callModel('not-an-options-object'), /requires model/);
  await assert.rejects(callModel({ model: 'gpt-6-astra', content: [] }), /positive output\/timeout budgets/);
});
