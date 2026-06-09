/**
 * tests/reflow.test.ts
 *
 * Tests for the R3 reflow pipeline:  reflow / dereflow / NL_SENTINEL
 *
 * L0 CONTRACT (losslessness relative to the current renderer):
 *   For any input `text`:
 *     • if reflow(text) returns null  →  text actually contains NL_SENTINEL
 *     • else  →  dereflow(reflow(text)) ===
 *                  minifyForRender(text).split('\n').map(expandTabsInLine).join('\n')
 *
 *   That reference string is exactly the text the non-reflow renderer also
 *   displays, so reflow adds zero new information loss.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  NL_SENTINEL,
  reflow,
  dereflow,
  minifyForRender,
  expandTabsInLine,
} from '../src/core/render.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The reference string that both the reflow and non-reflow renderer display. */
function referenceText(text: string): string {
  return minifyForRender(text)
    .split('\n')
    .map(expandTabsInLine)
    .join('\n');
}

/** Assert the L0 contract for a single input string. */
function assertL0(text: string, label?: string): void {
  const tag = label ? ` [${label}]` : '';
  const result = reflow(text);
  if (result === null) {
    // Contract: null means the input contained NL_SENTINEL
    expect(
      text.indexOf(NL_SENTINEL),
      `reflow returned null but input does not contain NL_SENTINEL${tag}`,
    ).toBeGreaterThanOrEqual(0);
  } else {
    // Contract: dereflow(reflow(text)) === referenceText(text)
    const got = dereflow(result);
    const expected = referenceText(text);
    expect(got, `L0 violation${tag}`).toBe(expected);
  }
}

// ---------------------------------------------------------------------------
// 1. Hand-written edge cases
// ---------------------------------------------------------------------------

