import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicManifest } from './publish.mjs';

test('public export excludes private fields even when nested in raw receipts', () => {
  const marker = 'PRIVATE_SETUP_MUST_NOT_BE_PUBLISHED';
  const hash = 'a'.repeat(64);
  const usage = { calls: 1, inputTokens: 10, outputTokens: 2, reasoningTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
  const summary = { protocol: 'profile-quality-v2', model: 'gpt-6-astra',
    inference: { family: 'responses', reasoning: 'low', endpoint: marker },
    profileHash: hash, newCalls: 1, reusedCalls: 0, usage: { all: { ...usage, endpoint: marker } },
    neverStated: { n: 16, confabulated: 0 },
    ...Object.fromEntries(['arithmeticText', 'arithmeticImage', 'gist', 'state', 'hex'].map(k => [k, { n: 1, correct: 1 }])),
  };
  const result = { environment: marker, rows: [{ id: 'hex-0', sourceHash: hash, requestHash: hash,
    raw: marker, question: marker, gold: marker, endpoint: marker, headers: { authorization: marker },
    ok: true, reusedFrom: { file: marker }, usage: { input_tokens: 10, output_tokens: 2, privateMetadata: marker },
    rendering: { recipe: { purpose: 'content', privateMetadata: marker }, profileHash: hash,
      detail: 'high', renderedSourceHash: hash, factsheetHash: hash,
      images: [{ width: 100, height: 100, sha256: hash, localPath: marker }] },
  }] };
  const published = publicManifest(result, summary);
  assert(!JSON.stringify(published).includes(marker));
  assert.equal(published.receipts[0].score.correct, 1);
  assert.equal(published.receipts[0].usage.inputTokens, 10);
  assert.equal(published.receipts[0].responseHash.length, 64);
  assert.equal(published.receipts[0].raw, undefined);
  assert.equal(published.receipts[0].rendering.recipe, undefined);
  result.rows[0].usage.input_tokens = marker;
  assert.throws(() => publicManifest(result, summary), /Public metrics/);
});
