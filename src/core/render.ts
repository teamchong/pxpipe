/**
 * Text → PNG renderer. Uses the build-time atlas (src/core/atlas.ts) and
 * blits glyphs into a single grayscale framebuffer, then PNG-encodes.
 *
 * The atlas is sparse (Unicode BMP subset) and supports wide cells (East
 * Asian Wide codepoints take 2× the Latin advance width). The renderer
 * iterates by *codepoint* (not UTF-16 code unit) so surrogate pairs above
 * U+FFFF — which are not in our atlas anyway — round-trip cleanly as a
 * single dropped-char event rather than two corrupt halves.
 *
 * Anthropic's vision encoder works best with images ≤ 1568×1568 px, so we
 * cap height there and split into N PNGs when content exceeds the budget.
 */

import {
  ATLAS_CELL_W,
  ATLAS_CELL_H,
  ATLAS_PIXELS,
  ATLAS_OFFSETS,
  ATLAS_WIDE_FLAGS,
  atlasRank,
} from './atlas.js';
import {
  ATLAS_GRAY_CELL_W,
  ATLAS_GRAY_CELL_H,
  ATLAS_GRAY_PIXELS,
  ATLAS_GRAY_OFFSETS,
  ATLAS_GRAY_WIDE_FLAGS,
  atlasGrayRank,
} from './atlas-gray.js';
import { encodeGrayPng, encodeRgbPng } from './png.js';

/** Vertical pixel budget per rendered PNG. Bounded by Anthropic's 1568×1568
 *  image cap. Exported so the break-even gate in transform.ts can derive
 *  CHARS_PER_IMAGE from the same constants the renderer actually uses. */
export const MAX_HEIGHT_PX = 1568;
/** Target upper bound for source text represented by one PNG page.
 *  At 313 cols × 196 rows the 1568×1568 canvas holds ~61k chars; we pack
 *  to ~50k to leave headroom for soft-wrap, dropped chars, and the paging
 *  marker. Policy: fill the canvas, one page per 1568×1568 image, max savings. */
export const READABLE_CHARS_PER_IMAGE = 50000;
/** Target source chars per image for dense user-visible content (tool output
 *  and collapsed history). The 50k canvas-max page is token-efficient but too
 *  dense for OCR on lockfiles/JSON/code. Keep those blocks paged into smaller
 *  images so the model can read them reliably. */
export const DENSE_CONTENT_CHARS_PER_IMAGE = 5000;
export const DENSE_CONTENT_COLS = 180;
/** 2026-06-09: dropped the 7×10 padded cell ({cellWBonus:2, cellHBonus:2})
 *  to the bare 5×8 atlas cell for the Fable-only scope — A/B on dense JSON
 *  needles read 4/5 at 5×8 vs 3/5 at 7×10 (n=5, flat) at 42% fewer image
 *  tokens per page (591 vs 1,028 est. on identical content). Verbatim recall
 *  is unreliable at every cell size; the verbatim-risk guard is the
 *  mitigation, not padding. Revert to {2,2} if misread rates rise. */
export const DENSE_RENDER_STYLE: RenderStyle = { cellWBonus: 0, cellHBonus: 0, aa: true };
/** Default columns per row. 1568 px / 5 px-per-cell = 313 cells. We render
 *  at the full canvas width by default — no shrink-to-content. */
const DEFAULT_COLS = 313;
/** Horizontal padding inside the rendered PNG (left + right each). Exported
 *  so transform.ts can derive image pixel-area for token-cost estimation. */
export const PAD_X = 4;
/** Vertical padding inside the rendered PNG (top + bottom each). Exported
 *  for the same reason as MAX_HEIGHT_PX. */
export const PAD_Y = 4;

/** Default render-cell padding. The atlas glyph is ATLAS_CELL_W×ATLAS_CELL_H
 *  (5×8) and production ships the BARE cell — both bonuses are 0. The L1 OCR
 *  sweep originally landed at 7×10 (96 % char accuracy vs ~82 % at naïve 5×8
 *  on dense text), but the later combination of packed reflow + grayscale
 *  atlas + the in-image instruction band (`reflow-inimage`) brought 5×8 back
 *  to 98.95 % on Opus 4.7 — slightly above the text-only baseline — so the
 *  production default reverted to the dense cell. RenderStyle.cellWBonus /
 *  cellHBonus override these (eval use only); with no style the renderer
 *  produces 5×8 cells. */
export const DEFAULT_CELL_W_BONUS = 0;
export const DEFAULT_CELL_H_BONUS = 0;
/** Effective production render-cell pixel dimensions (atlas glyph + default
 *  padding). transform.ts derives its image-budget and break-even math from
 *  these so the gate always tracks the renderer's real geometry. */
export const CELL_W = ATLAS_CELL_W + DEFAULT_CELL_W_BONUS;
export const CELL_H = ATLAS_CELL_H + DEFAULT_CELL_H_BONUS;

export interface RenderedImage {
  /** Raw PNG bytes. */
  png: Uint8Array;
  /** Pixel width. */
  width: number;
  /** Pixel height. */
  height: number;
  /** How many input *codepoints* were rendered into this image (covers wide
   *  chars correctly: 中 counts as 1, not 2). */
  charsRendered: number;
  /** Codepoints encountered that aren't in the atlas. They were rendered as
   *  blank cells; the caller may want to surface this as telemetry so a
   *  spike of drops triggers a profile review. */
  droppedChars: number;
  /** Histogram of dropped codepoints: codepoint → count for this render. The
   *  caller can merge across multiple renders to find the top offenders.
   *  Empty when droppedChars === 0; never undefined so callers don't need to
   *  null-check before iterating. */
  droppedCodepoints: Map<number, number>;
}

/** Optional render-time styling. With every field unset the renderer renders
 *  at the production default 5×8 cell (see DEFAULT_CELL_W_BONUS /
 *  DEFAULT_CELL_H_BONUS). The eval harness overrides these per variant to
 *  A/B structure aids and cell sizes against OCR fidelity on densely-packed
 *  (reflowed) text. */
