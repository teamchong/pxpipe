/**
 * Text → PNG renderer. Blits atlas glyphs into a grayscale framebuffer, then PNG-encodes.
 * Iterates by codepoint so East Asian Wide chars (2-cell advance) and surrogate pairs handled correctly.
 * Pages capped at ~1932×1932 px: Fable/Opus 4.8 >20-image requests are held to ≤2000 px/side
 * (REJECTED if exceeded, not silently downscaled); ≤4784 token limit binds first at 1932 px.
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

/** Page-height ceiling. Measured (2026-07-01, count_tokens sweep, claude-sonnet-4-5 — see
 *  /tmp/pxexp/LEVER1-findings.md): the API downscales any image to fit BOTH long-edge ≤1568
 *  AND ~1.15 MP (≈1,143,750 px), then bills ≈ px/750 (≈1525 tok cap, applied per-image).
 *  The old 1932×1932 page was billed at cap but resampled 0.555× → 5×8 glyphs reached the
 *  encoder at ~2.8×4.4 px. New page shape 1568×728 = 1,141,504 px fits both bounds →
 *  WYSIWYG for the vision encoder (also satisfies ≤2000 px/side for >20-image requests). */
export const MAX_HEIGHT_PX = 728;
/** Char budget for the static slab (system + tools + CLAUDE.md). Matches physical page
 *  capacity at 312 cols × 90 rows so image-count estimates track real pagination. */
export const READABLE_CHARS_PER_IMAGE = 28080;
/** Char budget for dense content (tool output, collapsed history). 312 cols × 90 rows = 28080
 *  chars fills the 1568×728 page. NOTE: verbatim recall of imaged text is unreliable at any size. */
export const DENSE_CONTENT_CHARS_PER_IMAGE = 28080;
export const DENSE_CONTENT_COLS = 312;
/** Bare 5×8 cell (no padding). A/B showed 5×8 beats 7×10 on dense JSON (4/5 vs 3/5 reads, 42% fewer tokens).
 *  Revert to {cellWBonus:2, cellHBonus:2} if misread rates rise. */
export const DENSE_RENDER_STYLE: RenderStyle = { cellWBonus: 0, cellHBonus: 0, aa: true };
/** Default columns for the static slab. 312 × 5 px + 8 px pad = 1568 px — exactly the API's
 *  long-edge bound (313 cols = 1573 px would trigger a 0.997× resample, blurring every glyph). */
const DEFAULT_COLS = 312;
/** Horizontal padding (left + right each), px. Exported for transform.ts token-cost math. */
export const PAD_X = 4;
/** Vertical padding (top + bottom each), px. Exported for transform.ts token-cost math. */
export const PAD_Y = 4;

/** Production ships bare 5×8 atlas cell (reflow+grayscale+inimage instruction band
 *  brought 5×8 to 98.95% OCR accuracy on Opus 4.7, matching or beating padded cells).
 *  RenderStyle.cellWBonus/cellHBonus override per-eval only. */
export const DEFAULT_CELL_W_BONUS = 0;
export const DEFAULT_CELL_H_BONUS = 0;
/** Effective cell pixel dimensions. transform.ts derives image-budget math from these. */
export const CELL_W = ATLAS_CELL_W + DEFAULT_CELL_W_BONUS;
export const CELL_H = ATLAS_CELL_H + DEFAULT_CELL_H_BONUS;

export interface RenderedImage {
  png: Uint8Array;
  width: number;
  height: number;
  /** Input codepoints rendered (wide chars count as 1, not 2). */
  charsRendered: number;
  /** Codepoints absent from atlas, rendered as blank cells. Surface as telemetry. */
  droppedChars: number;
  /** Per-codepoint drop histogram. Empty when droppedChars === 0; never undefined. */
  droppedCodepoints: Map<number, number>;
}

/** Optional render-time styling. All fields unset = production default 5×8 cell.
 *  Eval harness overrides per variant to A/B cell sizes and structure aids. */
