/**
 * Build-time glyph atlas generator — Unicode-capable hybrid code-font atlas.
 *
 * Default atlas (2026-05): Spleen 5×8 for printable ASCII/code glyphs,
 * Unifont 16.0.04 at 8px for Unicode fallback (CJK, arrows, symbols,
 * math, Hangul, etc.). The runtime renderer still sees one sparse atlas:
 * codepoint → bit offset + wide flag. There is no runtime font dependency.
 *
 * Why hybrid instead of replacing Unifont outright:
 * - Spleen 5×8 is a real bitmap/code font and is materially denser than
 *   historical Unifont 10px atlas: 5×8 cells vs 5×11, ~38% more rows
 *   per 1568px image.
 * - Spleen intentionally targets small code/terminal glyphs, but does not
 *   cover CJK/symbol blocks. Unifont remains the broad fallback so existing
 *   dropped-glyph behavior does not regress for non-ASCII text.
 * - The generator bakes both into one 1-bit atlas, preserving the Workers-safe
 *   zero-runtime-dependency contract.
 *
 * Profiles (selected via ATLAS_PROFILE env, default 'full-bmp'):
 * - 'full-bmp'  (~35k codepoints): practical Unicode blocks + Hangul.
 * - 'practical' (~24k codepoints): drops Hangul Syllables for smaller bundles.
 */

import { GlobalFonts, createCanvas } from '@napi-rs/canvas';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PRIMARY_FONT_PATH = resolve(ROOT, 'assets/Spleen-5x8.otb');
const FALLBACK_FONT_PATH = resolve(ROOT, 'assets/Unifont-16.0.04.otf');
const OUT_PATH = resolve(ROOT, 'src/core/atlas.ts');

/** When ATLAS_GRAY=1, write a separate grayscale atlas to atlas-gray.ts instead
 *  of the production 1-bit atlas. The production atlas is never touched. */
const GRAY_MODE = process.env['ATLAS_GRAY'] === '1';
const OUT_PATH_GRAY = resolve(ROOT, 'src/core/atlas-gray.ts');

const PRIMARY_FONT_FAMILY = 'Spleen';
const FALLBACK_FONT_FAMILY = 'Unifont';
const PRIMARY_FONT_PX = 8;
const FALLBACK_FONT_PX = 8;
const FONT_FAMILY_LABEL = 'Spleen 5x8 ASCII + Unifont 8px fallback';
const PROFILE = (process.env.ATLAS_PROFILE ?? 'full-bmp') as 'practical' | 'full-bmp';

/** Codepoint blocks included in each profile. */
const PRACTICAL_RANGES: ReadonlyArray<readonly [number, number, string]> = [
  [0x0020, 0x007e, 'ASCII printable'],
  [0x00a0, 0x024f, 'Latin-1 Supp + Latin Extended-A + Latin Extended-B'],
  [0x0370, 0x03ff, 'Greek and Coptic'],
  [0x0400, 0x04ff, 'Cyrillic'],
  [0x0590, 0x05ff, 'Hebrew'],
  [0x0600, 0x06ff, 'Arabic'],
  [0x2000, 0x206f, 'General Punctuation'],
  [0x2100, 0x214f, 'Letterlike Symbols'],
  [0x2190, 0x21ff, 'Arrows'],
  [0x2200, 0x22ff, 'Mathematical Operators'],
  [0x2300, 0x23ff, 'Miscellaneous Technical'],
  [0x2460, 0x24ff, 'Enclosed Alphanumerics'],
  [0x2500, 0x257f, 'Box Drawing'],
  [0x2580, 0x259f, 'Block Elements'],
  [0x25a0, 0x25ff, 'Geometric Shapes'],
  [0x2600, 0x26ff, 'Miscellaneous Symbols'],
  [0x2700, 0x27bf, 'Dingbats'],
  [0x3000, 0x303f, 'CJK Symbols and Punctuation'],
  [0x3040, 0x309f, 'Hiragana'],
  [0x30a0, 0x30ff, 'Katakana'],
  [0xff00, 0xffef, 'Halfwidth and Fullwidth Forms'],
  [0x4e00, 0x9fff, 'CJK Unified Ideographs'],
];

