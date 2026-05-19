/**
 * Regression tests for DashboardState.fitCosts() — the empirical
 * α (chars/token) + β (pixels/token) regression that powers honest
 * `saved_pct` in the live dashboard.
 *
 * Specifically locks in: warm-cache-hit requests MUST seed the fit ring.
 * Anthropic's tokenizer is deterministic on input bytes; cache state
 * changes billing, not token count. An earlier version of the gate
 * required `cache_read === 0` ("true cold miss") which locked the fit
 * out of all normal traffic — these tests prevent that regression.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DashboardState } from '../src/dashboard.js';
import type { SessionsPaths } from '../src/sessions.js';
import type { ProxyEvent } from '../src/core/proxy.js';

function makeTmp(): SessionsPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpipe-fit-'));
  return {
    eventsFile: path.join(dir, 'events.jsonl'),
    sidecarDir: path.join(dir, '4xx-bodies'),
  };
}

/** Build a synthetic ProxyEvent at the level fitCosts cares about. The
 *  numbers are toy — what matters for the gate is shape (compressed, full
 *  usage triple, both new measurements present, totalTokens > 1000). */
function ev(args: {
  textChars: number;
  pixels: number;
  input: number;
  cacheCreate: number;
  cacheRead: number;
}): ProxyEvent {
  return {
    method: 'POST',
    path: '/v1/messages',
    status: 200,
    durationMs: 100,
    info: {
      compressed: true,
      origChars: args.textChars + 50_000,
      compressedChars: 50_000,
      imageCount: 5,
      imageBytes: 200_000,
      imagePixels: args.pixels,
      outgoingTextChars: args.textChars,
      staticChars: 30_000,
      dynamicChars: 200,
      dynamicBlockCount: 1,
    },
    usage: {
      input_tokens: args.input,
      output_tokens: 50,
      cache_creation_input_tokens: args.cacheCreate,
      cache_read_input_tokens: args.cacheRead,
    },
  };
}

let dash: DashboardState;
beforeEach(() => {
  // Tmp paths so the fit-ring isn't seeded from any real history.
  const tmp = makeTmp();
  dash = new DashboardState(tmp, async () => new Map());
});