export interface RenderStyle {
  /** Draw faint grey grid rules onto background pixels (zero pixel cost). */
  grid?: boolean;
  /** Draw a vertical grid rule every N columns. 0/unset = row rules only. */
  gridCols?: number;
  /** Horizontal size multiplier for the ↵ newline marker. 1 = off. */
  markerScale?: number;
  /** Render the ↵ marker in red (switches PNG to RGB truecolor). */
  markerRed?: boolean;
  /** Extra blank rows above the 8px glyph (cell height = 8 + this). Unset = DEFAULT_CELL_H_BONUS. */
  cellHBonus?: number;
  /** Extra blank columns beside the 5px glyph (cell width = 5 + this). Negative overlaps glyphs. Unset = DEFAULT_CELL_W_BONUS. */
  cellWBonus?: number;
  /** Use the AA grayscale atlas (atlas-gray.ts). EVAL-ONLY; default 1-bit path is unchanged. */
  aa?: boolean;
  /** Cycle palette colors per glyph for per-character boundary cues. Forces RGB output. Composes with aa. */
  colorCycle?: boolean;
  /** Tint only the structural <user>/<assistant> boundary tags (body stays black)
   *  so speakers are scannable without recoloring content. Forces RGB. Composes with aa. */
  colorByRole?: boolean;
}

// --- column-aware wrapping -------------------------------------------------

/** Visual width of a codepoint in cells (1 = Latin, 2 = East Asian Wide).
 *  Missing codepoints advance 1 cell so wrap math stays stable. */
function cellsFor(codepoint: number, markerScale: number = 1): number {
  // Enlarged ↵ occupies markerScale cells of wrap budget instead of 1.
  if (codepoint === NL_SENTINEL_CP && markerScale > 1) return markerScale;
  const rank = atlasRank(codepoint);
  if (rank < 0) return 1;
  return ATLAS_WIDE_FLAGS[rank] === 1 ? 2 : 1;
}

const TAB_WIDTH = 4; // standard 4-space tab stops (logs, code, tool output are all 4-oriented)

/** Strip trailing whitespace per line and collapse 4+ consecutive \n to 3.
 *  Does NOT touch mid-line spaces or leading indent — structure is preserved. */
export function minifyForRender(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n'); // 4+ \n → 3 \n (max 2 blank lines)
}

// --- R3 reflow -------------------------------------------------------------
//
// Marks each original hard newline with U+21B5 ↵ so the model can distinguish
// real newlines from soft-wraps. Lossless at the transform level (see dereflow):
// the only mutation is the minifyForRender pass. Wrap-the-line measured ~99%
// OCR fidelity vs ~78% for naive dense packing.

/** U+21B5 ↵ sentinel for original hard newlines in reflowed text. In full-bmp atlas via Unifont. */
export const NL_SENTINEL = '↵';

const NL_SENTINEL_CP = 0x21b5; // precomputed for hot-path comparisons

/** Look-alike (U+23CE ⏎) for a ↵ that was ALREADY in the source content — distinct from
 *  the U+21B5 ↵ we insert for newlines. reflow() bails when its input already contains the
 *  sentinel; that's vanishingly rare for normal content but common when the content is about
 *  pxpipe itself (rendered dumps, OCR, this very transcript). {@link neutralizeSentinel}
 *  swaps pre-existing sentinels for this glyph in RENDER-PREP only, so reflow can pack
 *  newlines instead of bailing to a raw, unpacked render. Originals are preserved verbatim
 *  elsewhere (recordRecoverable / cache-stable history), and reflow()'s own round-trip
 *  contract — and its tests — are left untouched. */
export const NL_SENTINEL_LITERAL = '⏎'; // U+23CE
export function neutralizeSentinel(text: string): string {
  return text.indexOf(NL_SENTINEL) >= 0
    ? text.split(NL_SENTINEL).join(NL_SENTINEL_LITERAL)
    : text;
}

/** colorCycle palette: four dark ink-on-white hues for per-character boundary cues. */
const GLYPH_PALETTE: [number, number, number][] = [
  [20, 20, 20],   // near-black
  [20, 40, 160],  // dark blue
  [150, 20, 20],  // dark red
  [20, 110, 40],  // dark green
];

/** colorByRole palette, indexed by slot-1. Only the boundary TAGS are tinted;
 *  body content stays black. [<user> tags, <assistant> tags]. */
export const ROLE_PALETTE: [number, number, number][] = [
  [20, 120, 50],   // 1: <user> / </user> — green
  [30, 70, 180],   // 2: <assistant> / </assistant> — blue
];
const ROLE_SLOT_USER = 1;
const ROLE_SLOT_ASSISTANT = 2;

