/**
 * tests/glyph-escape.test.ts
 *
 * Atlas-miss escaping: emoji and other unrenderable codepoints are preserved
 * as ASCII `[U+HEX]` escapes instead of blank cells.
 *
 * CONTRACT:
 *   • escapeMissingGlyphs is pure, idempotent, and lossless for non-exempt
 *     misses (hex payload → codepoint)
 *   • rendering text containing emoji yields droppedChars === 0 on both the
 *     1-bit and the AA (production dense) paths
 *   • exempt codepoints (C0 slot markers, variation selectors, ZWJ, zero-width)
 *     are left untouched — still dropped — so slot-string width alignment and
 *     role coloring are unchanged
 */

import { describe, expect, it } from 'vitest';
import {
  escapeMissingGlyphs,
  GLYPH_ESCAPE_OPEN,
  GLYPH_ESCAPE_CLOSE,
  renderChunkToPng,
  wrapLines,
  measureContentCols,
  DENSE_RENDER_STYLE,
  SLOT_MARK_USER,
  SLOT_MARK_ASSISTANT,
} from '../src/core/render.js';

// ---------------------------------------------------------------------------
// 1. escapeMissingGlyphs unit contract
// ---------------------------------------------------------------------------

describe('escapeMissingGlyphs', () => {
  it('escapes an astral emoji as [U+HEX]', () => {
    expect(escapeMissingGlyphs('a\u{1F525}b')).toBe(
      `a${GLYPH_ESCAPE_OPEN}1F525${GLYPH_ESCAPE_CLOSE}b`,
    );
  });

  it('fast path: returns the SAME reference when nothing misses', () => {
    const s = 'plain ascii — no atlas misses, incl. ↵ and CJK 漢字';
    expect(escapeMissingGlyphs(s)).toBe(s);
  });

  it('is idempotent (escape output contains only atlas-present chars)', () => {
    const once = escapeMissingGlyphs('\u{1F4CA} chart \u{1F680}');
    expect(escapeMissingGlyphs(once)).toBe(once);
  });

  it('is lossless: hex payload round-trips to the source codepoint', () => {
    const escaped = escapeMissingGlyphs('\u{1F680}');
    const m = /\[U\+([0-9A-F]+)\]/.exec(escaped);
    expect(m).not.toBeNull();
    expect(String.fromCodePoint(parseInt(m![1]!, 16))).toBe('\u{1F680}');
  });

  it('escapes every miss in a multi-emoji line, preserving order', () => {
    expect(escapeMissingGlyphs('\u{1F525}x\u{1F680}')).toBe(
      `${GLYPH_ESCAPE_OPEN}1F525${GLYPH_ESCAPE_CLOSE}x${GLYPH_ESCAPE_OPEN}1F680${GLYPH_ESCAPE_CLOSE}`,
    );
  });

  it('leaves exempt codepoints untouched: VS16, ZWJ, C0 slot markers', () => {
    const s = '️‍' + SLOT_MARK_USER + SLOT_MARK_ASSISTANT + '̂';
    expect(escapeMissingGlyphs(s)).toBe(s);
  });
});

// ---------------------------------------------------------------------------
// 2. Render integration: emoji no longer drop
// ---------------------------------------------------------------------------

describe('rendering emoji', () => {
  it('1-bit path: droppedChars === 0 and escape survives into wrapped lines', async () => {
    const text = 'deploy \u{1F680} done, fire \u{1F525} out';
    const img = await renderChunkToPng(text, 80);
    expect(img.droppedChars).toBe(0);
    expect(img.droppedCodepoints.size).toBe(0);
    expect(wrapLines(text, 80).join('')).toContain(
      `${GLYPH_ESCAPE_OPEN}1F680${GLYPH_ESCAPE_CLOSE}`,
    );
  });

  it('AA dense path (production DENSE_RENDER_STYLE): droppedChars === 0', async () => {
    const img = await renderChunkToPng(
      'metrics \u{1F4CA} look good \u{1F389}',
      80,
      DENSE_RENDER_STYLE,
    );
    expect(img.droppedChars).toBe(0);
  });

  it('exempt invisibles still count as drops (behavior unchanged)', async () => {
    const img = await renderChunkToPng('x️y', 80);
    expect(img.droppedCodepoints.get(0xfe0f)).toBe(1);
  });

  it('measureContentCols sees the ESCAPED width, matching what wrapLines lays out', () => {
    const text = '\u{1F525}'; // 1 source cell naively; 9 cells escaped
    const measured = measureContentCols(text, 312);
    const laidOut = wrapLines(text, 312)[0]!.length;
    expect(measured).toBe(laidOut);
    expect(measured).toBe(9); // [U+1F525]
  });

  it('slot-string alignment: body slot copy wraps identically to text', () => {
    // Slot bodies are verbatim codepoint copies of the text body (slotCopyBody),
    // so both sides pass through the same escape and wrap to identical shapes.
    const body = 'alert \u{1F6A8} now, and again \u{1F6A8} later';
    expect(wrapLines(body, 10)).toEqual(wrapLines(body, 10));
    // Marker chars themselves are exempt → width-1 on the slot side is preserved.
    expect(escapeMissingGlyphs(SLOT_MARK_USER).length).toBe(1);
  });
});