const HANGUL: ReadonlyArray<readonly [number, number, string]> = [
  [0xac00, 0xd7af, 'Hangul Syllables'],
];

const RANGES = PROFILE === 'full-bmp' ? [...PRACTICAL_RANGES, ...HANGUL] : PRACTICAL_RANGES;

// --- Register fonts --------------------------------------------------------
GlobalFonts.register(readFileSync(PRIMARY_FONT_PATH), PRIMARY_FONT_FAMILY);
GlobalFonts.register(readFileSync(FALLBACK_FONT_PATH), FALLBACK_FONT_FAMILY);

// Spleen 5x8 defines the global Latin cell. Unifont fallback at 8px is
// narrower (4px Latin / 8px CJK) and is painted into the same 5/10px cells,
// leaving a little right-side blank space rather than changing renderer math.
const probe = createCanvas(64, 64);
const pctx = probe.getContext('2d');
pctx.textBaseline = 'alphabetic';
pctx.font = `${PRIMARY_FONT_PX}px ${PRIMARY_FONT_FAMILY}`;
const primaryLatin = pctx.measureText('M');
let maxAscent = 0;
let maxDescent = 0;
for (const ch of ['M', 'g', 'p', 'y', 'j', '0', 'O', 'l', 'I', '{', '}', '[', ']']) {
  const m = pctx.measureText(ch);
  if (Number.isFinite(m.actualBoundingBoxAscent) && m.actualBoundingBoxAscent > maxAscent) {
    maxAscent = m.actualBoundingBoxAscent;
  }
  if (Number.isFinite(m.actualBoundingBoxDescent) && m.actualBoundingBoxDescent > maxDescent) {
    maxDescent = m.actualBoundingBoxDescent;
  }
}
// Also verify fallback fits in the same height budget at its own baseline.
pctx.font = `${FALLBACK_FONT_PX}px ${FALLBACK_FONT_FAMILY}`;
for (const ch of ['M', 'g', 'p', 'y', 'j', '中', '漢', '國', '⌊', '∫', '日', 'カ', '한']) {
  const m = pctx.measureText(ch);
  if (Number.isFinite(m.actualBoundingBoxAscent) && m.actualBoundingBoxAscent > maxAscent) {
    maxAscent = m.actualBoundingBoxAscent;
  }
  if (Number.isFinite(m.actualBoundingBoxDescent) && m.actualBoundingBoxDescent > maxDescent) {
    maxDescent = m.actualBoundingBoxDescent;
  }
}

const cellW = Math.ceil(primaryLatin.width); // 5 at Spleen 8px
const ascent = Math.ceil(maxAscent); // 7 for Spleen/Unifont 8px
const descent = Math.ceil(maxDescent); // 1 for Spleen/Unifont 8px
const cellH = ascent + descent; // 8

if (cellW !== 5 || cellH !== 8) {
  throw new Error(
    `[gen-atlas] Spleen 5x8 invariant drifted: got cell=${cellW}×${cellH} ` +
      `(asc=${ascent} desc=${descent}). Refusing to silently change density.`,
  );
}

// Probe fallback advance against fallback's own Latin baseline. We classify
// fallback glyphs as one or two visual cells, then paint them into Spleen's
// 5px or 10px cell width. This keeps CJK wrapping at 2 cells even though
// Unifont 8px ink itself is 8px wide.
pctx.font = `${FALLBACK_FONT_PX}px ${FALLBACK_FONT_FAMILY}`;
const fallbackLatinW = pctx.measureText('M').width;
if (!Number.isFinite(fallbackLatinW) || fallbackLatinW <= 0) {
  throw new Error('[gen-atlas] could not measure fallback Unifont Latin width');
}

console.log(
  `[gen-atlas] font=${FONT_FAMILY_LABEL} profile=${PROFILE} ` +
    `cell=${cellW}×${cellH} (asc=${ascent} desc=${descent}, wide=${2 * cellW}×${cellH})`,
);

interface Found {
  cp: number;
  wide: boolean;
  source: 'primary' | 'fallback';
}

