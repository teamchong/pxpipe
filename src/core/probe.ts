/**
 * D11 — passive post-transform count_tokens probe.
 *
 * The PRE-transform baseline probe (proxy.ts `baselinePromise`/`baselineCacheablePromise`)
 * already runs on EVERY `/v1/messages` request — count_tokens is a free (unbilled)
 * endpoint, so there's no cost concern there. This module is the OTHER half: an
 * optional POST-transform count_tokens call, sampled at PXPIPE_PROBE_RATE (default 0,
 * i.e. off) because the real post-transform token count already comes back for free in
 * the response's `usage.input_tokens` — this probe exists only to calibrate
 * count_tokens' *estimate* against that real number on a sampled slice of traffic
 * (dashboard math, not billing). It must never affect the live request: fire-and-forget,
 * never awaited on the hot path before the response is sent to the client, and any
 * failure degrades silently (debug log + null).
 */

import { buildBaselineCountTokensBody } from './measurement.js';

/** Same shape as proxy.ts's `countTokensUpstream` — injected so this module never
 *  duplicates fetch/auth logic or creates a circular import with proxy.ts. */
export type CountTokensFn = (
  url: string,
  body: Uint8Array,
  headers: Headers,
) => Promise<number | null>;

/** Parse PXPIPE_PROBE_RATE into a sampling rate clamped to [0, 1].
 *  Unset / empty / non-numeric / <=0 → 0 (off, matches the documented default). */
export function parseProbeRate(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const trimmed = raw.trim();
  if (trimmed === '') return 0;
  const n = Number.parseFloat(trimmed);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n >= 1 ? 1 : n;
}

/** Read PXPIPE_PROBE_RATE directly — guarded the same way as
 *  gpt-model-profiles.ts's envProfiles() so this works on both Node and Workers. */
export function probeRateFromEnv(): number {
  const raw = typeof process !== 'undefined' && process.env
    ? process.env.PXPIPE_PROBE_RATE
    : undefined;
  return parseProbeRate(raw);
}

/** Sample decision for a single request. rate<=0 never samples; rate>=1 always samples. */
export function shouldSample(rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return Math.random() < rate;
}

/**
 * Run the POST-transform count_tokens probe for one sampled request.
 * Builds the count_tokens-accepted body from the already-transformed bytes
 * (same field-filtering `buildBaselineCountTokensBody` uses for the PRE-transform
 * probe — no new builder needed) and delegates the actual fetch to `countTokensFn`.
 * Never throws: any failure (unbuildable body, upstream error) resolves to null
 * after a debug-level log, so a probe outage has zero effect on client traffic.
 */
export async function runPostTransformProbe(params: {
  ctUrl: string;
  ctHeaders: Headers;
  postBody: Uint8Array;
  countTokensFn: CountTokensFn;
}): Promise<number | null> {
  const { ctUrl, ctHeaders, postBody, countTokensFn } = params;
  try {
    const ctBody = buildBaselineCountTokensBody(postBody);
    if (!ctBody) return null;
    return await countTokensFn(ctUrl, ctBody, ctHeaders);
  } catch (e) {
    console.debug(
      `[pxpipe] D11 post-transform probe failed (degrading silently): ${(e as Error)?.message ?? String(e)}`,
    );
    return null;
  }
}
