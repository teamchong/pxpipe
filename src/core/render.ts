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
import { encodeGrayPng } from './png.js';

/** Vertical pixel budget per rendered PNG. Bounded by Anthropic's 1568×1568
 *  image cap. Exported so the break-even gate in transform.ts can derive
 *  CHARS_PER_IMAGE from the same constants the renderer actually uses. */
export const MAX_HEIGHT_PX = 1568;
const DEFAULT_COLS = 100;
/** Horizontal padding inside the rendered PNG (left + right each). Exported
 *  so transform.ts can derive image pixel-area for token-cost estimation. */
export const PAD_X = 4;
/** Vertical padding inside the rendered PNG (top + bottom each). Exported
 *  for the same reason as MAX_HEIGHT_PX. */
export const PAD_Y = 4;

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

// --- column-aware wrapping -------------------------------------------------

/** Visual width of a codepoint in cells (1 = Latin, 2 = East Asian Wide).
 *  Codepoints not in the atlas advance by 1 cell — they render as blank but
 *  occupy space so wrap math is stable. */
function cellsFor(codepoint: number): number {
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
// Reflow re-packs the text into a continuous stream that fills every row to
// `cols`, marking each original hard newline with a visible sentinel glyph
// (U+21B5 ↵). The model is told via a system-prompt note that ↵ denotes a
// line break. Inline whitespace (indentation, spaces between words) is kept —
// only the dead right-margin and blank-line rows are recovered.
//
// FIDELITY: reflow is gated behind a flag and an A/B eval. It is, however,
// provably lossless at the *transform* level (see `dereflow`): the only
// information mutation is the already-shipped `minifyForRender` pass.

/** Sentinel glyph marking an original hard newline in reflowed text. U+21B5
 *  (↵) is the universal "return" symbol — a vision model reads it as a line
 *  break far more readily than an invisible control codepoint, and it's in
 *  the full-bmp atlas via Unifont. */
export const NL_SENTINEL = '↵';

/** Re-pack `text` into a single sentinel-delimited line so `wrapLines` fills
 *  every row to `cols` instead of leaving line-end dead margin.
 *
 *  Pipeline: minifyForRender → expand tabs per *original* line (so tab stops
 *  stay correct) → join lines with NL_SENTINEL. The result contains no '\n',
 *  so downstream soft-wrap packs it densely.
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
function wrapLines(text: string, cols: number): string[] {
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
    for (const ch of raw) {
      const w = cellsFor(ch.codePointAt(0)!);
      if (curCols + w > cols) {
        out.push(cur);
        cur = ch;
        curCols = w;
      } else {
        cur += ch;
        curCols += w;
      }
    }
    out.push(cur);
  }
  return out;
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
      }
    }
  }
  return wide ? 2 : 1;
}

/** Render up to `maxLines` of `text` to a single PNG, returning the unwritten
 *  tail. Each line gets one cell-row in the framebuffer; wide glyphs occupy
 *  two consecutive cells horizontally. */
export async function renderChunkToPng(
  text: string,
  cols: number = DEFAULT_COLS,
): Promise<RenderedImage> {
  const lines = wrapLines(text, cols);

  // Vertical budget: cap by MAX_HEIGHT_PX, then take that many lines.
  const maxLines = Math.max(1, Math.floor((MAX_HEIGHT_PX - 2 * PAD_Y) / ATLAS_CELL_H));
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

  const width = 2 * PAD_X + cols * ATLAS_CELL_W;
  const height = 2 * PAD_Y + fitLines.length * ATLAS_CELL_H;

  // Black canvas (matches atlas: text is white-on-black, we invert below to
  // black-on-white for crispness — same convention as the Python proxy).
  const fb = new Uint8Array(width * height);

  let droppedChars = 0;
  const droppedCodepoints = new Map<number, number>();
  for (let row = 0; row < fitLines.length; row++) {
    const line = fitLines[row]!;
    const baseY = PAD_Y + row * ATLAS_CELL_H;
    let col = 0;
    for (const ch of line) {
      if (col >= cols) break; // shouldn't happen — wrap should have prevented
      const codepoint = ch.codePointAt(0)!;
      const baseX = PAD_X + col * ATLAS_CELL_W;
      const advance = blitGlyph(fb, width, baseX, baseY, codepoint);
      if (advance === 0) {
        droppedChars++;
        droppedCodepoints.set(codepoint, (droppedCodepoints.get(codepoint) ?? 0) + 1);
        col += 1; // missing glyph still occupies one cell so wrap stays stable
      } else {
        col += advance;
      }
    }
  }

  // Invert: atlas stores white-on-black coverage; black-on-white renders
  // cleaner and matches what the Python proxy emits.
  for (let i = 0; i < fb.length; i++) fb[i] = 255 - fb[i]!;

  const png = await encodeGrayPng(fb, width, height);
  return { png, width, height, charsRendered, droppedChars, droppedCodepoints };
}

/** Reflow-aware variant of `renderTextToPngs`. When `text` can be reflowed
 *  (no sentinel collision) it renders the densely-packed stream; otherwise it
 *  falls back to the identical non-reflow output. Same return contract as
 *  `renderTextToPngs` so call sites only differ by which function they pick. */
export async function renderTextToPngsReflow(
  text: string,
  cols: number = DEFAULT_COLS,
): Promise<RenderedImage[]> {
  const packed = reflow(text);
  return renderTextToPngs(packed ?? text, cols);
}

/** Split `text` into N PNGs, each ≤ MAX_HEIGHT_PX tall. */
export async function renderTextToPngs(
  text: string,
  cols: number = DEFAULT_COLS,
): Promise<RenderedImage[]> {
  const lines = wrapLines(text, cols);
  const linesPerImg = Math.max(1, Math.floor((MAX_HEIGHT_PX - 2 * PAD_Y) / ATLAS_CELL_H));

  const images: RenderedImage[] = [];
  for (let i = 0; i < lines.length; i += linesPerImg) {
    const chunk = lines.slice(i, i + linesPerImg).join('\n');
    images.push(await renderChunkToPng(chunk, cols));
  }
  return images;
}

// --- R2 multi-column rendering --------------------------------------------
//
// Single-column packing leaves Anthropic's 1568×1568 image area badly
// under-used: at cell 5×8 and cols=100, our render canvas is only 508 px
// wide — ~32% of the horizontal budget. Most real Claude Code tool docs +
// CLAUDE.md content wraps at well under 100 chars/row, so we end up paying
// the per-image cost (~2,500 tokens) for an image that's mostly whitespace.
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
  return 2 * PAD_X + n * cols * ATLAS_CELL_W + (n - 1) * GUTTER_CELLS * ATLAS_CELL_W;
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
): Promise<RenderedImage> {
  const linesPerImg = Math.max(1, Math.floor((MAX_HEIGHT_PX - 2 * PAD_Y) / ATLAS_CELL_H));
  const width = multiColWidth(cols, numCols);
  // Height tracks the tallest column. With column-major packing column 0 is
  // always at least as tall as later columns, so usedRows = min(lines.length, linesPerImg).
  const usedRows = Math.min(lines.length, linesPerImg);
  const height = 2 * PAD_Y + usedRows * ATLAS_CELL_H;

  const fb = new Uint8Array(width * height);
  let droppedChars = 0;
  const droppedCodepoints = new Map<number, number>();

  // Column-major: lines [c*linesPerImg, (c+1)*linesPerImg) land in column c.
  const colStride = cols * ATLAS_CELL_W + GUTTER_CELLS * ATLAS_CELL_W;
  for (let c = 0; c < numCols; c++) {
    const colBaseX = PAD_X + c * colStride;
    const colStart = c * linesPerImg;
    if (colStart >= lines.length) break;
    const colEnd = Math.min(colStart + linesPerImg, lines.length);
    for (let r = 0; r < colEnd - colStart; r++) {
      const line = lines[colStart + r]!;
      const baseY = PAD_Y + r * ATLAS_CELL_H;
      let col = 0;
      for (const ch of line) {
        if (col >= cols) break;
        const codepoint = ch.codePointAt(0)!;
        const baseX = colBaseX + col * ATLAS_CELL_W;
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
    const gutterPxPerSide = GUTTER_CELLS * ATLAS_CELL_W;
    const yStart = GUTTER_DIVIDER_INSET_PX;
    const yEnd = height - GUTTER_DIVIDER_INSET_PX;
    for (let c = 0; c < numCols - 1; c++) {
      // X coord: end of column c's text area + half the gutter.
      const colEndX = PAD_X + c * colStride + cols * ATLAS_CELL_W;
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
  const linesPerImg = Math.max(1, Math.floor((MAX_HEIGHT_PX - 2 * PAD_Y) / ATLAS_CELL_H));
  const linesPerImage = linesPerImg * numCols;
  const totalLines = lines.length;

  // Total source codepoints — for the last image we can use this directly
  // when every wrapped line fits.
  let totalChars = 0;
  for (const _ of text) totalChars++;

  const images: RenderedImage[] = [];
  let coveredChars = 0;
  for (let i = 0; i < totalLines; i += linesPerImage) {
    const slice = lines.slice(i, i + linesPerImage);
    const isLast = i + linesPerImage >= totalLines;
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
    images.push(await renderMultiColChunkFromLines(slice, cols, numCols, chars));
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