/**
 * Slot markers for the parallel "slot string" — the structure-through mechanism
 * that replaces the old parse-back. A slot string is a width-preserving copy of
 * the rendered text: every structural role-tag character is swapped for one of
 * these control codes, and every other codepoint is copied verbatim. Because the
 * markers are width-1 (exactly like the ASCII tag chars they stand in for), the
 * existing reflow / wrapLines / paging transforms mutate the slot string in lock-
 * step with the text — only whitespace/newlines move, and those are slot 0 in
 * both. The renderer then reads role attribution BY POSITION instead of trying to
 * re-find "<user>" in flattened text (which miscolors a body that literally quotes
 * a tag). The structure is known at serialize time and carried, never guessed.
 */
export const SLOT_MARK_USER = String.fromCharCode(1);
export const SLOT_MARK_ASSISTANT = String.fromCharCode(2);
const SLOT_MARK_RE = new RegExp('[' + SLOT_MARK_USER + SLOT_MARK_ASSISTANT + ']', 'g');

/** Map a slot-string codepoint to its color slot (0 = body / black ink). */
function slotForMarkCp(cp: number | undefined): number {
  if (cp === 0x0001) return ROLE_SLOT_USER;
  if (cp === 0x0002) return ROLE_SLOT_ASSISTANT;
  return 0;
}

/** Replacement for a literal slot-marker found in body content. Must (a) map to slot 0
 *  like body (it's not 0x01/0x02), (b) share the markers' width class so wrapLines splits
 *  the slot identically to the text, and (c) NOT be ' '/'\t' — minifyForRender strips
 *  trailing spaces/tabs, which would shorten the slot line (where a body \x01 sat) but not
 *  the text line (\x01 isn't stripped), desyncing the two and smearing role hues. A C0
 *  control char satisfies all three. */
const SLOT_NEUTRAL = '\u0003'; // U+0003 ETX — non-marker C0 control

/** Width-preserving slot-0 copy of body text: identical codepoints (so wrap math is
 *  unchanged) but with any literal slot-marker control char neutralized. These are rare in
 *  real content but DO occur (e.g. binary-ish tool output that gets collapsed into history),
 *  so the replacement is width- and strip-equivalent to the marker — never a space, which
 *  the minifier would strip and misalign. Guarantees body can't forge a role hue. */
export function slotCopyBody(body: string): string {
  if (body.indexOf(SLOT_MARK_USER) < 0 && body.indexOf(SLOT_MARK_ASSISTANT) < 0) return body;
  return body.replace(SLOT_MARK_RE, SLOT_NEUTRAL);
}

/** Build the slot-string segment for one role-wrapped turn, mirroring the text
 *  form `<${tag}>\n${body}\n</${tag}>`: marker chars over the open/close tags,
 *  a verbatim slot-0 copy of the body. `mark` is the role's slot marker. */
export function roleSlotSegment(tag: string, body: string, mark: string, attr = ''): string {
  // `attr` (e.g. ` t="37"`) is part of the OPEN tag, so the marker run must cover it too —
  // the renderer colors by codepoint position, so a short marker run would un-tint the
  // attribute and break alignment. Width is identical to the text tag by construction.
  const open = `<${tag}${attr}>`;
  const close = `</${tag}>`;
  return `${mark.repeat(open.length)}\n${slotCopyBody(body)}\n${mark.repeat(close.length)}`;
}

/** Minify + tab-expand + join lines with ↵ sentinel. Returns null if text already
 *  contains ↵ (caller falls back to non-reflow path; vanishingly rare in practice). */
export function reflow(text: string): string | null {
  if (text.indexOf(NL_SENTINEL) >= 0) return null;
  return minifyForRender(text)
    .split('\n')
    .map(expandTabsInLine)
    .join(NL_SENTINEL);
}

/** Inverse of reflow: ↵ → '\n'. dereflow(reflow(text)) === minifyForRender(text) with tabs expanded. */
export function dereflow(reflowed: string): string {
  return reflowed.split(NL_SENTINEL).join('\n');
}

/** Expand \t to U+2192 → + padding to the next TAB_WIDTH stop. Visible marker lets the
 *  model distinguish indent-spaces from intentional-spaces. Wide CJK chars count as 2 cols.
 *  U+0009 is absent from the atlas (control codepoint), so without this every tab was a drop. */