describe('DashboardState.fitCosts() — empirical α/β regression', () => {
  it('returns null with fewer than 3 samples', () => {
    dash.update(ev({ textChars: 130_000, pixels: 21_000_000, input: 10, cacheCreate: 5_000, cacheRead: 0 }));
    dash.update(ev({ textChars: 132_000, pixels: 23_000_000, input: 10, cacheCreate: 0, cacheRead: 130_000 }));
    expect(dash.fitCosts()).toBeNull();
  });

  it('falls back to constrained (β pinned) when pixels column is constant', () => {
    // Single-session-style traffic: cached image is identical across warm
    // hits → `pixels` is collinear. Joint OLS can't split α and β so we
    // fall back to β = 1/750 (Anthropic's published rate) and solve α only
    // from the text-vs-(tokens - β·pixels) residuals. The headline number
    // still has a measured α; only β leans on docs.
    // Text varies enough (CV > 5%) to pass the α-identification gate, but
    // pixels are pinned to the same cached-image area so β can't be measured.
    dash.update(ev({ textChars:  80_000, pixels: 21_000_000, input: 5, cacheCreate: 500, cacheRead:  50_000 }));
    dash.update(ev({ textChars: 130_000, pixels: 21_000_000, input: 5, cacheCreate: 300, cacheRead:  80_000 }));
    dash.update(ev({ textChars: 180_000, pixels: 21_000_000, input: 5, cacheCreate: 200, cacheRead: 110_000 }));
    const fit = dash.fitCosts();
    expect(fit).not.toBeNull();
    expect(fit!.mode).toBe('constrained');
    // β is pinned to Anthropic's 1/750 ≈ 0.001333 (rounded to 3 sig figs).
    expect(fit!.beta).toBeCloseTo(0.001, 3);
    expect(fit!.pixels_per_token).toBe(750);
    // α is measured — should be positive and recover a sensible chars/token.
    expect(fit!.alpha).toBeGreaterThan(0);
    expect(fit!.chars_per_token).toBeGreaterThan(0);
    expect(fit!.n).toBe(3);
  });

  it('returns null when text_chars column is constant', () => {
    // Mirror case — same body shape across samples, only cache state varies.
    // Without text variance, α is unidentifiable.
    dash.update(ev({ textChars: 130_000, pixels: 21_000_000, input: 5, cacheCreate: 500, cacheRead: 141_680 }));
    dash.update(ev({ textChars: 130_000, pixels: 23_000_000, input: 5, cacheCreate: 300, cacheRead: 142_447 }));
    dash.update(ev({ textChars: 130_000, pixels: 25_000_000, input: 5, cacheCreate: 200, cacheRead: 143_119 }));
    expect(dash.fitCosts()).toBeNull();
  });

  it('returns mode="joint" when both columns vary (full empirical fit)', () => {
    // Both columns vary > 5% — joint OLS is identifiable. mode tags the
    // headline number as fully empirical so the operator can distinguish
    // this from a constrained-β regime in the dashboard label.
    dash.update(ev({ textChars: 100_000, pixels: 10_000_000, input: 5, cacheCreate: 500, cacheRead:  43_095 }));
    dash.update(ev({ textChars: 130_000, pixels: 18_000_000, input: 5, cacheCreate: 300, cacheRead:  63_875 }));
    dash.update(ev({ textChars: 160_000, pixels: 24_000_000, input: 5, cacheCreate: 200, cacheRead:  81_555 }));
    const fit = dash.fitCosts();
    expect(fit).not.toBeNull();
    expect(fit!.mode).toBe('joint');
  });

  it('activates the fit when BOTH columns vary > 5% (cross-session-style samples)', () => {
    // Synthetic data with α ≈ 0.286 (3.5 chars/tok), β ≈ 1.5e-3 (650 px/tok).
    // Both columns vary > 5% — coefficient of variation guard passes.
    //   sample 1: 100k text, 10M px → 0.286*100k + 1.5e-3*10M = 43,600
    //   sample 2: 130k text, 18M px → 0.286*130k + 1.5e-3*18M = 64,180
    //   sample 3: 160k text, 24M px → 0.286*160k + 1.5e-3*24M = 81,760
    dash.update(ev({ textChars: 100_000, pixels: 10_000_000, input: 5, cacheCreate: 500, cacheRead:  43_095 }));
    dash.update(ev({ textChars: 130_000, pixels: 18_000_000, input: 5, cacheCreate: 300, cacheRead:  63_875 }));
    dash.update(ev({ textChars: 160_000, pixels: 24_000_000, input: 5, cacheCreate: 200, cacheRead:  81_555 }));

    const fit = dash.fitCosts();
    expect(fit).not.toBeNull();
    expect(fit!.n).toBe(3);
    // With well-conditioned data, α and β recover to within ~10% of construction.
    expect(fit!.chars_per_token).toBeGreaterThan(3);
    expect(fit!.chars_per_token).toBeLessThan(4);
    expect(fit!.beta).toBeGreaterThan(0.001);
    expect(fit!.beta).toBeLessThan(0.002);
  });

  it('uses input + cache_create + cache_read as the LHS (full body tokenization)', () => {
    // Two requests with IDENTICAL body shape but different cache splits:
    // one fully cold, one fully warm. The fit's LHS must treat them as the
    // same token cost. Sneak in a third sample with varying text + pixels
    // to make the design matrix well-conditioned (pass the CV guard).
    dash.update(ev({ textChars: 130_000, pixels: 18_000_000, input: 0,  cacheCreate: 63_875, cacheRead: 0 }));
    dash.update(ev({ textChars: 130_000, pixels: 18_000_000, input: 0,  cacheCreate: 0,      cacheRead: 63_875 }));
    dash.update(ev({ textChars: 160_000, pixels: 24_000_000, input: 0,  cacheCreate: 0,      cacheRead: 81_555 }));

    const fit = dash.fitCosts();
    expect(fit).not.toBeNull();
    expect(fit!.chars_per_token).toBeGreaterThan(2);
    expect(fit!.chars_per_token).toBeLessThan(6);
  });

  it('skips requests below the 1000-token floor (filters trivial no-system traffic)', () => {
    // total_tokens = input + cc + cr = 200 + 50 + 100 = 350 < 1000 → not sampled.
    dash.update(ev({ textChars: 500, pixels: 200_000, input: 200, cacheCreate: 50,  cacheRead: 100 }));
    dash.update(ev({ textChars: 600, pixels: 200_000, input: 200, cacheCreate: 50,  cacheRead: 100 }));
    dash.update(ev({ textChars: 700, pixels: 200_000, input: 200, cacheCreate: 50,  cacheRead: 100 }));
    expect(dash.fitCosts()).toBeNull();
  });

  it('skips passthrough (compressed=false) requests', () => {
    const passthroughEvent = (textChars: number): ProxyEvent => ({
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      durationMs: 50,
      info: {
        compressed: false,
        origChars: textChars,
        compressedChars: 0,
        imageCount: 0,
        imageBytes: 0,
        imagePixels: 0,
        outgoingTextChars: textChars,
        staticChars: 0,
        dynamicChars: 0,
        dynamicBlockCount: 0,
        reason: 'below_threshold',
      },
      usage: {
        input_tokens: 0,
        output_tokens: 10,
        cache_creation_input_tokens: 50_000,
        cache_read_input_tokens: 100_000,
      },
    });
    dash.update(passthroughEvent(130_000));
    dash.update(passthroughEvent(132_000));
    dash.update(passthroughEvent(134_000));
    expect(dash.fitCosts()).toBeNull();
  });
});
