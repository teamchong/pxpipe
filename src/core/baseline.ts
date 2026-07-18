/**
 * Cache-aware baseline math for the unproxied counterfactual.
 * Workers-safe: no node:, no Buffer, no process.*. Pure number math.
 * See docs/CACHING_AND_SAVINGS.md for the full derivation and audit history.
 */

/** Documented Anthropic price ratios: cc_5m = 1.25×, cc_1h = 2×, cr = 0.1× base input. */
export const CACHE_CREATE_RATE = 1.25;
const CACHE_CREATE_1H_RATE = 2.0;
export const CACHE_READ_RATE = 0.1;

/** Effective cache-write rate for this request. Older usage payloads do not
 * expose the tier split; preserve the historical/conservative 5-minute rate
 * in that case. The text counterfactual uses the same observed tier mix as
 * the transformed request because pxpipe relocates, rather than invents, the
 * caller's cache-control markers. */
function cacheCreateRate(cc: number, cc5m?: number, cc1h?: number): number {
  if (!(cc > 0)) return CACHE_CREATE_RATE;
  const splitReported = cc5m !== undefined || cc1h !== undefined;
  if (!splitReported) return CACHE_CREATE_RATE;
  const fiveMinute = Math.max(0, cc5m ?? 0);
  const oneHour = Math.max(0, cc1h ?? 0);
  const splitTotal = fiveMinute + oneHour;
  if (!(splitTotal > 0)) return CACHE_CREATE_RATE;
  // The API contract says splitTotal === cc. Normalize malformed/mismatched
  // payloads to the aggregate so telemetry never invents extra write tokens.
  return (
    fiveMinute * CACHE_CREATE_RATE + oneHour * CACHE_CREATE_1H_RATE
  ) / splitTotal;
}

/** Anthropic prompt-cache TTL (seconds). Kept for callers that display provider
 *  docs, but savings math does not use TTL to infer a hypothetical text-cache
 *  hit: text is considered warm only when the actual request reports cr > 0. */
export const CACHE_TTL_SEC = 300;

/** This session's previous usage-bearing turn, used only for warm split sizing. */
export interface BaselineWarmthPrev {
  /** Completion time of that turn, in wall-clock seconds. */
  ts: number;
  /** Cacheable-prefix tokens measured that turn (0 if the probe missed). */
  cacheable: number;
  /** Hash of the image-bound/static text prefix. If it changes, do not reuse the
   *  prior prefix size for this row's text reused/grown split. */
  prefixSha?: string;
}

/**
 * Decide whether the TEXT counterfactual's prefix was warm this turn.
 *
 * Strict accounting rule: the imagined text path gets the same observed cache
 * state as the real image path. `cr > 0` is server proof that the request read a
 * warm prefix, so the text baseline is warm too. `cr === 0` means the actual
 * request did not read cache, so the text baseline is priced cold too. We do not
 * use wall-clock TTL to claim that text would have been warm while images were
 * cold; that would be an unobservable counterfactual and can create negative
 * rows from cache assumptions rather than token savings.
 *
 * When cr proves warmth, a completed same-prefix prior is used only to estimate
 * how much of the text prefix was reused vs grown. If none is available, assume
 * full reuse of this turn's cacheable prefix; this is conservative for savings.
 *
 * @param prev       this session's previous usage-bearing turn, or undefined.
 * @param nowSec     request-start wall-clock seconds, used only to reject prior
 *                   rows that had not completed before this request was sent.
 * @param cacheable  this turn's cacheable-prefix tokens (the full-reuse credit
 *                   when warm only via cr, since cr proves a read but not the split).
 * @param cr         observed cache-read tokens this turn; the only warm/cold signal.
 * @param ttlSec     legacy parameter; no longer decides warm/cold. It only
 *                   bounds whether a prior prefix size is used for reused/grown
 *                   splitting after cr > 0 has already proved warmth.
 * @param prefixSha  stable-prefix fingerprint for the text counterfactual. A
 *                   prior prefix size is reused only when this matches.
 */
export function deriveBaselineWarmth(
  prev: BaselineWarmthPrev | undefined,
  nowSec: number,
  cacheable: number,
  cr: number,
  ttlSec: number = CACHE_TTL_SEC,
  prefixSha?: string,
): { warm: boolean; prevCacheable: number } {
  const age = prev !== undefined ? nowSec - prev.ts : Number.POSITIVE_INFINITY;
  const samePrefix = prev === undefined
    || prev.prefixSha === undefined
    || prefixSha === undefined
    || prev.prefixSha === prefixSha;
  // cr is the only warm/cold signal. A prior only refines the warm split.
  if (!(cr > 0)) return { warm: false, prevCacheable: 0 };
  // Fresh prior: use its real prefix size for the reused/grown split. Without
  // one, cr proves warmth but not the split, so assume full reuse.
  const freshPrior = prev !== undefined && age >= 0 && age < ttlSec && samePrefix;
  return { warm: true, prevCacheable: freshPrior ? prev!.cacheable : cacheable };
}