export interface RenderStyle {
  /** Draw faint grey grid rules. Zero added pixels — see `drawGrid`. */
  grid?: boolean;
  /** Draw a vertical grid rule every N columns. 0/unset = row rules only. */
  gridCols?: number;
  /** Horizontal size multiplier for the ↵ newline marker. 1 = off. */
  markerScale?: number;
  /** Render the ↵ marker in red (switches the PNG to RGB truecolor). */
  markerRed?: boolean;
  /** Blank pixel rows over the 8px atlas glyph (cell height = 8 + this). The
   *  glyph bitmap stays 8px tall; this widens the vertical pitch. Unset =
   *  DEFAULT_CELL_H_BONUS (production 5×8 cell). */
  cellHBonus?: number;
  /** Blank pixel columns over the 5px atlas glyph (cell width = 5 + this).
   *  The glyph bitmap stays 5px wide; a negative value makes adjacent glyphs
   *  overlap. Unset = DEFAULT_CELL_W_BONUS (production 5×8 cell). */
  cellWBonus?: number;
  /** Use the anti-aliased grayscale atlas (atlas-gray.ts) instead of the
   *  default 1-bit atlas. EVAL-ONLY — gated on this flag; the default path
   *  (aa unset/false) is byte-identical to the pre-AA renderer. */
  aa?: boolean;
  /** Draw each successive glyph in a cycling palette color so the vision
   *  encoder gets a per-character boundary cue. Forces RGB output. Glyph
   *  shape/size unchanged. Composes with `aa: true` (AA coverage is blended
   *  onto a white background in the palette color). */
  colorCycle?: boolean;
}

// --- column-aware wrapping -------------------------------------------------

/** Visual width of a codepoint in cells (1 = Latin, 2 = East Asian Wide).
 *  Codepoints not in the atlas advance by 1 cell — they render as blank but
 *  occupy space so wrap math is stable. */
function cellsFor(codepoint: number, markerScale: number = 1): number {
  // The enlarged ↵ marker is scaled horizontally, so it occupies `markerScale`
  // cells of wrap budget instead of one.
  if (codepoint === NL_SENTINEL_CP && markerScale > 1) return markerScale;
  const rank = atlasRank(codepoint);
  if (rank < 0) return 1;
  return ATLAS_WIDE_FLAGS[rank] === 1 ? 2 : 1;
}

/** Default tab width when expanding `\t` to spaces. 4 is what GitHub, GNU
 *  cat -t, and most editors render by default. Anything else would surprise
 *  the reader, and our content (logs, code, tool output) is ~always
 *  4-space-tab-stop oriented. */
const TAB_WIDTH = 4;

/** Conservative whitespace minify pass run BEFORE tab-expand + wrap.
 *
 *  Two rules, deliberately limited so we never alter content semantics:
 *    1. Strip trailing whitespace (spaces + tabs) on every line. Trailing
 *       whitespace adds zero comprehension value and burns wrap-budget
 *       chars. Common in editor-saved files + auto-generated logs.
 *    2. Collapse runs of 4+ consecutive `\n` (= 3+ blank lines) down to
 *       3 `\n` (= 2 blank lines). Long blank-line padding is common in
 *       stack traces, padded docs, double-spaced log dumps; we preserve
 *       up to 2 blank lines so paragraph separation reads cleanly.
 *
 *  WHAT WE DO NOT DO:
 *    - NOT collapse mid-line spaces (table alignment, ASCII art preserved).
 *    - NOT collapse leading whitespace (indentation IS structure).
 *    - NOT mutate non-whitespace.
 *
 *  Target win per HANDOFF R1: ~1.5–2× more chars per rendered image on
 *  typical short-line workloads. See post-implementation measurement. */
export function minifyForRender(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n'); // 4+ \n → 3 \n (= 2 blank lines)
}

// --- R3 reflow -------------------------------------------------------------
//
// The single biggest source of wasted pixels is line-end dead margin: real
// Claude Code history wraps far short of `cols`, so most of every row is
// blank cells we still pay image-tokens for (measured glyph-fill ~29%).
//
// Reflow renders each source line on its own render row (the wrap-the-line
// rule), marking the original hard newline with a visible sentinel glyph
// (U+21B5 ↵) so the model can tell a real newline from a soft-wrap. Structure
// is preserved — a table row stays a row, indentation stays put. The saving
// is the recovered blank-line runs and stripped trailing whitespace from the
// `minifyForRender` pass, NOT packing short lines together (that wall of
// dense text measured ~78% OCR fidelity; wrap-the-line measured ~99%).
//
// FIDELITY: reflow is gated behind a flag and an A/B eval. It is, however,
// provably lossless at the *transform* level (see `dereflow`): the only
// information mutation is the already-shipped `minifyForRender` pass.

/** Sentinel glyph marking an original hard newline in reflowed text. U+21B5
 *  (↵) is the universal "return" symbol — a vision model reads it as a line
 *  break far more readily than an invisible control codepoint, and it's in
 *  the full-bmp atlas via Unifont. */
export const NL_SENTINEL = '↵';

/** Codepoint of NL_SENTINEL (U+21B5), precomputed for hot-path comparisons. */
const NL_SENTINEL_CP = 0x21b5;

/** Palette used by the `colorCycle` render mode. Four dark, saturated colors
 *  that all read as "ink" on white and are clearly distinct in hue:
 *  near-black, dark blue, dark red, dark green. */
const GLYPH_PALETTE: [number, number, number][] = [
  [20, 20, 20],   // near-black
  [20, 40, 160],  // dark blue
  [150, 20, 20],  // dark red
  [20, 110, 40],  // dark green
];

