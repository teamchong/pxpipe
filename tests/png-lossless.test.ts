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

  it('round-trips 1-bit, 2-bit, 4-bit indexed and 8-bit grayscale across odd widths', async () => {
    const cases: Array<{ name: string; palette: number[]; expectedBitDepth: number; expectedColorType: number }> = [
      { name: '1-bit (2 colors)', palette: [0, 255], expectedBitDepth: 1, expectedColorType: 3 },
      { name: '2-bit (4 colors)', palette: [0, 68, 170, 255], expectedBitDepth: 2, expectedColorType: 3 },
      { name: '4-bit (5 AA grays)', palette: [0, 31, 68, 119, 255], expectedBitDepth: 4, expectedColorType: 3 },
      { name: '4-bit (16 grays)', palette: Array.from({ length: 16 }, (_, i) => i * 17), expectedBitDepth: 4, expectedColorType: 3 },
      { name: '8-bit (>16 grays)', palette: Array.from({ length: 20 }, (_, i) => i * 13), expectedBitDepth: 8, expectedColorType: 0 },
    ];
    for (const c of cases) {
      for (const W of [1, 3, 7, 13, 31]) {
        const H = 21;
        const pixels = new Uint8Array(W * H);
        for (let i = 0; i < pixels.length; i++) {
          pixels[i] = c.palette[i % c.palette.length]!;
        }
        const png = await encodeGrayPng(pixels, W, H);
        expect(png[24], `${c.name} W=${W} bitDepth`).toBe(c.expectedBitDepth);
        expect(png[25], `${c.name} W=${W} colorType`).toBe(c.expectedColorType);
        const out = await decode(png);
        expect([out.w, out.h]).toEqual([W, H]);
        for (let i = 0; i < pixels.length; i++) {
          expect(out.data[i * 4], `${c.name} W=${W} px ${i}`).toBe(pixels[i]);
        }
      }
    }
  });

  it('round-trips indexed PLTE RGB (<=16 colors) and 8-bit RGB (>16 colors) bit-exact', async () => {
    const W = 19, H = 11;
    const palette: Array<[number, number, number]> = [
      [255, 255, 255], [0, 0, 0], [220, 38, 38], [30, 64, 175], [22, 163, 74],
    ];
    const pixels = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      const [r, g, b] = palette[(i * 3 + Math.floor(i / W)) % palette.length]!;
      pixels[i * 3] = r;
      pixels[i * 3 + 1] = g;
      pixels[i * 3 + 2] = b;
    }
    const png = await encodeRgbPng(pixels, W, H);
    expect(png[24]).toBe(4); // 5 colors -> 4-bit PLTE
    expect(png[25]).toBe(3); // indexed-color
    const out = await decode(png);
    expect([out.w, out.h]).toEqual([W, H]);
    for (let i = 0; i < W * H; i++) {
      expect([out.data[i * 4], out.data[i * 4 + 1], out.data[i * 4 + 2]]).toEqual([
        pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2],
      ]);
    }
  });
});
