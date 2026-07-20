/**
 * Adaptive chars-per-token (CPT) — the fit.
 *
 * The profitability gate compares `imageTokens` (exact, from pixel area) against
 * `textTokens = chars / CPT`. CPT was a hand-tuned constant per call site (4 for
 * reminders/tool_results, 2.0 for slab/history). Production telemetry showed the
 * real marginal density is ~1.5 for dense content, so the constant under-counted
 * text cost and biased the gate toward passthrough — leaving savings on the table.
 *
 * This module learns CPT from the events pxpipe already logs. Model: a request's
 * TEXT token cost decomposes into a per-bucket marginal rate times that bucket's
 * char count,
 *
 *     textTokens ≈ Σ_b α_b · chars_b        with     CPT_b = 1 / α_b
 *
 * where `textTokens` is the observed `baseline_tokens` (a free count_tokens probe
 * on the ORIGINAL uncompressed body) minus the image cost, priced off Anthropic's
 * 28×28-patch grid (see `PIXELS_PER_VISUAL_TOKEN` in `src/cpt-store.ts`, which
 * builds the samples). Solved by ordinary least squares
 * via the normal equations `α = (XᵀX)⁻¹ Xᵀy`. XᵀX is at most 6×6, so a hand-rolled
 * Gauss-Jordan inverse is microseconds and needs no dependency.
 *
 * Pure math — no `fs`, no `process`, no `Buffer`. Safe to import from the Workers
 * build. Reading the event log and persisting state is `src/cpt-store.ts` (Node).
 *
 * The fit is deliberately conservative: every guard below fails a bucket CLOSED
 * (back to the baked constant) rather than open. A wrong learned CPT would make
 * the gate image unprofitably, which costs real money; a missing one just returns
 * today's behavior.
 */

import type { BucketName } from './transform.js';

/** Column order for the design matrix. Stable + explicit so a fit is reproducible. */
export const CPT_BUCKETS: readonly BucketName[] = [
  'static_slab',
  'reminder',
  'tool_result_json',
  'tool_result_log',
  'tool_result_prose',
  'history',
];

/** Minimum events before any fit is trusted. Below this, a slope is noise. */
export const MIN_SAMPLES = 20;
/** A bucket must actually appear this many times to get its own column;
 *  an all-but-empty column makes XᵀX singular and the slope meaningless. */
export const MIN_BUCKET_PRESENCE = 8;
/** Plausible CPT band. Real content runs ~1.2 (dense JSON) to ~4 (prose);
 *  anything outside this is a fit artifact, not a measurement. */
export const CPT_PLAUSIBLE_MIN = 0.8;
export const CPT_PLAUSIBLE_MAX = 6.0;
/** Reject the whole fit above this pivot ratio — the buckets are too collinear
 *  to separate (e.g. reminders that always grow with tool_results). */
export const MAX_CONDITION = 1e8;

/** One request's regressors + target. */
export interface CptSample {
  /** Pre-compression TEXT chars per bucket (the logged `bucket_chars`). */
  bucketChars: Partial<Record<BucketName, number>>;
  /** Observed text tokens: `baseline_tokens − imagePixels / 750`. */
  textTokens: number;
}

export interface CptFitResult {
  /** Learned chars-per-token, per bucket. Absent = use the baked default. */
  cpt: Partial<Record<BucketName, number>>;
  nSamples: number;
  /** Why each bucket was NOT learned. Surfaced so a null result is explainable. */
  rejected: Partial<Record<BucketName, string>>;
  /** Pivot ratio of XᵀX. Higher = less trustworthy; > MAX_CONDITION rejects. */
  conditionEstimate: number;
  /** Buckets that got a column in this fit. */
  active: BucketName[];
}

/**
 * Invert a square matrix by Gauss-Jordan elimination with partial pivoting.
 * Returns `null` when the matrix is singular. `condition` is the ratio of the
 * largest to smallest pivot — a cheap stand-in for the true condition number,
 * good enough to detect "these columns are not independent".
 */
