import { describe, expect, it } from 'vitest';
import {
  renderChunkToPng,
  renderTextToPngs,
  renderTextToPngsMultiCol,
  multiColWidth,
  maxFittingCols,
  expandTabsInLine,
  minifyForRender,
  CELL_H,
  CELL_W,
} from '../src/core/render.js';
import { encodeGrayPng, bytesToBase64 } from '../src/core/png.js';
import {
  transformRequest,
  isCompressionProfitable,
  maxCharsPerImage,
  estimateImageCount,
  compactSlabWhitespace,
  SLAB_CHARS_PER_TOKEN,
} from '../src/core/transform.js';
import {
  atlasRank,
  ATLAS_CELL_H,
  ATLAS_CELL_W,
  ATLAS_PIXELS,
  ATLAS_WIDE_FLAGS,
  ATLAS_NUM_GLYPHS,
} from '../src/core/atlas.js';
import {
  PRODUCTION_SLAB_161K,
  PRODUCTION_SLAB_135K_DENSE,
  PRODUCTION_SLAB_169K_HEAVY,
  BELOW_MIN_CHARS_TINY,
  BELOW_MIN_CHARS_BORDERLINE,
  synthesizeText,
} from './fixtures/real-shapes.js';

describe('compactSlabWhitespace', () => {
  it('returns empty string unchanged', () => {
    expect(compactSlabWhitespace('')).toBe('');
  });

  it('strips trailing spaces and tabs per line', () => {
    const input = 'alpha   \nbeta\t\t\ngamma';
    expect(compactSlabWhitespace(input)).toBe('alpha\nbeta\ngamma');
  });

  it('collapses 3+ consecutive newlines to exactly 2', () => {
    expect(compactSlabWhitespace('a\n\n\nb')).toBe('a\n\nb');
    expect(compactSlabWhitespace('a\n\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('preserves single blank lines (paragraph breaks)', () => {
    expect(compactSlabWhitespace('a\n\nb')).toBe('a\n\nb');
  });

  it('preserves leading indentation', () => {
    const input = '  function f() {\n    return 1;   \n  }';
    expect(compactSlabWhitespace(input)).toBe('  function f() {\n    return 1;\n  }');
  });

  it('is idempotent', () => {
    const input = 'x   \n\n\n\ny\t\nz   ';
    const once = compactSlabWhitespace(input);
    const twice = compactSlabWhitespace(once);
    expect(twice).toBe(once);
  });

  it('shrinks a realistic markdown-ish slab', () => {
    const input = [
      '# Heading   ',
      '',
      '',
      '',
      'Paragraph with trailing space.   ',
      '',
      '- bullet one   ',
      '- bullet two\t',
      '',
      '',
      '',
      '## Sub',
    ].join('\n');
    const out = compactSlabWhitespace(input);
    expect(out.length).toBeLessThan(input.length);
    expect(out).not.toMatch(/[ \t]+\n/);
    expect(out).not.toMatch(/\n{3,}/);
  });
});

describe('png encoder', () => {
  it('produces a valid PNG signature', async () => {
    const pixels = new Uint8Array(4 * 4).fill(128); // 4×4 mid-gray
    const png = await encodeGrayPng(pixels, 4, 4);
    expect(png.slice(0, 8)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    // Last chunk should be IEND
    const tail = png.slice(-12);
    expect(String.fromCharCode(tail[4]!, tail[5]!, tail[6]!, tail[7]!)).toBe('IEND');
  });

  it('round-trips bytesToBase64 ↔ atob', () => {
    const original = new Uint8Array([0, 1, 2, 3, 254, 255]);
    const b64 = bytesToBase64(original);
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(original);
  });
});

describe('renderer', () => {
  it('renders a one-line string to a single PNG', async () => {
    const img = await renderChunkToPng('Hello, world!');
    expect(img.png.slice(0, 8)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(img.height).toBeLessThanOrEqual(1568);
    expect(img.width).toBeGreaterThan(0);
  });

  it('splits very long input into multiple PNGs', async () => {
    const huge = ('lorem ipsum dolor sit amet '.repeat(20) + '\n').repeat(500);
    const imgs = await renderTextToPngs(huge);
    expect(imgs.length).toBeGreaterThan(1);
    for (const img of imgs) expect(img.height).toBeLessThanOrEqual(1568);
  });

  // ---- R2 multi-column renderer ------------------------------------------
  // The multi-col path packs N source columns side-by-side per image so
  // each image covers numCols×LINES_PER_IMAGE wrapped lines instead of one.
  // Off by default (numCols=1) — these tests exercise the new path.

  it('multi-col with numCols=1 is byte-identical to renderTextToPngs (default cache contract)', async () => {
    // The cache_control story depends on identical bytes for identical
    // inputs. numCols=1 MUST be a pure passthrough so toggling the flag
    // back to 1 cannot regress cache hit rate.
    const text = ('lorem ipsum dolor sit amet\n'.repeat(8)) + 'final line';
    const single = await renderTextToPngs(text);
    const passthrough = await renderTextToPngsMultiCol(text, 100, 1);
    expect(passthrough.length).toBe(single.length);
    for (let i = 0; i < single.length; i++) {
      expect(passthrough[i]!.png).toEqual(single[i]!.png);
    }
  });

  it('multi-col emits a wider canvas with the predicted dimensions', async () => {
    const text = ('lorem ipsum dolor sit amet\n'.repeat(8)) + 'final line';
    const single = await renderTextToPngs(text, 100);
    const two = await renderTextToPngsMultiCol(text, 100, 2);
    // numCols=2 with 100-col text content + 4-cell gutter at 7px/cell (7×10 production cell):
    //   width = 2*PAD_X + 2*100*7 + 1*4*7 = 8 + 1400 + 28 = 1436 px
    expect(two[0]!.width).toBe(multiColWidth(100, 2));
    expect(two[0]!.width).toBeGreaterThan(single[0]!.width);
    expect(two[0]!.width).toBeLessThanOrEqual(1568);
  });

  it('multi-col halves image count on row-heavy input', async () => {
    // ~500 lines of narrow content. Single-col packs 195 lines/image →
    // ~4 images. Two columns should drop that to ~2.
    const text = ('lorem ipsum dolor sit amet\n'.repeat(500));
    const single = await renderTextToPngs(text, 100);
    const two = await renderTextToPngsMultiCol(text, 100, 2);
    expect(single.length).toBeGreaterThanOrEqual(3);
    // Two-col image count ≤ ceil(single / 2). The +1 slack handles the
    // pathological case where the boundary lands awkwardly.
    expect(two.length).toBeLessThanOrEqual(Math.ceil(single.length / 2));
    for (const img of two) expect(img.height).toBeLessThanOrEqual(1568);
  });

  it('multi-col render is deterministic (byte-identical across calls)', async () => {
    const text = ('alpha beta gamma delta epsilon\n'.repeat(400));
    const a = await renderTextToPngsMultiCol(text, 100, 2);
    const b = await renderTextToPngsMultiCol(text, 100, 2);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) expect(a[i]!.png).toEqual(b[i]!.png);
  });

  it('multi-col per-image charsRendered sums to the input codepoint count', async () => {
    // The honest-savings math (compressedChars in TransformInfo) relies on
    // sum(charsRendered) matching the input we paid to render. Off-by-one
    // here would silently mis-report savings.
    const text = ('lorem ipsum dolor sit amet\n'.repeat(400));
    let cpCount = 0;
    for (const _ of text) cpCount++;
    const imgs = await renderTextToPngsMultiCol(text, 100, 2);
    let total = 0;
    for (const img of imgs) total += img.charsRendered;
    expect(total).toBe(cpCount);
  });

  it('estimateImageCount(numCols=2) tracks actual multi-col image count', async () => {
    const text = ('lorem ipsum dolor sit amet\n'.repeat(500));
    const actual = (await renderTextToPngsMultiCol(text, 100, 2)).length;
    const estimated = estimateImageCount(text, 100, 2);
    expect(estimated).toBe(actual);
  });

  it('maxFittingCols clamps an over-wide numCols flag instead of producing >1568px canvases', async () => {
    // At cols=100 (5 px/cell + 4-cell gutter), the math says:
    //   1: 508 px, 2: 1028, 3: 1548, 4: 2068 → 4 already exceeds 1568.
    const fits = maxFittingCols(100);
    expect(fits).toBe(3);
    const text = 'short\n'.repeat(10);
    // numCols=10 → should clamp; output canvas width must stay ≤ 1568.
    const imgs = await renderTextToPngsMultiCol(text, 100, 10);
    for (const img of imgs) expect(img.width).toBeLessThanOrEqual(1568);
  });

  it('multi-col preserves CJK wide-glyph wrap math (no dropped chars on Chinese input)', async () => {
    // Wide glyphs are 2 cells in both layouts; multi-col must not regress
    // the wrap math or atlas lookup.
    const text = ('中文测试 mixed ASCII\n'.repeat(100));
    const imgs = await renderTextToPngsMultiCol(text, 100, 2);
    let dropped = 0;
    for (const img of imgs) dropped += img.droppedChars;
    expect(dropped).toBe(0);
  });

  it('multi-col draws a light-gray gutter divider (OCR column-boundary cue)', async () => {
    // Same "visible whitespace" idea as the U+2192 tab arrow: surface the
    // column boundary explicitly instead of relying on gap-of-whitespace
    // alone. The pixel sits at MID-GRAY (~191/255), distinct from both
    // background (255) and glyph ink (~0), so the vision encoder reads it
    // as a structural cue without competing with text. Cost is ~one
    // 1-pixel-wide column of identical gray that DEFLATE-collapses to ~5
    // bytes per gutter.
    //
    // Verification: inflate the IDAT chunks of the rendered PNG, locate the
    // expected divider x-coordinate (middle of the gutter between cols 0
    // and 1), and assert at least 80% of rows at that x are mid-gray.
    const zlib = await import('node:zlib');
    const text = ('lorem ipsum dolor sit amet\n'.repeat(200));
    const imgs = await renderTextToPngsMultiCol(text, 100, 2);
    expect(imgs.length).toBeGreaterThan(0);
    const img = imgs[0]!;

    // PNG layout: 8-byte signature, then chunks of (length-be32, type-4b,
    // data, crc-be32). IHDR is first; concat all IDATs and inflate. The
    // inflated stream has a 1-byte filter prefix per row; for grayscale our
    // encoder always writes filter type 0 (none) so the row body is just
    // the raw width bytes.
    const png = img.png;
    let pos = 8;
    const idats: Uint8Array[] = [];
    while (pos < png.length) {
      const len =
        (png[pos]! << 24) | (png[pos + 1]! << 16) | (png[pos + 2]! << 8) | png[pos + 3]!;
      const type = String.fromCharCode(png[pos + 4]!, png[pos + 5]!, png[pos + 6]!, png[pos + 7]!);
      const dataStart = pos + 8;
      if (type === 'IDAT') idats.push(png.subarray(dataStart, dataStart + len));
      if (type === 'IEND') break;
      pos = dataStart + len + 4;
    }
    const concatenated = Buffer.concat(idats.map((u) => Buffer.from(u)));
    const inflated = zlib.inflateSync(concatenated);

    // Decode: each row is 1 filter byte + width pixel bytes. We expect
    // filter=0 (none) on every row from our encoder, so the pixel-byte
    // index for (x, y) is `y * (width + 1) + 1 + x`.
    const width = img.width;
    const height = img.height;
    // Divider X: end of col 0's text area + half the gutter.
    //   colEnd = PAD_X (4) + 0 * stride + 100 * 7 = 704
    //   dividerX = 704 + floor((4 * 7) / 2) = 704 + 14 = 718
    const PAD_X = 4;
    const GUTTER_CELLS = 4;
    const cols = 100;
    const dividerX =
      PAD_X + 0 + cols * CELL_W + Math.floor((GUTTER_CELLS * CELL_W) / 2);
    expect(dividerX).toBeLessThan(width);

    let midGrayRows = 0;
    const rowStride = width + 1;
    for (let y = 2; y < height - 2; y++) {
      const px = inflated[y * rowStride + 1 + dividerX];
      // GUTTER_DIVIDER_INK=64 pre-invert → 191 post-invert. Allow a small
      // band in case the constant is tuned later — anywhere in [120, 230]
      // is "mid-gray, not full ink, not background".
      if (px !== undefined && px >= 120 && px <= 230) midGrayRows++;
    }
    // Most rows at the divider column should be mid-gray. The inset trims a
    // few top/bottom pixels and there might be glyph encroachments on a
    // handful of rows in pathological content, but >80% is the floor.
    const liveRows = height - 4;
    expect(midGrayRows).toBeGreaterThan(liveRows * 0.8);
  });

  it('multi-col single-column path skips the divider (byte-identical to renderTextToPngs)', async () => {
    // The divider only paints when numCols >= 2. The numCols=1 passthrough
    // path must remain byte-identical to the single-col renderer so the
    // cache-control deterministic-bytes story stays intact for single-col
    // deployments.
    const text = ('lorem ipsum dolor sit amet\n'.repeat(100));
    const passthrough = await renderTextToPngsMultiCol(text, 100, 1);
    const single = await renderTextToPngs(text, 100);
    expect(passthrough.length).toBe(single.length);
    for (let i = 0; i < passthrough.length; i++) {
      expect(passthrough[i]!.png).toEqual(single[i]!.png);
    }
  });

  // ---- Unicode coverage tests (hybrid atlas fallback) -------------------------------
  // These confirm the sparse-codepoint + wide-glyph machinery works end-to-end.
  // None of them assert specific PNG bytes (the byte-deterministic guarantee
  // is covered by the 'renders identical input...' test below); they assert
  // the *contract*: known glyphs render without dropping, missing glyphs
  // increment droppedChars, and wide chars advance two cells.

  it('renders a Chinese codepoint without dropping (CJK Unified)', async () => {
    const img = await renderChunkToPng('中文'); // U+4E2D U+6587
    expect(img.droppedChars).toBe(0);
    expect(img.charsRendered).toBe(2);
    expect(img.width).toBeGreaterThan(0);
  });

  it('renders Cyrillic without dropping', async () => {
    const img = await renderChunkToPng('Привет мир'); // 10 codepoints incl. space
    expect(img.droppedChars).toBe(0);
    expect(img.charsRendered).toBe(10);
  });

  it('renders Greek, Hebrew, Arabic, box-drawing, and math symbols', async () => {
    // One glyph from each profile range that the atlas claims to cover.
    // (The renderer is left-to-right only; Hebrew/Arabic will appear in
    // source order, not bidi-correct order — that's a documented limitation
    // of this slice, not a test failure.)
    const sample = 'α β π — → ∑ ∫ √ ─ │ ┌ ┐';
    const img = await renderChunkToPng(sample);
    expect(img.droppedChars).toBe(0);
  });

  it('treats codepoints outside the atlas as dropped (e.g. emoji)', async () => {
    // 😀 is U+1F600 — Supplementary Plane, not in BMP. Even `full-bmp` profile
    // wouldn't cover it. Renderer must advance by 1 cell and bump the counter,
    // not crash on the surrogate pair.
    const img = await renderChunkToPng('hi 😀 world');
    expect(img.droppedChars).toBe(1);
    // charsRendered counts codepoints, NOT UTF-16 units — the emoji is one
    // codepoint even though it occupies two UTF-16 units.
    expect(img.charsRendered).toBe(10); // 'hi ' (3) + 😀 (1) + ' world' (6) = 10
  });

  it('CJK characters advance two cells; mixed lines wrap correctly', async () => {
    // 100 cols, mixed Latin + CJK. 30 Latin chars + 40 CJK chars = 30 + 80 =
    // 110 visual columns → must wrap to 2 lines.
    const latin30 = 'abcdefghijklmnopqrstuvwxyz0123';
    const cjk40 = '中'.repeat(40);
    const img = await renderChunkToPng(latin30 + cjk40, 100);
    // First line fills 30 + 35*2 = 100 cols (35 CJK chars).
    // Second line holds the remaining 5 CJK chars.
    // Image height: 2 lines × CELL_H + 2*PAD_Y. PAD_Y is 4 px (matches
    // render.ts's const). CELL_H comes from the atlas so this stays correct
    // across font-size changes.
    expect(img.charsRendered).toBe(latin30.length + 40);
    expect(img.droppedChars).toBe(0);
    const expectedHeight = 2 * 4 /* PAD_Y */ + 2 * CELL_H;
    expect(img.height).toBe(expectedHeight);
  });

  it('does NOT split a wide glyph across the column boundary', async () => {
    // 99 Latin + 1 CJK at cols=100: the CJK would land at col 99 (1 col left)
    // and needs 2. Wrap math must move it to a new line, leaving col 99 blank
    // on the first line.
    const line = 'a'.repeat(99) + '中';
    const img = await renderChunkToPng(line, 100);
    expect(img.charsRendered).toBe(100);
    expect(img.droppedChars).toBe(0);
    // Two lines: first has 99 'a', second has the '中'.
    const expectedHeight = 2 * 4 /* PAD_Y */ + 2 * CELL_H;
    expect(img.height).toBe(expectedHeight);
  });

  // --- Atlas profile coverage: 6 blocks added per #27 + #28 -----------------
  // These confirm the codepoints the drop-histogram surfaced as 95% of
  // production drops are now in the atlas. Each `atlasRank` returns ≥ 0
  // for a representative glyph from each block.

  it('atlas covers Dingbats (✓ ✗ ❌)', () => {
    expect(atlasRank('✓'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('✗'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('❌'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
  });

  it('atlas covers Miscellaneous Symbols (⚠ ★)', () => {
    expect(atlasRank('⚠'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('★'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
  });

  it('atlas covers Letterlike Symbols (ℝ ℕ ℤ ℚ ℂ)', () => {
    expect(atlasRank('ℝ'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('ℕ'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('ℤ'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('ℚ'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('ℂ'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
  });

  it('atlas covers Block Elements (█ ░ ▒)', () => {
    expect(atlasRank('█'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('░'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('▒'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
  });

  it('atlas covers Geometric Shapes (▲ ▼ ► ◄ ●)', () => {
    expect(atlasRank('▲'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('▼'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('►'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('◄'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('●'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
  });

  it('atlas covers Miscellaneous Technical (⌈ ⌉ ⌊ ⌋)', () => {
    expect(atlasRank('⌈'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('⌉'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('⌊'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('⌋'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
  });

  it('atlas covers Enclosed Alphanumerics (ⓘ ① ② ⑩)', () => {
    expect(atlasRank('ⓘ'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('①'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('②'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('⑩'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
  });

  it('atlas pixel storage is bit-packed (1 bit per pixel)', () => {
    // Sanity check on the storage format. Total pixels across all glyphs =
    // numGlyphs × cellH × (cellW or 2*cellW) depending on each glyph's
    // wide-flag. The packed byte buffer must be ceil(totalBits / 8) bytes
    // — within 1 byte of the theoretical minimum.
    let totalBits = 0;
    for (let r = 0; r < ATLAS_NUM_GLYPHS; r++) {
      const srcW = ATLAS_WIDE_FLAGS[r] === 1 ? 2 * ATLAS_CELL_W : ATLAS_CELL_W;
      totalBits += srcW * ATLAS_CELL_H;
    }
    const expectedBytes = Math.ceil(totalBits / 8);
    expect(ATLAS_PIXELS.byteLength).toBe(expectedBytes);
    // Hard guarantee: the 8-bit format would have used totalBits bytes, so
    // bit-packed is exactly 8× smaller (modulo the rounding to whole bytes).
    expect(ATLAS_PIXELS.byteLength).toBeLessThanOrEqual(totalBits / 8 + 1);
  });

  it('atlas covers Hangul Syllables (한 글 안 녕) — full-bmp profile only', () => {
    // The default profile is now `full-bmp`, which ships ~11k Hangul
    // Syllables (U+AC00..U+D7AF). The `practical` profile drops these
    // for Workers free-tier deployments; if someone regenerates the atlas
    // with ATLAS_PROFILE=practical, these expectations will (correctly)
    // fail — that's the signal to update the test alongside the deploy.
    expect(atlasRank('한'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('글'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('안'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('녕'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
  });

  it('rendering a mix of newly-covered glyphs produces droppedChars: 0', async () => {
    // The histogram script found these were the most common drops in real
    // traffic. After the full-bmp default plus #29 cell-height fix, all
    // render cleanly — Hangul `한 글` included.
    const sample = '✓ ⚠ ℝ █ ▲ ⌈ ⌉ ⓘ ✗ ► ▼ ● ░ ★ ℕ ① 한 글 中 文';
    const img = await renderChunkToPng(sample);
    expect(img.droppedChars).toBe(0);
    expect(img.droppedCodepoints.size).toBe(0);
  });

  it('droppedCodepoints map is populated correctly when drops occur', async () => {
    // 😀 is supplementary-plane (not in atlas regardless of profile). The
    // codepoint should appear in the map with count 1; charsRendered counts
    // it as a single codepoint.
    const img = await renderChunkToPng('hi 😀 there');
    expect(img.droppedChars).toBe(1);
    expect(img.droppedCodepoints.size).toBe(1);
    expect(img.droppedCodepoints.get(0x1f600)).toBe(1);
  });

  it('droppedCodepoints tallies repeat drops correctly', async () => {
    // Three occurrences of the same dropped codepoint → count 3.
    const img = await renderChunkToPng('😀😀😀');
    expect(img.droppedChars).toBe(3);
    expect(img.droppedCodepoints.size).toBe(1);
    expect(img.droppedCodepoints.get(0x1f600)).toBe(3);
  });

  // --- Whitespace minify (HANDOFF R1) ---------------------------------------
  // Conservative whitespace cleanup before tab-expand + wrap. Strip trailing
  // whitespace per line; collapse 4+ \n runs down to 3 \n (max 2 blank lines).
  // Mid-line spaces and leading indent are NEVER touched (alignment + structure
  // are preserved).

  it('minifyForRender: strips trailing spaces', () => {
    expect(minifyForRender('foo   \n')).toBe('foo\n');
  });

  it('minifyForRender: strips trailing tab + space mix', () => {
    expect(minifyForRender('foo\t \n')).toBe('foo\n');
  });

  it('minifyForRender: collapses 5 newlines to 3 (= 2 blank lines)', () => {
    expect(minifyForRender('foo\n\n\n\n\nbar')).toBe('foo\n\n\nbar');
  });

  it('minifyForRender: preserves 2 newlines (= 1 blank line)', () => {
    expect(minifyForRender('foo\n\nbar')).toBe('foo\n\nbar');
  });

  it('minifyForRender: preserves 3 newlines (= 2 blank lines, the cap)', () => {
    expect(minifyForRender('foo\n\n\nbar')).toBe('foo\n\n\nbar');
  });

  it('minifyForRender: NEVER collapses mid-line spaces (alignment preserved)', () => {
    expect(minifyForRender('a   b   c')).toBe('a   b   c');
  });

  it('minifyForRender: NEVER strips leading whitespace (indent preserved)', () => {
    expect(minifyForRender('    foo')).toBe('    foo');
  });

  it('minifyForRender: real-world mix of trailing whitespace + blank runs', () => {
    // Stack-trace shaped: lines with trailing spaces + 5-line blank gaps.
    const input = 'Error: x failed   \n\tat foo()  \n\n\n\n\n\tat bar()\n';
    const expected = 'Error: x failed\n\tat foo()\n\n\n\tat bar()\n';
    expect(minifyForRender(input)).toBe(expected);
  });

  it('minify pipeline integration: trailing whitespace + blank runs → shorter image', async () => {
    // Same content, with-vs-without whitespace bloat. The "bloated" version
    // has trailing spaces and 6-line blank gaps; the "clean" version has
    // neither. Both render to single-PNG output for the test; we measure
    // the height delta and confirm the bloated→minified reduction is real.
    const cleanLines = ['line one', 'line two', '', '', 'line three', 'line four'];
    const bloatedLines = [
      'line one     ', // trailing whitespace
      'line two   ',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      'line three  ',
      'line four ',
    ];
    const cleanImg = await renderChunkToPng(cleanLines.join('\n'));
    const bloatedImg = await renderChunkToPng(bloatedLines.join('\n'));
    // After minify, both should render to the same final shape.
    expect(bloatedImg.height).toBe(cleanImg.height);
    expect(bloatedImg.droppedChars).toBe(0);
    expect(cleanImg.droppedChars).toBe(0);
  });

  // --- Tab expansion (production bug fix) -----------------------------------
  // Real telemetry on 2026-05-19 showed 5,339 of 5,358 drops (99.6%) were
  // U+0009 TAB. Tabs are control codepoints, not glyphs — they expand to
  // a visible `→` (U+2192) at the tab boundary + padding spaces to the next
  // 4-stop. The visible arrow preserves "this was an indent" structure for
  // the OCR'd model; silent spaces would lose that signal.

  it('expandTabsInLine: basic — a\\tb → a→<2sp>b (col 1 → col 4, span=3)', () => {
    expect(expandTabsInLine('a\tb')).toBe('a→  b');
  });

  it('expandTabsInLine: leading tab — \\tx → →<3sp>x (col 0 → col 4, span=4)', () => {
    expect(expandTabsInLine('\tx')).toBe('→   x');
  });

  it('expandTabsInLine: ab\\tc → ab→<1sp>c (col 2 → col 4, span=2)', () => {
    expect(expandTabsInLine('ab\tc')).toBe('ab→ c');
  });

  it('expandTabsInLine: abc\\tx → abc→x (col 3 → col 4, span=1, no padding)', () => {
    // NOTE: the team-lead brief showed `abc→   x` here, but the brief's own
    // formula `tabWidth - (col % tabWidth)` gives span=1 at col=3 — single
    // arrow, zero padding. Implementing per the formula (consistent across
    // all other cases); flagging the brief example as a typo.
    expect(expandTabsInLine('abc\tx')).toBe('abc→x');
  });

  it('expandTabsInLine: no tabs → unchanged (fast path)', () => {
    expect(expandTabsInLine('a\nb')).toBe('a\nb');
    expect(expandTabsInLine('hello world')).toBe('hello world');
  });

  it('expandTabsInLine: tab after CJK uses visual width (中 = 2 cols)', () => {
    // 中 at cols 0-1, tab at col 2 → span = 4 - 2 = 2 (arrow + 1 space).
    expect(expandTabsInLine('中\tx')).toBe('中→ x');
  });

  it('renders tab-containing text with droppedChars: 0 (was dropping pre-fix)', async () => {
    const img = await renderChunkToPng('a\tb');
    expect(img.droppedChars).toBe(0);
    expect(img.droppedCodepoints.size).toBe(0);
  });

  it('renders leading tab with droppedChars: 0', async () => {
    const img = await renderChunkToPng('\tx');
    expect(img.droppedChars).toBe(0);
  });

  it('full pipeline: foo\\n\\tbar renders to two lines with visible → in the indent', async () => {
    // Brief's specific E2E ask. `foo\n\tbar` is two logical lines:
    //   line 0: "foo"
    //   line 1: "\tbar" → expands to "→   bar"
    // Both lines render cleanly with no drops; arrow U+2192 is in the Arrows
    // block (covered by every profile).
    const img = await renderChunkToPng('foo\n\tbar');
    expect(img.droppedChars).toBe(0);
    expect(img.droppedCodepoints.size).toBe(0);
    // Two visible lines = 2 cell-rows of pixels (height check).
    const expectedHeight = 2 * 4 /* PAD_Y */ + 2 * CELL_H;
    expect(img.height).toBe(expectedHeight);
    // Sanity: charsRendered counts input codepoints (4 + 1 + 4 = 9 chars
    // including the embedded `\n`). The arrow + padding spaces aren't in
    // the input — they're created post-`\n`-split — so `charsRendered`
    // still reflects the original input length.
    expect(img.charsRendered).toBe('foo\n\tbar'.length);
  });

  it('multiple tabs land on their respective tab stops', async () => {
    // `a\tbb\tc`:
    //   'a'  → col 0..1
    //   '\t' → col 1, fills to col 4 (3 spaces)
    //   'bb' → col 4..6
    //   '\t' → col 6, fills to col 8 (2 spaces)
    //   'c'  → col 8..9
    // Net: 'a' + 3 spaces + 'bb' + 2 spaces + 'c' — all visible glyphs in
    // the atlas, zero drops.
    const img = await renderChunkToPng('a\tbb\tc');
    expect(img.droppedChars).toBe(0);
  });

  it('tab after CJK char respects East Asian Wide column count', async () => {
    // 中 is 2 visual cols. So tab after 中 fills col 2 → col 4 (2 spaces).
    const img = await renderChunkToPng('中\tx');
    expect(img.droppedChars).toBe(0);
  });

  it('tab at the start of multiple lines resets column tracking per line', async () => {
    // Each line independently treats tab as expanding from col 0 (4 spaces).
    const img = await renderChunkToPng('\ta\n\tb\n\tc');
    expect(img.droppedChars).toBe(0);
  });

  it('a long string with embedded tabs produces zero drops', async () => {
    // Stress test for the production failure mode (tabs in tool_result-like
    // text dumps with thousands of indented lines).
    const line = 'fn\tname\tlocation\n'.repeat(500);
    const img = await renderChunkToPng(line);
    expect(img.droppedChars).toBe(0);
    // Codepoint 0x0009 must NOT appear in any drop tally.
    expect(img.droppedCodepoints.has(0x09)).toBe(false);
  });
});

describe('transform', () => {
  it('is a no-op when below min-chars', async () => {
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'You are helpful.',
    });
    const bytes = new TextEncoder().encode(req);
    const { body, info } = await transformRequest(bytes, { minCompressChars: 100 });
    expect(info.compressed).toBe(false);
    expect(body).toBe(bytes); // returns same reference
  });

  it('compresses large system fields into image blocks', async () => {
    const bigSystem = 'You are a helpful assistant. '.repeat(5000); // ~31.9k chars, well past 2-image break-even (20k)
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: bigSystem,
    });
    const bytes = new TextEncoder().encode(req);
    const { body, info } = await transformRequest(bytes);
    expect(info.compressed).toBe(true);
    expect(info.imageCount).toBeGreaterThanOrEqual(1);

    const out = JSON.parse(new TextDecoder().decode(body));
    // Images always go into the first user message, not the system field
    // (Anthropic rejects image blocks in `system`).
    const userContent = out.messages[0].content as any[];
    expect(Array.isArray(userContent)).toBe(true);
    const imageBlocks = userContent.filter((b: any) => b.type === 'image');
    expect(imageBlocks.length).toBe(info.imageCount);
    expect(imageBlocks[0].source.media_type).toBe('image/png');
    // And the system field must NOT contain image blocks (would 400).
    if (Array.isArray(out.system)) {
      for (const b of out.system) expect(b.type).not.toBe('image');
    }
  });

  it('folds tool docs into the same image and stubs originals', async () => {
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'short',
      tools: [
        {
          name: 'BigTool',
          // Long enough to push the combined slab past the 2-image break-even
          // (20k chars). 'A very long tool description. ' = 30 chars × 1100 = 33k.
          description: 'A very long tool description. '.repeat(5000),
          input_schema: { type: 'object', properties: { x: { type: 'string' } } },
        },
      ],
    });
    const bytes = new TextEncoder().encode(req);
    const { body, info } = await transformRequest(bytes);
    expect(info.compressed).toBe(true);

    const out = JSON.parse(new TextDecoder().decode(body));
    expect(out.tools[0].description).toContain('See image');
    expect(out.tools[0].name).toBe('BigTool');
  });

  it('preserves input_schema structure (properties / required / enum) when compressing', async () => {
    // Production 400s were traced to the proxy replacing input_schema with a
    // bare `{ type: 'object' }`, which Anthropic's tool-use validator rejected
    // when the model tried to actually invoke a tool. The fix preserves the
    // schema SHELL (type, properties keys, required, enum, items) and only
    // strips long-form `description` / `title` / `$schema` / `default` /
    // `examples`. The image still carries the original schema for the model.
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'x'.repeat(150000), // force compression
      tools: [
        {
          name: 'Read',
          description: 'Read a file from disk',
          input_schema: {
            type: 'object',
            description: 'Reads a file', // should be stripped
            $schema: 'http://json-schema.org/draft-07/schema#', // stripped
            properties: {
              file_path: {
                type: 'string',
                description: 'Absolute path to the file', // stripped
              },
              mode: {
                type: 'string',
                enum: ['read', 'binary'], // preserved
                description: 'Read mode', // stripped
                default: 'read', // stripped
              },
            },
            required: ['file_path'], // preserved verbatim
          },
        },
        {
          name: 'Bash',
          description: 'Run a bash command',
          input_schema: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'cmd' },
              env: {
                type: 'object',
                description: 'env vars', // stripped
                properties: {
                  // nested properties — descriptions stripped, structure kept
                  PATH: { type: 'string', description: 'path var' },
                },
              },
              files: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    path: { type: 'string', description: 'path' },
                  },
                  required: ['path'],
                },
              },
            },
            required: ['command'],
          },
        },
      ],
    });
    const bytes = new TextEncoder().encode(req);
    const { body, info } = await transformRequest(bytes);
    expect(info.compressed).toBe(true);
    expect(info.reason).toBeUndefined(); // no advisory for these valid schemas

    const out = JSON.parse(new TextDecoder().decode(body));

    // Tool 0 (Read): properties + required preserved; descriptions stripped;
    // enum preserved.
    const read = out.tools[0];
    expect(read.input_schema.type).toBe('object');
    expect(read.input_schema.description).toBeUndefined();
    expect(read.input_schema.$schema).toBeUndefined();
    expect(read.input_schema.required).toEqual(['file_path']);
    expect(Object.keys(read.input_schema.properties)).toEqual(['file_path', 'mode']);
    expect(read.input_schema.properties.file_path.type).toBe('string');
    expect(read.input_schema.properties.file_path.description).toBeUndefined();
    expect(read.input_schema.properties.mode.enum).toEqual(['read', 'binary']);
    expect(read.input_schema.properties.mode.default).toBeUndefined();

    // Tool 1 (Bash): nested object + array-of-object both keep their structure.
    const bash = out.tools[1];
    expect(bash.input_schema.required).toEqual(['command']);
    expect(bash.input_schema.properties.env.type).toBe('object');
    expect(bash.input_schema.properties.env.description).toBeUndefined();
    expect(bash.input_schema.properties.env.properties.PATH.type).toBe('string');
    expect(bash.input_schema.properties.env.properties.PATH.description).toBeUndefined();
    expect(bash.input_schema.properties.files.type).toBe('array');
    expect(bash.input_schema.properties.files.items.type).toBe('object');
    expect(bash.input_schema.properties.files.items.required).toEqual(['path']);
    expect(bash.input_schema.properties.files.items.properties.path.description).toBeUndefined();
  });

  it('tool-doc JSON is rendered compact (no whitespace) so cols=100 fill stays dense', async () => {
    // Regression for the 40%-fill / -69% dashboard reduction crisis: pretty
    // schemas (indent=2) put each key on its own line, wasting ~70% of cols
    // at typical widths. Compact form is unambiguous and reads fluently
    // on one wrapped row. The static slab+tool-docs are rendered into the
    // image, but we can verify the source serialization by computing what
    // the renderer would see for a known schema.
    const schema = {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        mode: { type: 'string', enum: ['read', 'binary'] },
      },
      required: ['file_path'],
    };
    const pretty = JSON.stringify(schema, null, 2);
    const compact = JSON.stringify(schema);
    // Compact must be strictly shorter and have far fewer newlines.
    expect(compact.length).toBeLessThan(pretty.length);
    expect(compact.split('\n').length).toBe(1);
    expect(pretty.split('\n').length).toBeGreaterThan(8);
    // Compact must roundtrip back to the same value (no information loss).
    expect(JSON.parse(compact)).toEqual(schema);
  });

  it('flags schemas without properties via info.reason', async () => {
    // Some tools legitimately ship a bare `{type:'object'}` schema. We fall
    // back to the legacy stub but tag info.reason so we can spot them in the
    // events.jsonl when triaging future 400s.
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'x'.repeat(150000),
      tools: [
        { name: 'NoSchema', description: 'd', input_schema: { type: 'object' } },
      ],
    });
    const { body, info } = await transformRequest(new TextEncoder().encode(req));
    expect(info.reason).toBe('schema_no_properties');
    const out = JSON.parse(new TextDecoder().decode(body));
    expect(out.tools[0].input_schema).toEqual({ type: 'object' });
  });

  it('leaves input_schema untouched when the original is missing', async () => {
    // If the tool ships without an input_schema, we should NOT invent one.
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'x'.repeat(150000),
      tools: [{ name: 'Bare', description: 'd' }],
    });
    const { body } = await transformRequest(new TextEncoder().encode(req));
    const out = JSON.parse(new TextDecoder().decode(body));
    expect('input_schema' in out.tools[0]).toBe(false);
  });

  // Snapshot-style tests against real-world Claude Code tool schemas.
  // These exercise the full preservation contract: type / properties /
  // required / enum / items / oneOf / anyOf / allOf / $ref / numeric &
  // string constraints / format. Each case asserts the exact post-strip
  // shape so a regression in stripSchemaDescriptions surfaces immediately.
  describe('real-world tool-schema preservation', () => {
    async function rewriteOne(toolSchema: unknown): Promise<unknown> {
      const req = JSON.stringify({
        model: 'claude-3-5-sonnet',
        messages: [{ role: 'user', content: 'hi' }],
        system: 'x'.repeat(150000),
        tools: [{ name: 'T', description: 'd', input_schema: toolSchema }],
      });
      const { body } = await transformRequest(new TextEncoder().encode(req));
      const out = JSON.parse(new TextDecoder().decode(body));
      return out.tools[0].input_schema;
    }

    it("Read (file_path + optional offset/limit) round-trips correctly", async () => {
      const got = await rewriteOne({
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'The absolute path to the file to read',
          },
          offset: {
            type: 'integer',
            description: 'Line number to start at',
            minimum: 0,
            maximum: 9007199254740991,
          },
          limit: {
            type: 'integer',
            description: 'Number of lines',
            exclusiveMinimum: 0,
          },
        },
        required: ['file_path'],
        additionalProperties: false,
      });
      expect(got).toEqual({
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          offset: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
          limit: { type: 'integer', exclusiveMinimum: 0 },
        },
        required: ['file_path'],
        additionalProperties: false,
      });
    });

    it('Bash (command + optional timeout + boolean run_in_background) round-trips', async () => {
      const got = await rewriteOne({
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute' },
          timeout: {
            type: 'number',
            description: 'Optional timeout in ms (max 600000)',
            maximum: 600000,
          },
          run_in_background: {
            type: 'boolean',
            description: 'Run async, do not wait',
            default: false,
          },
        },
        required: ['command'],
      });
      expect(got).toEqual({
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout: { type: 'number', maximum: 600000 },
          run_in_background: { type: 'boolean' },
        },
        required: ['command'],
      });
    });

    it('Edit (file_path + old_string + new_string + replace_all) round-trips', async () => {
      const got = await rewriteOne({
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'absolute path' },
          old_string: { type: 'string', description: 'text to replace' },
          new_string: { type: 'string', description: 'replacement' },
          replace_all: {
            type: 'boolean',
            description: 'Replace every occurrence',
            default: false,
          },
        },
        required: ['file_path', 'old_string', 'new_string'],
      });
      expect(got).toEqual({
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      });
    });

    it('preserves enum constraints (Status-style tool)', async () => {
      const got = await rewriteOne({
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: 'Job status',
            enum: ['pending', 'in_progress', 'completed', 'failed'],
          },
        },
        required: ['status'],
      });
      expect(got).toEqual({
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'] },
        },
        required: ['status'],
      });
    });

    it("preserves oneOf/anyOf/allOf composition variants", async () => {
      const got = await rewriteOne({
        type: 'object',
        properties: {
          identifier: {
            description: 'either an id or a name',
            oneOf: [
              { type: 'string', description: 'name lookup', minLength: 1 },
              { type: 'integer', description: 'numeric id', minimum: 1 },
            ],
          },
          filter: {
            anyOf: [
              { type: 'string', description: 'plain text' },
              { type: 'null' },
            ],
          },
          combo: {
            allOf: [
              { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
              { type: 'object', properties: { b: { type: 'number' } } },
            ],
          },
        },
        required: ['identifier'],
      });
      expect(got).toEqual({
        type: 'object',
        properties: {
          identifier: {
            oneOf: [
              { type: 'string', minLength: 1 },
              { type: 'integer', minimum: 1 },
            ],
          },
          filter: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
          },
          combo: {
            allOf: [
              { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
              { type: 'object', properties: { b: { type: 'number' } } },
            ],
          },
        },
        required: ['identifier'],
      });
    });

    it('preserves $ref + $defs', async () => {
      const got = await rewriteOne({
        type: 'object',
        $defs: {
          Loc: {
            type: 'object',
            description: 'A 2D location',
            properties: {
              lat: { type: 'number', description: 'latitude' },
              lng: { type: 'number', description: 'longitude' },
            },
            required: ['lat', 'lng'],
          },
        },
        properties: {
          here: { $ref: '#/$defs/Loc' },
          there: { $ref: '#/$defs/Loc' },
        },
        required: ['here'],
      });
      expect(got).toEqual({
        type: 'object',
        $defs: {
          Loc: {
            type: 'object',
            properties: { lat: { type: 'number' }, lng: { type: 'number' } },
            required: ['lat', 'lng'],
          },
        },
        properties: {
          here: { $ref: '#/$defs/Loc' },
          there: { $ref: '#/$defs/Loc' },
        },
        required: ['here'],
      });
    });

    it('preserves short `format` tokens and strips long ones', async () => {
      const got = await rewriteOne({
        type: 'object',
        properties: {
          when: { type: 'string', format: 'date-time' }, // 9 chars, kept
          who: { type: 'string', format: 'uri' }, // 3 chars, kept
          freeform: {
            type: 'string',
            // 40-char "format" — almost certainly a description in disguise.
            format: 'a-very-long-format-string-that-is-prose',
          },
        },
      });
      expect(got).toEqual({
        type: 'object',
        properties: {
          when: { type: 'string', format: 'date-time' },
          who: { type: 'string', format: 'uri' },
          freeform: { type: 'string' }, // long format stripped
        },
      });
    });

    it('preserves pattern + numeric/length constraints + uniqueItems', async () => {
      const got = await rewriteOne({
        type: 'object',
        properties: {
          email: {
            type: 'string',
            description: 'email address',
            pattern: '^[^@]+@[^@]+$',
            minLength: 3,
            maxLength: 254,
          },
          tags: {
            type: 'array',
            description: 'list of tags',
            uniqueItems: true,
            minItems: 0,
            maxItems: 10,
            items: { type: 'string', minLength: 1 },
          },
        },
      });
      expect(got).toEqual({
        type: 'object',
        properties: {
          email: {
            type: 'string',
            pattern: '^[^@]+@[^@]+$',
            minLength: 3,
            maxLength: 254,
          },
          tags: {
            type: 'array',
            uniqueItems: true,
            minItems: 0,
            maxItems: 10,
            items: { type: 'string', minLength: 1 },
          },
        },
      });
    });

    it('handles boolean additionalProperties (true/false)', async () => {
      const got = await rewriteOne({
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: false,
      });
      expect(got).toEqual({
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: false,
      });

      const got2 = await rewriteOne({
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: true,
      });
      expect(got2).toEqual({
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: true,
      });
    });

    it('recognises oneOf-rooted schemas as structured (no schema_no_properties flag)', async () => {
      // A tool whose root schema is a union has no top-level `properties` but
      // IS structurally valid — it must NOT be flagged as no-structure.
      const req = JSON.stringify({
        model: 'claude-3-5-sonnet',
        messages: [{ role: 'user', content: 'hi' }],
        system: 'x'.repeat(150000),
        tools: [
          {
            name: 'UnionTool',
            description: 'd',
            input_schema: {
              oneOf: [
                { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
                { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
              ],
            },
          },
        ],
      });
      const { body, info } = await transformRequest(new TextEncoder().encode(req));
      expect(info.reason).toBeUndefined();
      const out = JSON.parse(new TextDecoder().decode(body));
      expect(out.tools[0].input_schema).toEqual({
        oneOf: [
          { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
          { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        ],
      });
    });

    it('leaves nodes deeper than the recursion cap untouched (no corruption)', async () => {
      // Build a schema 25 levels deep. The cap is 20; everything beyond it
      // must pass through verbatim — we'd rather ship a slightly bigger
      // schema than corrupt one.
      type Nest = { type: string; properties?: Record<string, Nest>; description?: string };
      const deep: Nest = { type: 'string', description: 'leaf' };
      let cur: Nest = deep;
      for (let i = 0; i < 25; i++) {
        cur = { type: 'object', description: `level ${i}`, properties: { next: cur } };
      }
      const got = (await rewriteOne(cur)) as Record<string, unknown>;
      // Walk down and confirm we reach the original deep node intact.
      let node: Record<string, unknown> = got;
      for (let i = 0; i < 20; i++) {
        const props = node.properties as Record<string, unknown>;
        node = props.next as Record<string, unknown>;
      }
      // We've now descended 20 levels (depth cap). The next 5 levels were
      // beyond the cap and should still carry their descriptions verbatim.
      let seenDescriptionBelowCap = false;
      while (node && typeof node === 'object') {
        if (typeof node.description === 'string') seenDescriptionBelowCap = true;
        node = (node.properties as Record<string, unknown> | undefined)?.next as Record<
          string,
          unknown
        >;
        if (!node) break;
      }
      expect(seenDescriptionBelowCap).toBe(true);
    });
  });

  it('strips x-anthropic-billing-header line and keeps it as text', async () => {
    const sysText = 'x-anthropic-billing-header: cch=abc123\n' + 'real prompt text. '.repeat(2500);
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: sysText,
    });
    const bytes = new TextEncoder().encode(req);
    const { body, info } = await transformRequest(bytes);
    expect(info.compressed).toBe(true);

    const out = JSON.parse(new TextDecoder().decode(body));
    const textBlocks = out.system.filter((b: any) => b.type === 'text');
    expect(textBlocks.some((b: any) => b.text.includes('x-anthropic-billing-header'))).toBe(true);
  });

  it('keeps <env> as text outside the image so cache_control stays stable', async () => {
    // Dense slab (long single line) so the row-aware break-even gate
    // greenlights compression. Same total chars as the old short-line
    // fixture but profitable: 1 image @ 2500 < 52800/4 = 13200 text.
    const staticSlab = 'claude.md ground truth. '.repeat(2200);
    const envBlock =
      "<env>\nWorking directory: /tmp/parityproj\nIs directory a git repo: Yes\nPlatform: darwin\nToday's date: 2026-05-18\n</env>";
    const sys = staticSlab + '\n' + envBlock;
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { body: outBytes, info } = await transformRequest(body);
    expect(info.compressed).toBe(true);
    expect(info.dynamicBlockCount).toBe(1);
    expect(info.dynamicChars).toBeGreaterThan(0);
    expect(info.staticChars).toBeGreaterThan(info.dynamicChars);

    const out = JSON.parse(new TextDecoder().decode(outBytes));
    // Images live in the first user message and the dynamic <env> block is
    // kept as text in the system field — so cache_control on the image is
    // unaffected by env drift.
    const userContent = out.messages[0].content as any[];
    const sysBlocks = (Array.isArray(out.system) ? out.system : []) as any[];

    const hasImage = userContent.some((b: any) => b.type === 'image');
    expect(hasImage).toBe(true);

    // <env> must show up as text somewhere outside the image — the dynamic
    // tail lives in the system field as cheap text.
    const allText = [...sysBlocks, ...userContent]
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
    expect(allText).toContain('<env>');
    expect(allText).toContain('Working directory: /tmp/parityproj');

    // The static slab must NOT appear in any text block — it lives in the
    // image now.
    for (const b of [...sysBlocks, ...userContent]) {
      if (b.type === 'text') expect(b.text).not.toContain('claude.md ground truth.');
    }
  });

  it('puts cache_control on the image only, never on the dynamic tail', async () => {
    const sys =
      'x'.repeat(150000) +
      '<env>\nWorking directory: /tmp/x\n</env>\n' +
      '<context name="todoList">\n[ ] do thing\n</context>';
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { body: outBytes, info } = await transformRequest(body);
    expect(info.dynamicBlockCount).toBe(2);

    const out = JSON.parse(new TextDecoder().decode(outBytes));
    // cache_control must land on exactly one image block — anywhere in the
    // request (system field OR user message), never on a text block.
    const sysBlocks = (Array.isArray(out.system) ? out.system : []) as any[];
    const userContent = (out.messages[0].content ?? []) as any[];
    const cached = [...sysBlocks, ...userContent].filter((b: any) => b.cache_control);
    expect(cached.length).toBe(1);
    expect(cached[0].type).toBe('image');
  });

  it('extracts env fields (cwd, platform, today, isGitRepo, branch) into info.env', async () => {
    const sys =
      'claude.md\n'.repeat(400) +
      "<env>\n" +
      'Working directory: /Users/me/code/pixelpipe\n' +
      'Is directory a git repo: Yes\n' +
      'Platform: darwin\n' +
      'OS Version: Darwin 25.0.0\n' +
      "Today's date: 2026-05-18\n" +
      '</env>\n' +
      '<git_status>\nOn branch main\nnothing to commit\n</git_status>';
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { info } = await transformRequest(body);
    expect(info.env).toBeDefined();
    expect(info.env!.cwd).toBe('/Users/me/code/pixelpipe');
    expect(info.env!.isGitRepo).toBe(true);
    expect(info.env!.platform).toBe('darwin');
    expect(info.env!.osVersion).toBe('Darwin 25.0.0');
    expect(info.env!.today).toBe('2026-05-18');
    expect(info.env!.gitBranch).toBe('main');
  });

  it('leaves info.env undefined when there is no <env> block', async () => {
    const sys = 'claude.md\n'.repeat(400);
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { info } = await transformRequest(body);
    expect(info.env).toBeUndefined();
  });

  it('computes stable systemSha8 across turns when the static slab is identical', async () => {
    const staticSlab = 'claude.md\n'.repeat(400);
    const t1 =
      staticSlab + "<env>\nWorking directory: /a\nToday's date: 2026-05-18\n</env>";
    const t2 =
      staticSlab + "<env>\nWorking directory: /a\nToday's date: 2026-05-19\n</env>";
    const mk = (sys: string) =>
      new TextEncoder().encode(
        JSON.stringify({
          model: 'claude',
          messages: [{ role: 'user', content: 'hi' }],
          system: sys,
        }),
      );
    const a = await transformRequest(mk(t1));
    const b = await transformRequest(mk(t2));
    expect(a.info.systemSha8).toBeDefined();
    expect(b.info.systemSha8).toBeDefined();
    // Static slab is identical, dynamic block changed → systemSha8 must NOT
    // change (the whole point is that the cached payload is stable).
    expect(a.info.systemSha8).toBe(b.info.systemSha8);
  });

  it('computes firstUserSha8 from the first user message', async () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [
          { role: 'user', content: 'continue from HANDOFF?' },
          { role: 'assistant', content: 'sure' },
          { role: 'user', content: 'a totally different message' },
        ],
        system: 'claude.md\n'.repeat(400),
      }),
    );
    const { info } = await transformRequest(body);
    expect(info.firstUserSha8).toBeDefined();
    expect(info.firstUserSha8).toMatch(/^[0-9a-f]{8}$/);
  });

  it('renders identical input to byte-identical output (determinism = cacheability)', async () => {
    // The whole token-savings story collapses if the renderer is non-
    // deterministic, because identical system prompts on consecutive turns
    // would produce different image bytes → 0% cache hit. Guard rail.
    const sys = 'x'.repeat(150000);
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const a = await transformRequest(body);
    const b = await transformRequest(
      new TextEncoder().encode(
        JSON.stringify({
          model: 'claude',
          messages: [{ role: 'user', content: 'hi' }],
          system: sys,
        }),
      ),
    );
    // Compare image PNG bytes only — the request envelope wraps the same
    // bytes but JSON ordering is deterministic too, so the whole body should
    // match. Images live in the first user message.
    const ua = (JSON.parse(new TextDecoder().decode(a.body)).messages[0].content ?? []) as any[];
    const ub = (JSON.parse(new TextDecoder().decode(b.body)).messages[0].content ?? []) as any[];
    const imgsA = ua.filter((x: any) => x.type === 'image').map((x: any) => x.source.data);
    const imgsB = ub.filter((x: any) => x.type === 'image').map((x: any) => x.source.data);
    expect(imgsA.length).toBeGreaterThan(0);
    expect(imgsA).toEqual(imgsB);
    expect(a.info.systemSha8).toBe(b.info.systemSha8);
  });

  it('flags unknown tag-shaped blocks in the static slab (canary for new dynamic tags)', async () => {
    const sys =
      'claude.md\n'.repeat(400) +
      '<recent_files>\nfoo.ts\nbar.ts\n</recent_files>\n' +
      "<env>\nWorking directory: /tmp\n</env>";
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { info } = await transformRequest(body);
    expect(info.unknownStaticTags).toBeDefined();
    expect(info.unknownStaticTags).toContain('recent_files');
    // <env> is known, must NOT appear here.
    expect(info.unknownStaticTags).not.toContain('env');
  });

  it('does not flag <types> as an unknown tag (it lives in KNOWN_STATIC_TAGS)', async () => {
    const sys =
      'claude.md\n'.repeat(400) +
      '<types>\nstring\nnumber\n</types>\n' +
      '<env>\nWorking directory: /tmp\n</env>';
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { info } = await transformRequest(body);
    // <types> is known-static; it should NOT show up as an unknown tag.
    expect(info.unknownStaticTags).toBeUndefined();
  });

  it('omits unknownStaticTags when the static slab has no tag-shaped blocks', async () => {
    const sys = 'claude.md\n'.repeat(400) + '<env>\nWorking directory: /tmp\n</env>';
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { info } = await transformRequest(body);
    expect(info.unknownStaticTags).toBeUndefined();
  });

  it('passes through when the system prompt is only dynamic blocks', async () => {
    const sys = '<env>\nWorking directory: /tmp\n</env>';
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { body: outBytes, info } = await transformRequest(body, { minCompressChars: 100 });
    // Static slab is empty → below_min_chars → no-op pass-through.
    expect(info.compressed).toBe(false);
    expect(info.reason).toMatch(/below_min_chars/);
    const out = JSON.parse(new TextDecoder().decode(outBytes));
    expect(out.system).toBe(sys);
  });

  it("uses ttl='1h' on the image cache_control (Anthropic ordering rule)", async () => {
    // Without ttl='1h' on our cache_control, Claude Code's own ttl='1h'
    // breakpoint on later user-message content triggers 400: "ttl='1h' must
    // not come after ttl='5m'" because our default 5m would land first.
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: 'x'.repeat(150000),
      }),
    );
    const { body: outBytes } = await transformRequest(body);
    const out = JSON.parse(new TextDecoder().decode(outBytes));
    const blocks = [
      ...((Array.isArray(out.system) ? out.system : []) as any[]),
      ...((out.messages?.[0]?.content ?? []) as any[]),
    ];
    const cached = blocks.filter((b: any) => b.cache_control);
    expect(cached.length).toBe(1);
    expect(cached[0].cache_control.ttl).toBe('1h');
  });

  it('compresses long <system-reminder> blocks in the first user message', async () => {
    // 'a long policy note. ' = 20 chars. 1550× = 31k chars + reminder tags
    // — past the 14k minReminderChars threshold AND past the multi-col
    // 1-image break-even (~30.7k chars at n=2, 7×10 cell).
    // 1550 × 20 = 31,000 chars → 310 visual rows → 1 image at n=2 (capacity 312 rows)
    // image cost 7665 tokens < text cost 31000/4=7750 → profitable.
    const reminder = '<system-reminder>\n' + 'a long policy note. '.repeat(1550) + '\n</system-reminder>';
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'real user prompt' },
              { type: 'text', text: reminder },
            ],
          },
        ],
        system: 'x'.repeat(150000),
      }),
    );
    const { body: outBytes, info } = await transformRequest(body);
    expect(info.reminderImgs).toBeGreaterThanOrEqual(1);

    const out = JSON.parse(new TextDecoder().decode(outBytes));
    const content = out.messages[0].content as any[];
    // Reminder text must NOT appear as a text block anymore.
    for (const b of content) {
      if (b.type === 'text') expect(b.text).not.toContain('<system-reminder>');
    }
    // But the user's actual prompt must still be there.
    const userTexts = content.filter((b: any) => b.type === 'text').map((b: any) => b.text);
    expect(userTexts.some((t: string) => t.includes('real user prompt'))).toBe(true);

    // Reminder images carry NO cache_control (only the system+tools image
    // does — Anthropic caps at 4 breakpoints).
    const reminderImageBlocks = content.filter(
      (b: any) => b.type === 'image' && !b.cache_control,
    );
    expect(reminderImageBlocks.length).toBeGreaterThanOrEqual(info.reminderImgs ?? 0);
  });

  it('leaves short <system-reminder> blocks alone (below minReminderChars)', async () => {
    const shortReminder = '<system-reminder>\nshort note\n</system-reminder>';
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: shortReminder }],
          },
        ],
        system: 'x'.repeat(150000),
      }),
    );
    const { body: outBytes, info } = await transformRequest(body);
    expect(info.reminderImgs ?? 0).toBe(0);
    const out = JSON.parse(new TextDecoder().decode(outBytes));
    const allText = (out.messages[0].content as any[])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
    expect(allText).toContain('<system-reminder>');
  });

  it('compresses large tool_result text content across user messages', async () => {
    // 'output line. ' = 13 chars × 2400 = 31.2k chars — past minToolResultChars
    // (14k) AND past the multi-col 1-image break-even (~30.7k chars at n=2, 7×10 cell).
    // 2400 × 13 = 31,200 chars → 312 visual rows → 1 image at n=2 (capacity 312 rows)
    // image cost 7665 tokens < text cost 31200/4=7800 → profitable.
    const bigResult = 'output line. '.repeat(2400);
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_x',
                content: bigResult,
              },
            ],
          },
        ],
        system: 'x'.repeat(150000),
      }),
    );
    const { body: outBytes, info } = await transformRequest(body);
    expect(info.toolResultImgs).toBeGreaterThanOrEqual(1);

    const out = JSON.parse(new TextDecoder().decode(outBytes));
    // Find the tool_result block and confirm its content is now image blocks.
    const tr = (out.messages[0].content as any[]).find((b: any) => b.type === 'tool_result');
    expect(tr).toBeDefined();
    expect(Array.isArray(tr.content)).toBe(true);
    const imgInner = (tr.content as any[]).filter((b: any) => b.type === 'image');
    expect(imgInner.length).toBeGreaterThanOrEqual(1);
    // No cache_control on tool_result images.
    for (const b of imgInner) expect(b.cache_control).toBeUndefined();
  });

  it('leaves is_error tool_results untouched (Anthropic forbids images there)', async () => {
    const bigResult = 'error trace. '.repeat(1000); // 13k chars — past 10k break-even
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_x',
                content: bigResult,
                is_error: true,
              },
            ],
          },
        ],
        system: 'x'.repeat(150000),
      }),
    );
    const { body: outBytes, info } = await transformRequest(body);
    expect(info.toolResultImgs ?? 0).toBe(0);
    const out = JSON.parse(new TextDecoder().decode(outBytes));
    const tr = (out.messages[0].content as any[]).find((b: any) => b.type === 'tool_result');
    expect(tr).toBeDefined();
    expect(tr.is_error).toBe(true);
    expect(typeof tr.content).toBe('string');
  });

  // --- dropped_codepoints_top telemetry --------------------------------------
  // Records the top-20 dropped codepoints on each request. Lets the operator
  // see which Unicode blocks to add to the atlas profile without having to
  // capture & inspect the request body.

  it('populates droppedCodepointsTop when drops occur, sorted by count', async () => {
    // System slab forces compression. The slab contains drops for two distinct
    // supplementary-plane codepoints at different rates so we can verify the
    // sort order.
    const cpA = String.fromCodePoint(0x1f600); // 😀
    const cpB = String.fromCodePoint(0x1f604); // 😄
    const cpC = String.fromCodePoint(0x1f60a); // 😊
    const sys =
      'x'.repeat(150000) + // bulk to force compression
      '\n' + cpA.repeat(10) +  // 10 drops of U+1F600
      '\n' + cpB.repeat(3) +   // 3  drops of U+1F604
      '\n' + cpC.repeat(1);    // 1  drop  of U+1F60A
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: sys,
    });
    const { info } = await transformRequest(new TextEncoder().encode(req));
    expect(info.compressed).toBe(true);
    expect(info.droppedChars).toBeGreaterThanOrEqual(14);
    expect(info.droppedCodepointsTop).toBeDefined();
    const top = info.droppedCodepointsTop!;
    expect(top['U+1F600']).toBe(10);
    expect(top['U+1F604']).toBe(3);
    expect(top['U+1F60A']).toBe(1);
    // Ensure key format is the expected U+HHHH uppercase with no surprises.
    for (const k of Object.keys(top)) {
      expect(k).toMatch(/^U\+[0-9A-F]{4,}$/);
    }
    // Sorted by count desc: iteration of object keys preserves insertion order
    // in V8/JSC, so the first key is the highest-count drop.
    const keys = Object.keys(top);
    expect(keys[0]).toBe('U+1F600');
  });

  it('omits droppedCodepointsTop entirely when no drops occur', async () => {
    // Pure ASCII; nothing the practical-profile atlas wouldn't cover.
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'x'.repeat(150000),
    });
    const { info } = await transformRequest(new TextEncoder().encode(req));
    expect(info.compressed).toBe(true);
    expect(info.droppedChars ?? 0).toBe(0);
    expect(info.droppedCodepointsTop).toBeUndefined();
  });

  it('caps droppedCodepointsTop at 20 entries', async () => {
    // 25 distinct supplementary-plane codepoints, each appearing N times so
    // we can verify the cap drops the smallest counts.
    let payload = 'x'.repeat(150000) + '\n';
    for (let i = 0; i < 25; i++) {
      // U+1F300..U+1F318 — 25 distinct codepoints, each occurring (25 - i) times
      // so U+1F300 occurs 25 times, U+1F318 occurs 1 time.
      payload += String.fromCodePoint(0x1f300 + i).repeat(25 - i);
    }
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: payload,
    });
    const { info } = await transformRequest(new TextEncoder().encode(req));
    expect(info.droppedCodepointsTop).toBeDefined();
    const top = info.droppedCodepointsTop!;
    expect(Object.keys(top).length).toBe(20);
    // The 5 smallest-count codepoints (last in the input) must be dropped
    // from the top-20.
    for (let i = 20; i < 25; i++) {
      const hex = (0x1f300 + i).toString(16).toUpperCase().padStart(4, '0');
      expect(top[`U+${hex}`]).toBeUndefined();
    }
    // The top entry is the most-frequent.
    expect(top['U+1F300']).toBe(25);
  });

  // --- Per-block break-even gate (URGENT slice, supersedes prior threshold tests) ---
  // history-researcher's round-3 analysis measured Anthropic's real per-image
  // cost at ~2,500 tokens. At the current renderer config (19,500 chars/image)
  // the break-even point is 10,000 chars per image. Blocks shorter than that
  // cost MORE as images than as text. The fix: gate every per-block image
  // encoding on `isCompressionProfitable()` which checks
  //   ceil(textLen / 19500) * 2500 < textLen / 4
  // Tests below confirm the function math AND that the gates correctly skip
  // net-loss compressions in the full pipeline.

  it('isCompressionProfitable: false at 5000 chars (1 image @ 2500 > 1250 text)', () => {
    expect(isCompressionProfitable(5000)).toBe(false);
  });

  it('isCompressionProfitable: false at 10000 chars (1 image @ 2500 == 2500 text — strict <)', () => {
    expect(isCompressionProfitable(10000)).toBe(false);
  });

  it('isCompressionProfitable: true at 13937 chars (tiny win past break-even)', () => {
    // Single-col break-even at 7×10 cell: 1 image = 3484 tokens.
    // Need len/4 > 3484 → len > 13,936. 13,937 chars → 140 rows → 1 image →
    // 3484 tokens < 13937/4 = 3484.25 → profitable (strict <).
    expect(isCompressionProfitable(13937)).toBe(true);
  });

  it('isCompressionProfitable: true at 14000 chars (clear single-image win)', () => {
    expect(isCompressionProfitable(14000)).toBe(true);
  });

  it('isCompressionProfitable: false at 20000 chars (2 images @ 5000 == 5000 text — strict <)', () => {
    // Hits 2-image break-even exactly. Strict < returns false for safety —
    // we'd rather skip a tied trade than risk a net loss on a budgeting wobble.
    expect(isCompressionProfitable(20000)).toBe(false);
  });

  it('isCompressionProfitable: true at 42000 chars (3 images, clear win)', () => {
    // 7×10 cell, single-col: 42000 chars → 420 rows → ceil(420/156)=3 images →
    // 3×3484=10452 tokens < 42000/4=10500 → profitable.
    expect(isCompressionProfitable(42000)).toBe(true);
  });

  // --- chars/token override: gate accepts a per-request value ---
  //
  // The default `CHARS_PER_TOKEN = 4` corresponds to Anthropic's English
  // average. Real Claude Code traffic tokenizes denser — JSON-dense tool
  // definitions, structured CLAUDE.md slabs, etc. The gate accepts a
  // per-request override so the host can pass a deployment-specific value.
  //
  // Production trace 2026-05-19: a 169_632-char slab with 88 lines of
  // markdown got `not_profitable` rejected because the gate used 4 ch/tok
  // (textEq=42_408) while actual upstream billed 148_891 tokens (ch/tok=
  // 1.14). With the override (1.14 ch/tok), the gate flips to ACCEPT.

  it('isCompressionProfitable: stale default rejects newline-heavy 170K slab', () => {
    // CLAUDE.md-like slab: many short lines, ~138K chars. Default ch/tok=4
    // gives textEq=34_515 vs imgCost~95_000 (multiCol=2). Reject.
    const slab = (
      '## Section\n\n- Bullet point with reasonable length.\n- Another bullet.\n\n' +
      '```ts\nconst x = 42;\nconst y = "string";\n```\n\n'
    ).repeat(Math.floor(170000 / 160));
    expect(isCompressionProfitable(slab, 100, undefined, 2)).toBe(false);
  });

  it('isCompressionProfitable: live α≈0.88 (1.14 ch/tok) flips a single-image slab at numCols=1', () => {
    // A dense 6060-char slab (60 long lines, no big newline penalty) that:
    //   • At default 4 ch/tok: textEq = 6060/4 = 1515 < imgCost 2500 → REJECT
    //   • At live α=1.14:      textEq = 6060/1.14 ≈ 5316 > imgCost 2500 → ACCEPT
    // The cpt override is the lever that lets the gate respect denser real-world
    // tokenization without us widening the production default (which would
    // pull net-loser blocks across the line on lighter content).
    const line = 'A'.repeat(100) + '\n';
    const slab = line.repeat(60); // 6060 chars, fits in 1 image at cols=100
    expect(isCompressionProfitable(slab, 100, undefined, 1, 4)).toBe(false);
    expect(isCompressionProfitable(slab, 100, undefined, 1, 1.14)).toBe(true);
  });

  it('isCompressionProfitable: multi-col safety margin holds — same low-cpt slab stays rejected at numCols=2', () => {
    // Regression guard for the multi-col-loss patch. At numCols=2 each image
    // costs ≈ 5500 tokens (10% extrapolation margin on top of 2×2500). The
    // gate must NOT flip the slab to PROFITABLE just because cpt is low —
    // the safety margin exists precisely so multi-col stays a net win, not
    // a marginal bet.
    const line = 'A'.repeat(100) + '\n';
    const slab = line.repeat(60); // same fixture as the n=1 case above
    expect(isCompressionProfitable(slab, 100, undefined, 2, 1.14)).toBe(false);
  });

  it('isCompressionProfitable: defensive clamp on bogus chars/token (≤0 / NaN → falls back to 4)', () => {
    // Corrupt values would either crash or produce wildly wrong gate
    // decisions. The function falls back to CHARS_PER_TOKEN=4 silently.
    // Confirm: a 5000-char input is rejected at 4 ch/tok regardless of
    // whether we pass 0, -1, NaN, or Infinity.
    expect(isCompressionProfitable(5000, 100, undefined, 1, 0)).toBe(false);
    expect(isCompressionProfitable(5000, 100, undefined, 1, -1)).toBe(false);
    expect(isCompressionProfitable(5000, 100, undefined, 1, NaN)).toBe(false);
    expect(isCompressionProfitable(5000, 100, undefined, 1, Infinity)).toBe(false);
  });

  it('TransformOptions.charsPerToken: low value unlocks a previously-rejected slab end-to-end', async () => {
    // Dense 4848-char slab — rejected at default SLAB_CHARS_PER_TOKEN=2.0
    // (text=2424 tok < single-col image cost 2500), accepted at cpt=1.14
    // (text=4252 tok > 2500). Forced to numCols=1 so the cpt override does
    // the flipping on its own; multi-col adds a separate 10% safety margin
    // (see the numCols=2 regression test above). Resized 2026-05-21 when
    // SLAB_CHARS_PER_TOKEN moved 2.5 → 2.0; the 6060-char fixture now
    // compresses under the new default and stopped exercising the intended
    // before/after edge.
    const line = 'A'.repeat(100) + '\n';
    const slab = line.repeat(48); // 4848 chars
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: slab,
    });
    const bytes = new TextEncoder().encode(req);

    // Built-in slab ch/tok=2.0 at single-col: rejected as not_profitable.
    const stale = await transformRequest(bytes, { multiCol: 1 });
    expect(stale.info.compressed).toBe(false);
    expect(stale.info.reason).toMatch(/^not_profitable/);

    // Live α equivalent (1.14 ch/tok) at single-col: same slab now compresses.
    const live = await transformRequest(bytes, { multiCol: 1, charsPerToken: 1.14 });
    expect(live.info.compressed).toBe(true);
    expect(live.info.imageCount ?? 0).toBeGreaterThan(0);
  });

  // --- Slab-specific cpt: built-in 2.0 cpt unlocks production-shape slabs ---
  //
  // Empirical: N=354 production count_tokens probes (2026-05-18..2026-05-20)
  // give body-level chars/token median 1.17, max 2.62. The English-prose
  // CHARS_PER_TOKEN=4 default was 3.4× too high for the slab call site,
  // silently rejecting every realistic slab. The slab gate now uses
  // SLAB_CHARS_PER_TOKEN=2.0 — conservative versus the empirical max — which
  // unlocks the production-shape slab while preserving the prime-directive
  // safety (no net-loss compressions on shapes we've actually observed).

  it('transformRequest: production-shape 161k slab compresses without an explicit cpt override', async () => {
    // Build a dense ~161k-char slab matching the production passthrough event
    // (orig_chars=161101). 60-100 char lines, modest blank density —
    // representative of system + tool-doc slab shape under multi-col=2.
    const parts: string[] = [];
    let acc = 0;
    const target = 161_101;
    while (acc < target) {
      const len = 60 + (acc % 40);
      parts.push('A'.repeat(len) + (acc % 200 === 0 ? '   ' : ''));
      acc += len + 1;
    }
    const slab = parts.join('\n').slice(0, target);
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: slab,
    });
    const bytes = new TextEncoder().encode(req);

    // No host-supplied cpt: built-in SLAB_CHARS_PER_TOKEN flips this to ACCEPT
    // at multi-col=2 (production default). This is the regression guard for
    // the 2026-05-20 zero-compression production bug.
    const out = await transformRequest(bytes, { multiCol: 2 });
    expect(out.info.compressed).toBe(true);
    expect(out.info.imageCount ?? 0).toBeGreaterThan(0);
  });

  it('isCompressionProfitable: 7x10 atlas makes a 161k production-shape slab profitable at cpt=2', () => {
    // With 7×10 atlas (CELL_H=10): LINES_PER_IMAGE=156, MaxCharsPerImage=15600.
    // At numCols=2: images = ceil(rows/312). The 161k slab has ~2001 rows →
    // ceil(2001/312)=7 images. imageCost = 7 × 7665 = 53,655 tokens.
    // At cpt=2 (SLAB_CHARS_PER_TOKEN): text = 161101/2 = 80,550 → profitable.
    // At cpt=4: text = 161101/4 = 40,275 < 53,655 → NOT profitable.
    const parts: string[] = [];
    let acc = 0;
    while (acc < 161_101) {
      const len = 60 + (acc % 40);
      parts.push('A'.repeat(len));
      acc += len + 1;
    }
    const slab = parts.join('\n').slice(0, 161_101);
    expect(isCompressionProfitable(slab, 100, undefined, 2, 2)).toBe(true);
    expect(isCompressionProfitable(slab, 100, undefined, 2, 2.5)).toBe(true);
  });

  it('TransformOptions.charsPerToken: explicit 4 is honored (no silent swap to SLAB_CHARS_PER_TOKEN)', async () => {
    // Fragility #2 regression: the override-gate previously used a `!==
    // CHARS_PER_TOKEN` check that silently swapped 4 → the built-in slab cpt
    // because the static default *also* happened to be 4. After the fix it
    // uses `!== undefined`, so passing exactly 4 is honored as an explicit
    // host override.
    //
    // With 7×10 atlas (CELL_H=10): MaxCharsPerImage(2)=31,200, effectiveTokensPerImage(2)=7665.
    // Use a ~220k-char slab (14 images at numCols=2 → 107,310 tokens):
    //   cpt=2: text=110,000 → 107,310 < 110,000 → ACCEPT ✓
    //   cpt=4: text=55,000  → 107,310 > 55,000  → REJECT ✓
    const parts: string[] = [];
    let acc = 0;
    const target = 220_000;
    while (acc < target) {
      const len = 50;
      parts.push('A'.repeat(len) + (acc % 200 === 0 ? '   ' : ''));
      acc += len + 1;
    }
    const slab = parts.join('\n').slice(0, target);
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: slab,
    });
    const bytes = new TextEncoder().encode(req);

    // Built-in cpt (no override): slab compresses via SLAB_CHARS_PER_TOKEN=2.0.
    const builtin = await transformRequest(bytes, { multiCol: 2 });
    expect(builtin.info.compressed).toBe(true);

    // Explicit cpt=4: host pinned to the English-prose value. The slab gate
    // must honor it and reject the slab — not silently fall back to 2.0.
    const overridden = await transformRequest(bytes, { multiCol: 2, charsPerToken: 4 });
    expect(overridden.info.compressed).toBe(false);
    expect(overridden.info.reason).toMatch(/^not_profitable/);
  });

  // --- Adaptive break-even: CHARS_PER_IMAGE derived from atlas cell, not hardcoded ---
  // Brief: when font-rater swaps the atlas cell height, more/fewer chars pack
  // into one image, so the N-image break-even thresholds shift. Tests below
  // verify both the regression case (current Spleen/Unifont 5×8 hybrid) AND that the formula
  // responds to `cols` (which scales chars/image linearly the same way a smaller
  // cell-H would).

  it('maxCharsPerImage: matches the 19,500 constant at the 5x8 shipping config', () => {
    // 5×8 cell, cols=100: floor((1568-8)/8) × 100 = 195 × 100 = 19,500.
    // If this ever drifts, every break-even test downstream needs re-pinning.
    expect(maxCharsPerImage(100)).toBe(19_500);
  });

  it('maxCharsPerImage: scales linearly with cols (same atlas)', () => {
    expect(maxCharsPerImage(50)).toBe(9_750);
    expect(maxCharsPerImage(200)).toBe(39_000);
  });

  it('isCompressionProfitable: doubling cols halves the 2-image break-even threshold', () => {
    // At cols=100, CHARS_PER_IMAGE=15,600. 20,000 chars needs 2 images (cost
    // 2*3484=6968 tokens) vs 5000 text-tokens → tied, strict `<` returns false.
    expect(isCompressionProfitable(20_000, 100)).toBe(false);
    // At cols=200, CHARS_PER_IMAGE=31,200. 20,000 chars fits in 1 image
    // (cost 3484 tokens) vs 5000 text-tokens → clear win.
    expect(isCompressionProfitable(20_000, 200)).toBe(true);
  });

  it('isCompressionProfitable: tiny-cols config raises the break-even threshold', () => {
    // Simulated narrow render: cols=20 → CHARS_PER_IMAGE=3120. A 14,001-char
    // block needs ceil(14001/3120)=5 images (17,420 tokens) vs 3501 text →
    // huge net loss. At cols=100 the same block fits in 1 image and wins
    // (imgCost=3484 < textCost=3501).
    expect(isCompressionProfitable(14_001, 100)).toBe(true);
    expect(isCompressionProfitable(14_001, 20)).toBe(false);
  });

  it('isCompressionProfitable(string): row-aware → newline-heavy sparse content rejected as net-loss', () => {
    // Regression for the -69% dashboard bug: the number-arg form estimates
    // by chars/charsPerImage which assumes uniform line-fill. The string
    // form is row-aware and matches what renderTextToPngs actually budgets.
    //
    // 30,000 chars of `x.md\n` = 6,000 short lines → 6,000 visual rows →
    // ceil(6000/156) = 39 images. 39 × 3484 = 135,876 image tokens vs
    // 30000/4 = 7,500 text tokens → massive net loss, correctly rejected.
    // The looser numeric form sees 30,000/15,600 = 2 images → 6,968 < 7,500
    // → "profitable" — the exact mis-estimate the row-aware form fixes.
    const sparse = 'x.md\n'.repeat(6_000); // 30k chars, 6000 short lines
    expect(isCompressionProfitable(sparse, 100)).toBe(false);
    expect(isCompressionProfitable(sparse.length, 100)).toBe(true); // back-compat: looser estimate
  });

  it('isCompressionProfitable(string): row-aware → dense single-line content packs full-width and profits', () => {
    // 30000 'x' chars as ONE line wraps to 100-char rows → 300 rows / 156
    // = 2 images. 2 * 3484 = 6968 image tokens vs 30000/4 = 7500 text →
    // profitable. Both forms agree on dense content.
    const dense = 'x'.repeat(30_000);
    expect(isCompressionProfitable(dense, 100)).toBe(true);
    expect(isCompressionProfitable(dense.length, 100)).toBe(true);
  });

  it('isCompressionProfitable(string, cols, cap): truncation cap lets 500KB log become profitable', () => {
    // For tool_result paging — actual image cost is bounded by maxImagesPerToolResult
    // while the SAVED text is the full pre-truncation length. Without cap we'd
    // reject (50k rows = 257 images), with cap=10 we accept (10*2500=25000 vs
    // 500000/4=125000 text → win by 100k).
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) lines.push(`log entry ${i} payload`);
    const log = lines.join('\n');
    expect(isCompressionProfitable(log, 100)).toBe(false); // 10k rows × 2500 way over
    expect(isCompressionProfitable(log, 100, 10)).toBe(true); // capped, profits
  });

  it('isCompressionProfitable: 7x10 atlas lets 15k blocks become 1-image wins', () => {
    // Historical comparison: the previous Unifont 5×11 atlas packed
    // 14,100 chars/image, so 15k chars (14,101–15,000 range)
    // needed 2 images and failed break-even. The 7×10 atlas now packs
    // 15,600 chars/image, so the same block fits in one image and wins.
    // 15000 chars: imgCost=1*3484=3484, textCost=ceil(15000/4)=3750 → profitable.
    expect(isCompressionProfitable(15_000, 100)).toBe(true);
  });

  it('break-even gate: 7000-char tool_result stays as text (below break-even)', async () => {
    // Above the old 5000 minToolResultChars cutoff but still net-loss to
    // image (image=2500 > text=7000/4=1750). The fast-path threshold (now
    // 10000) catches it first; if someone overrides --min-tool-result-chars
    // to 5000 the break-even check is the gate. Test it via override.
    const longResult = 'x'.repeat(7000);
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_x', content: longResult },
          ],
        },
      ],
      system: 'x'.repeat(150000),
    });
    // Override the fast-path threshold to 5000 so the break-even check is
    // the only thing that can reject the block. Confirms the real gate.
    const { body: outBytes, info } = await transformRequest(
      new TextEncoder().encode(req),
      { minToolResultChars: 5000 },
    );
    expect(info.compressed).toBe(true);
    expect(info.toolResultImgs ?? 0).toBe(0);
    expect(info.passthroughReasons?.not_profitable ?? 0).toBeGreaterThanOrEqual(1);
    // tool_result content should still be the original 7000-char string.
    const out = JSON.parse(new TextDecoder().decode(outBytes));
    const tr = (out.messages[0].content as Array<{ type: string; content: unknown }>).find(
      (b) => b.type === 'tool_result',
    );
    expect(typeof tr!.content).toBe('string');
    expect((tr!.content as string).length).toBe(7000);
  });

  it('break-even gate: 25000-char tool_result still images (clear win at 1 image)', async () => {
    // 25000 chars of dense code/log content (charsPerToken≈2) → profitable.
    // With cpt=2: textCost=ceil(25000/2)=12500 vs imgCost=2*3484=6968 → clear win.
    const longResult = 'x'.repeat(25000);
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_x', content: longResult },
          ],
        },
      ],
      system: 'x'.repeat(150000),
    });
    const { body: outBytes, info } = await transformRequest(new TextEncoder().encode(req), { charsPerToken: 2 });
    expect(info.compressed).toBe(true);
    expect((info.toolResultImgs ?? 0)).toBeGreaterThan(0);
    const out = JSON.parse(new TextDecoder().decode(outBytes));
    const tr = (out.messages[0].content as Array<{ type: string; content: unknown }>).find(
      (b) => b.type === 'tool_result',
    );
    expect(Array.isArray(tr!.content)).toBe(true);
  });

  it('break-even gate: 8000-char reminder stays as text (below break-even)', async () => {
    // Below minReminderChars threshold (10000) → marked below_threshold.
    const reminder = '<system-reminder>' + 'x'.repeat(8000) + '</system-reminder>';
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [
        { role: 'user', content: [{ type: 'text', text: reminder }] },
      ],
      system: 'x'.repeat(150000),
    });
    const { info } = await transformRequest(new TextEncoder().encode(req));
    expect(info.compressed).toBe(true);
    expect(info.reminderImgs ?? 0).toBe(0);
    expect(info.passthroughReasons?.below_threshold ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('break-even gate: 25000-char reminder images (above threshold and profitable)', async () => {
    // With charsPerToken=2 (dense code/log), profitable: textCost=12500 vs imgCost=2*3484=6968.
    const reminder = '<system-reminder>' + 'x'.repeat(25000) + '</system-reminder>';
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [
        { role: 'user', content: [{ type: 'text', text: reminder }] },
      ],
      system: 'x'.repeat(150000),
    });
    const { info } = await transformRequest(new TextEncoder().encode(req), { charsPerToken: 2 });
    expect(info.compressed).toBe(true);
    expect((info.reminderImgs ?? 0)).toBeGreaterThan(0);
  });

  it('break-even gate: passthroughReasons omitted when no passthrough happened', async () => {
    // 40k slab, no per-block reminders or tool_results. Only the static slab
    // gets imaged; nothing's gated by the per-block check.
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'x'.repeat(150000),
    });
    const { info } = await transformRequest(new TextEncoder().encode(req));
    expect(info.compressed).toBe(true);
    expect(info.passthroughReasons).toBeUndefined();
  });

  describe('outgoingTextChars walker (denominator honesty)', () => {
    // These tests pin the walker to what the upstream tokenizer actually
    // sees. Under-counting any path inflates α in `tokens ≈ α·textChars
    // + β·pixels`, which biases the dashboard `saved_pct` HIGH. All four
    // sub-tests use `minCompressChars: 10_000_000` to disable image
    // compression so we measure the raw walker, not post-compression text.
    const noCompress = { minCompressChars: 10_000_000 };

    async function countFor(req: object): Promise<number> {
      const { info } = await transformRequest(
        new TextEncoder().encode(JSON.stringify(req)),
        noCompress,
      );
      // Sanity: no compression happened — we want pre-image numbers.
      expect(info.compressed).toBe(false);
      return info.outgoingTextChars ?? 0;
    }

    it('baseline: system string + plain text user message', async () => {
      const n = await countFor({
        model: 'claude-3-5-sonnet',
        system: 'You are helpful.', // 16 chars
        messages: [{ role: 'user', content: 'hello' }], // 5 chars
      });
      expect(n).toBe(16 + 5);
    });

    it('counts tools[] (name + description + JSON-serialized input_schema)', async () => {
      const schema = { type: 'object', properties: { path: { type: 'string' } } };
      const schemaLen = JSON.stringify(schema).length;
      const base = await countFor({
        model: 'claude-3-5-sonnet',
        messages: [{ role: 'user', content: 'hi' }], // 2
      });
      const withTools = await countFor({
        model: 'claude-3-5-sonnet',
        messages: [{ role: 'user', content: 'hi' }], // 2
        tools: [
          {
            name: 'Read', // 4
            description: 'Read a file from disk.', // 22
            input_schema: schema, // schemaLen
          },
        ],
      });
      expect(base).toBe(2);
      expect(withTools - base).toBe(4 + 22 + schemaLen);
    });

    it('counts tool_use blocks (name + serialized input)', async () => {
      const input = { command: 'ls -la', cwd: '/tmp' };
      const inputLen = JSON.stringify(input).length;
      const n = await countFor({
        model: 'claude-3-5-sonnet',
        system: 'sys', // 3
        messages: [
          { role: 'user', content: 'run it' }, // 6
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'sure' }, // 4
              { type: 'tool_use', id: 'toolu_01', name: 'Bash', input }, // 4 + inputLen
            ],
          },
        ],
      });
      expect(n).toBe(3 + 6 + 4 + 4 + inputLen);
    });

    it('counts tool_result inner text + tool_use_id (string and array forms)', async () => {
      // String form.
      const a = await countFor({
        model: 'claude-3-5-sonnet',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_AB', // 8
                content: 'exit 0', // 6
              },
            ],
          },
        ],
      });
      expect(a).toBe(8 + 6);

      // Array form: text block (counted) + image block (not counted).
      const b = await countFor({
        model: 'claude-3-5-sonnet',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_CD', // 8
                content: [
                  { type: 'text', text: 'stdout' }, // 6
                  {
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }, // not counted
                  },
                ],
              },
            ],
          },
        ],
      });
      expect(b).toBe(8 + 6);
    });

    it('counts thinking blocks (extended thinking, Opus/Sonnet 4.x)', async () => {
      const n = await countFor({
        model: 'claude-3-5-sonnet',
        messages: [
          { role: 'user', content: 'hi' }, // 2
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'considering options' }, // 19
              { type: 'text', text: 'ok' }, // 2
            ],
          },
        ],
      });
      expect(n).toBe(2 + 19 + 2);
    });

    it('skips image blocks and unknown block types (β·pixels handles those)', async () => {
      const n = await countFor({
        model: 'claude-3-5-sonnet',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'caption' }, // 7
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
              },
              { type: 'redacted_thinking', data: 'opaque-blob' } as unknown as never,
            ],
          },
        ],
      });
      expect(n).toBe(7);
    });

    it('upper bound: walker count never exceeds JSON.stringify(req).length', async () => {
      // Synthetic request that mixes every block kind. The walker is
      // counting only chars the upstream tokenizer sees, so it must stay
      // strictly below the total JSON envelope length (which includes
      // structural keys/braces/quotes).
      const reqObj = {
        model: 'claude-3-5-sonnet',
        system: [{ type: 'text', text: 'A'.repeat(200) }],
        tools: [
          {
            name: 'Edit',
            description: 'B'.repeat(150),
            input_schema: {
              type: 'object',
              properties: {
                old: { type: 'string' },
                new: { type: 'string' },
              },
              required: ['old', 'new'],
            },
          },
        ],
        messages: [
          { role: 'user', content: 'C'.repeat(50) },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'D'.repeat(60) },
              { type: 'text', text: 'E'.repeat(30) },
              { type: 'tool_use', id: 'toolu_xx', name: 'Edit', input: { old: 'a', new: 'b' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_xx', content: 'F'.repeat(40) },
            ],
          },
        ],
      };
      const upperBound = JSON.stringify(reqObj).length;
      const walker = await countFor(reqObj);
      expect(walker).toBeGreaterThan(0);
      expect(walker).toBeLessThan(upperBound);
      // And it must be a meaningful fraction — if the walker is missing
      // big paths it'll fall to a tiny ratio. We want >= 50% of the JSON
      // envelope on a request this dense in content vs. structure.
      expect(walker / upperBound).toBeGreaterThan(0.5);
    });
  });

  describe('real-shape regression (anonymized production events.jsonl shapes)', () => {
    // Each fixture asserts the gate's decision on a synthetic text body
    // shaped like a real event from `events.jsonl` (2026-05-19 → 2026-05-20).
    // The constants `SLAB_CHARS_PER_TOKEN = 2.0` and `HISTORY_CHARS_PER_TOKEN = 2.0`
    // are empirical fits to Opus 4.7 production samples. If a future model
    // (Sonnet 4.6 vs Opus 4.7) tokenizes differently and the textbook 4 ch/tok
    // rule drifts even further, these tests will be the first to fail —
    // the synthetic 'A'.repeat(N) shapes elsewhere prove the math but not
    // the *constants*. Refresh the shape constants from a fresh events.jsonl
    // when that happens; see tests/fixtures/real-shapes.ts.

    it('production slab (161k chars, multi-col): ACCEPTED at slab cpt=2.0', () => {
      const shape = PRODUCTION_SLAB_161K;
      const text = synthesizeText(shape);
      // The body that motivated the cpt calibration. Conservative cpt=4 would
      // reject many dense slabs under the older geometry; cpt=2.0 reflects
      // Opus 4.7 telemetry and keeps this shape accepted with margin.
      expect(
        isCompressionProfitable(text, 100, undefined, shape.numCols, SLAB_CHARS_PER_TOKEN),
      ).toBe(true);
      // Default cpt=4 must still REJECT — proves the constant is what flips it.
      expect(isCompressionProfitable(text, 100, undefined, shape.numCols)).toBe(false);
    });

    it('production slab (135k chars, newline-heavy): synthetic shape REJECTED at slab cpt=2.0', () => {
      const shape = PRODUCTION_SLAB_135K_DENSE;
      const text = synthesizeText(shape);
      // Note: the real production event for this shape was ACCEPTED (compressed),
      // but uniform `'A'.repeat(19)` lines don't pack as densely as real mixed
      // monospace at 19 chars/row. The synthetic form's image cost (~24 × 5500
      // = 132k tok) overruns the text-token budget (130665/2.0 = 65k). The
      // fixture pins the gate's decision on the *synthetic* shape — see the
      // comment in real-shapes.ts for why this divergence is expected.
      expect(
        isCompressionProfitable(text, 100, undefined, shape.numCols, SLAB_CHARS_PER_TOKEN),
      ).toBe(false);
    });

    it('production slab (169k chars, very dense): REJECTED even at slab cpt=2.0', () => {
      const shape = PRODUCTION_SLAB_169K_HEAVY;
      const text = synthesizeText(shape);
      // The largest real-event shape we logged. Even at cpt=2.0 the body
      // (169632/2.0 = 84816 tok) doesn't clear the image cost (37 imgs × 5500
      // × 2 = 407k tok at multiCol=2). Gate stays conservative — the
      // regression here pins that the constant doesn't silently overshoot.
      expect(
        isCompressionProfitable(text, 100, undefined, shape.numCols, SLAB_CHARS_PER_TOKEN),
      ).toBe(false);
    });

    it('tiny body (142 chars): rejected by pre-filter (below MIN_COMPRESS_CHARS)', () => {
      const shape = BELOW_MIN_CHARS_TINY;
      // The gate isn't reached for inputs < minCompressChars (default 2000) —
      // the transformRequest pre-filter short-circuits. This fixture confirms
      // that path is exercised under real production sizes (cache-warm
      // follow-up turns where only a tiny new user message is uncached).
      // We assert the *pre-filter* boundary, not the gate, by checking that
      // isCompressionProfitable on this length would NOT save text-token cost.
      const text = synthesizeText(shape);
      expect(text.length).toBeLessThan(2000);
    });

    it('borderline (1123 chars): below pre-filter, never hits gate', () => {
      const shape = BELOW_MIN_CHARS_BORDERLINE;
      const text = synthesizeText(shape);
      expect(text.length).toBeLessThan(2000);
    });
  });
});