function sourceForCodepoint(cp: number): 'primary' | 'fallback' {
  // Code-font-first means the exact ASCII/code glyphs that dominate Claude
  // Code prompts use Spleen. Unicode punctuation/symbols/CJK keep Unifont.
  if (cp >= 0x20 && cp <= 0x7e) return 'primary';
  return 'fallback';
}

function classifyFallbackWidth(cp: number): boolean | null {
  const ch = String.fromCodePoint(cp);
  const w = pctx.measureText(ch).width;
  if (!Number.isFinite(w) || w <= 0) return null;
  const ratio = w / fallbackLatinW;
  if (Math.abs(ratio - 1) < 0.05) return false;
  if (Math.abs(ratio - 2) < 0.05) return true;
  throw new Error(
    `[gen-atlas] fallback codepoint U+${cp.toString(16).toUpperCase()} has advance ` +
      `${w}px (Unifont Latin=${fallbackLatinW}px, ratio=${ratio.toFixed(3)}; expected 1× or 2×).`,
  );
}

const found: Found[] = [];
for (const [lo, hi, label] of RANGES) {
  let kept = 0;
  let primary = 0;
  let fallback = 0;
  for (let cp = lo; cp <= hi; cp++) {
    const source = sourceForCodepoint(cp);
    if (source === 'primary') {
      found.push({ cp, wide: false, source });
      primary++;
      kept++;
      continue;
    }
    const wide = classifyFallbackWidth(cp);
    if (wide == null) continue;
    found.push({ cp, wide, source });
    fallback++;
    kept++;
  }
  console.log(
    `[gen-atlas]   ${label.padEnd(48)} ` +
      `U+${lo.toString(16).padStart(4, '0').toUpperCase()}..` +
      `U+${hi.toString(16).padStart(4, '0').toUpperCase()}  ` +
      `kept ${kept}/${hi - lo + 1} (spleen=${primary}, unifont=${fallback})`,
  );
}

found.sort((a, b) => a.cp - b.cp);
const wideCount = found.filter((f) => f.wide).length;
const primaryCount = found.filter((f) => f.source === 'primary').length;
console.log(`[gen-atlas] total glyphs: ${found.length} (${wideCount} wide, ${primaryCount} Spleen primary)`);

// --- Rasterize glyphs ------------------------------------------------------
const contexts = {
  primary: {
    narrow: createCanvas(cellW, cellH).getContext('2d'),
    wide: createCanvas(2 * cellW, cellH).getContext('2d'),
    font: `${PRIMARY_FONT_PX}px ${PRIMARY_FONT_FAMILY}`,
  },
  fallback: {
    narrow: createCanvas(cellW, cellH).getContext('2d'),
    wide: createCanvas(2 * cellW, cellH).getContext('2d'),
    font: `${FALLBACK_FONT_PX}px ${FALLBACK_FONT_FAMILY}`,
  },
} as const;
for (const src of [contexts.primary, contexts.fallback]) {
  for (const ctx of [src.narrow, src.wide]) {
    ctx.font = src.font;
    ctx.textBaseline = 'alphabetic';
  }
}

const codepoints = new Uint32Array(found.length);
const offsets = new Uint32Array(found.length);
const wideFlags = new Uint8Array(found.length);
const cellBitSlices: Uint8Array[] = [];
let totalBits = 0;

// Gray mode: collect raw coverage bytes (0-255) per pixel, 1 byte per pixel.
// Used only when ATLAS_GRAY=1; the 1-bit path is unchanged when GRAY_MODE is false.
const graySlices: Uint8Array[] = [];
let grayTotalBytes = 0;

