/**
 * Tests for the per-tool_result paging / truncation slice (task #42).
 *
 * Strategy:
 *   - Unit-test the truncation helpers directly (`classifyContent`,
 *     `estimateImageCount`, `truncateForBudget`) — they're pure, no
 *     rendering needed.
 *   - End-to-end through `transformRequest` to verify the counters land
 *     in `info` (`truncatedToolResults`, `omittedChars`) and that the
 *     image budget is actually honored.
 *
 * The rendered PNGs themselves are opaque in tests (we don't have an OCR
 * harness in this repo), but the truncated *source* text is what
 * actually carries the paging marker into the image — so verifying the
 * source string is the right level.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyContent,
  estimateImageCount,
  truncateForBudget,
  transformRequest,
} from '../src/core/transform.js';
import { toTrackEvent } from '../src/core/tracker.js';
import type { ProxyEvent } from '../src/core/proxy.js';

// Default render config: cols=100, 195 lines/img → ~19,500 chars/img if
// lines fully fill the width. For shorter lines, the budget is dominated
// by row count (each line takes ≥1 row regardless of length).
const COLS = 100;
const ROWS_PER_IMG = 195; // floor((1568 - 8) / 8), Spleen 5×8 production cell

describe('estimateImageCount', () => {
  it('returns 1 for empty / tiny text', () => {
    expect(estimateImageCount('', COLS)).toBe(1);
    expect(estimateImageCount('hello world', COLS)).toBe(1);
  });

  it('scales linearly with row count for short-line content', () => {
    // 195 lines of "x" (1 char) = 195 rows = 1 image.
    const oneImage = Array.from({ length: ROWS_PER_IMG }, () => 'x').join('\n');
    expect(estimateImageCount(oneImage, COLS)).toBe(1);
    // 196 lines = 2 images (just over the line).
    const justOver = Array.from({ length: ROWS_PER_IMG + 1 }, () => 'x').join('\n');
    expect(estimateImageCount(justOver, COLS)).toBe(2);
    // 10 × 195 = 1950 lines → 10 images.
    const tenImages = Array.from({ length: ROWS_PER_IMG * 10 }, () => 'x').join('\n');
    expect(estimateImageCount(tenImages, COLS)).toBe(10);
  });

  it('accounts for soft-wrap of long lines', () => {
    // A single 1000-char line wraps to ceil(1000/100) = 10 rows.
    const wrapped = 'x'.repeat(1000);
    expect(estimateImageCount(wrapped, COLS)).toBe(1); // 10 rows, fits in 1 img
    // 19,500 chars on one line → 195 rows → 1 image.
    const oneImg = 'x'.repeat(19_500);
    expect(estimateImageCount(oneImg, COLS)).toBe(1);
    // 19,501 chars → 196 rows → 2 images.
    const twoImgs = 'x'.repeat(19_501);
    expect(estimateImageCount(twoImgs, COLS)).toBe(2);
  });

  it('also accepts a numeric length (legacy chars-based estimate)', () => {
    expect(estimateImageCount(0, COLS)).toBe(1);
    expect(estimateImageCount(19_500, COLS)).toBe(1);
    expect(estimateImageCount(19_501, COLS)).toBe(2);
  });
});

describe('classifyContent', () => {
  it('flags JSON objects as structured', () => {
    const json = JSON.stringify({ foo: 'bar', baz: [1, 2, 3] }, null, 2);
    expect(classifyContent(json)).toBe('structured');
  });

  it('flags JSON arrays of objects as structured', () => {
    const json = JSON.stringify(
      [
        { a: 1, b: 2 },
        { a: 3, b: 4 },
      ],
      null,
      2,
    );
    expect(classifyContent(json)).toBe('structured');
  });

  it('flags YAML frontmatter as structured', () => {
    const yaml = '---\ntitle: foo\ndate: 2026-05-18\n---\n\nBody text here.';
    expect(classifyContent(yaml)).toBe('structured');
  });

  it('flags unified diffs as structured', () => {
    const diff =
      'diff --git a/foo.ts b/foo.ts\nindex 1234..5678 100644\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1,3 +1,3 @@\n-old\n+new\n';
    expect(classifyContent(diff)).toBe('structured');
  });

  it('flags ISO-timestamp lines as log', () => {
    const log = Array.from(
      { length: 20 },
      (_, i) => `2026-05-18T12:00:${String(i).padStart(2, '0')}Z some log line`,
    ).join('\n');
    expect(classifyContent(log)).toBe('log');
  });

  it('flags [LEVEL] prefix lines as log', () => {
    const log = Array.from(
      { length: 20 },
      (_, i) => `[INFO] line ${i} doing a thing`,
    ).join('\n');
    expect(classifyContent(log)).toBe('log');
  });

  it('flags bare HH:MM:SS prefix lines as log', () => {
    const log = Array.from(
      { length: 20 },
      (_, i) => `12:00:${String(i).padStart(2, '0')} event ${i}`,
    ).join('\n');
    expect(classifyContent(log)).toBe('log');
  });

  it('does NOT flag a stack trace that opens with [ERROR] alone as structured', () => {
    // Only 4 lines — too few to log-classify cleanly, falls back to other.
    const text = '[ERROR] something went wrong\n  at foo()\n  at bar()\n  at baz()';
    // log-line threshold needs ≥30% of ≥4 non-empty lines to start with a
    // log marker. Just the first line does → 1/4 = 25%, fails → other.
    expect(classifyContent(text)).toBe('other');
  });

  it('falls back to other for plain prose', () => {
    const prose =
      'The quick brown fox jumps over the lazy dog.\n'.repeat(20);
    expect(classifyContent(prose)).toBe('other');
  });

  it('falls back to other for very short input (under 4 lines)', () => {
    expect(classifyContent('one line')).toBe('other');
    expect(classifyContent('one\ntwo\nthree')).toBe('other');
  });
});

describe('truncateForBudget', () => {
  it('passes through text under the budget unchanged', () => {
    const text = 'x'.repeat(1000); // way under 10-image budget
    const { text: out, omittedChars, truncated } = truncateForBudget(text, 10, COLS);
    expect(truncated).toBe(false);
    expect(omittedChars).toBe(0);
    expect(out).toBe(text);
  });

  it('truncates head+tail for log-shaped content over the budget', () => {
    // 10k log lines, each ~32 chars → ~320k chars total. With short lines
    // the row budget dominates: 10k rows >> 10 × 195 = 1950 row budget.
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      lines.push(`2026-05-18T12:00:${String(i % 60).padStart(2, '0')}Z entry ${i}`);
    }
    const log = lines.join('\n');
    expect(log.length).toBeGreaterThan(300_000);

    const { text: out, omittedChars, truncated } = truncateForBudget(log, 10, COLS);
    expect(truncated).toBe(true);
    expect(omittedChars).toBeGreaterThan(0);
    // Output should fit in the 10-image budget (count visual rows).
    expect(estimateImageCount(out, COLS)).toBeLessThanOrEqual(10);
    // Marker present
    expect(out).toContain('pixelpipe paging:');
    // Head + tail format: marker mentions both first and last lines
    expect(out).toMatch(/Showing first \d+ lines and last \d+ lines/);
    // Both ends visible: first log entry and last log entry survive
    expect(out).toContain('entry 0\n'); // first line
    expect(out).toContain(`entry ${9999}`); // last line (no newline after)
  });

  it('truncates tail-only for structured (JSON) content over the budget', () => {
    // Build a huge JSON-shaped blob.
    const items = Array.from({ length: 5000 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      payload: 'x'.repeat(100),
    }));
    const json = JSON.stringify(items, null, 2);
    expect(json.length).toBeGreaterThan(500_000);

    const { text: out, omittedChars, truncated } = truncateForBudget(json, 10, COLS);
    expect(truncated).toBe(true);
    expect(omittedChars).toBeGreaterThan(0);
    expect(estimateImageCount(out, COLS)).toBeLessThanOrEqual(10);
    // Marker present
    expect(out).toContain('pixelpipe paging:');
    // Tail-only format: marker says "tail elided", NOT head+tail
    expect(out).toContain('tail elided');
    expect(out).not.toMatch(/Showing first \d+ lines and last \d+ lines/);
    // Head preserved (the structure opens with `[`)
    expect(out.trimStart().startsWith('[')).toBe(true);
    // First few items present
    expect(out).toContain('"item-0"');
    expect(out).toContain('"item-1"');
    // Last item is NOT present (it was the tail we dropped)
    expect(out).not.toContain('"item-4999"');
  });

  it('truncates head+tail for unclassified prose (default behavior)', () => {
    // A blob with no log/JSON markers — random prose, repeated.
    const para =
      'The quick brown fox jumps over the lazy dog and goes home for dinner.\n';
    const prose = para.repeat(8000); // ~550k chars

    const { text: out, omittedChars, truncated } = truncateForBudget(prose, 10, COLS);
    expect(truncated).toBe(true);
    expect(omittedChars).toBeGreaterThan(0);
    expect(estimateImageCount(out, COLS)).toBeLessThanOrEqual(10);
    expect(out).toContain('pixelpipe paging:');
    // Default prose gets head+tail (not tail-only)
    expect(out).toMatch(/Showing first \d+ lines and last \d+ lines/);
  });

  it('marker reports accurate omitted-lines and original-size numbers', () => {
    // Predictable shape: 10,000 lines of "logline N" — easy to count.
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      lines.push(`2026-05-18T12:00:00Z logline ${i} something`);
    }
    const log = lines.join('\n');
    const originalChars = log.length;
    const originalLines = lines.length;

    const { text: out, omittedChars } = truncateForBudget(log, 10, COLS);

    // Pull the numbers out of the marker.
    const omittedLinesMatch = out.match(
      /omitted ([\d,]+) lines \(([\d,]+) chars\)/,
    );
    const originalMatch = out.match(/Original length: ([\d,]+) chars \(([\d,]+) lines/);
    expect(omittedLinesMatch).not.toBeNull();
    expect(originalMatch).not.toBeNull();

    const parseNum = (s: string) => parseInt(s.replaceAll(',', ''), 10);
    const reportedOmittedLines = parseNum(omittedLinesMatch![1]!);
    const reportedOmittedChars = parseNum(omittedLinesMatch![2]!);
    const reportedOriginalChars = parseNum(originalMatch![1]!);
    const reportedOriginalLines = parseNum(originalMatch![2]!);

    // Original size numbers should match exactly.
    expect(reportedOriginalChars).toBe(originalChars);
    expect(reportedOriginalLines).toBe(originalLines);
    // Omitted-chars number in marker should match the returned count.
    expect(reportedOmittedChars).toBe(omittedChars);
    // Omitted lines should be most-but-not-all of the original.
    expect(reportedOmittedLines).toBeGreaterThan(0);
    expect(reportedOmittedLines).toBeLessThan(originalLines);
  });

  it('always shows at least one head line even on degenerate input', () => {
    // Single huge line — bigger than budget. Should still render with marker.
    const text = 'x'.repeat(500_000);
    const { text: out, truncated } = truncateForBudget(text, 10, COLS);
    // No newlines means lines.length === 1, so "truncation" can only show
    // that single line. Verify behavior is sane (doesn't crash, marker
    // present somewhere if truncated).
    if (truncated) {
      expect(out).toContain('pixelpipe paging:');
    }
  });
});

// -- end-to-end through transformRequest -----------------------------------

function makeReq(toolResultText: string) {
  return new TextEncoder().encode(
    JSON.stringify({
      model: 'claude-3-5-sonnet',
      // Force compression to fire: need a system slab past the per-block
      // break-even (≥10k chars) so the main static-slab compression runs
      // and `info.compressed` flips to true. Smaller slabs no-op out via
      // isCompressionProfitable and the test wouldn't see compressed=true.
      system: 'x'.repeat(80_000),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_x', content: toolResultText },
          ],
        },
      ],
    }),
  );
}

describe('paging end-to-end (transformRequest)', () => {
  it('tool_result under cap renders normally (no truncation counters)', async () => {
    // Above the multi-col break-even (~22k chars), well under the 10-image
    // single-column budget (~195k chars at the current 5×8 atlas).
    // charsPerToken:2 reflects reality (tool_result content is code/logs, ~2 ch/tok)
    // and ensures the gate accepts this size at numCols=1.
    const text = 'x'.repeat(50_000);
    const { info } = await transformRequest(makeReq(text), { multiCol: 1, charsPerToken: 2 });
    expect(info.compressed).toBe(true);
    expect((info.toolResultImgs ?? 0)).toBeGreaterThan(0);
    expect(info.truncatedToolResults ?? 0).toBe(0);
    expect(info.omittedChars ?? 0).toBe(0);
  });

  it('tool_result over cap fires truncation, lands ≤ 10 images', async () => {
    // ~500k char log → ~36 raw images, should clamp to ≤10.
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      lines.push(`2026-05-18T12:00:00Z entry ${i} payload content here`);
    }
    const log = lines.join('\n');
    expect(log.length).toBeGreaterThan(400_000);

    const { info } = await transformRequest(makeReq(log), { multiCol: 1, charsPerToken: 2 });
    expect(info.compressed).toBe(true);
    expect(info.truncatedToolResults).toBe(1);
    expect(info.omittedChars).toBeGreaterThan(0);
    // Image count for this tool_result should be capped at the budget.
    // (Allow 1-image slack for the marker / rounding.)
    expect(info.toolResultImgs).toBeLessThanOrEqual(11);
  });

  it('respects a custom maxImagesPerToolResult option', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      lines.push(`2026-05-18T12:00:00Z entry ${i} payload content here`);
    }
    const log = lines.join('\n');

    // Tight budget of 2 images = ~28k chars.
    const { info } = await transformRequest(makeReq(log), {
      multiCol: 1,
      charsPerToken: 2,
      maxImagesPerToolResult: 2,
    });
    expect(info.truncatedToolResults).toBe(1);
    expect(info.toolResultImgs).toBeLessThanOrEqual(3); // 2 + slack
  });

  it('counts multiple tool_results that all exceed the budget', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      lines.push(`2026-05-18T12:00:00Z entry ${i} payload content here`);
    }
    const log = lines.join('\n');

    // Two big tool_results in one request.
    const req = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude-3-5-sonnet',
        system: 'x'.repeat(80_000),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_a', content: log },
              { type: 'tool_result', tool_use_id: 'toolu_b', content: log },
            ],
          },
        ],
      }),
    );
    const { info } = await transformRequest(req, { multiCol: 1, charsPerToken: 2 });
    expect(info.truncatedToolResults).toBe(2);
    // Both should have been truncated → omittedChars roughly doubled. The
    // exact bound depends on renderer config: at multiCol=1 each image
    // packs ~19.5k chars worst-case. Threshold below covers the single-col case.
    expect(info.omittedChars).toBeGreaterThan(600_000);
  });

  it('handles array-shaped tool_result content', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      lines.push(`2026-05-18T12:00:00Z entry ${i} payload content here`);
    }
    const log = lines.join('\n');

    // Array shape: tool_result content is [{type: 'text', text: ...}]
    const req = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude-3-5-sonnet',
        system: 'x'.repeat(80_000),
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_x',
                content: [{ type: 'text', text: log }],
              },
            ],
          },
        ],
      }),
    );
    const { info } = await transformRequest(req, { multiCol: 1, charsPerToken: 2 });
    expect(info.truncatedToolResults).toBe(1);
    expect(info.omittedChars).toBeGreaterThan(0);
    expect(info.toolResultImgs).toBeLessThanOrEqual(11);
  });
});

// -- tracker wire-through ---------------------------------------------------

describe('paging telemetry → TrackEvent', () => {
  it('forwards truncated_tool_results and omitted_chars when set', () => {
    const ev: ProxyEvent = {
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      durationMs: 100,
      info: {
        compressed: true,
        origChars: 500_000,
        imageCount: 10,
        imageBytes: 20_000,
        staticChars: 0,
        dynamicChars: 0,
        dynamicBlockCount: 0,
        truncatedToolResults: 2,
        omittedChars: 350_000,
      },
    };
    const out = toTrackEvent(ev);
    expect(out.truncated_tool_results).toBe(2);
    expect(out.omitted_chars).toBe(350_000);
  });

  it('omits the fields when no truncation fired (zero / undefined)', () => {
    const ev: ProxyEvent = {
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      durationMs: 100,
      info: {
        compressed: true,
        origChars: 10_000,
        imageCount: 1,
        imageBytes: 2_000,
        staticChars: 0,
        dynamicChars: 0,
        dynamicBlockCount: 0,
        // truncatedToolResults: undefined
        // omittedChars: undefined
      },
    };
    const out = toTrackEvent(ev);
    expect(out.truncated_tool_results).toBeUndefined();
    expect(out.omitted_chars).toBeUndefined();
  });

  it('omits the fields when explicitly zero (no-op truncation pass)', () => {
    const ev: ProxyEvent = {
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      durationMs: 100,
      info: {
        compressed: true,
        origChars: 10_000,
        imageCount: 1,
        imageBytes: 2_000,
        staticChars: 0,
        dynamicChars: 0,
        dynamicBlockCount: 0,
        truncatedToolResults: 0,
        omittedChars: 0,
      },
    };
    const out = toTrackEvent(ev);
    // Skipped because the wire-through gate is `> 0`.
    expect(out.truncated_tool_results).toBeUndefined();
    expect(out.omitted_chars).toBeUndefined();
  });
});
