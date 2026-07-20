/**
 * Adaptive CPT — gate wiring.
 *
 * `cpt-fit.test.ts` proves the regression recovers the right numbers. This file
 * proves the numbers are actually *consumed*: that a learned chars-per-token
 * reaches the profitability gate, changes real decisions, and can never make the
 * gate worse than the baked constant when the learned table is absent or broken.
 *
 * Contract:
 *   - No resolver → every bucket reports `default` and the baked constant (today's
 *     behavior, byte-for-byte).
 *   - A learned CPT is reported on `info.cptSource` / `info.cptUsed`.
 *   - A learned CPT changes the gate verdict (the whole point of the feature).
 *   - Precedence: explicit `charsPerToken` > learned > baked constant.
 *   - A throwing or nonsensical resolver is ignored, never fatal.
 *   - The resolver is told which project (`system_sha8`) is asking.
 */

import { describe, expect, it } from 'vitest';
import {
  transformRequest,
  SLAB_CHARS_PER_TOKEN,
  type BucketName,
} from '../src/core/transform.js';

const enc = new TextEncoder();

/**
 * A system slab of `nLines` lines each `width` chars wide. With `reflow: false`
 * the rendered page keeps one row per line, so a narrow width makes a tall,
 * mostly-empty (expensive) image — the regime where the gate is genuinely
 * cpt-sensitive rather than trivially profitable.
 */
function slabReq(nLines: number, width: number): Uint8Array {
  const line = 'a'.repeat(width);
  return enc.encode(
    JSON.stringify({
      model: 'claude-3-5-sonnet',
      system: Array.from({ length: nLines }, () => line).join('\n'),
      messages: [{ role: 'user', content: 'hi' }],
    }),
  );
}

/** Slab shape the constant (2.0) images but a sparse learned rate (6.0) refuses. */
const SPARSE = { lines: 900, width: 48 } as const;
/** Slab shape the constant passes up but a dense learned rate (1.0) captures —
 *  the case that motivates the whole feature: savings the constant leaves behind. */
const MISSED = { lines: 900, width: 32 } as const;

describe('adaptive CPT — gate wiring', () => {
  it('uses the baked constant and reports "default" when no resolver is supplied', async () => {
    const { info } = await transformRequest(slabReq(400, 120), { reflow: false });
    expect(info.cptSource?.static_slab).toBe('default');
    expect(info.cptUsed?.static_slab).toBe(SLAB_CHARS_PER_TOKEN);
  });

  it('consumes a learned CPT and reports it as "learned"', async () => {
    const { info } = await transformRequest(slabReq(400, 120), {
      reflow: false,
      cptFor: () => 1.37,
    });
    expect(info.cptSource?.static_slab).toBe('learned');
    expect(info.cptUsed?.static_slab).toBeCloseTo(1.37, 5);
  });

  it('changes the gate verdict — a high learned CPT refuses an image the constant would have made', async () => {
    const req = () => slabReq(SPARSE.lines, SPARSE.width);
    const base = { reflow: false as const };

    // Baked constant (2.0): dense assumption → images this sparse slab.
    const withDefault = await transformRequest(req(), base);
    // Learned 6.0 (genuinely sparse prose): text is cheaper than the image → skip.
    const withLearned = await transformRequest(req(), { ...base, cptFor: () => 6.0 });

    expect(withDefault.info.compressed).toBe(true);
    expect(withLearned.info.compressed).toBe(false);
    expect(withLearned.info.reason).toContain('not_profitable');
  });

  it('captures a compression the baked constant passes up (the motivating case)', async () => {
    const req = () => slabReq(MISSED.lines, MISSED.width);
    const base = { reflow: false as const };

    // Constant 2.0 under-counts this slab's true token cost → declines to image.
    const withDefault = await transformRequest(req(), base);
    // Learned 1.0 prices the same text honestly → the image now wins.
    const withLearned = await transformRequest(req(), { ...base, cptFor: () => 1.0 });

    expect(withDefault.info.compressed).toBe(false);
    expect(withLearned.info.compressed).toBe(true);
  });

  it('keeps imaging when the learned CPT says the content is dense', async () => {
    const { info } = await transformRequest(slabReq(SPARSE.lines, SPARSE.width), {
      reflow: false,
      cptFor: () => 1.0,
    });
    expect(info.compressed).toBe(true);
  });

  it('lets an explicit charsPerToken override the learned value', async () => {
    const { info } = await transformRequest(slabReq(SPARSE.lines, SPARSE.width), {
      reflow: false,
      charsPerToken: 6.0, // host pins the gate …
      cptFor: () => 1.0, // … and the learned table disagrees; the host must win.
    });
    expect(info.cptSource?.static_slab).toBe('host');
    expect(info.cptUsed?.static_slab).toBe(6.0);
    expect(info.compressed).toBe(false);
  });

  it('ignores a throwing resolver instead of failing the request', async () => {
    const { info } = await transformRequest(slabReq(400, 120), {
      reflow: false,
      cptFor: () => {
        throw new Error('corrupt cpt-state.jsonl');
      },
    });
    expect(info.cptSource?.static_slab).toBe('default');
    expect(info.cptUsed?.static_slab).toBe(SLAB_CHARS_PER_TOKEN);
  });

  it('ignores nonsensical learned values (NaN, zero, negative)', async () => {
    for (const bad of [Number.NaN, 0, -2, Number.POSITIVE_INFINITY]) {
      const { info } = await transformRequest(slabReq(400, 120), {
        reflow: false,
        cptFor: () => bad,
      });
      expect(info.cptSource?.static_slab, `value ${bad}`).toBe('default');
      expect(info.cptUsed?.static_slab).toBe(SLAB_CHARS_PER_TOKEN);
    }
  });

  it('tells the resolver which bucket and which project is asking', async () => {
    const seen: Array<{ bucket: BucketName; sha?: string }> = [];
    const { info } = await transformRequest(slabReq(400, 120), {
      reflow: false,
      cptFor: (bucket, systemSha8) => {
        seen.push({ bucket, sha: systemSha8 });
        return undefined;
      },
    });
    const slab = seen.find((s) => s.bucket === 'static_slab');
    expect(slab).toBeDefined();
    // The slab gate runs after the system fingerprint is computed, so the
    // resolver can serve a per-project rate.
    expect(slab!.sha).toBe(info.systemSha8);
    expect(typeof slab!.sha).toBe('string');
  });
});
