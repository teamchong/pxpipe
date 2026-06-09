/**
 * Cache-aware baseline math for the unproxied counterfactual.
 *
 * The whole point of the parallel count_tokens probe is to answer:
 *   "If the user had sent the ORIGINAL request (no pxpipe) on this turn,
 *    against an unproxied cache that's been built up turn-by-turn the same
 *    way, what would Anthropic have billed?"
 *
 * The naive formula collapsed the unproxied counterfactual into a single
 * cache-class weight:
 *
 *     weight = cr > 0 ? 0.10
 *            : cc > 0 ? 1.25
 *            :          1.0
 *     baseline_eff = cacheable × weight + cold_tail × 1.0
 *
 * That formula is wrong on every WARM turn that pays real cache_create.
 * When the proxied path's `cc > 0 AND cr > 0` (the new user-message tail
 * re-creates the last breakpoint while the prior turns hit), it attributes
 * 100% of the unproxied prefix to `cr × 0.10` — making the unproxied path
 * look 12.5× cheaper than reality and the proxied path look like it lost.
 *
 * Reality: the proxied path's `cc` bucket is approximately the new tail
 * (user-typed content this turn), which exists IDENTICALLY on the unproxied
 * path — we don't compress user messages. So the unproxied path on the same
 * turn would also pay roughly the same absolute `cc` tokens at 1.25×, and
 * read the rest of the prefix at 0.10×.
 *
 * Honest counterfactual:
 *   cold start    (cr === 0, cc > 0):  cc_u = cacheable,         cr_u = 0
 *   warm turn     (cr > 0):            cc_u = min(cc, cacheable), cr_u = cacheable − cc_u
 *   no caching    (cc === 0, cr === 0): cc_u = 0,                 cr_u = 0  (cacheable still pays 1.0×)
 *
 *   baseline_eff = cc_u × 1.25 + cr_u × 0.10 + (cacheable − cc_u − cr_u) × 1.0
 *                                            + cold_tail × 1.0
 *
 * Verified against the 7-event May-2026 regression: pre-fix sum = −9,786
 * "saved" tokens (every warm turn with mixed cc/cr went negative);
 * post-fix sum = +19,452 tokens, matching the per-event break-even
 * (≈ +2,780 per warm turn, identical compression delta on every row).
 *
 * Workers-safe: no node:, no Buffer, no process.*. Pure number math.
 */

/** Anthropic input-token price multipliers we use for cost-weighting.
 *  These are the documented per-token rates relative to the base input
 *  rate (cache_create_5m at 1.25×, cache_read at 0.1×). Centralized so a
 *  future rate change is a one-line edit. The 1-hour cache tier (2×) is
 *  not yet used by Claude Code's default config; we'd add a parameter
 *  here when it is. */
export const CACHE_CREATE_RATE = 1.25;
export const CACHE_READ_RATE = 0.1;

/**
 * Compute the cache-aware baseline-eff input cost for the counterfactual
 * unproxied request, given the measured cache class of THIS request.
 *
 * @param baseline           count_tokens on the ORIGINAL (pre-compression) body.
 * @param baselineCacheable  count_tokens on the original body truncated at
 *                           the last cache_control marker. 0 when no markers.
 *                           Capped at `baseline` (any overflow is rounded down).
 * @param cc                 cache_creation_input_tokens billed on the proxied path.
 * @param cr                 cache_read_input_tokens billed on the proxied path.
 *
 * Returns the weighted input-token equivalent the unproxied path would have
 * billed. Output tokens are NOT included — they're identical on both paths
 * and live in their own accumulator on the dashboard.
 */
export function computeBaselineInputEff(
  baseline: number,
  baselineCacheable: number,
  cc: number,
  cr: number,
): number {
  if (baseline <= 0) return 0;
  const cacheable = Math.max(0, Math.min(baselineCacheable, baseline));
  const coldTail = baseline - cacheable;

  let ccU: number;
  let crU: number;
  if (cr > 0) {
    // Warm turn — the unproxied path is also warm. Its cc bucket equals the
    // new-tail tokens this turn (user-typed content, NOT compressed), which
    // are approximately the same absolute number as the proxied path's cc.
    // The rest of the cacheable prefix reads at 0.10×.
    ccU = Math.min(cc, cacheable);
    crU = cacheable - ccU;
  } else if (cc > 0) {
    // Cold start (no prior cache state) — the unproxied path is also cold,
    // so its entire cacheable prefix is cache-created at 1.25×.
    ccU = cacheable;
    crU = 0;
  } else {
    // No cache activity at all on the proxied path. The marker was either
    // ignored (body below the minimum cacheable size) or absent. Both paths
    // pay the entire body at the cold 1.0× rate.
    ccU = 0;
    crU = 0;
  }

  const cacheablePaidCold = cacheable - ccU - crU;
  return (
    ccU * CACHE_CREATE_RATE
    + crU * CACHE_READ_RATE
    + cacheablePaidCold * 1.0
    + coldTail * 1.0
  );
}

/**
 * Companion: the weighted INPUT cost the proxied path actually paid this
 * turn. Centralized so all three consumers (live dashboard, JSONL replay,
 * per-session rollup) use one definition.
 */
export function computeActualInputEff(
  inputTokens: number,
  cc: number,
  cr: number,
): number {
  return inputTokens + cc * CACHE_CREATE_RATE + cr * CACHE_READ_RATE;
}