/** Reflow `text` for the renderer: minify, expand tabs, and join lines with
 *  the NL_SENTINEL (↵) glyph so every original hard newline is visible.
 *
 *  `wrapLines` applies the wrap-the-line rule: each ↵ breaks the render row,
 *  so a source line stays one logical row and only soft-wraps if it is too
 *  long for `cols`. Structure — tables, code, indentation — is preserved.
 *
 *  Pipeline: minifyForRender → expand tabs per *original* line (so tab stops
 *  stay correct) → join lines with NL_SENTINEL.
 *
 *  Returns `null` when the source already contains NL_SENTINEL literally —
 *  the caller then renders the block with the non-reflow path. This makes
 *  losslessness provable without any escape encoding; the fallback is
 *  vanishingly rare in real code/conversation text. */
export function reflow(text: string): string | null {
  if (text.indexOf(NL_SENTINEL) >= 0) return null;
  return minifyForRender(text)
    .split('\n')
    .map(expandTabsInLine)
    .join(NL_SENTINEL);
}

/** Inverse of `reflow` at the logical-text level: NL_SENTINEL → '\n'. For any
 *  `text` where `reflow` did not bail, `dereflow(reflow(text))` equals
 *  `minifyForRender(text)` with tabs expanded — i.e. exactly the text the
 *  *current* (non-reflow) renderer also displays. Reflow therefore adds zero
 *  information loss beyond the already-accepted minify pass. */
export function dereflow(reflowed: string): string {
  return reflowed.split(NL_SENTINEL).join('\n');
}

/** Expand `\t` in a single line to a visible `→` (U+2192) glyph + padding
 *  spaces to the next `TAB_WIDTH` tab stop. Honors visual columns: wide
 *  chars (CJK) count as 2 columns so tab alignment after `中\tx` lands
 *  where a human reader would expect.
 *
 *  WHY a visible marker, not silent spaces: the model sees tab indent
 *  *structure* explicitly. Silent spaces would lose the "this was an
 *  indent" signal — diffs, code, log columns all benefit when the OCR
 *  reader can tell indent-spaces apart from intentional-spaces. The arrow
 *  glyph U+2192 is in the Arrows block (already in both `practical` and
 *  `full-bmp` atlas profiles, zero added cost).
 *
 *  WHY this exists at all: U+0009 isn't in the atlas (it's a control
 *  codepoint, not a glyph), so before this fix it counted as a dropped
 *  char and rendered as a blank cell with no width compensation. Real
 *  production telemetry on 2026-05-19 showed 5,339 of 5,358 drops (99.6%)
 *  were tabs — fixed here. */
export function expandTabsInLine(line: string): string {
  if (line.indexOf('\t') < 0) return line; // fast path: no tabs
  let out = '';
  let col = 0;
  for (const ch of line) {
    if (ch === '\t') {
      const span = TAB_WIDTH - (col % TAB_WIDTH);
      out += '→'; // → arrow at the tab boundary (1 col)
      if (span > 1) out += ' '.repeat(span - 1); // padding to next tab stop
      col += span;
    } else {
      out += ch;
      col += cellsFor(ch.codePointAt(0)!);
    }
  }
  return out;
}

/** Soft-wrap a single logical line at `cols` visual columns, accounting for
 *  wide cells. Wide chars that would exceed the column budget wrap before
 *  the char (leaving the last narrow slot blank). Mirrors the old
 *  character-count behavior for pure-ASCII input — guarantees the
 *  determinism test stays byte-identical.
 *
 *  Pipeline order (per HANDOFF R1):
 *    1. minifyForRender: strip trailing whitespace, collapse 4+ \n → 3 \n
 *    2. expandTabsInLine: \t → '→' + padding to next 4-stop
 *    3. soft-wrap by visual column budget (this loop)
 *  Minify runs first so trailing tabs get stripped before they'd
 *  needlessly expand to arrow + spaces. */
/** Visual width of a single wrapped line in cells. Wide CJK glyphs count as
 *  2, the enlarged ↵ marker counts as `markerScale` when `markerScale > 1`.
 *  Iterates codepoints (handles surrogate pairs correctly). */
export function measureLineCols(line: string, markerScale: number = 1): number {
  let w = 0;
  for (const ch of line) w += cellsFor(ch.codePointAt(0)!, markerScale);
  return w;
}

/** Policy: always render at full canvas width — no shrink-to-content.
 *  Maximum chars per page = maximum image-token savings on dense content,
 *  and the unused canvas tail is just whitespace (cheap to encode). The
 *  signature is preserved so callers (transform.ts) still compile; the
 *  function now returns `cols` unchanged. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function shrinkColsToContent(text: string, cols: number, markerScale: number = 1): number {
  return Math.max(1, cols | 0);
}

export function wrapLines(text: string, cols: number, markerScale: number = 1): string[] {
  const out: string[] = [];
  const minified = minifyForRender(text);
  for (const rawWithTabs of minified.split('\n')) {
    const raw = expandTabsInLine(rawWithTabs);
    if (raw.length === 0) {
      out.push('');
      continue;
    }
    let cur = '';
    let curCols = 0;
    // Codepoint iteration: handles surrogate pairs as one unit.
    // Packed reflow: the ↵ sentinel is treated as an INLINE glyph — every
    // visual row fills to `cols` regardless of source-line boundaries. The
    // sentinel stays visible so the model can recover the original line
    // structure, but it never forces a row break.
    for (const ch of raw) {
      const cp = ch.codePointAt(0)!;
      const w = cellsFor(cp, markerScale);
      if (curCols + w > cols) {
        out.push(cur);
        cur = ch;
        curCols = w;
      } else {
        cur += ch;
        curCols += w;
      }
    }
    if (cur.length > 0) out.push(cur);
  }
  return out;
}

function splitWrappedLinesIntoReadablePages(
  lines: string[],
  maxLines: number,
  maxChars: number = READABLE_CHARS_PER_IMAGE,
): string[][] {
  const pages: string[][] = [];
  let cur: string[] = [];
  let curChars = 0;
  const lineLimit = Math.max(1, maxLines | 0);
  const charLimit = Math.max(1, maxChars | 0);

  for (const line of lines) {
    const lineChars = line.length + (cur.length > 0 ? 1 : 0);
    if (
      cur.length > 0 &&
      (cur.length >= lineLimit || curChars + lineChars > charLimit)
    ) {
      pages.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(line);
    curChars += line.length + (cur.length > 1 ? 1 : 0);
  }
  if (cur.length > 0) pages.push(cur);
  return pages.length > 0 ? pages : [[]];
}

function readableLinesPerColumn(cols: number): number {
  return Math.max(1, Math.floor(READABLE_CHARS_PER_IMAGE / Math.max(1, cols)));
}

/**
 * Blit a single glyph onto the framebuffer at cell coordinate (cx, cy).
 * Returns the number of cells the glyph occupies (1 or 2). 0 if the
 * codepoint isn't in the atlas — caller MUST still advance by 1 cell to
 * keep wrap math stable.
 *
 * Coordinate convention: `x`, `y` are pixel positions of the cell's
 * top-left corner. The glyph fills `(advance × CELL_W) × CELL_H` pixels.
 */
