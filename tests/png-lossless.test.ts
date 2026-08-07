import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { encodeGrayPng, encodeRgbPng } from '../src/core/png.js';

/**
 * The encoder applies PNG's Average scanline filter, which must be bit-exact
 * reversible: the model has to see the pixels the renderer drew, not an
 * approximation. Verified with skia (@napi-rs/canvas) rather than a hand-rolled
 * decoder, so a bug in the filter can't be masked by the same bug in the check.
 *
 * `loadImage` awaits the decode. `new Image()` + `.src` does NOT, and silently
 * yields a blank canvas that passes any comparison against blank expectations.
 */
async function decode(png: Uint8Array): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  const img = await loadImage(Buffer.from(png));
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { data: ctx.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height };
}

// Deliberately not a multiple of 8, so the last partial byte-group is exercised.
const W = 259;
const H = 131;

describe('PNG encoder is lossless', () => {
  it('round-trips grayscale pixels bit-for-bit', async () => {
    // Includes 0 and 255 (the filter residual wraps past both) and the mid greys
    // the antialiased atlas actually emits.
    const pixels = new Uint8Array(W * H);
    const palette = [0, 31, 68, 119, 255, 1, 254, 128];
    for (let i = 0; i < pixels.length; i++) pixels[i] = palette[i % palette.length]!;

    const out = await decode(await encodeGrayPng(pixels, W, H));
    expect([out.w, out.h]).toEqual([W, H]);

    let firstDiff = -1;
    for (let i = 0; i < W * H; i++) {
      if (out.data[i * 4] !== pixels[i]) { firstDiff = i; break; }
    }
    // Row 0 has no upper neighbour and column 0 no left neighbour; both are
    // defined as zero by the spec, and both are covered by scanning from index 0.
    expect(firstDiff).toBe(-1);
  });

  it('round-trips RGB pixels bit-for-bit', async () => {
    const pixels = new Uint8Array(W * H * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37 + (i % 5)) & 255;

    const out = await decode(await encodeRgbPng(pixels, W, H));
    expect([out.w, out.h]).toEqual([W, H]);

    let firstDiff = -1;
    outer: for (let i = 0; i < W * H; i++) {
      for (let c = 0; c < 3; c++) {
        // Filtering is per-channel at bpp=3: the left neighbour is 3 bytes back,
        // so a wrong bpp shows up as channel bleed rather than a whole-image break.
        if (out.data[i * 4 + c] !== pixels[i * 3 + c]) { firstDiff = i * 3 + c; break outer; }
      }
    }
    expect(firstDiff).toBe(-1);
  });

  it('preserves a solid run and a single-pixel image', async () => {
    const solid = new Uint8Array(64 * 4).fill(200);
    const s = await decode(await encodeGrayPng(solid, 64, 4));
    expect([...new Set(Array.from({ length: 64 * 4 }, (_, i) => s.data[i * 4]))]).toEqual([200]);

    const one = await decode(await encodeGrayPng(new Uint8Array([137]), 1, 1));
    expect(one.data[0]).toBe(137);
  });
});
