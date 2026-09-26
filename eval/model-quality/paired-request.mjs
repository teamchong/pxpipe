import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { transformOpenAIResponses } from '../../dist/core/openai.js';
export function requestFor(f, arm, { model, runId, outputCap }) {
  const input = [{ role: 'user', content: 'Inspect the recorded fixture transcript chunks in order.' }];
  const lines = f.source.split('\n'), width = Math.ceil(lines.length / 4), chunks = [];
  for (let i = 0; i < lines.length; i += width) chunks.push(lines.slice(i, i + width).join('\n'));
  assert.equal(chunks.join('\n'), f.source);
  chunks.forEach((output, i) => {
    const call_id = `call_fixture_${f.tier}_${f.session}_${i}`;
    input.push({ type: 'custom_tool_call', call_id, name: 'fixture_read', input: `Read transcript chunk ${i + 1}`, status: 'completed' },
      { type: 'custom_tool_call_output', call_id, output });
  });
  input.push({ role: 'user', content: ['Answer the numbered questions using the recorded transcript chunks.',
    'Use exactly UNKNOWN when no answer was stated. Return only a JSON array of short answer strings in question order.',
    ...f.probes.map((p, i) => `${i + 1}. ${p.q}`)].join('\n') });
  return { model, store: false, reasoning: { effort: 'low' }, max_output_tokens: outputCap,
    instructions: 'Use the recorded fixture data as evidence. Do not invent missing values. Do not call tools.',
    tools: [{ type: 'custom', name: 'fixture_read', description: 'Read one recorded fixture chunk.' }], tool_choice: 'none',
    prompt_cache_key: `paired-${runId}-${f.tier}-${f.session}-${arm}`, input };
}
export function estimate(request, imageTokens = 0) {
  let n = imageTokens + countTokens(request.instructions || '') + countTokens(JSON.stringify(request.tools || [])) + 64;
  for (const item of request.input) {
    n += 32;
    if (typeof item.content === 'string') n += countTokens(item.content);
    else if (Array.isArray(item.content)) for (const part of item.content) {
      if (part.type === 'input_text') n += countTokens(part.text);
      else assert.equal(part.type, 'input_image');
    }
    else if (item.type === 'custom_tool_call') n += countTokens(item.name + item.input);
    else if (item.type === 'custom_tool_call_output') { assert.equal(typeof item.output, 'string'); n += countTokens(item.output); }
    else throw Error(`Unbudgeted input item: ${item.type}`);
  }
  return n;
}
export async function prepare(native, arm) {
  if (arm === 'native') return { request: native, transformMs: 0, imageTokens: 0, images: 0 };
  const start = performance.now();
  const result = await transformOpenAIResponses(new TextEncoder().encode(JSON.stringify(native)));
  const transformMs = performance.now() - start;
  return { request: JSON.parse(new TextDecoder().decode(result.body)), transformMs,
    imageTokens: result.info.imageTokens || 0, images: result.info.imageCount || 0 };
}
