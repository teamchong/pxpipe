/**
 * Tests for the recovery channel (Task #2): `emitRecoverable` + `info.recoverable`.
 *
 * `keepSharp` is the *keep-as-text* half of the fidelity contract — it pins a
 * block before it is ever imaged. `emitRecoverable` is the *recover* half: for
 * blocks pxpipe DID render to image(s), it returns a `RecoverableBlock` carrying
 * the exact original text + provenance, so a stateful caller (a harness, not a
 * proxy) can re-inject the bytes or re-fetch from source if the model later
 * needs the imaged region verbatim. This is the documented mitigation for the
 * silent-confabulation failure mode: imaged content becomes lossy-but-recoverable
 * instead of lossy-and-permanent.
 *
 * Contract being verified:
 *   - Default (option off): `info.recoverable` is undefined even when imaging.
 *   - emitRecoverable → true: each imaged live-region block yields an entry with
 *     a stable `rec_` id, kind, toolUseId, byte-exact original `text`, and
 *     `imageCount`.
 *   - The id is content-derived and stable (same content → same id).
 *   - A kept-sharp (never-imaged) block produces NO recovery entry.
 *   - Recording is free when the option is off (no entries, no field).
 *   - The channel is reachable through the public library wrapper.
 */

import { describe, expect, it } from 'vitest';
import { transformRequest } from '../src/core/transform.js';
import { transformAnthropicMessages } from '../src/core/library.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeReq(content: unknown[], model = 'claude-3-5-sonnet') {
  return enc.encode(
    JSON.stringify({
      model,
      system: 'x'.repeat(80_000),
      messages: [{ role: 'user', content }],
    }),
  );
}

function parse(body: Uint8Array): any {
  return JSON.parse(dec.decode(body));
}

function userBlocks(body: Uint8Array): any[] {
  const req = parse(body);
  const user = (req.messages ?? []).find((m: any) => m.role === 'user');
  return Array.isArray(user?.content) ? user.content : [];
}

// Big enough that the profitability gate images it by default.
const BIG = 'x'.repeat(50_000);

describe('emitRecoverable recovery channel', () => {
  it('emits no recovery map by default, even when content is imaged', async () => {
    const { info } = await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'toolu_a', content: BIG }]),
      { charsPerToken: 2 },
    );
    // The block WAS imaged...
    expect(info.toolResultImgs ?? 0).toBeGreaterThan(0);
    // ...but with the option off, pxpipe keeps nothing (a proxy can't anyway).
    expect(info.recoverable).toBeUndefined();
  });

  it('records an imaged tool_result with byte-exact original text + provenance', async () => {
    const { body, info } = await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'toolu_a', content: BIG }]),
      { charsPerToken: 2, emitRecoverable: true },
    );

    // The block was imaged out of the body...
    const tr = userBlocks(body).find((b) => b.type === 'tool_result');
    const hasImage =
      Array.isArray(tr?.content) &&
      tr.content.some((b: any) => b.type === 'image');
    expect(hasImage).toBe(true);

    // ...and recorded for recovery, with the exact bytes preserved.
    expect(Array.isArray(info.recoverable)).toBe(true);
    const entry = info.recoverable!.find((r) => r.kind === 'tool_result');
    expect(entry).toBeTruthy();
    expect(entry!.id).toMatch(/^rec_[0-9a-f]{8}$/);
    expect(entry!.toolUseId).toBe('toolu_a');
    expect(entry!.text).toBe(BIG); // byte-exact, pre-compaction
    expect(entry!.imageCount).toBeGreaterThan(0);
  });

  it('derives a stable content id (same content → same id)', async () => {
    const opts = { charsPerToken: 2, emitRecoverable: true } as const;
    const a = await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'toolu_a', content: BIG }]),
      opts,
    );
    const b = await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'toolu_a', content: BIG }]),
      opts,
    );
    const idA = a.info.recoverable!.find((r) => r.kind === 'tool_result')!.id;
    const idB = b.info.recoverable!.find((r) => r.kind === 'tool_result')!.id;
    expect(idA).toBe(idB);

    // Different tool_use_id → different id (provenance is part of the key).
    const c = await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'toolu_OTHER', content: BIG }]),
      opts,
    );
    const idC = c.info.recoverable!.find((r) => r.kind === 'tool_result')!.id;
    expect(idC).not.toBe(idA);
  });

  it('does NOT record a block that keepSharp kept as text (never imaged)', async () => {
    const { info } = await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'keep_me', content: BIG }]),
      {
        charsPerToken: 2,
        emitRecoverable: true,
        keepSharp: (blk) => blk.toolUseId === 'keep_me',
      },
    );
    // Pinned as text up-front, so there is nothing to recover.
    expect(info.keptSharpBlocks ?? 0).toBeGreaterThan(0);
    expect(info.toolResultImgs ?? 0).toBe(0);
    expect(info.recoverable).toBeUndefined();
  });

  it('records only the imaged sibling when one block is kept sharp', async () => {
    const { info } = await transformRequest(
      makeReq([
        { type: 'tool_result', tool_use_id: 'keep_me', content: BIG },
        { type: 'tool_result', tool_use_id: 'image_me', content: BIG },
      ]),
      {
        charsPerToken: 2,
        emitRecoverable: true,
        keepSharp: (blk) => blk.toolUseId === 'keep_me',
      },
    );
    const ids = (info.recoverable ?? []).map((r) => r.toolUseId);
    expect(ids).toContain('image_me');
    expect(ids).not.toContain('keep_me');
  });

  it('is reachable through the public library wrapper', async () => {
    const result = await transformAnthropicMessages({
      body: makeReq(
        [{ type: 'tool_result', tool_use_id: 'toolu_a', content: BIG }],
        'claude-fable-5',
      ),
      model: 'claude-fable-5',
      options: { charsPerToken: 2, emitRecoverable: true },
    });
    expect(result.applied).toBe(true);
    const entry = (result.info.recoverable ?? []).find((r) => r.kind === 'tool_result');
    expect(entry).toBeTruthy();
    expect(entry!.text).toBe(BIG);
  });
});