export function expandTabsInLine(line: string): string {
  if (line.indexOf('\t') < 0) return line; // fast path
  let out = '';
  let col = 0;
  for (const ch of line) {
    if (ch === '\t') {
      const span = TAB_WIDTH - (col % TAB_WIDTH);
      out += '→'; // visible tab marker (1 col)
      if (span > 1) out += ' '.repeat(span - 1); // pad to next stop
      col += span;
    } else {
      out += ch;
      col += cellsFor(ch.codePointAt(0)!);
    }
  }
  return out;
}

/** Visual width of a line in cells. Wide CJK = 2; enlarged ↵ = markerScale. */
export function measureLineCols(line: string, markerScale: number = 1): number {
  let w = 0;
  for (const ch of line) w += cellsFor(ch.codePointAt(0)!, markerScale);
  return w;
}

/** Always renders at full canvas width. Signature kept for transform.ts compatibility; returns cols unchanged. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function shrinkColsToContent(text: string, cols: number, markerScale: number = 1): number {
  // Real content-width measurement — delegates to measureContentCols (was historically a
  // no-op stub). The proxy's cost gate AND renderer both call this, so sizing the canvas to
  // the widest line here makes the proxy match the SDK/export path (renderTextToImages),
  // which already uses measureContentCols. Never narrows below the widest line ⇒ row count
  // (and thus image/paging count) is unchanged; only the canvas WIDTH (pixel cost) drops.
  return measureContentCols(text, cols, markerScale);
}

/**
 * Real content-width measurement (the capability `shrinkColsToContent` historically
 * stubbed out): the display width, in cols, of the widest line in `text`, capped at
 * `maxCols`. Lets a renderer size a narrow canvas to short-line content (e.g. code)
 * instead of padding every page to full width. Pure function of (text, maxCols) →
 * deterministic width → cache-prefix-safe. Tabs are expanded so the measured width
 * matches what the renderer actually lays out.
 */
export function measureContentCols(text: string, maxCols: number, markerScale: number = 1): number {
  const cap = Math.max(1, maxCols | 0);
  let widest = 1;
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      const w = measureLineCols(expandTabsInLine(text.slice(start, i)), markerScale);
      if (w > widest) widest = w;
      if (widest >= cap) return cap;
      start = i + 1;
    }
  }
  return Math.min(cap, widest);
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
    // Codepoint iteration handles surrogate pairs as one unit.
    // ↵ is treated as an inline glyph — it never forces a row break.
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
 * Blit a 1-bit glyph at pixel (x, y). Returns cells advanced (1 or 2), or 0 if absent
 * from atlas — caller must still advance 1 cell to keep wrap math stable.
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
  // ATLAS_OFFSETS is a bit offset (MSB-first packing). Pixel (gx,gy): byte = bitIdx>>>3, bit = 7-(bitIdx&7).
  const srcOff = ATLAS_OFFSETS[rank]!;
  for (let gy = 0; gy < ATLAS_CELL_H; gy++) {
    const dstRow = (y + gy) * fbW + x;
    const bitRowStart = srcOff + gy * srcW;
    for (let gx = 0; gx < srcW; gx++) {
      const bitIdx = bitRowStart + gx;
      const byte = ATLAS_PIXELS[bitIdx >>> 3]!;
      const bit = (byte >>> (7 - (bitIdx & 7))) & 1;
      if (bit) {
        fb[dstRow + gx] = 255; // glyphs never overlap in grid layout; set unconditionally
        if (markerMask) markerMask[dstRow + gx] = 1;
      }
    }
  }
  return wide ? 2 : 1;
}

/**
 * Blit a grayscale atlas glyph at pixel (x, y) using max-blending. EVAL-ONLY (style.aa).
 * Returns cells advanced (1 or 2), or 0 if absent from the gray atlas.
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
  // ATLAS_GRAY_OFFSETS is a byte offset (1 byte/pixel, unlike the bit-packed 1-bit atlas).
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

/** Blit a glyph scaled horizontally by scaleX (height unchanged). Used for enlarged ↵:
 *  horizontal-only avoids corrupting the row below. Returns cells advanced (scaleX or 2*scaleX). */
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