function blitGlyph(
  fb: Uint8Array,
  fbW: number,
  x: number,
  y: number,
  codepoint: number,
  markerMask: Uint8Array | null = null,
): number {
  const rank = atlasRank(codepoint);
  if (rank < 0) return 0;
  const wide = ATLAS_WIDE_FLAGS[rank] === 1;
  const srcW = wide ? 2 * ATLAS_CELL_W : ATLAS_CELL_W;
  // ATLAS_OFFSETS is a BIT offset since the bit-pack slice. To read pixel
  // (gx, gy) of this glyph: bitIdx = srcOff + gy*srcW + gx, then extract
  // the MSB-first bit at byte (bitIdx >>> 3), position 7 - (bitIdx & 7).
  // Output pixel = 0 (background) or 255 (full ink).
  const srcOff = ATLAS_OFFSETS[rank]!;
  for (let gy = 0; gy < ATLAS_CELL_H; gy++) {
    const dstRow = (y + gy) * fbW + x;
    const bitRowStart = srcOff + gy * srcW;
    for (let gx = 0; gx < srcW; gx++) {
      const bitIdx = bitRowStart + gx;
      const byte = ATLAS_PIXELS[bitIdx >>> 3]!;
      const bit = (byte >>> (7 - (bitIdx & 7))) & 1;
      if (bit) {
        // 1-bit pixel: full ink. No max() blending needed since glyphs
        // never overlap in our grid layout — set unconditionally.
        fb[dstRow + gx] = 255;
        if (markerMask) markerMask[dstRow + gx] = 1;
      }
    }
  }
  return wide ? 2 : 1;
}

/**
 * Blit a single glyph from the grayscale atlas (atlas-gray.ts) onto the
 * framebuffer at pixel position (x, y). Reads coverage bytes and writes
 * `fb[idx] = Math.max(fb[idx], coverage)` so glyph ink accumulates without
 * overwriting already-inked pixels (max blending, same convention as the
 * 1-bit path which just sets 255).
 *
 * EVAL-ONLY: called only when style.aa is set. The 1-bit blitGlyph path
 * is unchanged and remains byte-identical to before.
 *
 * Returns the number of cells the glyph occupies (1 or 2), or 0 if the
 * codepoint is absent from the gray atlas.
 */
function blitGlyphGray(
  fb: Uint8Array,
  fbW: number,
  x: number,
  y: number,
  codepoint: number,
): number {
  const rank = atlasGrayRank(codepoint);
  if (rank < 0) return 0;
  const wide = ATLAS_GRAY_WIDE_FLAGS[rank] === 1;
  const srcW = wide ? 2 * ATLAS_GRAY_CELL_W : ATLAS_GRAY_CELL_W;
  // ATLAS_GRAY_OFFSETS is a BYTE offset (1 byte per pixel, unlike the bit-packed 1-bit atlas).
  const srcOff = ATLAS_GRAY_OFFSETS[rank]!;
  for (let gy = 0; gy < ATLAS_GRAY_CELL_H; gy++) {
    const dstRow = (y + gy) * fbW + x;
    const srcRow = srcOff + gy * srcW;
    for (let gx = 0; gx < srcW; gx++) {
      const coverage = ATLAS_GRAY_PIXELS[srcRow + gx]!;
      if (coverage > 0) {
        const idx = dstRow + gx;
        if (coverage > fb[idx]!) fb[idx] = coverage;
      }
    }
  }
  return wide ? 2 : 1;
}

/** Blit a glyph scaled horizontally by `scaleX` (each atlas pixel becomes
 *  `scaleX` px wide; height unchanged). Used for the enlarged ↵ marker:
 *  horizontal-only scaling keeps it from overlapping the densely-packed row
 *  below, which a uniform scale-up would corrupt. Marks `markerMask` for the
 *  red-output path. Returns cells advanced (`scaleX`, `2*scaleX` if wide). */
function blitGlyphScaled(
  fb: Uint8Array,
  markerMask: Uint8Array | null,
  fbW: number,
  fbH: number,
  x: number,
  y: number,
  codepoint: number,
  scaleX: number,
): number {
  const rank = atlasRank(codepoint);
  if (rank < 0) return 0;
  const wide = ATLAS_WIDE_FLAGS[rank] === 1;
  const srcW = wide ? 2 * ATLAS_CELL_W : ATLAS_CELL_W;
  const srcOff = ATLAS_OFFSETS[rank]!;
  for (let gy = 0; gy < ATLAS_CELL_H; gy++) {
    const py = y + gy;
    if (py >= fbH) break;
    const bitRowStart = srcOff + gy * srcW;
    for (let gx = 0; gx < srcW; gx++) {
      const bitIdx = bitRowStart + gx;
      const byte = ATLAS_PIXELS[bitIdx >>> 3]!;
      if (((byte >>> (7 - (bitIdx & 7))) & 1) === 0) continue;
      for (let sx = 0; sx < scaleX; sx++) {
        const px = x + gx * scaleX + sx;
        if (px >= fbW) break;
        const idx = py * fbW + px;
        fb[idx] = 255;
        if (markerMask) markerMask[idx] = 1;
      }
    }
  }
  return wide ? 2 * scaleX : scaleX;
}

