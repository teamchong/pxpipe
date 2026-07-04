import { describe, it, expect } from 'vitest';
import {
  anthropicVisionProfile,
  anthropicVisionTokens,
  patchTokens,
  ANTHROPIC_PATCH_PX,
} from '../src/core/anthropic-vision.js';

// Anthropic bills images by 28×28-pixel patches: ⌈w/28⌉×⌈h/28⌉ visual tokens,
// after downscaling to the model tier's long-edge (1568/2576) and token-budget
// (1568/4784) limits. Numbers below are cross-checked against Anthropic's own
// worked cost table (platform.claude.com/docs/en/build-with-claude/vision).

describe('patchTokens — raw 28-px patch count', () => {
  it('is one token per full 28×28 patch, padding partial edges up', () => {
    expect(ANTHROPIC_PATCH_PX).toBe(28);
    expect(patchTokens(28, 28)).toBe(1);
    expect(patchTokens(29, 29)).toBe(4); // ⌈29/28⌉² = 2² = 4
    expect(patchTokens(1000, 1000)).toBe(1296); // 36² (docs worked example)
    expect(patchTokens(1568, 728)).toBe(1456); // 56×26 — pxpipe's full dense page
    expect(patchTokens(1928, 1928)).toBe(4761); // 69² (old page, high-res)
  });
});

describe('anthropicVisionProfile — tier by model', () => {
  it('puts the documented high-res models on the 2576/4784 tier', () => {
    for (const m of ['claude-fable-5', 'claude-mythos-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5']) {
      expect(anthropicVisionProfile(m).tier).toBe('high-res');
    }
    // aliases / variant tags tier with their base
    expect(anthropicVisionProfile('claude-fable-5-high').tier).toBe('high-res');
    expect(anthropicVisionProfile('claude-opus-4-8[1m]').tier).toBe('high-res');
    expect(anthropicVisionProfile('claude-fable-5')).toEqual({ tier: 'high-res', maxLongEdge: 2576, maxVisualTokens: 4784 });
  });

  it('falls back to the conservative standard 1568/1568 tier otherwise', () => {
    for (const m of ['claude-opus-4-5', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-3-5-sonnet', '', undefined, null]) {
      expect(anthropicVisionProfile(m as string).tier).toBe('standard');
    }
    expect(anthropicVisionProfile('claude-opus-4-5')).toEqual({ tier: 'standard', maxLongEdge: 1568, maxVisualTokens: 1568 });
  });
});

// Independent translation of Anthropic's documented resize + patch count, used
// as the oracle for the property test below. Kept separate from the production
// code so a future edit to one is caught by the other.
function refVisionTokens(maxEdge: number, maxTok: number, W: number, H: number): number {
  const pt = (w: number, h: number): number => Math.ceil(w / 28) * Math.ceil(h / 28);
  const fits = (w: number, h: number): boolean =>
    Math.ceil(w / 28) * 28 <= maxEdge && Math.ceil(h / 28) * 28 <= maxEdge && pt(w, h) <= maxTok;
  const resize = (w: number, h: number): [number, number] => {
    if (fits(w, h)) return [w, h];
    if (h > w) { const [rh, rw] = resize(h, w); return [rw, rh]; }
    const a = h / w;
    let lo = 1, hi = w, best = 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (fits(m, Math.max(1, Math.round(m * a)))) { best = m; lo = m + 1; } else hi = m - 1;
    }
    return [best, Math.max(1, Math.round(best * a))];
  };
  const [rw, rh] = resize(Math.max(1, Math.floor(W)), Math.max(1, Math.floor(H)));
  return pt(rw, rh);
}

const STD = 'claude-opus-4-5'; // standard tier: 1568 / 1568
const HI = 'claude-fable-5'; // high-res tier: 2576 / 4784

describe('anthropicVisionTokens — documented cost with resize', () => {
  it('reproduces Anthropic\'s worked cost table on both tiers', () => {
    const rows: Array<[string, number, number, number, number]> = [
      // model, w, h, standard, high-res
      [STD, 200, 200, 64, 64], [STD, 1000, 1000, 1296, 1296], [STD, 1092, 1092, 1521, 1521],
      [STD, 1920, 1080, 1560, 2691], [STD, 2000, 1500, 1564, 3888], [STD, 3840, 2160, 1560, 4784],
    ];
    for (const [, w, h, std, hi] of rows) {
      expect(anthropicVisionTokens(STD, w, h), `${w}x${h} standard`).toBe(std);
      expect(anthropicVisionTokens(HI, w, h), `${w}x${h} high-res`).toBe(hi);
    }
  });

  it('is exact on extreme aspect ratios (where a continuous scale would drift)', () => {
    // These caught the old sqrt/decrement approximation (it gave 1008 / 896 / 1504).
    expect(anthropicVisionTokens(STD, 2510, 7800)).toBe(1064);
    expect(anthropicVisionTokens(STD, 1194, 4171)).toBe(952);
    expect(anthropicVisionTokens(STD, 2384, 1625)).toBe(1551);
  });

  it('charges the raw patch count when the image already fits', () => {
    // pxpipe's full dense page (1568×728) fits BOTH tiers unchanged.
    expect(anthropicVisionTokens(HI, 1568, 728)).toBe(1456);
    expect(anthropicVisionTokens(STD, 1568, 728)).toBe(1456);
    // High-res leaves 1928² and 1568² unchanged; standard shrinks them to 1521.
    expect(anthropicVisionTokens(HI, 1928, 1928)).toBe(4761);
    expect(anthropicVisionTokens(HI, 1568, 1568)).toBe(3136);
    expect(anthropicVisionTokens(STD, 1568, 1568)).toBe(1521);
    expect(anthropicVisionTokens(STD, 1928, 1928)).toBe(1521);
  });

  it('never exceeds the tier visual-token budget', () => {
    for (const [w, h] of [[8000, 8000], [4000, 500], [500, 4000], [7680, 1080]] as const) {
      expect(anthropicVisionTokens(HI, w, h)).toBeLessThanOrEqual(4784);
      expect(anthropicVisionTokens(STD, w, h)).toBeLessThanOrEqual(1568);
    }
  });

  it('equals the independent reference across a spread of sizes and aspects', () => {
    // Deterministic LCG — no Math.random, reproducible.
    let seed = 0x9e3779b9;
    const next = (n: number): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n) + 1;
    for (let i = 0; i < 400; i++) {
      const w = next(9000);
      const h = next(9000);
      expect(anthropicVisionTokens(STD, w, h), `std ${w}x${h}`).toBe(refVisionTokens(1568, 1568, w, h));
      expect(anthropicVisionTokens(HI, w, h), `hi ${w}x${h}`).toBe(refVisionTokens(2576, 4784, w, h));
    }
  });

  it('is below the retired w×h/750 approximation for the standard-tier page', () => {
    const legacy750 = Math.ceil((1568 * 728) / 750); // 1522
    expect(anthropicVisionTokens(HI, 1568, 728)).toBeLessThan(legacy750);
  });
});