const GRID_INK = 25; // pre-invert → 230 post-invert; distinct from gutter divider (64 → 191)

/** Draw faint grid rules onto background pixels only (glyph ink wins). Zero pixel-cost to image size. */
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

/** Render text to a single PNG (≤ MAX_HEIGHT_PX tall). Wide glyphs occupy 2 consecutive cells. */
export async function renderChunkToPng(
  text: string,
  cols: number = DEFAULT_COLS,
  style: RenderStyle = {},
  maxHeightPx: number = MAX_HEIGHT_PX,
  slotText?: string,
): Promise<RenderedImage> {
  const useAA = style.aa === true;
  const atlasH = useAA ? ATLAS_GRAY_CELL_H : ATLAS_CELL_H;
  const atlasW = useAA ? ATLAS_GRAY_CELL_W : ATLAS_CELL_W;
  const markerScale = Math.max(1, Math.floor(style.markerScale ?? 1));
  const cellH = atlasH + Math.max(0, Math.floor(style.cellHBonus ?? DEFAULT_CELL_H_BONUS));
  const cellW = Math.max(1, atlasW + Math.floor(style.cellWBonus ?? DEFAULT_CELL_W_BONUS));
  const lines = wrapLines(text, cols, markerScale);
  // Slot string carries role attribution by position. It is width-identical to
  // `text`, so wrapLines splits it into the exact same rows — fitSlotLines[r] aligns
  // codepoint-for-codepoint with fitLines[r]. Only built when coloring is on.
  const slotLines: string[] | null =
    style.colorByRole === true && slotText !== undefined
      ? wrapLines(slotText, cols, markerScale)
      : null;

  const maxLines = Math.max(1, Math.floor((maxHeightPx - 2 * PAD_Y) / cellH));
  const fitLines = lines.slice(0, maxLines);
  const fitSlotLines = slotLines ? slotLines.slice(0, maxLines) : null;

  // charsRendered = input codepoints covered by this image (for..of counts by codepoint, not code unit).
  let charsRendered: number;
  if (fitLines.length === lines.length) {
    let n = 0;
    for (const _ of text) n++;
    charsRendered = n;
  } else {
    // Partial: sum kept-line codepoints + 1 separator per adjacent pair.
    let n = 0;
    for (let i = 0; i < fitLines.length; i++) {
      for (const _ of fitLines[i]!) n++;
    }
    n += Math.max(0, fitLines.length - 1);
    charsRendered = n;
  }

  // Widen by overhang when cellW < atlasW so the last glyph stays inside the framebuffer.
  const width = 2 * PAD_X + cols * cellW + Math.max(0, atlasW - cellW);
  const height = 2 * PAD_Y + fitLines.length * cellH;

  // Black canvas — inverted to black-on-white after blitting (matches Python proxy convention).
  const fb = new Uint8Array(width * height);
  // markerMask: 1 where ↵ glyph was inked; used to recolor those pixels red.
  const markerMask: Uint8Array | null =
    style.markerRed ? new Uint8Array(width * height) : null;
  // colorMask: stores colorSlot per inked pixel (0 = background) for colorCycle / colorByRole RGB output.
  const useColorCycle = style.colorCycle === true;
  const useColorByRole = style.colorByRole === true;
  const colorMask: Uint8Array | null =
    (useColorCycle || useColorByRole) ? new Uint8Array(width * height) : null;

  let droppedChars = 0;
  const droppedCodepoints = new Map<number, number>();
  let glyphIndex = 0; // every cell including spaces/missing
  for (let row = 0; row < fitLines.length; row++) {
    const line = fitLines[row]!;
    const baseY = PAD_Y + row * cellH;
    let col = 0;
    // Per-row slot codepoints, aligned 1:1 with `line` (same wrap, width-preserved).
    const slotRow: string[] | null =
      fitSlotLines ? Array.from(fitSlotLines[row] ?? '') : null;
    let charIdx = 0;
    for (const ch of line) {
      if (col >= cols) break; // shouldn't happen — wrap prevents this
      const codepoint = ch.codePointAt(0)!;
      const baseX = PAD_X + col * cellW;
      const isMarker = codepoint === NL_SENTINEL_CP;
      const colorSlot = useColorByRole
        ? (slotRow ? slotForMarkCp(slotRow[charIdx]?.codePointAt(0)) : 0) // 0 = body (black); only tags carry a role hue
        : (glyphIndex % GLYPH_PALETTE.length) + 1; // 0 reserved for background in colorMask
      let advance: number;
      if (isMarker && markerScale > 1) {
        advance = blitGlyphScaled(fb, markerMask, width, height, baseX, baseY, codepoint, markerScale);
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
      charIdx++;
      if (advance === 0) {
        droppedChars++;
        droppedCodepoints.set(codepoint, (droppedCodepoints.get(codepoint) ?? 0) + 1);
        col += 1; // missing glyph still occupies 1 cell for wrap stability
      } else {
        col += advance;
      }
    }
  }

  if (style.grid) {
    drawGrid(fb, width, height, fitLines.length, Math.max(0, Math.floor(style.gridCols ?? 0)), cellH, cellW, atlasH);
  }

  // Invert to black-on-white (matches Python proxy).
  for (let i = 0; i < fb.length; i++) fb[i] = 255 - fb[i]!;

  let png: Uint8Array;
  if (colorMask) {
    // colorCycle / colorByRole: AA-blend each inked pixel onto white in its palette color. markerRed ignored.
    const palette = useColorByRole ? ROLE_PALETTE : GLYPH_PALETTE;
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < fb.length; i++) {
      const g = fb[i]!; // post-invert: 0 = ink, 255 = background
      const slot = colorMask[i]!;
      if (slot > 0) {
        const coverage = 255 - g; // pre-invert coverage
        const [pr, pg, pb] = palette[(slot - 1) % palette.length]!;
        // Alpha-blend: channel = 255 - coverage*(255-palette)/255
        rgb[i * 3]     = Math.round(255 - coverage * (255 - pr!) / 255);
        rgb[i * 3 + 1] = Math.round(255 - coverage * (255 - pg!) / 255);
        rgb[i * 3 + 2] = Math.round(255 - coverage * (255 - pb!) / 255);
      } else {
        rgb[i * 3]     = g;
        rgb[i * 3 + 1] = g;
        rgb[i * 3 + 2] = g;
      }
    }
    png = await encodeRgbPng(rgb, width, height);
  } else if (markerMask) {
    // markerRed: ↵ pixels → red, everything else stays greyscale.
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

/** Reflow-aware variant of renderTextToPngs. Falls back to non-reflow on sentinel collision. */
export async function renderTextToPngsReflow(
  text: string,
  cols: number = DEFAULT_COLS,
  style: RenderStyle = {},
): Promise<RenderedImage[]> {
  const packed = reflow(text);
  return renderTextToPngs(packed ?? text, cols, style);
}

/** Split text into N PNGs each ≤ MAX_HEIGHT_PX tall, respecting per-image char budget. */
export async function renderTextToPngsWithCharLimit(
  text: string,
  cols: number = DEFAULT_COLS,
  maxCharsPerImage: number = READABLE_CHARS_PER_IMAGE,
  style: RenderStyle = {},
  maxHeightPx: number = MAX_HEIGHT_PX,
  slotText?: string,
): Promise<RenderedImage[]> {
  const markerScale = Math.max(1, Math.floor(style.markerScale ?? 1));
  const cellH = ATLAS_CELL_H + Math.max(0, Math.floor(style.cellHBonus ?? DEFAULT_CELL_H_BONUS));
  const lines = wrapLines(text, cols, markerScale);
  // Width-identical slot rows align 1:1 with `lines`; pages are contiguous slices,
  // so the same index range gives each page its slot half. Only built when coloring.
  const slotLines: string[] | null =
    style.colorByRole === true && slotText !== undefined
      ? wrapLines(slotText, cols, markerScale)
      : null;
  const hardLinesPerImg = Math.max(1, Math.floor((maxHeightPx - 2 * PAD_Y) / cellH));
  // Dense pages (DENSE_CONTENT_CHARS_PER_IMAGE) fill the full 1932 px height;
  // the slab budget (READABLE_CHARS_PER_IMAGE) keeps its shorter row cap.
  const linesPerImg = Math.min(hardLinesPerImg, Math.max(1, Math.floor(maxCharsPerImage / cols)));

  const images: RenderedImage[] = [];
  let slotCursor = 0;
  for (const page of splitWrappedLinesIntoReadablePages(lines, linesPerImg, maxCharsPerImage)) {
    const chunk = page.join('\n');
    const slotChunk = slotLines
      ? slotLines.slice(slotCursor, slotCursor + page.length).join('\n')
      : undefined;
    slotCursor += page.length;
    images.push(await renderChunkToPng(chunk, cols, style, maxHeightPx, slotChunk));
  }
  return images;
}

export async function renderTextToPngs(
  text: string,
  cols: number = DEFAULT_COLS,
  style: RenderStyle = {},
  maxHeightPx: number = MAX_HEIGHT_PX,
  slotText?: string,
): Promise<RenderedImage[]> {
  return renderTextToPngsWithCharLimit(text, cols, READABLE_CHARS_PER_IMAGE, style, maxHeightPx, slotText);
}

// --- R2 multi-column rendering --------------------------------------------
//
// Packs N columns side-by-side (column-major) so one image covers numCols×linesPerImg
// wrapped lines. Reduces image count by ~numCols for short-line content.
// OCR column ordering is the risk — gated behind an opt-in flag pending empirical eval.

const GUTTER_CELLS = 4;
// Width hard-capped at the API's long-edge bound: anything wider is resampled server-side
// (measured 2026-07-01: fit-within 1568-edge AND ~1.15 MP, then ≈px/750 billing).
const MAX_WIDTH_PX = 1568;

const GUTTER_DIVIDER_INK = 64; // pre-invert → 191 post-invert: light gray column separator
const GUTTER_DIVIDER_INSET_PX = 2; // keep divider clear of padding rows

/** Pixel width of a multi-col canvas. */
export function multiColWidth(cols: number, numCols: number): number {
  const n = Math.max(1, numCols | 0);
  return 2 * PAD_X + n * cols * CELL_W + (n - 1) * GUTTER_CELLS * CELL_W;
}

/** Largest numCols fitting within MAX_WIDTH_PX. Used to clamp over-large CLI flags. */
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
  // Column 0 is always the tallest in column-major packing.
  const rowsPerCol = Math.max(1, linesPerCol | 0);
  const usedRows = Math.min(lines.length, rowsPerCol);
  const height = 2 * PAD_Y + usedRows * CELL_H;

  const fb = new Uint8Array(width * height);
  let droppedChars = 0;
  const droppedCodepoints = new Map<number, number>();

  const colStride = cols * CELL_W + GUTTER_CELLS * CELL_W; // pixel stride per column including gutter
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

  // Draw faint vertical divider in each gutter before the invert pass (DEFLATE cost ≈ 3-5 bytes).
  if (numCols >= 2) {
    const gutterPxPerSide = GUTTER_CELLS * CELL_W;
    const yStart = GUTTER_DIVIDER_INSET_PX;
    const yEnd = height - GUTTER_DIVIDER_INSET_PX;
    for (let c = 0; c < numCols - 1; c++) {
      const colEndX = PAD_X + c * colStride + cols * CELL_W;
      const dividerX = colEndX + Math.floor(gutterPxPerSide / 2);
      for (let y = yStart; y < yEnd; y++) {
        const idx = y * width + dividerX;
        if (fb[idx] === 0) fb[idx] = GUTTER_DIVIDER_INK; // background pixels only (defensive)
      }
    }
  }

  for (let i = 0; i < fb.length; i++) fb[i] = 255 - fb[i]! // invert to black-on-white;

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

/** Split text into N multi-column PNGs. numCols <= 1 delegates to renderTextToPngs
 *  for byte-identical output (determinism/cache_control preserved when flag is off). */
export async function renderTextToPngsMultiCol(
  text: string,
  cols: number = DEFAULT_COLS,
  numCols: number = 2,
): Promise<RenderedImage[]> {
  if (numCols <= 1) return renderTextToPngs(text, cols);
  if (multiColWidth(cols, numCols) > MAX_WIDTH_PX) {
    // Clamp to widest fitting count rather than throw (bad CLI flag recovery).
    numCols = maxFittingCols(cols);
    if (numCols <= 1) return renderTextToPngs(text, cols);
  }

  const lines = wrapLines(text, cols);
  const hardLinesPerImg = Math.max(1, Math.floor((MAX_HEIGHT_PX - 2 * PAD_Y) / CELL_H));
  const linesPerImg = Math.min(hardLinesPerImg, readableLinesPerColumn(cols));
  const linesPerImage = linesPerImg * numCols;

  // Total source codepoints; assigned to the last image to ensure counts sum exactly.
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
      chars = Math.max(0, totalChars - coveredChars);
    } else {
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

/** Reflow-aware variant of renderTextToPngsMultiCol. Falls back to non-reflow on sentinel collision. */
export async function renderTextToPngsReflowMultiCol(
  text: string,
  cols: number = DEFAULT_COLS,
  numCols: number = 2,
): Promise<RenderedImage[]> {
  const packed = reflow(text);
  return renderTextToPngsMultiCol(packed ?? text, cols, numCols);
}

export interface RenderDensePagesOptions {
  /** Wrap-width cap in cols. Default DENSE_CONTENT_COLS (384). */
  readonly cols?: number;
  /** Shrink the canvas to the widest actual line (default true). `false` keeps the full
   *  `cols` width — the proxy's eval-backed full-canvas / slab behavior. */
  readonly shrink?: boolean;
  /** Columns to pack side-by-side. `'auto'` (default) packs as many as fit the width cap;
   *  a number forces that count. Collapses to 1 when the canvas shrinks below the cap. */
  readonly multiCol?: number | 'auto';
  /** Reflow (minify + join hard newlines with ↵) before rendering. Default false. Callers
   *  that pre-reflow (the proxy's maybeReflow / history lockstep) pass false; `pxpipe export`
   *  passes true so short lines pack into full-width rows. */
  readonly reflow?: boolean;
  /** Max source chars per page. Default DENSE_CONTENT_CHARS_PER_IMAGE. */
  readonly maxCharsPerImage?: number;
  /** Render style. Default DENSE_RENDER_STYLE. */
  readonly style?: RenderStyle;
  /** Max page height in px. Default MAX_HEIGHT_PX. */
  readonly maxHeightPx?: number;
}

/**
 * The single dense-page rendering decision shared by the public SDK primitive
 * `renderTextToImages` (library.ts → `pxpipe export`) AND the proxy's `textToImageBlocks`
 * (transform.ts): optionally reflow, measure the content width, pack as many side-by-side
 * columns as actually fit the width cap (or honor an explicit count, collapsing the wasted
 * divider column when the canvas shrinks), then render. Both callers route through HERE so
 * export PNGs and proxy image blocks are produced by the exact same code and cannot drift —
 * `shrinkColsToContent` is `measureContentCols`, so the proxy's old inline path was already
 * identical at the default 384 cols; this makes it identical at every cols. Returns the raw
 * rendered pages; each caller packages them (PNG files vs. base64 Anthropic ImageBlocks).
 *
 * History (history.ts) deliberately does NOT use this: it reflows a parallel role-slot string
 * in lockstep with the text and renders with `colorByRole`, which code export has no concept
 * of — wiring slots through this public surface would bloat it for one internal caller. It
 * still shares the underlying `reflow()` + `renderTextToPngsWithCharLimit` primitives.
 */
export async function renderDensePages(
  text: string,
  opts: RenderDensePagesOptions = {},
): Promise<RenderedImage[]> {
  const source = opts.reflow ? reflow(text) ?? text : text;
  const maxCols = Math.max(1, (opts.cols ?? DENSE_CONTENT_COLS) | 0);
  const cols = opts.shrink === false ? maxCols : measureContentCols(source, maxCols);
  const requestedCols =
    opts.multiCol === undefined || opts.multiCol === 'auto'
      ? Math.max(1, maxFittingCols(cols))
      : Math.max(1, opts.multiCol | 0);
  const numCols = cols < maxCols ? 1 : requestedCols;
  const style = opts.style ?? DENSE_RENDER_STYLE;
  const maxChars = opts.maxCharsPerImage ?? DENSE_CONTENT_CHARS_PER_IMAGE;
  const maxHeightPx = opts.maxHeightPx ?? MAX_HEIGHT_PX;
  return numCols > 1
    ? renderTextToPngsMultiCol(source, cols, numCols)
    : renderTextToPngsWithCharLimit(source, cols, maxChars, style, maxHeightPx);
}