/** Faint grey grid ink, pre-invert. 25 → post-invert 230: a light-grey rule
 *  distinct from the multicol gutter divider (pre 64 → post 191) by both
 *  shade and orientation, so a row rule is never mistaken for a column edge. */
const GRID_INK = 25;

/** Paint grid rules into the framebuffer. Rules are written only onto
 *  background pixels — glyph ink always wins — so the grid adds zero pixels
 *  to the image (no width, no height, no token cost). It exists purely to
 *  give the vision model row/column landmarks that dense reflow packing
 *  destroys. Horizontal rule: bottom pixel-row of every cell-band (one ruled
 *  lane per text row). Vertical rules: every `gridCols` columns when > 0. */
function drawGrid(
  fb: Uint8Array,
  fbW: number,
  fbH: number,
  rows: number,
  gridCols: number,
  cellH: number,
  cellW: number,
  glyphH: number = ATLAS_CELL_H,
): void {
  for (let row = 0; row < rows; row++) {
    const y = PAD_Y + row * cellH + (glyphH - 1);
    if (y >= fbH) break;
    const rowStart = y * fbW;
    for (let x = 0; x < fbW; x++) {
      if (fb[rowStart + x] === 0) fb[rowStart + x] = GRID_INK;
    }
  }
  if (gridCols > 0) {
    for (let col = gridCols; ; col += gridCols) {
      const x = PAD_X + col * cellW;
      if (x >= fbW - PAD_X) break;
      for (let y = 0; y < fbH; y++) {
        const idx = y * fbW + x;
        if (fb[idx] === 0) fb[idx] = GRID_INK;
      }
    }
  }
}

/** Render up to `maxLines` of `text` to a single PNG, returning the unwritten
 *  tail. Each line gets one cell-row in the framebuffer; wide glyphs occupy
 *  two consecutive cells horizontally. */
