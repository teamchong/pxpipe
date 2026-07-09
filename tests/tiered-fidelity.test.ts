import { describe, expect, it } from 'vitest';
import {
  renderDensePages,
  renderTextToPngsWithCharLimit,
  measureContentCols,
  maxFittingCols,
  multiColWidth,
  DENSE_CONTENT_COLS,
  DENSE_CONTENT_CHARS_PER_IMAGE,
  DENSE_RENDER_STYLE,
  MAX_HEIGHT_PX,
  MAX_WIDTH_PX,
} from '../src/core/render.js';

/** Sum of width×height across a set of rendered pages — the pixel-area proxy for
 *  Anthropic's image-token billing (tokens ≈ pixels / 750; see transform.ts ANTHROPIC_PIXELS_PER_TOKEN). */
function sumPixels(imgs: { width: number; height: number }[]): number {
  return imgs.reduce((sum, img) => sum + img.width * img.height, 0);
}

describe('B5+B8 tiered fidelity + pixel minimization (renderDensePages)', () => {
  it('(a) default (no fidelity/minimizePixels) is bit-identical to the pre-tiering formula', async () => {
    // Mixed short/long lines so the shrink + page-split paths both get exercised, same as
    // real dense content (tool output / collapsed history).
    const text = Array.from({ length: 40 }, (_, i) =>
      i % 5 === 0 ? 'short' : `line ${i} — ${'payload '.repeat(20)}`,
    ).join('\n');

    const got = await renderDensePages(text);

    // Reconstruct via the exact primitives renderDensePages delegated to before this task
    // (DENSE_CONTENT_COLS / DENSE_CONTENT_CHARS_PER_IMAGE / DENSE_RENDER_STYLE, shrink-to-content,
    // single column — numCols always resolved to 1 pre-tiering for this shape of input).
    const cols = measureContentCols(text, DENSE_CONTENT_COLS);
    const want = await renderTextToPngsWithCharLimit(
      text,
      cols,
      DENSE_CONTENT_CHARS_PER_IMAGE,
      DENSE_RENDER_STYLE,
      MAX_HEIGHT_PX,
    );

    expect(got.length).toBe(want.length);
    for (let i = 0; i < got.length; i++) {
      expect(got[i]!.width).toBe(want[i]!.width);
      expect(got[i]!.height).toBe(want[i]!.height);
      expect(Buffer.from(got[i]!.png)).toEqual(Buffer.from(want[i]!.png));
    }
  });

  it('(a) default fidelity resolves to the same output as an explicit fidelity: "aged"', async () => {
    const text = 'lorem ipsum dolor sit amet\n'.repeat(50);
    const implicit = await renderDensePages(text);
    const explicit = await renderDensePages(text, { fidelity: 'aged' });
    expect(implicit.length).toBe(explicit.length);
    for (let i = 0; i < implicit.length; i++) {
      expect(Buffer.from(implicit[i]!.png)).toEqual(Buffer.from(explicit[i]!.png));
    }
  });

  it('(b) denser tiers cost ≤ pixels than fresher tiers for the same text', async () => {
    // One unbroken 5000-char line: wider than every tier's cols cap, so every tier shrinks its
    // canvas down to exactly its own max width (no per-tier shrink noise in the comparison).
    const text = 'x'.repeat(5000);

    const fresh = await renderDensePages(text, { fidelity: 'fresh' });
    const aged = await renderDensePages(text, { fidelity: 'aged' });
    const stale = await renderDensePages(text, { fidelity: 'stale' });

    const freshPx = sumPixels(fresh);
    const agedPx = sumPixels(aged);
    const stalePx = sumPixels(stale);

    // fresh (padded 7×10 cell) must cost strictly more than aged (bare 5×8) for identical content.
    expect(agedPx).toBeLessThan(freshPx);
    // stale reuses aged's exact canvas geometry (only AA differs, which is pixel-area-neutral),
    // so it must never cost MORE than aged — equality is the expected, honest outcome here.
    expect(stalePx).toBeLessThanOrEqual(agedPx);
  });

  it('(c) every fidelity preset stays within MAX_WIDTH_PX / MAX_HEIGHT_PX', async () => {
    // Long enough to force multiple pages (height cap) for every tier.
    const text = ('lorem ipsum dolor sit amet consectetur adipiscing elit\n').repeat(400);
    for (const fidelity of ['fresh', 'aged', 'stale'] as const) {
      const imgs = await renderDensePages(text, { fidelity });
      expect(imgs.length).toBeGreaterThan(1);
      for (const img of imgs) {
        expect(img.width).toBeLessThanOrEqual(MAX_WIDTH_PX);
        expect(img.height).toBeLessThanOrEqual(MAX_HEIGHT_PX);
      }
    }
  });

  it('(d) minimizePixels picks a cheaper numCols than the greedy maxFittingCols default', async () => {
    // cols=100 → maxFittingCols(100) === 3 (508 / 1028 / 1548 / 2068px; see render.test.ts's
    // own "maxFittingCols clamps..." case for the identical derivation). shrink:false pins the
    // canvas at exactly cols=100 so multi-col packing is actually reachable (renderDensePages
    // otherwise collapses numCols to 1 whenever the content shrinks below the cap).
    expect(maxFittingCols(100)).toBe(3);

    // 140 wrapped-at-100 lines (14,000 'x' chars, no whitespace so wrapLines splits purely by
    // the 100-col cap): needs 1 image at every candidate numCols (90-line-per-column cap), but a
    // greedy 3-column canvas leaves its 3rd column almost entirely empty (140 lines only fills
    // ~1.5 columns' worth) while still paying full width for it.
    const text = 'x'.repeat(14_000);
    const opts = { cols: 100, shrink: false as const, multiCol: 'auto' as const };

    const greedy = await renderDensePages(text, { ...opts, minimizePixels: false });
    const optimal = await renderDensePages(text, { ...opts, minimizePixels: true });

    const greedyPx = sumPixels(greedy);
    const optimalPx = sumPixels(optimal);

    expect(optimalPx).toBeLessThan(greedyPx);
    // Confirm the two actually chose different geometries, not just different page counts.
    expect(greedy[0]!.width).toBe(multiColWidth(100, 3));
    expect(optimal[0]!.width).toBeLessThan(greedy[0]!.width);

    // Sanity: neither path drops a glyph or exceeds the API's hard bounds. Total charsRendered
    // isn't compared 1:1 across the two paths: the single-col path (optimal, 2 images here)
    // re-wraps each page chunk and counts its own inserted '\n' page-join separators as
    // rendered codepoints (pre-existing renderChunkToPng accounting, unrelated to this task),
    // while the multi-col path (greedy, 1 image here) tracks the original untouched input
    // length. Both are internally consistent; only the multi-col (greedy) case has a
    // no-wrap-noise expected total.
    for (const imgs of [greedy, optimal]) {
      for (const img of imgs) {
        expect(img.droppedChars).toBe(0);
        expect(img.width).toBeLessThanOrEqual(MAX_WIDTH_PX);
        expect(img.height).toBeLessThanOrEqual(MAX_HEIGHT_PX);
      }
    }
    const greedyChars = greedy.reduce((s, img) => s + img.charsRendered, 0);
    expect(greedyChars).toBe(14_000);
  });
});