for (let i = 0; i < found.length; i++) {
  const { cp, wide, source } = found[i]!;
  codepoints[i] = cp;
  wideFlags[i] = wide ? 1 : 0;

  const w = wide ? 2 * cellW : cellW;
  const ctx = wide ? contexts[source].wide : contexts[source].narrow;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, cellH);
  ctx.fillStyle = '#fff';
  ctx.fillText(String.fromCodePoint(cp), 0, ascent);

  const img = ctx.getImageData(0, 0, w, cellH);

  if (GRAY_MODE) {
    // Gray mode: record the raw R-channel coverage byte (canvas is white-on-black).
    offsets[i] = grayTotalBytes; // BYTE offset (not bit offset)
    const coverage = new Uint8Array(w * cellH);
    for (let p = 0; p < coverage.length; p++) coverage[p] = img.data[p * 4]!;
    graySlices.push(coverage);
    grayTotalBytes += coverage.length;
  } else {
    // 1-bit mode (default / production path): threshold and bit-pack.
    offsets[i] = totalBits;
    const bits = new Uint8Array(w * cellH);
    for (let p = 0; p < bits.length; p++) bits[p] = img.data[p * 4]! >= 128 ? 1 : 0;
    cellBitSlices.push(bits);
    totalBits += bits.length;
  }
}

function bytesB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

