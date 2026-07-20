import { describe, expect, it } from 'vitest';
import {
  fitCpt,
  CPT_BUCKETS,
  MIN_SAMPLES,
  CPT_PLAUSIBLE_MAX,
  type CptSample,
} from '../src/core/cpt-fit.js';
import type { BucketName } from '../src/core/transform.js';

/** Build a sample whose textTokens is exactly Σ chars_b / cpt_b (noise-free). */
function synth(
  chars: Partial<Record<BucketName, number>>,
  trueCpt: Partial<Record<BucketName, number>>,
): CptSample {
  let tokens = 0;
  for (const b of CPT_BUCKETS) {
    const c = chars[b] ?? 0;
    const cpt = trueCpt[b];
    if (c > 0 && cpt) tokens += c / cpt;
  }
  return { bucketChars: chars, textTokens: tokens };
}

/** Deterministic pseudo-random so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('fitCpt', () => {
  it('recovers known CPTs from noise-free synthetic data', () => {
    const truth: Partial<Record<BucketName, number>> = {
      static_slab: 1.5,
      tool_result_json: 1.3,
      tool_result_prose: 3.6,
    };
    const r = rng(42);
    const samples: CptSample[] = [];
    for (let i = 0; i < 60; i++) {
      samples.push(
        synth(
          {
            static_slab: Math.floor(20000 + r() * 40000),
            tool_result_json: Math.floor(5000 + r() * 30000),
            tool_result_prose: Math.floor(2000 + r() * 20000),
          },
          truth,
        ),
      );
    }

    const fit = fitCpt(samples);
    expect(fit.nSamples).toBe(60);
    for (const [bucket, expected] of Object.entries(truth) as Array<[BucketName, number]>) {
      const got = fit.cpt[bucket];
      expect(got, `${bucket} rejected: ${fit.rejected[bucket]}`).toBeDefined();
      // ±5% — the fit is exact here, so this is a generous correctness bound.
      expect(Math.abs(got! - expected) / expected).toBeLessThan(0.05);
    }
  });

  it('still recovers CPTs within tolerance under mild noise', () => {
    const truth: Partial<Record<BucketName, number>> = { static_slab: 1.5, history: 1.4 };
    const r = rng(7);
    const samples: CptSample[] = [];
    for (let i = 0; i < 120; i++) {
      const s = synth(
        {
          static_slab: Math.floor(20000 + r() * 40000),
          history: Math.floor(10000 + r() * 50000),
        },
        truth,
      );
      // ±2% multiplicative noise on the observed token count.
      s.textTokens *= 1 + (r() - 0.5) * 0.04;
      samples.push(s);
    }
    const fit = fitCpt(samples);
    expect(fit.cpt.static_slab).toBeDefined();
    expect(Math.abs(fit.cpt.static_slab! - 1.5) / 1.5).toBeLessThan(0.1);
    expect(Math.abs(fit.cpt.history! - 1.4) / 1.4).toBeLessThan(0.1);
  });

  it('refuses to fit below MIN_SAMPLES and says why', () => {
    const truth = { static_slab: 1.5 };
    const samples = Array.from({ length: MIN_SAMPLES - 1 }, (_, i) =>
      synth({ static_slab: 10000 + i * 100 }, truth),
    );
    const fit = fitCpt(samples);
    expect(fit.cpt).toEqual({});
    expect(fit.rejected.static_slab).toContain('MIN_SAMPLES');
  });

  it('rejects a bucket that barely appears instead of fitting noise', () => {
    const truth: Partial<Record<BucketName, number>> = { static_slab: 1.5, reminder: 2.0 };
    const r = rng(11);
    const samples: CptSample[] = [];
    for (let i = 0; i < 40; i++) {
      // `reminder` present in only 3 of 40 samples → below MIN_BUCKET_PRESENCE.
      const chars: Partial<Record<BucketName, number>> = {
        static_slab: Math.floor(20000 + r() * 20000),
      };
      if (i < 3) chars.reminder = 7000;
      samples.push(synth(chars, truth));
    }
    const fit = fitCpt(samples);
    expect(fit.cpt.static_slab).toBeDefined();
    expect(fit.cpt.reminder).toBeUndefined();
    expect(fit.rejected.reminder).toContain('present in 3/40');
  });

  it('rejects implausible CPTs rather than handing them to the gate', () => {
    // Truth far outside the plausible band (20 chars/token) must not be adopted.
    const truth: Partial<Record<BucketName, number>> = { static_slab: 20 };
    const r = rng(3);
    const samples = Array.from({ length: 40 }, () =>
      synth({ static_slab: Math.floor(20000 + r() * 20000) }, truth),
    );
    const fit = fitCpt(samples);
    expect(fit.cpt.static_slab).toBeUndefined();
    expect(fit.rejected.static_slab).toContain('outside');
    expect(CPT_PLAUSIBLE_MAX).toBeLessThan(20);
  });

  it('rejects perfectly collinear buckets instead of inventing slopes', () => {
    // history is always exactly 2× slab → the two columns are not separable.
    const r = rng(5);
    const samples: CptSample[] = [];
    for (let i = 0; i < 40; i++) {
      const slab = Math.floor(20000 + r() * 20000);
      samples.push({
        bucketChars: { static_slab: slab, history: slab * 2 },
        textTokens: slab / 1.5 + (slab * 2) / 1.4,
      });
    }
    const fit = fitCpt(samples);
    // Either singular or ill-conditioned — both must fail closed, never emit a value.
    expect(fit.cpt.static_slab).toBeUndefined();
    expect(fit.cpt.history).toBeUndefined();
    expect(fit.rejected.static_slab).toBeTruthy();
  });

  it('never throws on degenerate input', () => {
    expect(() => fitCpt([])).not.toThrow();
    expect(fitCpt([]).cpt).toEqual({});
    const junk: CptSample[] = Array.from({ length: 30 }, () => ({
      bucketChars: { static_slab: 0 },
      textTokens: Number.NaN,
    }));
    expect(() => fitCpt(junk)).not.toThrow();
    expect(fitCpt(junk).cpt).toEqual({});
  });
});
