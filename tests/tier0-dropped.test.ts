/**
 * Tests for `TransformInfo.tier0DroppedTotal` — passive per-request telemetry
 * (multi-specialist debate 2026-07-07): how often a single request carries a
 * fact-sheet-eligible block with more than MAX_TIER0 zero-redundancy tokens
 * (hex/uuid/const-id/ticket/flag/number), summed across every fact-sheet caption
 * built this request (static slab, reminders, tool_results, tool_result parts).
 * Zero model calls — pure function of the transformed request's content.
 */

import { describe, expect, it } from 'vitest';
import { transformRequest } from '../src/core/transform.js';

const enc = new TextEncoder();

function makeReq(toolResultContent: string) {
  return enc.encode(
    JSON.stringify({
      model: 'claude-3-5-sonnet',
      system: 'x'.repeat(80_000), // clears minCompressChars so the pipeline engages
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: toolResultContent }] },
      ],
    }),
  );
}

describe('TransformInfo.tier0DroppedTotal', () => {
  it('is absent (undefined) when nothing was ever dropped', async () => {
    const toolResult = 'commit 9d121ac on port 47821 in src/net/pool.ts. '.repeat(400);
    const { info } = await transformRequest(makeReq(toolResult), {});
    expect(info.tier0DroppedTotal).toBeUndefined();
  });

  it('accumulates when a single dense block exceeds MAX_TIER0 (260 hex ids)', async () => {
    const hexes = Array.from({ length: 260 }, (_, i) => (0xe8d4a51000 + i).toString(16));
    const toolResult = hexes
      .map((h, i) => `step ${i}: cache key ${h}, ok, continuing the run without any incident whatsoever.`)
      .join('\n');
    const { info } = await transformRequest(makeReq(toolResult), {});
    expect(info.tier0DroppedTotal).toBeGreaterThanOrEqual(68); // 260 - MAX_TIER0(192)
  });
});