// ---------------------------------------------------------------------------
// Gray-mode output — completely separate file, never touches atlas.ts
// ---------------------------------------------------------------------------
if (GRAY_MODE) {
  // Flatten all coverage slices into one Uint8Array.
  const grayPixels = new Uint8Array(grayTotalBytes);
  let off = 0;
  for (const slice of graySlices) {
    grayPixels.set(slice, off);
    off += slice.length;
  }

  const codepointsB64 = bytesB64(new Uint8Array(codepoints.buffer));
  const offsetsB64    = bytesB64(new Uint8Array(offsets.buffer));
  const wideFlagsB64  = bytesB64(wideFlags);
  const pixelsB64     = bytesB64(grayPixels);

  console.log(
    `[gen-atlas] GRAY MODE: coverage byte storage: ${grayTotalBytes} bytes ` +
      `(${pixelsB64.length} b64 chars)`,
  );
  console.log(
    `[gen-atlas] sizes (base64 chars): codepoints=${codepointsB64.length} ` +
      `offsets=${offsetsB64.length} wide=${wideFlagsB64.length} pixels=${pixelsB64.length}`,
  );

  const grayBanner = `// AUTO-GENERATED by scripts/gen-atlas.ts (ATLAS_GRAY=1) — DO NOT EDIT.
// Regenerate with: ATLAS_GRAY=1 npx tsx scripts/gen-atlas.ts
// EVAL-ONLY artifact: this file is NOT imported by the production render path.
// Source fonts: assets/Spleen-5x8.otb @ ${PRIMARY_FONT_PX}px for ASCII/code; assets/Unifont-16.0.04.otf @ ${FALLBACK_FONT_PX}px fallback (profile: ${PROFILE})
// Glyphs: ${found.length} codepoints (${wideCount} wide, ${primaryCount} Spleen primary)
// Pixel format: 1 coverage byte per pixel (0-255), raw R-channel from anti-aliased canvas.
// ATLAS_GRAY_OFFSETS are BYTE offsets (not bit offsets like ATLAS_OFFSETS).
`;

  const grayBody = `
/** Latin advance width in pixels. CJK glyphs advance ${2 * cellW}px (= 2 × this). */
export const ATLAS_GRAY_CELL_W = ${cellW};
/** Cell height in pixels. */
export const ATLAS_GRAY_CELL_H = ${cellH};
/** Distance from cell top to baseline. */
export const ATLAS_GRAY_ASCENT = ${ascent};
/** Distance from baseline to cell bottom. */
export const ATLAS_GRAY_DESCENT = ${descent};

// ---- base64 blobs (decoded once at module init) --------------------------

const GRAY_CODEPOINTS_B64 = ${JSON.stringify(codepointsB64)};
const GRAY_OFFSETS_B64    = ${JSON.stringify(offsetsB64)};
const GRAY_WIDE_FLAGS_B64 = ${JSON.stringify(wideFlagsB64)};
const GRAY_PIXELS_B64     = ${JSON.stringify(pixelsB64)};

/** Decode base64 → Uint8Array. Workers-safe (no Buffer / no node:zlib). */
function decodeB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeU32(b64: string): Uint32Array {
  const bytes = decodeB64(b64);
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/** Sorted codepoint table. \`ATLAS_GRAY_CODEPOINTS[rank]\` is the codepoint at \`rank\`. */
export const ATLAS_GRAY_CODEPOINTS: Uint32Array = /* @__PURE__ */ decodeU32(GRAY_CODEPOINTS_B64);

/** BYTE offset into ATLAS_GRAY_PIXELS for the glyph at each rank.
 *  (Unlike the 1-bit atlas, this is a byte offset — 1 byte per pixel.) */
export const ATLAS_GRAY_OFFSETS: Uint32Array = /* @__PURE__ */ decodeU32(GRAY_OFFSETS_B64);

/** 1 if the glyph at this rank is double-wide (East Asian Wide), 0 otherwise. */
export const ATLAS_GRAY_WIDE_FLAGS: Uint8Array = /* @__PURE__ */ decodeB64(GRAY_WIDE_FLAGS_B64);

/** Coverage bytes (0-255), one byte per pixel. Runtime extraction:
 *    byteIdx = ATLAS_GRAY_OFFSETS[rank] + gy * srcW + gx
 *    coverage = ATLAS_GRAY_PIXELS[byteIdx]
 *  where srcW is ATLAS_GRAY_CELL_W (narrow) or 2*ATLAS_GRAY_CELL_W (wide). */
export const ATLAS_GRAY_PIXELS: Uint8Array = /* @__PURE__ */ decodeB64(GRAY_PIXELS_B64);

/** Number of glyphs in the gray atlas. */
export const ATLAS_GRAY_NUM_GLYPHS = ATLAS_GRAY_CODEPOINTS.length;

/** Binary-search the sparse codepoint table. Returns rank (≥0) or -1 if absent.
 *  Mirrors atlasRank() from atlas.ts but operates on ATLAS_GRAY_CODEPOINTS. */
export function atlasGrayRank(codepoint: number): number {
  let lo = 0;
  let hi = ATLAS_GRAY_CODEPOINTS.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = ATLAS_GRAY_CODEPOINTS[mid]!;
    if (v === codepoint) return mid;
    if (v < codepoint) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
`;

  writeFileSync(OUT_PATH_GRAY, grayBanner + grayBody);
  console.log(
    `[gen-atlas] wrote ${OUT_PATH_GRAY} ` +
      `(${grayTotalBytes} coverage bytes, ${pixelsB64.length} b64 chars; ` +
      `total file ~${Math.round((grayBanner.length + grayBody.length) / 1024)} KB)`,
  );
  // Do not write or touch src/core/atlas.ts — production path is unchanged.
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1-bit mode (default / production path) — unchanged below this point
// ---------------------------------------------------------------------------

const totalBytes = (totalBits + 7) >>> 3;
const pixels = new Uint8Array(totalBytes);
{
  let bitOff = 0;
  for (const bits of cellBitSlices) {
    for (let p = 0; p < bits.length; p++) {
      if (bits[p]!) {
        const byteIdx = bitOff >>> 3;
        const bitShift = 7 - (bitOff & 7);
        pixels[byteIdx]! |= 1 << bitShift;
      }
      bitOff++;
    }
  }
}
console.log(
  `[gen-atlas] bit-packed pixel storage: ${totalBits} bits → ${totalBytes} bytes ` +
    `(was ${totalBits} bytes at 8-bit; ${(totalBits / totalBytes).toFixed(1)}× pre-deflate shrink)`,
);

const codepointsB64 = bytesB64(new Uint8Array(codepoints.buffer));
const offsetsB64 = bytesB64(new Uint8Array(offsets.buffer));
const wideFlagsB64 = bytesB64(wideFlags);
const pixelsB64 = bytesB64(pixels);

console.log(
  `[gen-atlas] sizes (base64 chars): codepoints=${codepointsB64.length} ` +
    `offsets=${offsetsB64.length} wide=${wideFlagsB64.length} pixels=${pixelsB64.length}`,
);

const banner = `// AUTO-GENERATED by scripts/gen-atlas.ts — DO NOT EDIT.
// Regenerate with: pnpm run build:atlas
//   (or ATLAS_PROFILE=practical pnpm run build:atlas to drop Hangul for
//    Workers free-tier deployments under the 1 MB compressed-bundle cap)
// Source fonts: assets/Spleen-5x8.otb @ ${PRIMARY_FONT_PX}px for ASCII/code; assets/Unifont-16.0.04.otf @ ${FALLBACK_FONT_PX}px fallback (profile: ${PROFILE})
// Glyphs: ${found.length} codepoints (${wideCount} wide, ${primaryCount} Spleen primary)
`;

const body = `
/** Latin advance width in pixels. CJK glyphs advance ${2 * cellW}px (= 2 × this). */
export const ATLAS_CELL_W = ${cellW};
/** Cell height in pixels. */
export const ATLAS_CELL_H = ${cellH};
/** Distance from cell top to baseline. */
export const ATLAS_ASCENT = ${ascent};
/** Distance from baseline to cell bottom. */
export const ATLAS_DESCENT = ${descent};
/** Primary font size used when rasterizing ASCII/code glyphs. */
export const ATLAS_FONT_PX = ${PRIMARY_FONT_PX};
/** Font family label used at build time. Renderer never re-loads the font. */
export const ATLAS_FONT_FAMILY = ${JSON.stringify(FONT_FAMILY_LABEL)};
/** Profile used to build this atlas. */
export const ATLAS_PROFILE = ${JSON.stringify(PROFILE)};

// ---- base64 blobs (decoded once at module init) --------------------------

const CODEPOINTS_B64 = ${JSON.stringify(codepointsB64)};
const OFFSETS_B64    = ${JSON.stringify(offsetsB64)};
const WIDE_FLAGS_B64 = ${JSON.stringify(wideFlagsB64)};
const PIXELS_B64     = ${JSON.stringify(pixelsB64)};

/** Decode base64 → Uint8Array. Workers-safe (no Buffer / no node:zlib). */
function decodeB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeU32(b64: string): Uint32Array {
  const bytes = decodeB64(b64);
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/** Sorted codepoint table. \`ATLAS_CODEPOINTS[rank]\` is the codepoint stored
 *  at \`rank\` in OFFSETS / WIDE_FLAGS / PIXELS. */
export const ATLAS_CODEPOINTS: Uint32Array = /* @__PURE__ */ decodeU32(CODEPOINTS_B64);

/** BIT offset into ATLAS_PIXELS for the glyph at each rank. */
export const ATLAS_OFFSETS: Uint32Array = /* @__PURE__ */ decodeU32(OFFSETS_B64);

/** 1 if the glyph at this rank is double-wide (East Asian Wide), 0 otherwise. */
export const ATLAS_WIDE_FLAGS: Uint8Array = /* @__PURE__ */ decodeB64(WIDE_FLAGS_B64);

/** Bit-packed 1-bit pixel data, MSB-first. Runtime extraction:
 *    bitIdx  = OFFSETS[rank] + row * srcW + col
 *    byteIdx = bitIdx >>> 3
 *    bitOff  = 7 - (bitIdx & 7)
 *    pixel   = (ATLAS_PIXELS[byteIdx] >>> bitOff) & 1
 *  where srcW is CELL_W (narrow) or 2*CELL_W (wide, per WIDE_FLAGS[rank]). */
export const ATLAS_PIXELS: Uint8Array = /* @__PURE__ */ decodeB64(PIXELS_B64);

/** Number of glyphs in the atlas. */
export const ATLAS_NUM_GLYPHS = ATLAS_CODEPOINTS.length;

/** Binary-search the sparse codepoint table. Returns rank (≥0) or -1 if the
 *  codepoint is not in the atlas. Hot path; called once per rendered char. */
export function atlasRank(codepoint: number): number {
  let lo = 0;
  let hi = ATLAS_CODEPOINTS.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = ATLAS_CODEPOINTS[mid]!;
    if (v === codepoint) return mid;
    if (v < codepoint) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
`;

writeFileSync(OUT_PATH, banner + body);
console.log(
  `[gen-atlas] wrote ${OUT_PATH} ` +
    `(${pixels.length} pixel bytes packed from ${totalBits} bits, ${pixelsB64.length} b64 chars; total file ~${Math.round((banner.length + body.length) / 1024)} KB)`,
);