/**
 * Weighted input cost for the unproxied TEXT counterfactual (see docs/CACHING_AND_SAVINGS.md).
 *
 * Warmth matters: a TEXT prefix is only a cheap cache-read when a warm cache
 * actually existed this turn. The previous warmth-FREE version always priced
 * the cacheable prefix at CACHE_READ_RATE, which fabricated a "free read" on
 * cold/TTL-expiry turns where text would in fact have paid a 1.25× create —
 * that produced a phantom loss vs the imaged path (which DOES pay the create).
 *
 *   cold turn (first turn / >5min since this session's last turn):
 *     text has no warm cache either ⇒ cacheable×CACHE_CREATE_RATE + coldTail×1.0
 *   warm turn (a prior turn cached the prefix within TTL):
 *     text append-caches ⇒ reused×CACHE_READ_RATE + grown×CACHE_CREATE_RATE + coldTail×1.0
 *     where reused = min(prevCacheable, cacheable), grown = cacheable − reused.
 *     This is what TEXT pays regardless of whether pxpipe's image busted its
 *     own cache on a growth turn — so the real growth loss is preserved.
 *
 * Saving = baseline_eff − actual_eff; can be negative (honestly reported, not floored).
 *
 * @param baselineCacheable  tokens up to the last cache_control marker. ≤0 ⇒ credit nothing.
 * @param warm               was a warm cache available for this session this turn?
 * @param prevCacheable      cacheable prefix size on this session's previous turn (warm only).
 */
export function computeBaselineInputEff(
  baseline: number,
  baselineCacheable: number,
  inputTokens: number,
  cc: number,
  cr: number,
  warm = false,
  prevCacheable = 0,
): number {
  return computeBaselineInputEffWithCacheTier(
    baseline, baselineCacheable, inputTokens, cc, cr, warm, prevCacheable, 0,
  );
}

/** Tier-aware variant for internal telemetry accounting. */
export function computeBaselineInputEffWithCacheTier(
  baseline: number,
  baselineCacheable: number,
  inputTokens: number,
  cc: number,
  cr: number,
  warm: boolean,
  prevCacheable: number,
  cacheCreate1hTokens: number,
  cacheCreate5mTokens?: number,
): number {
  if (baseline <= 0) return 0;
  // Probe miss: can't split prefix from tail, so credit nothing (same as actual).
  if (baselineCacheable <= 0) {
    return computeActualInputEffWithCacheTier(
      inputTokens, cc, cr, cacheCreate1hTokens, cacheCreate5mTokens,
    );
  }
  const cacheable = Math.min(baselineCacheable, baseline);
  const coldTail = baseline - cacheable;
  const createRate = cacheCreateRate(cc, cacheCreate5mTokens, cacheCreate1hTokens);
  if (warm) {
    // Text reads the prefix it already had cached (0.10×) and creates only the
    // growth since last turn (at the observed write-tier rate). Independent of
    // the image path's cache.
    const reused = Math.min(Math.max(prevCacheable, 0), cacheable);
    const grown = cacheable - reused;
    return reused * CACHE_READ_RATE + grown * createRate + coldTail * 1.0;
  }
  // Cold (first turn / TTL expiry): no warm cache for text either, so it
  // re-creates the whole cacheable prefix at the create rate — same event the
  // imaged path pays. Removes the phantom "free read" that fabricated a loss.
  return cacheable * createRate + coldTail * 1.0;
}

/** Weighted input cost pxpipe actually paid this turn. */
export function computeActualInputEff(
  inputTokens: number,
  cc: number,
  cr: number,
): number {
  return computeActualInputEffWithCacheTier(inputTokens, cc, cr, 0);
}

/** Tier-aware variant for internal telemetry accounting. */
export function computeActualInputEffWithCacheTier(
  inputTokens: number,
  cc: number,
  cr: number,
  cacheCreate1hTokens: number,
  cacheCreate5mTokens?: number,
): number {
  return inputTokens
    + cc * cacheCreateRate(cc, cacheCreate5mTokens, cacheCreate1hTokens)
    + cr * CACHE_READ_RATE;
}
