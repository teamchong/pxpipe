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

/** Anthropic prompt-cache TTL (seconds). A same-prefix prior that completed
 *  within this window makes the text counterfactual warm even when the actual
 *  request reports cr === 0 (see deriveBaselineWarmth). */
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
  /** cache_prefix_tools_sha8 of that turn. A changed tool list busts the text
   *  prefix too; missing on either side is treated as unknown (don't care). */
  toolsSha?: string;
  /** cache_prefix_sha8 pxpipe actually sent (post-transform). */
  pxPrefixSha?: string;
  /** Model of that turn; prompt cache does not cross models. */
  model?: string;
}

/**
 * Decide whether the TEXT counterfactual's prefix was warm this turn.
 *
 * The text path is warm when either:
 *  - this session has a prior row that completed less than `ttlSec` before
 *    this request started, with the same `system_sha8` (both known) and the
 *    same tools hash (or either unknown). The text request would have read
 *    that prefix from cache even if the image path missed — pxpipe busting its
 *    own cache is a real cost of pxpipe, not something text would have paid;
 *  - or the actual request reports `cr > 0`, which is server proof of a warm read.
 *
 * Otherwise the text baseline is priced cold. When warm, reused =
 * min(prevCacheable, cacheable); without a usable prior, cr-only warmth assumes
 * full reuse of this turn's cacheable prefix, which is conservative for savings.
 *
 * @param prev       this session's previous usage-bearing turn, or undefined.
 * @param nowSec     request-start wall-clock seconds, used only to reject prior
 *                   rows that had not completed before this request was sent.
 * @param cacheable  this turn's cacheable-prefix tokens (the full-reuse credit
 *                   when warm only via cr, since cr proves a read but not the split).
 * @param cr         observed cache-read tokens this turn.
 * @param ttlSec     how recently a prior must have completed to count as fresh.
 * @param prefixSha  system_sha8 of this row. Must match the prior's for a
 *                   cr === 0 row to be warm.
 * @param toolsSha   cache_prefix_tools_sha8 of this row; a mismatch keeps the row cold.
 */
export function deriveBaselineWarmth(
  prev: BaselineWarmthPrev | undefined,
  nowSec: number,
  cacheable: number,
  cr: number,
  ttlSec: number = CACHE_TTL_SEC,
  prefixSha?: string,
  toolsSha?: string,
  opts?: { pxPrefixSha?: string; model?: string },
): { warm: boolean; prevCacheable: number } {
  const age = prev !== undefined ? nowSec - prev.ts : Number.POSITIVE_INFINITY;
  const samePrefix = prev === undefined
    || prev.prefixSha === undefined
    || prefixSha === undefined
    || prev.prefixSha === prefixSha;
  // cr is the only warm/cold signal. A prior only refines the warm split.
  const fresh = prev !== undefined && age >= 0 && age < ttlSec;
  const sameTools = prev === undefined
    || prev.toolsSha === undefined
    || toolsSha === undefined
    || prev.toolsSha === toolsSha;
  // A same-prefix prior that completed inside the TTL means the TEXT request
  // would have found its own prefix cached, even when the image path missed
  // (cr === 0 because pxpipe re-rendered and busted its own cache). Requires a
  // positive system match — an unknown system hash can't vouch for the prefix.
  const provenSystem = prev !== undefined
    && prev.prefixSha !== undefined
    && prefixSha !== undefined
    && prev.prefixSha === prefixSha;
  if (!(cr > 0)) {
    // Self-bust exception: only when pxpipe PROVABLY changed what it sent.
    //  - prompt cache is per model: a model switch means text would miss too;
    //  - the outgoing cache_prefix_sha8 must differ from the prior's. If pxpipe
    //    sent the same prefix and still got cr === 0, the server evicted it and
    //    text would have missed as well — not pxpipe's fault, not text's gain.
    const sameModel = prev?.model !== undefined
      && opts?.model !== undefined
      && prev.model === opts.model;
    const pxpipeBusted = prev?.pxPrefixSha !== undefined
      && opts?.pxPrefixSha !== undefined
      && prev.pxPrefixSha !== opts.pxPrefixSha;
    if (fresh && provenSystem && sameTools && sameModel && pxpipeBusted) {
      return { warm: true, prevCacheable: prev!.cacheable };
    }
    return { warm: false, prevCacheable: 0 };
  }
  // cr proves warmth. A fresh same-prefix prior gives the real reused/grown
  // split; without one, assume full reuse (conservative for savings).
  // (Unchanged from 0.15.0: tools hash does not gate the split.)
  const freshPrior = fresh && samePrefix;
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
