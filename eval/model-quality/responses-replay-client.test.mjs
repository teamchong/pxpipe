import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { callResponsesRequest } from './responses-replay-client.mjs';
const fetchBefore = globalThis.fetch;
const before = { base: process.env.OPENAI_BASE_URL, key: process.env.OPENAI_API_KEY };
afterEach(() => {
  globalThis.fetch = fetchBefore;
  for (const [key, value] of [['OPENAI_BASE_URL', before.base], ['OPENAI_API_KEY', before.key]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
function setup() { process.env.OPENAI_BASE_URL = 'https://example.invalid/v1'; process.env.OPENAI_API_KEY = 'test-key'; }
const request = { model: 'gpt-6-astra', input: [{ role: 'user', content: 'Synthetic test.' }], max_output_tokens: 768, reasoning: { effort: 'low' }, store: false };
test('rejects malformed arguments before any network request', async () => {
  setup(); globalThis.fetch = () => { throw Error('must not fetch'); };
  await assert.rejects(callResponsesRequest({ request: { ...request, max_output_tokens: 0 }, timeoutMs: 1000 }), TypeError);
});
test('forwards the exact complete request body', async () => {
  setup(); let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++; assert.equal(url, 'https://example.invalid/v1/responses'); assert.deepEqual(JSON.parse(options.body), request);
    return new Response(JSON.stringify({ status: 'completed', output_text: '["fixture"]', usage: { input_tokens: 20, output_tokens: 5 } }));
  };
  const r = await callResponsesRequest({ request, timeoutMs: 1000 });
  assert.equal(r.text, '["fixture"]'); assert.equal(r.status, 'completed'); assert.equal(calls, 1);
});
test('retains incomplete-response usage without retrying', async () => {
  setup(); let calls = 0;
  globalThis.fetch = async () => {
    calls++; return new Response(JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 250, output_tokens: 768 } }));
  };
  const r = await callResponsesRequest({ request, timeoutMs: 1000 });
  assert.equal(r.status, 'incomplete'); assert.equal(r.usage.output_tokens, 768); assert.equal(calls, 1);
});
test('refuses the pxpipe endpoint to avoid double transformation', async () => {
  setup(); process.env.OPENAI_BASE_URL = 'http://127.0.0.1:47821/v1';
  globalThis.fetch = () => { throw Error('must not fetch'); };
  await assert.rejects(callResponsesRequest({ request, timeoutMs: 1000 }));
});