function invertMatrix(src: readonly number[][]): { inv: number[][]; condition: number } | null {
  const n = src.length;
  if (n === 0) return null;
  // Augment [A | I] and reduce the left half to identity.
  const a: number[][] = src.map((row, i) => {
    const aug = new Array<number>(2 * n).fill(0);
    for (let j = 0; j < n; j++) aug[j] = row[j] ?? 0;
    aug[n + i] = 1;
    return aug;
  });

  let minPivot = Infinity;
  let maxPivot = 0;

  for (let col = 0; col < n; col++) {
    let best = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r]![col]!) > Math.abs(a[best]![col]!)) best = r;
    }
    const pivot = Math.abs(a[best]![col]!);
    if (!Number.isFinite(pivot) || pivot === 0) return null;
    minPivot = Math.min(minPivot, pivot);
    maxPivot = Math.max(maxPivot, pivot);

    if (best !== col) {
      const tmp = a[best]!;
      a[best] = a[col]!;
      a[col] = tmp;
    }

    const d = a[col]![col]!;
    for (let j = 0; j < 2 * n; j++) a[col]![j] = a[col]![j]! / d;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r]![col]!;
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[r]![j] = a[r]![j]! - f * a[col]![j]!;
    }
  }

  const inv = a.map((row) => row.slice(n));
  return { inv, condition: minPivot > 0 ? maxPivot / minPivot : Infinity };
}

/** Reject every bucket with one reason. Used for the whole-fit bailouts. */
function rejectAll(reason: string): Partial<Record<BucketName, string>> {
  const out: Partial<Record<BucketName, string>> = {};
  for (const b of CPT_BUCKETS) out[b] = reason;
  return out;
}

/**
 * Fit per-bucket CPT from samples. Never throws; a fit it cannot trust comes back
 * with an empty `cpt` and a populated `rejected` explaining why.
 */
export function fitCpt(samples: readonly CptSample[]): CptFitResult {
  const n = samples.length;
  if (n < MIN_SAMPLES) {
    return {
      cpt: {},
      nSamples: n,
      rejected: rejectAll(`n=${n} < MIN_SAMPLES=${MIN_SAMPLES}`),
      conditionEstimate: Infinity,
      active: [],
    };
  }

  const rejected: Partial<Record<BucketName, string>> = {};

  // Only give a column to buckets that actually show up. An all-zero (or
  // nearly-all-zero) column is exactly collinear with nothing and makes the
  // normal equations singular.
  const active: BucketName[] = [];
  for (const b of CPT_BUCKETS) {
    let present = 0;
    for (const s of samples) if ((s.bucketChars[b] ?? 0) > 0) present++;
    if (present < MIN_BUCKET_PRESENCE) {
      rejected[b] = `present in ${present}/${n} samples < ${MIN_BUCKET_PRESENCE}`;
    } else {
      active.push(b);
    }
  }
  if (active.length === 0) {
    return { cpt: {}, nSamples: n, rejected, conditionEstimate: Infinity, active };
  }

  // Accumulate XᵀX and Xᵀy in one pass.
  const k = active.length;
  const xtx: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty = new Array<number>(k).fill(0);
  for (const s of samples) {
    if (!Number.isFinite(s.textTokens)) continue;
    const row = new Array<number>(k);
    for (let i = 0; i < k; i++) row[i] = s.bucketChars[active[i]!] ?? 0;
    for (let i = 0; i < k; i++) {
      const ri = row[i]!;
      xty[i] = xty[i]! + ri * s.textTokens;
      for (let j = 0; j < k; j++) xtx[i]![j] = xtx[i]![j]! + ri * row[j]!;
    }
  }

  const inverted = invertMatrix(xtx);
  if (!inverted) {
    for (const b of active) rejected[b] = 'singular XᵀX (collinear buckets)';
    return { cpt: {}, nSamples: n, rejected, conditionEstimate: Infinity, active };
  }
  if (inverted.condition > MAX_CONDITION) {
    for (const b of active) {
      rejected[b] = `ill-conditioned (${inverted.condition.toExponential(1)} > ${MAX_CONDITION.toExponential(0)})`;
    }
    return { cpt: {}, nSamples: n, rejected, conditionEstimate: inverted.condition, active };
  }

  // α = (XᵀX)⁻¹ Xᵀy, then CPT = 1/α with a plausibility band.
  const cpt: Partial<Record<BucketName, number>> = {};
  for (let i = 0; i < k; i++) {
    const bucket = active[i]!;
    let alpha = 0;
    for (let j = 0; j < k; j++) alpha += inverted.inv[i]![j]! * xty[j]!;

    if (!Number.isFinite(alpha) || alpha <= 0) {
      rejected[bucket] = `non-positive slope (${Number.isFinite(alpha) ? alpha.toExponential(2) : 'NaN'})`;
      continue;
    }
    const value = 1 / alpha;
    if (value < CPT_PLAUSIBLE_MIN || value > CPT_PLAUSIBLE_MAX) {
      rejected[bucket] =
        `cpt ${value.toFixed(2)} outside [${CPT_PLAUSIBLE_MIN}, ${CPT_PLAUSIBLE_MAX}]`;
      continue;
    }
    cpt[bucket] = value;
  }

  return { cpt, nSamples: n, rejected, conditionEstimate: inverted.condition, active };
}
