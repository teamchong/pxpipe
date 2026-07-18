import { describe, it, expect } from 'vitest';
import {
  computeBaselineInputEff,
  computeBaselineInputEffWithCacheTier,
  computeActualInputEff,
  computeActualInputEffWithCacheTier,
  deriveBaselineWarmth,
  CACHE_CREATE_RATE,
  CACHE_READ_RATE,
  CACHE_TTL_SEC,
} from '../src/core/baseline.js';

/**
 * The text counterfactual must be warmth-aware. The old warmth-free version
 * always priced the cacheable prefix at the cheap read rate, which fabricated a
 * "free read" on cold/TTL-expiry turns — text would actually re-create the
 * prefix there, same as the imaged path. That phantom read showed up as a
 * dashboard loss on growth/cold turns even when imaging genuinely won.
 */
describe('computeBaselineInputEff (warmth-aware)', () => {
  const inp = 1000;
  const cc = 0;
  const cr = 0;

  it('credits nothing (returns actual) when the probe could not split the prefix', () => {
    const actual = computeActualInputEff(inp, cc, cr);
    expect(computeBaselineInputEff(5000, 0, inp, cc, cr, true, 0)).toBe(actual);
    expect(computeBaselineInputEff(5000, -1, inp, cc, cr, false, 0)).toBe(actual);
  });

  it('returns 0 for a non-positive baseline', () => {
    expect(computeBaselineInputEff(0, 100, inp, cc, cr)).toBe(0);
    expect(computeBaselineInputEff(-10, 100, inp, cc, cr)).toBe(0);
  });

  it('cold turn re-creates the whole cacheable prefix at the create rate', () => {
    // baseline=5000, cacheable=4000, coldTail=1000. No warm cache for text.
    const got = computeBaselineInputEff(5000, 4000, inp, cc, cr, false, 0);
    expect(got).toBe(4000 * CACHE_CREATE_RATE + 1000 * 1.0);
  });

  it('defaults to the cold (warmth-free) path when warm is omitted', () => {
    const explicit = computeBaselineInputEff(5000, 4000, inp, cc, cr, false, 0);
    const defaulted = computeBaselineInputEff(5000, 4000, inp, cc, cr);
    expect(defaulted).toBe(explicit);
  });

  it('warm turn reads the prefix it already had cached at the read rate', () => {
    // Same prefix size as last turn: fully reused, nothing grown.
    const got = computeBaselineInputEff(5000, 4000, inp, cc, cr, true, 4000);
    expect(got).toBe(4000 * CACHE_READ_RATE + 1000 * 1.0);
  });

  it('warm growth turn reads the reused prefix and creates only the growth', () => {
    // prev cached 3000, prefix grew to 4000: reused=3000, grown=1000.
    const got = computeBaselineInputEff(5000, 4000, inp, cc, cr, true, 3000);
    expect(got).toBe(3000 * CACHE_READ_RATE + 1000 * CACHE_CREATE_RATE + 1000 * 1.0);
  });

  it('caps reused at the current cacheable when the prefix shrank', () => {
    // prev cached 9000 but prefix is now 4000: reused=4000, grown=0.
    const got = computeBaselineInputEff(5000, 4000, inp, cc, cr, true, 9000);
    expect(got).toBe(4000 * CACHE_READ_RATE + 1000 * 1.0);
  });

  it('never prices a cold turn cheaper than a warm turn for the same prefix', () => {
    // The regression guard: cold must cost MORE than warm (no phantom free read).
    const cold = computeBaselineInputEff(5000, 4000, inp, cc, cr, false, 0);
    const warm = computeBaselineInputEff(5000, 4000, inp, cc, cr, true, 4000);
    expect(cold).toBeGreaterThan(warm);
  });

  it('prices server-reported 1-hour cache writes at 2x on both sides', () => {
    const actual = computeActualInputEffWithCacheTier(1000, 4000, 0, 4000);
    const baseline = computeBaselineInputEffWithCacheTier(5000, 4000, 1000, 4000, 0, false, 0, 4000);
    expect(actual).toBe(1000 + 4000 * 2);
    expect(baseline).toBe(4000 * 2 + 1000);
  });

  it('uses the observed weighted rate for mixed 5-minute and 1-hour writes', () => {
    const actual = computeActualInputEffWithCacheTier(1000, 4000, 0, 1000, 3000);
    const baseline = computeBaselineInputEffWithCacheTier(
      5000, 4000, 1000, 4000, 0, false, 0, 1000, 3000,
    );
    expect(actual).toBe(1000 + 3000 * 1.25 + 1000 * 2);
    expect(baseline).toBe(1000 + 4000 * ((3000 * 1.25 + 1000 * 2) / 4000));
  });

  it('preserves zero savings on a probe miss with 1-hour writes', () => {
    const actual = computeActualInputEffWithCacheTier(1000, 4000, 0, 4000, 0);
    const baseline = computeBaselineInputEffWithCacheTier(
      5000, 0, 1000, 4000, 0, false, 0, 4000, 0,
    );
    expect(baseline).toBe(actual);
  });

  it('uses both reported tiers and normalizes a mismatched split to aggregate writes', () => {
    const actual = computeActualInputEffWithCacheTier(0, 4000, 0, 1000, 1000);
    expect(actual).toBe(4000 * ((1000 * 1.25 + 1000 * 2) / 2000));
  });
});

