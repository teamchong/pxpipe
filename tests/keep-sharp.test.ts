/**
 * Tests for the caller fidelity hint (Task #1): `keepSharp`.
 *
 * A caller (typically a harness that knows a block carries exact-match-
 * critical content — an ID, hash, secret, or file path) can supply a
 * `keepSharp(block)` predicate. Any block for which it returns `true`
 * is left as text and never rendered into an image, overriding the
 * chars/token profitability heuristic.
 *
 * Contract being verified:
 *   - Default (no predicate): a large tool_result is imaged.
 *   - keepSharp → true: the same block stays text, is NOT imaged, and
 *     `info.keptSharpBlocks` is incremented.
 *   - The predicate receives a descriptor it can decide on (kind/text).
 *   - keepSharp is per-block: a sharp block stays text while a sibling
 *     block in the same request still images.
 *   - A throwing / non-boolean predicate is treated as `false` and never
 *     breaks the request (pure, defensive).
 *   - The hint is reachable through the public library option type.
 *
 * Rendered PNGs are opaque in tests, so we assert on the request body
 * shape (text block survived vs. became image) and the `info` counters.
 */

import { describe, expect, it } from 'vitest';
import { transformRequest } from '../src/core/transform.js';
import { transformAnthropicMessages } from '../src/core/library.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Build a request whose first user message carries `content` blocks and a
 * large static system slab (so compression machinery is definitely active).
 * `model` defaults to a sonnet alias (the proxy path transforms any model);
 * the library wrapper gates on supported models, so its test passes Fable.
 */
function makeReq(content: unknown[], model = 'claude-3-5-sonnet') {
  return enc.encode(
    JSON.stringify({
      model,
      // Large static slab → main compression path runs, info.compressed flips.
      system: 'x'.repeat(80_000),
      messages: [{ role: 'user', content }],
    }),
  );
}

function parse(body: Uint8Array): any {
  return JSON.parse(dec.decode(body));
}

/** Pull the (single) user message's content blocks out of a transformed body. */
function userBlocks(body: Uint8Array): any[] {
  const req = parse(body);
  const user = (req.messages ?? []).find((m: any) => m.role === 'user');
  return Array.isArray(user?.content) ? user.content : [];
}

// A tool_result big enough that the profitability gate would normally image it.
const BIG = 'x'.repeat(50_000);

describe('keepSharp fidelity hint', () => {
  it('images a large tool_result by default (baseline, no hint)', async () => {
    const { body, info } = await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'toolu_a', content: BIG }]),
      { charsPerToken: 2 },
    );
    expect(info.compressed).toBe(true);
    expect(info.toolResultImgs ?? 0).toBeGreaterThan(0);
    expect(info.keptSharpBlocks ?? 0).toBe(0);

    // The imaged tool_result no longer carries its original text payload.
    const blocks = userBlocks(body);
    const tr = blocks.find((b) => b.type === 'tool_result');
    const hasImage =
      Array.isArray(tr?.content) &&
      tr.content.some((b: any) => b.type === 'image');
    expect(hasImage).toBe(true);
  });

  it('keeps a tool_result as text when keepSharp returns true', async () => {
    const { body, info } = await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'toolu_a', content: BIG }]),
      {
        charsPerToken: 2,
        keepSharp: (blk) => blk.kind === 'tool_result',
      },
    );

    // No tool_result image was produced; the counter recorded the override.
    expect(info.toolResultImgs ?? 0).toBe(0);
    expect(info.keptSharpBlocks ?? 0).toBeGreaterThan(0);

    // The original text survived byte-for-byte inside the tool_result.
    const tr = userBlocks(body).find((b) => b.type === 'tool_result');
    const text =
      typeof tr?.content === 'string'
        ? tr.content
        : (tr?.content ?? []).find((b: any) => b.type === 'text')?.text;
    expect(text).toBe(BIG);
  });

  it('passes a descriptor the predicate can decide on', async () => {
    const seen: Array<{ kind: string; toolUseId?: string; len: number }> = [];
    await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'toolu_z', content: BIG }]),
      {
        charsPerToken: 2,
        keepSharp: (blk) => {
          seen.push({ kind: blk.kind, toolUseId: blk.toolUseId, len: blk.text.length });
          return false;
        },
      },
    );
    const tr = seen.find((s) => s.kind === 'tool_result');
    expect(tr).toBeTruthy();
    expect(tr!.toolUseId).toBe('toolu_z');
    expect(tr!.len).toBe(BIG.length);
  });

  it('is per-block: a sharp block stays text while a sibling images', async () => {
    const { body, info } = await transformRequest(
      makeReq([
        { type: 'tool_result', tool_use_id: 'keep_me', content: BIG },
        { type: 'tool_result', tool_use_id: 'image_me', content: BIG },
      ]),
      {
        charsPerToken: 2,
        keepSharp: (blk) => blk.toolUseId === 'keep_me',
      },
    );

    expect(info.keptSharpBlocks ?? 0).toBe(1);
    expect(info.toolResultImgs ?? 0).toBeGreaterThan(0);

    const blocks = userBlocks(body);
    const kept = blocks.find((b) => b.tool_use_id === 'keep_me');
    const imaged = blocks.find((b) => b.tool_use_id === 'image_me');

    const keptText =
      typeof kept?.content === 'string'
        ? kept.content
        : (kept?.content ?? []).find((b: any) => b.type === 'text')?.text;
    expect(keptText).toBe(BIG);

    const imagedHasImage =
      Array.isArray(imaged?.content) &&
      imaged.content.some((b: any) => b.type === 'image');
    expect(imagedHasImage).toBe(true);
  });

  it('treats a throwing predicate as false and never breaks the request', async () => {
    const { body, info } = await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'toolu_a', content: BIG }]),
      {
        charsPerToken: 2,
        keepSharp: () => {
          throw new Error('caller bug');
        },
      },
    );
    // Falls back to default behavior: the block is imaged, nothing pinned.
    expect(info.compressed).toBe(true);
    expect(info.keptSharpBlocks ?? 0).toBe(0);
    const tr = userBlocks(body).find((b) => b.type === 'tool_result');
    const hasImage =
      Array.isArray(tr?.content) &&
      tr.content.some((b: any) => b.type === 'image');
    expect(hasImage).toBe(true);
  });

  it('is reachable through the public library wrapper', async () => {
    // Fable is the supported model by default; the wrapper gates on
    // `input.model`, so set it to a Fable alias to run the real transform.
    const result = await transformAnthropicMessages({
      body: makeReq(
        [{ type: 'tool_result', tool_use_id: 'toolu_a', content: BIG }],
        'claude-fable-5',
      ),
      model: 'claude-fable-5',
      options: {
        // library surface to charsPerToken / historyAmortizationHorizon / keepSharp.
        charsPerToken: 2,
        keepSharp: (blk) => blk.kind === 'tool_result',
      },
    });

    // The model gate let the transform run, and the sharp block stayed text.
    expect(result.applied).toBe(true);
    const tr = userBlocks(result.body).find((b) => b.type === 'tool_result');
    const text =
      typeof tr?.content === 'string'
        ? tr.content
        : (tr?.content ?? []).find((b: any) => b.type === 'text')?.text;
    expect(text).toBe(BIG);
  });
});
