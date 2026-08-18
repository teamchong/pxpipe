import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearCodexCacheState,
  getCodexCacheHint,
  noteCodexCacheOutcome,
} from '../src/core/codex-cache-state.js';
import { buildCodexProxyConfig } from '../src/core/codex.js';
import { transformOpenAIResponses } from '../src/core/openai.js';
import { createProviderRouter } from '../src/core/provider-router.js';

const enc = new TextEncoder();
const THREAD_A = 'thread-a-fingerprint';
const THREAD_B = 'thread-b-fingerprint';

async function observerKey(rawThreadId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    enc.encode(rawThreadId),
  );

  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('').slice(0, 16);
}

function build(pairs: number): Uint8Array {
  const input: Array<Record<string, unknown>> = [
    { role: 'user', content: 'Audit this repository thoroughly and continue until done.' },
  ];
  for (let i = 0; i < pairs; i += 1) {
    const id = `cc_${i}`;
    input.push({
      type: 'custom_tool_call',
      id: `ct_${id}`,
      call_id: id,
      name: 'exec_command',
      input: `read file ${i}`,
    });
    input.push({
      type: 'custom_tool_call_output',
      call_id: id,
      output: Array.from({ length: 120 }, (_, j) =>
        `file_${i}_${j}.ts symbol_${i}_${j} arg_${j}=value_${i}_${j} ` +
        `checksum=${(i * 1000 + j).toString(16).padStart(8, '0')} ` +
        `path=/tmp/repo_${i}/module_${j}/handler_${j}.ts`,
      ).join('\n'),
    });
  }
  input.push({ role: 'assistant', content: 'Still working on the live task.' });
  return enc.encode(JSON.stringify({
    model: 'gpt-5.6-sol',
    instructions: 'Keep all live tool state exact.',
    input,
  }));
}

beforeEach(() => clearCodexCacheState());
afterEach(() => vi.unstubAllGlobals());

describe('Codex protocol-aware history', () => {
  it('accounts completed custom-tool rounds instead of treating every call as a barrier', async () => {
    const result = await transformOpenAIResponses(build(10), { codexOptimization: false });
    const c = result.info.responsesComposition!;
    expect(c.customToolCalls ?? 0).toBeGreaterThan(0);
    expect(c.customToolOutputs ?? 0).toBeGreaterThan(0);
    expect(c.completedCustomToolPairs).toBe(10);
    expect(c.malformedCustomToolItems).toBe(0);
    const customCallBarriers = c.barrierTypes?.filter((x) => x.startsWith('custom_tool_call:')) ?? [];
    // The newest protected/live boundary may remain native; closed historical
    // rounds must not each become their own barrier.
    expect(customCallBarriers.length).toBeLessThanOrEqual(1);
  });
});