/**
 * deriveBaselineWarmth decides WHEN the text counterfactual was warm. The rule
 * is server-observed: text is warm iff the actual request reported cr>0. A prior
 * completed turn can refine reused-vs-grown prefix size after cr has proved a
 * warm read, but it never makes a cr===0 row warm by itself.
 */
describe('deriveBaselineWarmth (server-observed: cr>0 only)', () => {
  const prev = (ts: number, cacheable: number, prefixSha?: string) => ({
    ts,
    cacheable,
    ...(prefixSha !== undefined ? { prefixSha } : {}),
  });

  it('cold when there is no prior and no observed read', () => {
    expect(deriveBaselineWarmth(undefined, 1000, 5000, 0)).toEqual({ warm: false, prevCacheable: 0 });
  });

  it('warm via cr>0 even with no prior (session warmed before this process booted)', () => {
    // The first TRACKED turn of an already-warm session: no in-memory prior, but
    // cr>0 proves the cache was warm (post-restart / SESSION_CAP-eviction rescue).
    // Assume full reuse (prevCacheable=cacheable) — cr proves a read, not its split.
    expect(deriveBaselineWarmth(undefined, 1000, 5000, 100)).toEqual({ warm: true, prevCacheable: 5000 });
  });

  it('keeps text cold when cr===0 even with a fresh prior', () => {
    // The text path is hypothetical. Without a server-observed read on the real
    // request, do not claim the text counterfactual would have read cache.
    expect(deriveBaselineWarmth(prev(1000, 8000), 1060, 5000, 0)).toEqual({
      warm: false,
      prevCacheable: 0,
    });
  });

  it('observed read is warm even when the prior hash cannot refine the split', () => {
    expect(deriveBaselineWarmth(prev(1000, 8000, 'old'), 1060, 5000, 10, CACHE_TTL_SEC, 'new')).toEqual({
      warm: true,
      prevCacheable: 5000,
    });
  });

  it('uses a matching fresh prior only to refine the warm reused/grown split', () => {
    expect(deriveBaselineWarmth(prev(1000, 8000, 'same'), 1060, 5000, 10, CACHE_TTL_SEC, 'same')).toEqual({
      warm: true,
      prevCacheable: 8000,
    });
  });

  it('cold once the prior is older than the TTL (genuine expiry) and no observed read', () => {
    expect(deriveBaselineWarmth(prev(1000, 8000), 1000 + CACHE_TTL_SEC + 1, 5000, 0)).toEqual({
      warm: false,
      prevCacheable: 0,
    });
  });

  it('a fresh prior gives the real prior prefix size; cr-only warmth assumes full reuse', () => {
    // observed read + fresh prior → prevCacheable = prev.cacheable (real reused/grown split)
    expect(deriveBaselineWarmth(prev(1000, 3000), 1100, 5000, 50).prevCacheable).toBe(3000);
    // warm via cr but stale prior → full-reuse assumption (prevCacheable = cacheable)
    expect(deriveBaselineWarmth(prev(0, 3000), 1_000_000, 5000, 50).prevCacheable).toBe(5000);
  });

  it('ignores a prior with a future/negative age (clock skew) — needs cr to be warm', () => {
    expect(deriveBaselineWarmth(prev(2000, 8000), 1000, 5000, 0).warm).toBe(false);
    expect(deriveBaselineWarmth(prev(2000, 8000), 1000, 5000, 9).warm).toBe(true);
  });

  it('warm is the conservative direction: it never raises the baseline vs cold', () => {
    // Whichever way warmth resolves, pricing warm must not claim MORE savings
    // than cold for the same prefix (warm lowers, or holds, the baseline).
    const cacheable = 4000;
    const { warm, prevCacheable } = deriveBaselineWarmth(prev(1000, 4000), 1100, cacheable, 50);
    // inp/cc/cr only feed the probe-miss branch (cacheable>0 here ⇒ unused).
    const warmEff = computeBaselineInputEff(5000, cacheable, 0, 0, 0, warm, prevCacheable);
    const coldEff = computeBaselineInputEff(5000, cacheable, 0, 0, 0, false, 0);
    expect(warmEff).toBeLessThanOrEqual(coldEff);
  });
});