describe('reflow / dereflow – hand-written edge cases', () => {
  it('NL_SENTINEL is the expected character', () => {
    expect(NL_SENTINEL).toBe('↵'); // ↵
  });

  it('empty string → reflow returns empty string, dereflow returns empty', () => {
    const r = reflow('');
    expect(r).not.toBeNull();
    expect(r).toBe('');
    expect(dereflow(r!)).toBe('');
    assertL0('');
  });

  it('single line with no newline', () => {
    const text = 'hello world';
    assertL0(text);
    const r = reflow(text);
    expect(r).toBe('hello world');
  });

  it('single line with trailing whitespace (stripped by minify)', () => {
    const text = 'hello   ';
    assertL0(text);
    const r = reflow(text);
    expect(r).not.toBeNull();
    // minify strips trailing spaces; no newline so no sentinel in output
    expect(r!.indexOf('\n')).toBe(-1);
    expect(r!.indexOf(NL_SENTINEL)).toBe(-1);
  });

  it('only newlines → sentinels where newlines were', () => {
    const text = '\n\n\n';
    assertL0(text);
    const r = reflow(text);
    expect(r).not.toBeNull();
    expect(r!.indexOf('\n')).toBe(-1);
  });

  it('trailing whitespace on every line is stripped', () => {
    const text = 'foo   \nbar \nbaz\t';
    assertL0(text);
    const r = reflow(text);
    expect(r).not.toBeNull();
    expect(r!.indexOf('\n')).toBe(-1);
  });

  it('blank-line runs of 3+ are collapsed by minify (4+ \\n → 3 \\n)', () => {
    const text = 'a\n\n\n\n\nb'; // 5 newlines = 4 blank lines
    assertL0(text);
    const r = reflow(text);
    expect(r).not.toBeNull();
    // After minify: 'a\n\n\nb' — 3 newlines → 3 sentinels in reflow output
    const sentinelCount = r!.split(NL_SENTINEL).length - 1;
    expect(sentinelCount).toBe(3); // minify collapsed 5→3 \n
    expect(r!.indexOf('\n')).toBe(-1);
  });

  it('exactly 3 blank lines (at the collapse cap) are preserved', () => {
    const text = 'a\n\n\nb'; // 3 newlines = 2 blank lines — exactly at the cap
    assertL0(text);
    const r = reflow(text);
    expect(r).not.toBeNull();
    const sentinelCount = r!.split(NL_SENTINEL).length - 1;
    expect(sentinelCount).toBe(3);
  });

  it('tabs are expanded by expandTabsInLine', () => {
    const text = 'a\tb\n\tc';
    assertL0(text);
    const r = reflow(text);
    expect(r).not.toBeNull();
    // Tabs must not appear in the reflowed output (they were expanded)
    expect(r!.indexOf('\t')).toBe(-1);
    // Arrow character → must appear (tab marker)
    expect(r!.indexOf('→')).toBeGreaterThanOrEqual(0);
  });

  it('CJK / wide characters round-trip correctly', () => {
    const text = '中文 hello\n日本語 test\n한글';
    assertL0(text);
  });

  it('text containing literal NL_SENTINEL → reflow returns null', () => {
    const text = 'line one' + NL_SENTINEL + 'line two';
    const r = reflow(text);
    expect(r).toBeNull();
    // Verify the null contract holds
    assertL0(text);
  });

  it('text starting with NL_SENTINEL → reflow returns null', () => {
    const text = NL_SENTINEL + 'rest of text';
    const r = reflow(text);
    expect(r).toBeNull();
  });

  it('text ending with NL_SENTINEL → reflow returns null', () => {
    const text = 'start' + NL_SENTINEL;
    const r = reflow(text);
    expect(r).toBeNull();
  });

  it('text starting with a newline', () => {
    const text = '\nhello world';
    assertL0(text);
    const r = reflow(text);
    expect(r).not.toBeNull();
    expect(r!.indexOf('\n')).toBe(-1);
  });

  it('text ending with a newline', () => {
    const text = 'hello world\n';
    assertL0(text);
    const r = reflow(text);
    expect(r).not.toBeNull();
    expect(r!.indexOf('\n')).toBe(-1);
  });

  it('very long single line (no wrapping concerns at transform level)', () => {
    const text = 'x'.repeat(10_000);
    assertL0(text);
    const r = reflow(text);
    expect(r).not.toBeNull();
    expect(r!.indexOf('\n')).toBe(-1);
    expect(r!.indexOf(NL_SENTINEL)).toBe(-1);
  });

  it('very long multiline text', () => {
    const line = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
    const text = Array.from({ length: 200 }, () => line).join('\n');
    assertL0(text);
    const r = reflow(text);
    expect(r).not.toBeNull();
    expect(r!.indexOf('\n')).toBe(-1);
  });

  it('mixed content: code-like text with indentation', () => {
    const text = [
      'function hello() {',
      '  const x = 1;',
      '  if (x > 0) {',
      '    return x;',
      '  }',
      '}',
    ].join('\n');
    assertL0(text);
  });

  it('mid-line spaces are preserved (not collapsed)', () => {
    const text = 'a   b   c\nd   e   f';
    assertL0(text);
    const r = reflow(text);
    expect(r).not.toBeNull();
    // Mid-line spaces must survive
    expect(r!).toContain('a   b   c');
  });

  it('leading whitespace (indentation) is preserved', () => {
    const text = '    indented line\n        double indented';
    assertL0(text);
    const r = reflow(text);
    expect(r).not.toBeNull();
    expect(r!).toContain('    indented line');
    expect(r!).toContain('        double indented');
  });

  it('CRLF-style text (\\r\\n) passes L0 (\\r is not special to minify)', () => {
    // We don't split on \r — only \n. The \r becomes trailing-whitespace on
    // the line and is stripped by minify.
    const text = 'line one\r\nline two\r\n';
    assertL0(text);
  });

  it('text with only spaces', () => {
    const text = '   ';
    assertL0(text);
    // Trailing spaces stripped → empty string
    const r = reflow(text);
    expect(r).not.toBeNull();
    expect(r!).toBe('');
  });

  it('text with only tabs', () => {
    const text = '\t\t\t';
    assertL0(text);
    // Trailing tabs stripped by minify before expandTabsInLine runs
    const r = reflow(text);
    expect(r).not.toBeNull();
  });

  it('newline-only and NL_SENTINEL-containing text both handled', () => {
    // Pure newlines → reflow works
    assertL0('\n\n');
    // Sentinel in middle → null
    assertL0('a' + NL_SENTINEL + 'b');
  });

  it('unicode: emoji (supplementary plane) round-trips', () => {
    // Emoji are not in the atlas but still pass through the transform layer
    const text = 'hello 😀 world\n🎉 celebration';
    assertL0(text);
  });

  it('unicode: combining characters round-trip', () => {
    const text = 'café\nnaïve\nrésumé';
    assertL0(text);
  });

  it('text that is exactly the NL_SENTINEL alone → null', () => {
    const r = reflow(NL_SENTINEL);
    expect(r).toBeNull();
  });

  it('dereflow of empty string returns empty string', () => {
    expect(dereflow('')).toBe('');
  });

  it('dereflow replaces sentinels with newlines exactly', () => {
    const s = 'line1' + NL_SENTINEL + 'line2' + NL_SENTINEL + 'line3';
    expect(dereflow(s)).toBe('line1\nline2\nline3');
  });

  it('round-trip: multiline text survives reflow → dereflow', () => {
    const text = 'alpha\nbeta\ngamma\ndelta';
    const r = reflow(text);
    expect(r).not.toBeNull();
    expect(dereflow(r!)).toBe(referenceText(text));
  });

  it('round-trip: text with trailing whitespace + blank lines', () => {
    const text = 'foo   \n\n\n\nbar \nbaz';
    assertL0(text);
  });

  it('multi-sentinel round-trip: heavily tabbed code block', () => {
    const text = [
      'class Foo {',
      '\tpublic bar(): void {',
      '\t\tconsole.log("hello");',
      '\t}',
      '}',
    ].join('\n');
    assertL0(text);
    const r = reflow(text);
    expect(r).not.toBeNull();
    // No raw newlines in reflow output
    expect(r!.indexOf('\n')).toBe(-1);
    // No raw tabs (they were expanded)
    expect(r!.indexOf('\t')).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// 2. Property-style tests
// ---------------------------------------------------------------------------

describe('reflow – structural properties', () => {
  const samples = [
    '',
    'hello',
    'a\nb\nc',
    'a\n\nb',
    'a\n\n\n\nb', // 4+ newlines, collapses
    '\tfoo\n\tbar',
    '中文\nEnglish\n日本語',
    'x'.repeat(500),
    ('line ' + 'x'.repeat(80) + '\n').repeat(50),
    'trailing   \nspaces\t\ton\tevery\tline   ',
  ];

  it('reflow output contains no literal \\n when non-null', () => {
    for (const text of samples) {
      const r = reflow(text);
      if (r !== null) {
        expect(r.indexOf('\n'), `found \\n in reflow("${text.slice(0, 40)}...")`).toBe(-1);
      }
    }
  });

  it('NL_SENTINEL count in reflow output equals newline count in minifyForRender(text)', () => {
    for (const text of samples) {
      const r = reflow(text);
      if (r === null) continue;

      const minified = minifyForRender(text);
      const expectedNewlines = (minified.match(/\n/g) ?? []).length;
      const sentinelCount = r.split(NL_SENTINEL).length - 1;

      expect(
        sentinelCount,
        `sentinel count mismatch for "${text.slice(0, 40)}..."`,
      ).toBe(expectedNewlines);
    }
  });

  it('reflow is idempotent in a sense: reflowing once and applying dereflow reproduces referenceText', () => {
    for (const text of samples) {
      assertL0(text);
    }
  });

  it('dereflow is the left-inverse of reflow (when reflow is non-null)', () => {
    for (const text of samples) {
      const r = reflow(text);
      if (r === null) continue;
      // dereflow(reflow(text)) must equal the reference renderer's view
      expect(dereflow(r)).toBe(referenceText(text));
    }
  });

  it('reflow output never starts or ends with \\n', () => {
    for (const text of samples) {
      const r = reflow(text);
      if (r === null || r === '') continue;
      expect(r[0]).not.toBe('\n');
      expect(r[r.length - 1]).not.toBe('\n');
    }
  });

  it('null return iff input contains NL_SENTINEL (mutual exclusion)', () => {
    // Texts without sentinel: must not return null
    const clean = ['hello\nworld', 'simple', ''];
    for (const t of clean) {
      expect(reflow(t)).not.toBeNull();
    }

    // Texts with sentinel: must return null
    const dirty = [
      NL_SENTINEL,
      'a' + NL_SENTINEL,
      NL_SENTINEL + 'b',
      'a' + NL_SENTINEL + 'b',
      'line\n' + NL_SENTINEL + '\nmore',
    ];
    for (const t of dirty) {
      expect(reflow(t), `expected null for text containing NL_SENTINEL`).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Corpus test: real Claude Code session transcripts
// ---------------------------------------------------------------------------

describe('reflow L0 contract – real corpus', () => {
  /**
   * Extract human-readable text strings from a parsed JSONL line.
   * Claude Code JSONL lines have a `message` field with role+content.
   * Content can be a string or an array of content blocks.
   */
  function extractTexts(line: unknown): string[] {
    if (typeof line !== 'object' || line === null) return [];
    const obj = line as Record<string, unknown>;

    const msg = obj['message'];
    if (typeof msg !== 'object' || msg === null) return [];
    const message = msg as Record<string, unknown>;

    const content = message['content'];
    if (content === undefined || content === null) return [];

    if (typeof content === 'string') {
      return content.length > 0 ? [content] : [];
    }

    if (!Array.isArray(content)) return [];

    const texts: string[] = [];
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;

      // text blocks
      if (b['type'] === 'text' && typeof b['text'] === 'string' && b['text'].length > 0) {
        texts.push(b['text'] as string);
      }

      // tool_use input (often has long description-like fields)
      if (b['type'] === 'tool_use' && typeof b['input'] === 'object' && b['input'] !== null) {
        const inp = b['input'] as Record<string, unknown>;
        for (const v of Object.values(inp)) {
          if (typeof v === 'string' && v.length > 0) texts.push(v);
        }
      }

      // tool_result content (can be string or array)
      if (b['type'] === 'tool_result') {
        const rc = b['content'];
        if (typeof rc === 'string' && rc.length > 0) texts.push(rc);
        if (Array.isArray(rc)) {
          for (const rb of rc) {
            if (
              typeof rb === 'object' &&
              rb !== null &&
              (rb as Record<string, unknown>)['type'] === 'text' &&
              typeof (rb as Record<string, unknown>)['text'] === 'string'
            ) {
              const t = (rb as Record<string, unknown>)['text'] as string;
              if (t.length > 0) texts.push(t);
            }
          }
        }
      }
    }
    return texts;
  }

  // 30 s timeout: statSync scan + reading up to 500 text blocks can take a few seconds
  it('L0 contract holds for all sampled real transcript texts', () => {
    const corpusDir = resolve(homedir(), '.claude', 'projects');
    if (!existsSync(corpusDir)) {
      console.log('[corpus] ~/.claude/projects not found — skipping corpus test');
      return;
    }

    const MAX_TEXTS_PER_FILE = 50;
    const MAX_TOTAL = 500;

    // Collect jsonl files, recursively to handle nested subdirs (e.g. subagents/)
    function collectJsonl(dir: string, out: string[], limit: number): void {
      if (out.length >= limit) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= limit) break;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          collectJsonl(full, out, limit);
        } else if (e.isFile() && e.name.endsWith('.jsonl')) {
          out.push(full);
        }
      }
    }

    const allJsonl: string[] = [];
    try {
      collectJsonl(corpusDir, allJsonl, 5000);
    } catch {
      console.log('[corpus] Cannot read ~/.claude/projects — skipping corpus test');
      return;
    }

    if (allJsonl.length === 0) {
      console.log('[corpus] No .jsonl files found — skipping corpus test');
      return;
    }

    // Sort by file size descending so we prefer rich files with lots of content
    const withSize: Array<{ path: string; size: number }> = [];
    for (const p of allJsonl) {
      try {
        const st = statSync(p);
        withSize.push({ path: p, size: st.size });
      } catch {
        withSize.push({ path: p, size: 0 });
      }
    }
    withSize.sort((a, b) => b.size - a.size);

    // Take the top-50 richest files, then sample the remainder evenly
    const topN = withSize.slice(0, 50).map((x) => x.path);
    const rest = withSize.slice(50);
    const step = Math.max(1, Math.floor(rest.length / 30));
    const sampled = [...topN, ...rest.filter((_, i) => i % step === 0).map((x) => x.path)];

    let textsChecked = 0;
    let filesProcessed = 0;
    let violations: string[] = [];

    for (const filePath of sampled) {
      if (textsChecked >= MAX_TOTAL) break;
      let rawContent: string;
      try {
        rawContent = readFileSync(filePath, 'utf-8');
      } catch {
        continue; // unreadable — skip
      }

      const lines = rawContent.split('\n');
      let textsFromFile = 0;

      for (const rawLine of lines) {
        if (textsChecked >= MAX_TOTAL) break;
        if (textsFromFile >= MAX_TEXTS_PER_FILE) break;
        const line = rawLine.trim();
        if (!line) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // malformed JSON — skip
        }

        const texts = extractTexts(parsed);
        for (const text of texts) {
          if (textsChecked >= MAX_TOTAL) break;
          if (textsFromFile >= MAX_TEXTS_PER_FILE) break;

          try {
            const result = reflow(text);
            if (result === null) {
              // Verify: must contain NL_SENTINEL
              if (text.indexOf(NL_SENTINEL) < 0) {
                violations.push(
                  `reflow returned null but no NL_SENTINEL found in: ${JSON.stringify(text.slice(0, 100))}`,
                );
              }
            } else {
              const got = dereflow(result);
              const expected = referenceText(text);
              if (got !== expected) {
                violations.push(
                  `L0 violation in ${filePath}:\n` +
                    `  input (first 200): ${JSON.stringify(text.slice(0, 200))}\n` +
                    `  got (first 200):   ${JSON.stringify(got.slice(0, 200))}\n` +
                    `  expected (first 200): ${JSON.stringify(expected.slice(0, 200))}`,
                );
              }
            }
          } catch (err) {
            violations.push(`Exception on text from ${filePath}: ${String(err)}`);
          }

          textsChecked++;
          textsFromFile++;
        }
      }
      filesProcessed++;
    }

    console.log(
      `[corpus] Checked ${textsChecked} text blocks from ${filesProcessed} files.` +
        (violations.length > 0
          ? ` L0 VIOLATIONS: ${violations.length}`
          : ' All L0 checks passed.'),
    );

    if (violations.length > 0) {
      // Report all violations before failing
      for (const v of violations) {
        console.error('[L0 VIOLATION]', v);
      }
    }

    expect(violations, 'L0 violations found in real corpus (see logs above)').toHaveLength(0);
  }, 30_000);

  it('L0 contract holds for ~/.pxpipe/4xx-bodies/ if present', () => {
    const dir4xx = resolve(homedir(), '.pxpipe', '4xx-bodies');
    if (!existsSync(dir4xx)) {
      console.log('[4xx-bodies] ~/.pxpipe/4xx-bodies not found — skipping');
      return;
    }

    let files: string[];
    try {
      files = readdirSync(dir4xx);
    } catch {
      console.log('[4xx-bodies] Cannot read directory — skipping');
      return;
    }

    let textsChecked = 0;
    let violations: string[] = [];

    for (const fname of files.slice(0, 50)) {
      let raw: string;
      try {
        raw = readFileSync(join(dir4xx, fname), 'utf-8');
      } catch {
        continue;
      }

      // Try parsing as JSON first, then as JSONL
      const candidates: unknown[] = [];
      try {
        candidates.push(JSON.parse(raw));
      } catch {
        for (const line of raw.split('\n')) {
          const l = line.trim();
          if (!l) continue;
          try {
            candidates.push(JSON.parse(l));
          } catch {
            // skip
          }
        }
      }

      for (const parsed of candidates) {
        for (const text of extractTexts(parsed)) {
          if (textsChecked >= 500) break;
          const result = reflow(text);
          if (result === null) {
            if (text.indexOf(NL_SENTINEL) < 0) {
              violations.push(`null without sentinel in ${fname}`);
            }
          } else {
            const got = dereflow(result);
            const expected = referenceText(text);
            if (got !== expected) {
              violations.push(
                `L0 violation in ${fname}: ${JSON.stringify(text.slice(0, 100))}`,
              );
            }
          }
          textsChecked++;
        }
      }
    }

    console.log(`[4xx-bodies] Checked ${textsChecked} text blocks.`);
    expect(violations).toHaveLength(0);
  });
});