describe('Codex cache-stable admission', () => {
  it('observes one native request before creating the first image epoch', async () => {
    const first = await transformOpenAIResponses(build(12), { codexOptimization: true, codexSessionKey: THREAD_A });
    expect(first.info.firstUserSha8).toMatch(/^[0-9a-f]{8}$/);
    expect(first.info.historyReason).toBe('cache_preservation');
    expect(first.info.responsesComposition?.historyCacheDecision).toBe('no_prior_usage');
    expect(first.info.collapsedImages ?? 0).toBe(0);
  });

  it('blocks a warm native prefix but permits a material cold transition', async () => {
    const probe = await transformOpenAIResponses(build(12), { codexOptimization: true, codexSessionKey: THREAD_A });
    const key = THREAD_A;

    noteCodexCacheOutcome(key, { inputTokens: 120_000, cachedTokens: 110_000, compressed: false });
    const warm = await transformOpenAIResponses(build(12), { codexOptimization: true, codexSessionKey: THREAD_A });
    expect(warm.info.historyReason).toBe('cache_preservation');
    expect(warm.info.responsesComposition?.historyCacheDecision).toBe('warm_native_blocked');

    noteCodexCacheOutcome(key, { inputTokens: 120_000, cachedTokens: 10_000, compressed: false });
    const cold = await transformOpenAIResponses(build(12), { codexOptimization: true, codexSessionKey: THREAD_A });
    expect(cold.info.responsesComposition?.historyCacheDecision).toBe('cold_or_low_cache');
    expect(cold.info.historyReason).toBe('collapsed');
    expect(cold.info.collapsedImages ?? 0).toBeGreaterThan(0);
    expect(cold.info.responsesComposition?.historyCandidateRawSaving ?? 0).toBeGreaterThan(1024);
    expect(cold.info.responsesComposition?.historyCandidateRawSavingPct ?? 0).toBeGreaterThanOrEqual(15);
  });

  it('does not reuse a same-prompt cache hint across Codex thread keys', async () => {
    noteCodexCacheOutcome(THREAD_A, {
      inputTokens: 120_000,
      cachedTokens: 10_000,
      compressed: false,
    });
    const other = await transformOpenAIResponses(build(12), {
      codexOptimization: true,
      codexSessionKey: THREAD_B,
    });
    expect(other.info.firstUserSha8).toMatch(/^[0-9a-f]{8}$/);
    expect(other.info.historyReason).toBe('cache_preservation');
    expect(other.info.responsesComposition?.historyCacheDecision).toBe('no_prior_usage');
    expect(other.info.collapsedImages ?? 0).toBe(0);
  });

  it('invalidates stale pressure after successful native compaction only', async () => {
    const rawThreadId = 'thread-native-compact';
    const key = await observerKey(rawThreadId);

    const router = createProviderRouter({
      defaultProxy: {
        upstream: 'https://api.anthropic.example',
      },
      providers: [{
        id: 'codex',
        protocol: 'openai',
        proxy: buildCodexProxyConfig({}),
      }],
    });

    const request = () => new Request(
      'http://127.0.0.1:47821/providers/codex/backend-api/codex/responses/compact',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-oauth',
          'content-type': 'application/json',
          'thread-id': rawThreadId,
        },
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          input: [{ type: 'opaque', value: 'native compact payload' }],
        }),
      },
    );

    noteCodexCacheOutcome(key, {
      inputTokens: 900_000,
      cachedTokens: 100_000,
      compressed: false,
    });

    expect(getCodexCacheHint(key)?.inputTokens).toBe(900_000);

    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ));

    const success = await router(request());
    expect(success.status).toBe(200);
    expect(getCodexCacheHint(key)).toBeUndefined();

    // A failed compact did not replace the trajectory, so keep the previous
    // trustworthy observation rather than forcing a needless cold restart.
    noteCodexCacheOutcome(key, {
      inputTokens: 900_000,
      cachedTokens: 100_000,
      compressed: false,
    });

    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () =>
      new Response('failed', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      }),
    ));

    const failed = await router(request());
    expect(failed.status).toBe(500);
    expect(getCodexCacheHint(key)?.inputTokens).toBe(900_000);
  });

  it('extends a warm compressed epoch only when old synthetic segments stay a prefix', async () => {
    const probe = await transformOpenAIResponses(build(12), { codexOptimization: true, codexSessionKey: THREAD_A });
    const key = THREAD_A;
    noteCodexCacheOutcome(key, { inputTokens: 120_000, cachedTokens: 10_000, compressed: false });
    const established = await transformOpenAIResponses(build(12), { codexOptimization: true, codexSessionKey: THREAD_A });
    const segments = established.info.historySegmentShas ?? [];
    expect(segments.length).toBeGreaterThan(0);

    noteCodexCacheOutcome(key, {
      inputTokens: 130_000,
      cachedTokens: 125_000,
      compressed: true,
      historySegmentShas: segments,
    });
    const extended = await transformOpenAIResponses(build(14), { codexOptimization: true, codexSessionKey: THREAD_A });
    expect(extended.info.responsesComposition?.historyCacheDecision).toBe('warm_append_only');
    expect(extended.info.responsesComposition?.historyStablePrefixSegments).toBe(segments.length);
    expect(extended.info.historyReason).toBe('collapsed');
  });
});