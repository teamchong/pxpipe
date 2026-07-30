import { describe, expect, it } from 'vitest';
import {
  renderChunkToPng,
  roleSlotSegment,
  SLOT_MARK_USER,
  UPPER_INK,
  ROLE_PALETTE,
  CELL_H,
  CELL_W,
} from '../src/core/render.js';

/**
 * upperBlue (case parity): uppercase A-Z carries a fixed blue ink so letter
 * case survives rasterization. At 5×8, w/W, c/C, s/S, x/X, z/Z differ only by
 * scale — after the vision encoder resamples, color is the only channel left.
 * A real w→W misread shipped before this; owner approved the defensive
 * implementation without a red repro (200/200 single-image probes stayed
 * clean; the misread happened in long-context).
 */

interface DecodedPng {
  width: number;
  height: number;
  channels: 1 | 3;
  /** Row-major; grayscale 1 byte/px, RGB 3 bytes/px. */
  pixels: Uint8Array;
}

async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** Minimal decoder for this repo's own encoder: 8-bit gray/RGB, filter None, single IDAT. */
async function decodePng(png: Uint8Array): Promise<DecodedPng> {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = dv.getUint32(16);
  const height = dv.getUint32(20);
  const colorType = png[25]!;
  const channels = colorType === 2 ? 3 : 1;
  // Walk chunks, concat IDAT payloads.
  const idat: Uint8Array[] = [];
  let off = 8;
  while (off < png.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(png[off + 4]!, png[off + 5]!, png[off + 6]!, png[off + 7]!);
    if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = await inflateZlib(
    idat.length === 1 ? idat[0]! : new Uint8Array(idat.flatMap((c) => [...c])),
  );
  const stride = width * channels + 1;
  const pixels = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    expect(raw[y * stride]).toBe(0); // filter None — matches png.ts encoder
    pixels.set(raw.subarray(y * stride + 1, (y + 1) * stride), y * width * channels);
  }
  return { width, height, channels, pixels };
}

const PAD = 4; // PAD_X = PAD_Y = 4 in render.ts

/** Classify every inked pixel of a single-line render by source column (= char index
 *  when all chars are width-1). Returns per-char ink summaries. */
function inkByChar(img: DecodedPng, text: string): { blue: number; black: number }[] {
  const out = Array.from(text, () => ({ blue: 0, black: 0 }));
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const col = Math.floor((x - PAD) / CELL_W);
      if (col < 0 || col >= text.length) continue;
      let r: number, g: number, b: number;
      if (img.channels === 3) {
        const i = (y * img.width + x) * 3;
        r = img.pixels[i]!; g = img.pixels[i + 1]!; b = img.pixels[i + 2]!;
      } else {
        r = g = b = img.pixels[y * img.width + x]!;
      }
      if (r > 200 && g > 200 && b > 200) continue; // background
      if (b > r + 40) out[col]!.blue++;
      else if (r === g && g === b) out[col]!.black++;
    }
  }
  return out;
}

