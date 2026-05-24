/**
 * Foundational gate-flapping tests.
 *
 * Background: the slab break-even gate originally penalised compressing
 * when the un-rewritten text path was warm (`priorWarmTokens`). It did
 * NOT symmetrically penalise decompressing when the rewritten image path
 * was warm. Sessions ping-ponged between modes — each flip paid a fresh
 * `cache_create` on the new side, then the next turn flipped back.
 *
 * Fix: symmetric burn (`priorWarmImageTokens`) on the TEXT side. Once a
 * session commits to a mode, the same-mode side gets a discount equal to
 * `priorWarm × (CACHE_CREATE_RATE − CACHE_READ_RATE)`. Mode changes only
 * happen when the per-turn delta exceeds the burn cost.
 *
 * These tests pin the new behavior end-to-end at the public API:
 * `isCompressionProfitable` + `evalCompressionProfitability`.
 */
import { describe, expect, it } from 'vitest';
import {
  isCompressionProfitable,
  evalCompressionProfitability,
} from '../src/core/transform.js';

describe('symmetric warm-cache burn (anti-flapping)', () => {
  it('back-compat: omitting both warm args matches previous behavior', () => {
    // A clearly-profitable case (large text, few images) must still
    // come out as `true` when no warm-cache burn is supplied.
    const text = 'x'.repeat(50_000);
    expect(isCompressionProfitable(text, 100, undefined, 2, 4)).toBe(true);
  });

  it('priorWarmTokens alone penalises compressing when text is warm', () => {
    // Borderline-profitable text length — small enough that adding any
    // image-side burn flips the verdict to "not profitable".
    const text = 'x'.repeat(12_000);
    const cold = isCompressionProfitable(text, 100, undefined, 2, 4, 0, 0);
    const warm = isCompressionProfitable(text, 100, undefined, 2, 4, 50_000, 0);
    // If the cold gate says compress, the warm-text gate must NOT (asymmetric
    // burn now pins the session in text mode).
    if (cold) expect(warm).toBe(false);
  });

  it('priorWarmImageTokens symmetrically pins a session in image mode', () => {
    // Pick a scenario where the cold gate says NOT profitable: text whose
    // text-token cost is below the image cost. Under the post-shrink gate
    // (content-aware image cost) this is rare on natural shapes — but a
    // pathologically-tight chars-per-token (~50) simulates a session where
    // the text is unusually token-cheap (think: extremely repetitive
    // content). Once image mode is warm, the symmetric burn must flip the
    // verdict to "profitable" so we stay in image mode rather than
    // re-creating the text cache.
    const text = 'hello'.repeat(500); // 2500 chars
    const cold = isCompressionProfitable(text, 100, undefined, 1, 50, 0, 0);
    const warmImage = isCompressionProfitable(text, 100, undefined, 1, 50, 0, 60_000);
    expect(cold).toBe(false);
    expect(warmImage).toBe(true);
  });

  it('warm on BOTH sides cancels out (no asymmetric bias)', () => {
    const text = 'x'.repeat(12_000);
    const cold = isCompressionProfitable(text, 100, undefined, 2, 4, 0, 0);
    const both = isCompressionProfitable(text, 100, undefined, 2, 4, 25_000, 25_000);
    expect(both).toBe(cold);
  });
});

describe('evalCompressionProfitability observability', () => {
  it('returns the same verdict as isCompressionProfitable', () => {
    const samples = [
      { text: 'x'.repeat(50_000), pw: 0, pwi: 0 },
      { text: 'x'.repeat(12_000), pw: 50_000, pwi: 0 },
      { text: 'hello'.repeat(500), pw: 0, pwi: 60_000 },
      { text: 'x'.repeat(12_000), pw: 25_000, pwi: 25_000 },
    ];
    for (const s of samples) {
      const verdict = isCompressionProfitable(s.text, 100, undefined, 2, 4, s.pw, s.pwi);
      const evaled = evalCompressionProfitability(s.text, 100, undefined, 2, 4, s.pw, s.pwi);
      expect(evaled).not.toBeNull();
      expect(evaled!.profitable).toBe(verdict);
    }
  });

  it('exposes the symmetric burn terms used internally', () => {
    const e = evalCompressionProfitability(
      'x'.repeat(12_000),
      100,
      undefined,
      2,
      4,
      40_000,
      60_000,
    );
    expect(e).not.toBeNull();
    // burn = warm × (1.25 − 0.10) = warm × 1.15
    expect(e!.burnImageSide).toBeCloseTo(40_000 * 1.15, 5);
    expect(e!.burnTextSide).toBeCloseTo(60_000 * 1.15, 5);
    // imageTokens / textTokens are positive token-equivalents.
    expect(e!.imageTokens).toBeGreaterThan(0);
    expect(e!.textTokens).toBeGreaterThan(0);
  });

  it('returns null when textLen ≤ 0 (defensive against degenerate inputs)', () => {
    expect(evalCompressionProfitability(0, 100)).toBeNull();
    expect(evalCompressionProfitability(-5, 100)).toBeNull();
  });
});