export async function renderChunkToPng(
  text: string,
  cols: number = DEFAULT_COLS,
  style: RenderStyle = {},
): Promise<RenderedImage> {
  const useAA = style.aa === true;
  const atlasH = useAA ? ATLAS_GRAY_CELL_H : ATLAS_CELL_H;
  const atlasW = useAA ? ATLAS_GRAY_CELL_W : ATLAS_CELL_W;
  const markerScale = Math.max(1, Math.floor(style.markerScale ?? 1));
  const cellH = atlasH + Math.max(0, Math.floor(style.cellHBonus ?? DEFAULT_CELL_H_BONUS));
  const cellW = Math.max(1, atlasW + Math.floor(style.cellWBonus ?? DEFAULT_CELL_W_BONUS));
  const lines = wrapLines(text, cols, markerScale);

  // Vertical budget: cap by MAX_HEIGHT_PX, then take that many lines.
  const maxLines = Math.max(1, Math.floor((MAX_HEIGHT_PX - 2 * PAD_Y) / cellH));
  const fitLines = lines.slice(0, maxLines);

  // charsRendered = how many *input* codepoints this image covers. If we fit
  // the whole input, that's just the codepoint count of `text`. If we had to
  // drop overflow lines, we count only the chars in the lines we kept,
  // including the input newlines BETWEEN them but excluding synthetic
  // newlines that `wrapLines` introduced for soft-wrap.
  let charsRendered: number;
  if (fitLines.length === lines.length) {
    // Full coverage: count input codepoints exactly. `for..of` iterates by
    // codepoint, so surrogate pairs above U+FFFF count as 1.
    let n = 0;
    for (const _ of text) n++;
    charsRendered = n;
  } else {
    // Partial coverage: sum codepoints in the lines we kept, plus one for
    // each line break (since the input separator was either a real '\n' or a
    // soft-wrap point — both represent one input position we covered).
    let n = 0;
    for (let i = 0; i < fitLines.length; i++) {
      for (const _ of fitLines[i]!) n++;
    }
    // Each pair of adjacent fitLines was separated by either an input '\n'
    // or a soft-wrap point; we cover (fitLines.length - 1) such separators.
    n += Math.max(0, fitLines.length - 1);
    charsRendered = n;
  }

  // When cellW < the glyph width, the last glyph overruns its cell; widen the
  // canvas by that overhang so it stays inside the framebuffer.
  const width = 2 * PAD_X + cols * cellW + Math.max(0, atlasW - cellW);
  const height = 2 * PAD_Y + fitLines.length * cellH;

  // Black canvas (matches atlas: text is white-on-black, we invert below to
  // black-on-white for crispness — same convention as the Python proxy).
  const fb = new Uint8Array(width * height);
  // Marker mask: 1 where a ↵ glyph was inked, so the red-output path can
  // recolor exactly those pixels. null when no red marker was requested.
  const markerMask: Uint8Array | null =
    style.markerRed ? new Uint8Array(width * height) : null;
  // Color-cycle mask: stores colorIndex+1 per inked pixel (0 = background).
  // Each successive glyph cell gets a different palette color so the vision
  // encoder sees a hard color boundary at every character boundary.
  const useColorCycle = style.colorCycle === true;
  const colorMask: Uint8Array | null =
    useColorCycle ? new Uint8Array(width * height) : null;

  let droppedChars = 0;
  const droppedCodepoints = new Map<number, number>();
  let glyphIndex = 0; // increments for every glyph cell (including spaces/missing)
  for (let row = 0; row < fitLines.length; row++) {
    const line = fitLines[row]!;
    const baseY = PAD_Y + row * cellH;
    let col = 0;
    for (const ch of line) {
      if (col >= cols) break; // shouldn't happen — wrap should have prevented
      const codepoint = ch.codePointAt(0)!;
      const baseX = PAD_X + col * cellW;
      const isMarker = codepoint === NL_SENTINEL_CP;
      // For colorCycle: determine palette color for this glyph cell.
      const colorIdx = glyphIndex % GLYPH_PALETTE.length;
      // colorSlot is colorIdx+1 (0 is reserved for background in colorMask).
      const colorSlot = colorIdx + 1;
      let advance: number;
      if (isMarker && markerScale > 1) {
        // Enlarged ↵: scaled horizontally only — a packed grid has no
        // vertical room, so a uniform scale-up would corrupt the next row.
        advance = blitGlyphScaled(fb, markerMask, width, height, baseX, baseY, codepoint, markerScale);
        // Also stamp colorMask for the enlarged marker pixels if colorCycle.
        if (colorMask) {
          for (let gy = 0; gy < atlasH; gy++) {
            const py = baseY + gy;
            if (py >= height) break;
            for (let gx = 0; gx < advance * cellW; gx++) {
              const px = baseX + gx;
              if (px >= width) break;
              const idx = py * width + px;
              if (fb[idx]! > 0) colorMask[idx] = colorSlot;
            }
          }
        }
      } else if (useAA) {
        advance = blitGlyphGray(fb, width, baseX, baseY, codepoint);
        // For AA + colorCycle: stamp colorMask for every pixel blitGlyphGray
        // wrote coverage into. We detect coverage by checking fb[idx] > 0
        // after the blit. Stamp the glyph's cell region.
        if (colorMask && advance > 0) {
          const srcW = advance * atlasW;
          for (let gy = 0; gy < atlasH; gy++) {
            const py = baseY + gy;
            if (py >= height) break;
            for (let gx = 0; gx < srcW; gx++) {
              const px = baseX + gx;
              if (px >= width) break;
              const idx = py * width + px;
              if (fb[idx]! > 0) colorMask[idx] = colorSlot;
            }
          }
        }
      } else {
        advance = blitGlyph(fb, width, baseX, baseY, codepoint, isMarker ? markerMask : null);
        // For 1-bit + colorCycle: stamp colorMask for every inked pixel.
        if (colorMask && advance > 0) {
          const srcW = advance * atlasW;
          for (let gy = 0; gy < atlasH; gy++) {
            const py = baseY + gy;
            if (py >= height) break;
            for (let gx = 0; gx < srcW; gx++) {
              const px = baseX + gx;
              if (px >= width) break;
              const idx = py * width + px;
              if (fb[idx]! > 0) colorMask[idx] = colorSlot;
            }
          }
        }
      }
      glyphIndex++;
      if (advance === 0) {
        droppedChars++;
        droppedCodepoints.set(codepoint, (droppedCodepoints.get(codepoint) ?? 0) + 1);
        col += 1; // missing glyph still occupies one cell so wrap stays stable
      } else {
        col += advance;
      }
    }
  }

  // Grid: faint grey row/column rules drawn only onto background pixels (glyph
  // ink always wins), adding zero pixels — pure structure, no token cost.
  if (style.grid) {
    drawGrid(fb, width, height, fitLines.length, Math.max(0, Math.floor(style.gridCols ?? 0)), cellH, cellW, atlasH);
  }

  // Invert: atlas stores white-on-black coverage; black-on-white renders
  // cleaner and matches what the Python proxy emits.
  for (let i = 0; i < fb.length; i++) fb[i] = 255 - fb[i]!;

  let png: Uint8Array;
  if (colorMask) {
    // colorCycle RGB output: each inked pixel gets its glyph's palette color
    // (AA-blended onto white background). Non-inked pixels stay white.
    // markerRed is ignored when colorCycle is active — palette colors subsume it.
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < fb.length; i++) {
      const g = fb[i]!; // post-invert: 0 = pure black ink, 255 = white background
      const slot = colorMask[i]!;
      if (slot > 0) {
        // Inked pixel: blend palette color onto white background.
        // coverage = how much ink (0..255 range, pre-invert fb was 0..255 coverage).
        // Post-invert: g = 255 - coverage, so coverage = 255 - g.
        const coverage = 255 - g;
        const [pr, pg, pb] = GLYPH_PALETTE[(slot - 1) % GLYPH_PALETTE.length]!;
        // AA blend: channel = 255 - coverage*(255-paletteChannel)/255
        rgb[i * 3]     = Math.round(255 - coverage * (255 - pr!) / 255);
        rgb[i * 3 + 1] = Math.round(255 - coverage * (255 - pg!) / 255);
        rgb[i * 3 + 2] = Math.round(255 - coverage * (255 - pb!) / 255);
      } else {
        // Background pixel: white.
        rgb[i * 3]     = g;
        rgb[i * 3 + 1] = g;
        rgb[i * 3 + 2] = g;
      }
    }
    png = await encodeRgbPng(rgb, width, height);
  } else if (markerMask) {
    // RGB output: marker ink → red, every other pixel stays greyscale.
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < fb.length; i++) {
      const g = fb[i]!;
      if (markerMask[i] === 1 && g < 128) {
        rgb[i * 3] = 220; // R
        rgb[i * 3 + 1] = 0; // G
        rgb[i * 3 + 2] = 0; // B
      } else {
        rgb[i * 3] = g;
        rgb[i * 3 + 1] = g;
        rgb[i * 3 + 2] = g;
      }
    }
    png = await encodeRgbPng(rgb, width, height);
  } else {
    png = await encodeGrayPng(fb, width, height);
  }
  return { png, width, height, charsRendered, droppedChars, droppedCodepoints };
}

