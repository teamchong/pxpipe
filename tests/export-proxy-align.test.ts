// Export ⇄ proxy render alignment.
//
// Goal (the whole point of routing `pxpipe export` through the SDK): a given text must
// render to the SAME PNG bytes whether it goes through the `pxpipe export` CLI or the
// live proxy's history-image compression. Both now share one renderer:
//
//   export  → renderTextToImages(text, { cols, shrink })   [library.ts, public SDK]
//   proxy   → textToImageBlocks(text, cols, shrinkWidth)   [transform.ts, internal]
//
// textToImageBlocks is the proxy's packaging wrapper (adds base64 ImageBlocks +
// droppedCodepoints); its column-selection rule is mirrored verbatim by renderTextToImages
// (`cols < maxCols ? 1 : requestedCols`). This test pins that parity against the REAL proxy
// function (not a replica), so any future drift in either path fails CI.
//
// Alignment is guaranteed at the proxy's operating width, DENSE_CONTENT_COLS (384) — the
// export CLI's default and the proxy's hardcoded dense cap. `pxpipe export --cols N` with
// N≠384 is an intentionally-wider export and is out of scope for proxy parity.
import { describe, expect, it } from 'vitest';
import { renderTextToImages } from '../src/core/library.js';
import { textToImageBlocks } from '../src/core/transform.js';
import { DENSE_CONTENT_COLS } from '../src/core/render.js';

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Render `text` through both paths and assert full parity: page count, per-page PNG bytes,
 * pixel dimensions, dropped-glyph count, and total pixel area.
 *
 * `shrink` maps the export's SDK option onto the proxy's positional argument.
 */
async function expectIdenticalRender(
  text: string,
  { shrink = true }: { shrink?: boolean } = {},
): Promise<number> {
  const exported = await renderTextToImages(text, {
    cols: DENSE_CONTENT_COLS,
    shrink,
  });
  const proxied = await textToImageBlocks(text, DENSE_CONTENT_COLS, shrink);

  // Same number of pages.
  expect(proxied.pngs.length).toBe(exported.pages.length);

  // Byte-for-byte identical PNG per page, and matching pixel dimensions.
  for (let i = 0; i < exported.pages.length; i++) {
    const page = exported.pages[i];
    expect(
      bytesEqual(proxied.pngs[i], page.png),
      `page ${i}: proxy PNG (${proxied.pngs[i].length}B) must equal export PNG (${page.png.length}B)`,
    ).toBe(true);
    expect(proxied.dims[i]).toEqual({ width: page.width, height: page.height });
  }

  // Aggregate accounting must agree (drives px/token cost + dropped-glyph telemetry).
  expect(proxied.droppedChars).toBe(exported.droppedChars);
  expect(proxied.pixels).toBe(exported.pixels);

  return exported.pages.length;
}

describe('export ⇄ proxy render alignment', () => {
  it('narrow short-line code → byte-identical single-col PNG (shrink wins, no wasted width)', async () => {
    const code = [
      'function add(a, b) {',
      '  return a + b;',
      '}',
      '',
      'const xs = [1, 2, 3].map((n) => n * 2);',
      'export default add;',
    ].join('\n');
    await expectIdenticalRender(code, { shrink: true });
  });

  it('full-width prose (lines at the 384-col cap) → byte-identical', async () => {
    const line = 'lorem ipsum dolor sit amet '.repeat(20); // > 384 display cols → fills width
    const prose = Array.from({ length: 12 }, () => line).join('\n');
    await expectIdenticalRender(prose, { shrink: true });
  });

  it('large input spanning multiple pages → every page byte-identical', async () => {
    // Enough lines to overflow MAX_HEIGHT_PX and force pagination, so we pin multi-PAGE
    // parity (page-boundary slicing must match between the two paths).
    const big = Array.from({ length: 900 }, (_, i) => `line ${i}: const value_${i} = compute(${i});`).join('\n');
    const pages = await expectIdenticalRender(big, { shrink: true });
    expect(pages).toBeGreaterThan(1);
  });

  it('non-atlas codepoints drop identically on both paths', async () => {
    // Glyphs outside the atlas render as blank cells and bump droppedChars; both paths must
    // count them the same or px/token accounting diverges.
    const text = 'plain ascii line\n日本語 ☃ →★ exotic\nmore ascii';
    await expectIdenticalRender(text, { shrink: true });
  });

  it('proxy rendering honors a caller-supplied full canvas width', async () => {
    const text = 'width-sensitive content '.repeat(200);
    const narrow = await textToImageBlocks(text, 80, false);
    const wide = await textToImageBlocks(text, 120, false);
    expect(narrow.dims[0]?.width).toBeLessThan(wide.dims[0]?.width ?? 0);
  });
});