describe('upperBlue (uppercase case-parity ink)', () => {
  it('uppercase inks blue, lowercase and digits stay black', async () => {
    const text = 'abc XYZ 019';
    const img = await renderChunkToPng(text, 40);
    expect(img.png[25]).toBe(2); // page has A-Z → RGB
    const ink = await decodePng(img.png).then((d) => inkByChar(d, text));
    for (const [i, ch] of Array.from(text).entries()) {
      if (/[A-Z]/.test(ch)) {
        expect(ink[i]!.blue, `'${ch}' should be blue`).toBeGreaterThan(0);
        expect(ink[i]!.black, `'${ch}' should carry no black ink`).toBe(0);
      } else if (ch !== ' ') {
        expect(ink[i]!.black, `'${ch}' should be black`).toBeGreaterThan(0);
        expect(ink[i]!.blue, `'${ch}' should carry no blue ink`).toBe(0);
      }
    }
  });

  it('shape-identical case pairs (w/W, c/C, s/S, x/X, z/Z) are color-distinguishable', async () => {
    const text = 'wW cC sS xX zZ';
    const ink = await decodePng((await renderChunkToPng(text, 40)).png).then((d) =>
      inkByChar(d, text),
    );
    for (const [lo, hi] of [[0, 1], [3, 4], [6, 7], [9, 10], [12, 13]] as const) {
      expect(ink[lo]!.blue, `'${text[lo]}' lower must not be blue`).toBe(0);
      expect(ink[lo]!.black).toBeGreaterThan(0);
      expect(ink[hi]!.blue, `'${text[hi]}' upper must be blue`).toBeGreaterThan(0);
      expect(ink[hi]!.black).toBe(0);
    }
  });

  it('pages without any A-Z stay grayscale and byte-identical to upperBlue:false', async () => {
    const text = 'lowercase only 123 — 中文 too';
    const on = await renderChunkToPng(text, 60);
    const off = await renderChunkToPng(text, 60, { upperBlue: false });
    expect(on.png[25]).toBe(0); // still grayscale — cache/byte story intact
    expect(on.png).toEqual(off.png);
  });

  it('upperBlue:false restores the exact legacy bytes for uppercase pages', async () => {
    const text = 'Mixed CASE content';
    const off = await renderChunkToPng(text, 40, { upperBlue: false });
    expect(off.png[25]).toBe(0); // opt-out = legacy grayscale output
  });

  it('pixel diff vs upperBlue:false is confined to uppercase cells (no layout drift)', async () => {
    const text = 'The Quick brown FOX 42 jumps';
    const on = await decodePng((await renderChunkToPng(text, 40)).png);
    const off = await decodePng((await renderChunkToPng(text, 40, { upperBlue: false })).png);
    expect(on.width).toBe(off.width);
    expect(on.height).toBe(off.height);
    const chars = Array.from(text);
    for (let y = 0; y < on.height; y++) {
      for (let x = 0; x < on.width; x++) {
        const g = off.pixels[y * off.width + x]!;
        const i = (y * on.width + x) * 3;
        const same =
          on.pixels[i] === g && on.pixels[i + 1] === g && on.pixels[i + 2] === g;
        if (same) continue;
        const col = Math.floor((x - PAD) / CELL_W);
        const ch = chars[col] ?? '';
        expect(/[A-Z]/.test(ch), `diff pixel at (${x},${y}) outside uppercase cell '${ch}'`).toBe(
          true,
        );
      }
    }
  });

  it('composes with colorByRole: role tags keep their hue, body uppercase goes blue', async () => {
    const body = 'Say HELLO world';
    const text = `<user>\n${body}\n</user>`;
    const slot = roleSlotSegment('user', body, SLOT_MARK_USER);
    const img = await renderChunkToPng(text, 40, { colorByRole: true }, undefined, slot);
    expect(img.png[25]).toBe(2);
    const d = await decodePng(img.png);
    // Row 0 = "<user>" tag → ROLE_PALETTE[0] red. Row 1 = body.
    const [tagR] = ROLE_PALETTE[0]!;
    let sawTagHue = 0;
    let sawBodyBlue = 0;
    let sawBodyBlack = 0;
    for (let y = 0; y < d.height; y++) {
      const row = Math.floor((y - PAD) / CELL_H);
      for (let x = 0; x < d.width; x++) {
        const i = (y * d.width + x) * 3;
        const [r, g, b] = [d.pixels[i]!, d.pixels[i + 1]!, d.pixels[i + 2]!];
        if (r > 200 && g > 200 && b > 200) continue;
        if (row === 0 && r > b + 40 && Math.abs(r - tagR) < 90) sawTagHue++;
        if (row === 1 && b > r + 40) sawBodyBlue++;
        if (row === 1 && r === g && g === b) sawBodyBlack++;
      }
    }
    expect(sawTagHue).toBeGreaterThan(0); // <user> stayed red
    expect(sawBodyBlue).toBeGreaterThan(0); // HELLO went blue
    expect(sawBodyBlack).toBeGreaterThan(0); // lowercase body stayed black
  });

  it('markerRed ↵ pixels stay red when upperBlue forces the RGB path', async () => {
    const text = 'Alpha↵Beta';
    const d = await decodePng(
      (await renderChunkToPng(text, 40, { markerRed: true })).png,
    );
    let sawRed = 0;
    for (let i = 0; i < d.pixels.length; i += 3) {
      if (d.pixels[i]! > 180 && d.pixels[i + 1]! < 60 && d.pixels[i + 2]! < 60) sawRed++;
    }
    expect(sawRed).toBeGreaterThan(0);
  });

  it('UPPER_INK is distinct from the assistant role blue', () => {
    expect(UPPER_INK).not.toEqual(ROLE_PALETTE[1]);
  });
});