/** Reflow-aware variant of `renderTextToPngs`. When `text` can be reflowed
 *  (no sentinel collision) it renders the densely-packed stream; otherwise it
 *  falls back to the identical non-reflow output. Same return contract as
 *  `renderTextToPngs` so call sites only differ by which function they pick. */
export async function renderTextToPngsReflow(
  text: string,
  cols: number = DEFAULT_COLS,
  style: RenderStyle = {},
): Promise<RenderedImage[]> {
  const packed = reflow(text);
  return renderTextToPngs(packed ?? text, cols, style);
}

/** Split `text` into N PNGs, each ≤ MAX_HEIGHT_PX tall. */
export async function renderTextToPngsWithCharLimit(
  text: string,
  cols: number = DEFAULT_COLS,
  maxCharsPerImage: number = READABLE_CHARS_PER_IMAGE,
  style: RenderStyle = {},
): Promise<RenderedImage[]> {
  const markerScale = Math.max(1, Math.floor(style.markerScale ?? 1));
  const cellH = ATLAS_CELL_H + Math.max(0, Math.floor(style.cellHBonus ?? DEFAULT_CELL_H_BONUS));
  const lines = wrapLines(text, cols, markerScale);
  const hardLinesPerImg = Math.max(1, Math.floor((MAX_HEIGHT_PX - 2 * PAD_Y) / cellH));
  const linesPerImg = Math.min(hardLinesPerImg, readableLinesPerColumn(cols));

  const images: RenderedImage[] = [];
  for (const page of splitWrappedLinesIntoReadablePages(lines, linesPerImg, maxCharsPerImage)) {
    const chunk = page.join('\n');
    images.push(await renderChunkToPng(chunk, cols, style));
  }
  return images;
}

export async function renderTextToPngs(
  text: string,
  cols: number = DEFAULT_COLS,
  style: RenderStyle = {},
): Promise<RenderedImage[]> {
  return renderTextToPngsWithCharLimit(text, cols, READABLE_CHARS_PER_IMAGE, style);
}

// --- R2 multi-column rendering --------------------------------------------
//
// Single-column packing leaves Anthropic's 1568×1568 image area badly
// under-used: at the 5×8 cell and cols=100, our render canvas is only
// 508 px wide — ~32% of the horizontal budget. Most real Claude Code tool
// docs + CLAUDE.md content wraps well under 100 chars/row, so we end up
// paying the full per-image cost for an image that's mostly whitespace.
//
// R2 packs N columns side-by-side per image, column-major: column 1 holds
// the first `linesPerImg` wrapped lines top-to-bottom, column 2 holds the
// next `linesPerImg`, etc. One image therefore covers `numCols×linesPerImg`
// wrapped lines instead of `linesPerImg` — image count drops by ~numCols.
//
// OCR ORDERING IS THE RISK. The vision encoder must read column 1 fully
// before column 2. Modern vision LLMs (Claude included) handle newspaper-
// column layout reasonably well when the gutter is visually clear, but
// this needs empirical verification on representative slabs before
// becoming the default. Until then this lives behind an opt-in flag.

const GUTTER_CELLS = 4;
const MAX_WIDTH_PX = 1568;

/** Mid-gray ink level for the multicol gutter divider, BEFORE the final
 *  `255 - fb[i]` invert that flips the framebuffer to black-on-white. 64
 *  pre-invert → 191 post-invert = a light gray (~75% white) that the vision
 *  encoder can resolve as a boundary cue without competing with the glyph
 *  ink (which lands at 0 = pure black). Same "visible whitespace" principle
 *  as the U+2192 tab arrow: surfaces structure that pure whitespace alone
 *  leaves ambiguous, at near-zero pixel-token cost (DEFLATE collapses long
 *  runs of identical mid-gray ~free). */
const GUTTER_DIVIDER_INK = 64;
/** Vertical inset of the divider from the canvas top/bottom edges, in pixels.
 *  Keeps the line short of the padding region so it reads as intentional
 *  rather than as a render artifact bleeding into the margin. */
const GUTTER_DIVIDER_INSET_PX = 2;

/** Pixel width of a multi-col render canvas at the given `cols` and `numCols`. */
export function multiColWidth(cols: number, numCols: number): number {
  const n = Math.max(1, numCols | 0);
  return 2 * PAD_X + n * cols * CELL_W + (n - 1) * GUTTER_CELLS * CELL_W;
}

/** Largest `numCols` that fits within MAX_WIDTH_PX at `cols`. Useful for the
 *  CLI clamp so an over-large flag doesn't produce >1568px PNGs. */
export function maxFittingCols(cols: number): number {
  let n = 1;
  while (multiColWidth(cols, n + 1) <= MAX_WIDTH_PX) n++;
  return n;
}

async function renderMultiColChunkFromLines(
  lines: string[],
  cols: number,
  numCols: number,
  charsCovered: number,
  linesPerCol: number,
): Promise<RenderedImage> {
  const width = multiColWidth(cols, numCols);
  // Height tracks the tallest column. With column-major packing column 0 is
  // always at least as tall as later columns, so usedRows = min(lines.length, linesPerImg).
  const rowsPerCol = Math.max(1, linesPerCol | 0);
  const usedRows = Math.min(lines.length, rowsPerCol);
  const height = 2 * PAD_Y + usedRows * CELL_H;

  const fb = new Uint8Array(width * height);
  let droppedChars = 0;
  const droppedCodepoints = new Map<number, number>();

  // Column-major: lines [c*linesPerImg, (c+1)*linesPerImg) land in column c.
  const colStride = cols * CELL_W + GUTTER_CELLS * CELL_W;
  for (let c = 0; c < numCols; c++) {
    const colBaseX = PAD_X + c * colStride;
    const colStart = c * rowsPerCol;
    if (colStart >= lines.length) break;
    const colEnd = Math.min(colStart + rowsPerCol, lines.length);
    for (let r = 0; r < colEnd - colStart; r++) {
      const line = lines[colStart + r]!;
      const baseY = PAD_Y + r * CELL_H;
      let col = 0;
      for (const ch of line) {
        if (col >= cols) break;
        const codepoint = ch.codePointAt(0)!;
        const baseX = colBaseX + col * CELL_W;
        const advance = blitGlyph(fb, width, baseX, baseY, codepoint);
        if (advance === 0) {
          droppedChars++;
          droppedCodepoints.set(codepoint, (droppedCodepoints.get(codepoint) ?? 0) + 1);
          col += 1;
        } else {
          col += advance;
        }
      }
    }
  }

  // Draw a faint vertical divider in each gutter BEFORE the invert pass.
  // We're still in "ink = high, background = low" framebuffer convention here,
  // so GUTTER_DIVIDER_INK (64) lands at 255-64 = 191 after the invert — a
  // light gray on the final image. Position the line in the *center* of the
  // gutter region between columns c and c+1, with a small top/bottom inset
  // so it doesn't visually bleed into the padding rows.
  //
  // Cost: ~1568 px × 1 byte = 1568 bytes of identical mid-gray. After DEFLATE
  // this is ~3-5 bytes; per-pixel token cost is β·1568 ≈ 2 tokens for the
  // entire divider at the current measured β. Trivial vs the OCR-clarity win.
  if (numCols >= 2) {
    const gutterPxPerSide = GUTTER_CELLS * CELL_W;
    const yStart = GUTTER_DIVIDER_INSET_PX;
    const yEnd = height - GUTTER_DIVIDER_INSET_PX;
    for (let c = 0; c < numCols - 1; c++) {
      // X coord: end of column c's text area + half the gutter.
      const colEndX = PAD_X + c * colStride + cols * CELL_W;
      const dividerX = colEndX + Math.floor(gutterPxPerSide / 2);
      for (let y = yStart; y < yEnd; y++) {
        const idx = y * width + dividerX;
        // Only paint if the pixel is still background (0). Defensive against
        // a glyph-overrun scenario where a wide char could in principle have
        // landed in the gutter — though our wrap math caps col < cols above,
        // so this is belt-and-braces.
        if (fb[idx] === 0) fb[idx] = GUTTER_DIVIDER_INK;
      }
    }
  }

  // Invert: black-on-white (matches single-col convention).
  for (let i = 0; i < fb.length; i++) fb[i] = 255 - fb[i]!;

  const png = await encodeGrayPng(fb, width, height);
  return {
    png,
    width,
    height,
    charsRendered: charsCovered,
    droppedChars,
    droppedCodepoints,
  };
}

/** Split `text` into N multi-column PNGs.
 *
 *  When `numCols <= 1`, delegates to `renderTextToPngs` to guarantee
 *  byte-identical output (so the determinism / cache_control story stays
 *  intact when the flag is off).
 *
 *  Column-major layout: column 0 fills top-to-bottom with the first
 *  `linesPerImg` wrapped lines, column 1 with the next `linesPerImg`, etc.
 *  One image holds `numCols × linesPerImg` wrapped lines total.
 *
 *  `charsRendered` for each image is the codepoint count of source text
 *  whose wrapped lines landed in that image, with a +1 separator between
 *  adjacent kept lines — same convention as `renderChunkToPng`. */
export async function renderTextToPngsMultiCol(
  text: string,
  cols: number = DEFAULT_COLS,
  numCols: number = 2,
): Promise<RenderedImage[]> {
  if (numCols <= 1) return renderTextToPngs(text, cols);
  if (multiColWidth(cols, numCols) > MAX_WIDTH_PX) {
    // Clamp rather than throw — keeps the proxy serving traffic even if a
    // bad CLI flag slipped through. Falls back to the widest fitting count.
    numCols = maxFittingCols(cols);
    if (numCols <= 1) return renderTextToPngs(text, cols);
  }

  const lines = wrapLines(text, cols);
  const hardLinesPerImg = Math.max(1, Math.floor((MAX_HEIGHT_PX - 2 * PAD_Y) / CELL_H));
  const linesPerImg = Math.min(hardLinesPerImg, readableLinesPerColumn(cols));
  const linesPerImage = linesPerImg * numCols;

  // Total source codepoints — for the last image we can use this directly
  // when every wrapped line fits.
  let totalChars = 0;
  for (const _ of text) totalChars++;

  const images: RenderedImage[] = [];
  let coveredChars = 0;
  const pages = splitWrappedLinesIntoReadablePages(
    lines,
    linesPerImage,
    READABLE_CHARS_PER_IMAGE * Math.max(1, numCols | 0),
  );
  for (let i = 0; i < pages.length; i++) {
    const slice = pages[i]!;
    const isLast = i === pages.length - 1;
    let chars: number;
    if (isLast) {
      // Last image: assign whatever source coverage remains so the per-image
      // counts sum to the total input codepoint count.
      chars = Math.max(0, totalChars - coveredChars);
    } else {
      // Count kept-line codepoints + one separator per adjacent pair.
      let n = 0;
      for (const ln of slice) for (const _ of ln) n++;
      n += Math.max(0, slice.length - 1);
      chars = n;
    }
    coveredChars += chars;
    images.push(await renderMultiColChunkFromLines(slice, cols, numCols, chars, linesPerImg));
  }
  return images;
}

/** Reflow-aware variant of `renderTextToPngsMultiCol`. Reflow and multi-column
 *  packing compose: reflow fills each row to `cols`, multi-col then stacks
 *  `numCols` of those dense rows side-by-side. Falls back to identical
 *  non-reflow output on sentinel collision. */
export async function renderTextToPngsReflowMultiCol(
  text: string,
  cols: number = DEFAULT_COLS,
  numCols: number = 2,
): Promise<RenderedImage[]> {
  const packed = reflow(text);
  return renderTextToPngsMultiCol(packed ?? text, cols, numCols);
}
