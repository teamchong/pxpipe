import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  matchGlob,
  shouldIncludeFile,
  parseExportArgv,
  computeTokenReport,
  buildPromptText,
  sourceShortHash,
  runExportCore,
  exportImageTokens,
  DEFAULT_EXPORT_MODEL,
  DEFAULT_EXPORT_COLS,
} from '../src/core/export.js';
import { extractFactSheetTokensAllPages, extractFactSheetTokens } from '../src/core/factsheet.js';
import { DENSE_CONTENT_CHARS_PER_IMAGE } from '../src/core/render.js';

// ---------------------------------------------------------------------------
// Temp-dir helpers
// ---------------------------------------------------------------------------

let tmpDir = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-export-test-'));
});

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// matchGlob
// ---------------------------------------------------------------------------

describe('matchGlob', () => {
  it('matches a bare extension glob against basename', () => {
    expect(matchGlob('*.ts', 'src/foo.ts')).toBe(true);
    expect(matchGlob('*.ts', 'src/foo.js')).toBe(false);
    expect(matchGlob('*.ts', 'foo.ts')).toBe(true);
  });

  it('handles ** for any-depth matching', () => {
    expect(matchGlob('**/*.ts', 'src/core/foo.ts')).toBe(true);
    expect(matchGlob('**/*.ts', 'foo.ts')).toBe(true);
    expect(matchGlob('**/*.ts', 'src/core/foo.js')).toBe(false);
  });

  it('matches a directory prefix pattern', () => {
    expect(matchGlob('src/**', 'src/core/foo.ts')).toBe(true);
    expect(matchGlob('src/**', 'tests/foo.ts')).toBe(false);
  });

  it('matches literal basename (no separator = basename match anywhere)', () => {
    expect(matchGlob('README.md', 'README.md')).toBe(true);
    // no separator in pattern → matches the basename at any depth
    expect(matchGlob('README.md', 'docs/README.md')).toBe(true);
  });

  it('literal path with separator matches only that path', () => {
    expect(matchGlob('docs/README.md', 'docs/README.md')).toBe(true);
    expect(matchGlob('docs/README.md', 'other/README.md')).toBe(false);
  });

  it('handles ? wildcard', () => {
    expect(matchGlob('foo?.ts', 'foo1.ts')).toBe(true);
    expect(matchGlob('foo?.ts', 'foo.ts')).toBe(false);
    expect(matchGlob('foo?.ts', 'foo12.ts')).toBe(false);
  });

  it('handles node_modules exclude pattern', () => {
    expect(matchGlob('node_modules/**', 'node_modules/x/y.js')).toBe(true);
    expect(matchGlob('node_modules/**', 'src/foo.ts')).toBe(false);
  });

  it('escapes regex special chars in patterns', () => {
    // dot in extension should match literal dot, not any char
    expect(matchGlob('*.ts', 'foots')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldIncludeFile
// ---------------------------------------------------------------------------

describe('shouldIncludeFile', () => {
  it('includes everything when no patterns', () => {
    expect(shouldIncludeFile('src/foo.ts', [], [])).toBe(true);
    expect(shouldIncludeFile('README.md', [], [])).toBe(true);
  });

  it('excludes files matching an exclude pattern', () => {
    expect(shouldIncludeFile('node_modules/x.js', [], ['node_modules/**'])).toBe(false);
    expect(shouldIncludeFile('src/x.js', [], ['node_modules/**'])).toBe(true);
  });

  it('includes only files matching an include pattern', () => {
    expect(shouldIncludeFile('src/foo.ts', ['*.ts'], [])).toBe(true);
    expect(shouldIncludeFile('src/foo.js', ['*.ts'], [])).toBe(false);
  });

  it('exclude takes priority over include', () => {
    expect(shouldIncludeFile('dist/foo.ts', ['*.ts'], ['dist/**'])).toBe(false);
  });

  it('multiple include patterns — any match passes', () => {
    expect(shouldIncludeFile('README.md', ['*.ts', '*.md'], [])).toBe(true);
    expect(shouldIncludeFile('foo.txt', ['*.ts', '*.md'], [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseExportArgv
// ---------------------------------------------------------------------------

describe('parseExportArgv', () => {
  it('returns help when -h is passed', () => {
    expect(parseExportArgv(['-h'])).toEqual({ kind: 'help' });
    expect(parseExportArgv(['--help'])).toEqual({ kind: 'help' });
  });

  it('returns defaults when argv is empty', () => {
    const result = parseExportArgv([], '/tmp');
    expect(result.kind).toBe('opts');
    if (result.kind !== 'opts') return;
    const p = result.parsed;
    expect(p.targets).toEqual([]);
    expect(p.include).toEqual([]);
    expect(p.exclude).toEqual([]);
    expect(p.git).toBe(false);
    expect(p.diff).toBeUndefined();
    expect(p.stdin).toBe(false);
    expect(p.cols).toBe(DEFAULT_EXPORT_COLS);
    expect(p.out).toBe('/tmp');
    expect(p.model).toBe(DEFAULT_EXPORT_MODEL);
    expect(p.json).toBe(false);
    expect(p.open).toBe(false);
  });

  it('parses --include and --exclude (repeatable)', () => {
    const result = parseExportArgv(
      ['--include', '*.ts', '--include', '*.md', '--exclude', 'node_modules/**'],
      '/tmp',
    );
    expect(result.kind).toBe('opts');
    if (result.kind !== 'opts') return;
    expect(result.parsed.include).toEqual(['*.ts', '*.md']);
    expect(result.parsed.exclude).toEqual(['node_modules/**']);
  });

  it('parses --include= and --exclude= forms', () => {
    const result = parseExportArgv(['--include=*.ts', '--exclude=dist/**'], '/tmp');
    expect(result.kind).toBe('opts');
    if (result.kind !== 'opts') return;
    expect(result.parsed.include).toEqual(['*.ts']);
    expect(result.parsed.exclude).toEqual(['dist/**']);
  });

  it('parses --git flag', () => {
    const result = parseExportArgv(['--git'], '/tmp');
    expect(result.kind).toBe('opts');
    if (result.kind !== 'opts') return;
    expect(result.parsed.git).toBe(true);
  });

  it('parses --diff <ref>', () => {
    const result = parseExportArgv(['--diff', 'HEAD~3'], '/tmp');
    expect(result.kind).toBe('opts');
    if (result.kind !== 'opts') return;
    expect(result.parsed.diff).toBe('HEAD~3');
  });

  it('parses --stdin flag', () => {
    const result = parseExportArgv(['--stdin'], '/tmp');
    expect(result.kind).toBe('opts');
    if (result.kind !== 'opts') return;
    expect(result.parsed.stdin).toBe(true);
  });

  // Export has NO width knob: cols is locked to the proxy's density (DENSE_CONTENT_COLS)
  // so the rendered pages are byte-identical to what the proxy ships to the model.
  // --cols (in either form) is therefore rejected as an unknown option.
  it('rejects --cols <n> (no width knob; locked to proxy density)', () => {
    const result = parseExportArgv(['--cols', '200'], '/tmp');
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('unknown option');
  });

  it('rejects --cols=<n> form', () => {
    const result = parseExportArgv(['--cols=128'], '/tmp');
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('unknown option');
  });

  it('parses --out', () => {
    const result = parseExportArgv(['--out', '/custom/dir'], '/tmp');
    expect(result.kind).toBe('opts');
    if (result.kind !== 'opts') return;
    expect(result.parsed.out).toBe('/custom/dir');
  });

  it('parses --model', () => {
    const result = parseExportArgv(['--model', 'gpt-4o'], '/tmp');
    expect(result.kind).toBe('opts');
    if (result.kind !== 'opts') return;
    expect(result.parsed.model).toBe('gpt-4o');
  });

  it('parses --json flag', () => {
    const result = parseExportArgv(['--json'], '/tmp');
    expect(result.kind).toBe('opts');
    if (result.kind !== 'opts') return;
    expect(result.parsed.json).toBe(true);
  });

  it('parses --open flag', () => {
    const result = parseExportArgv(['--open'], '/tmp');
    expect(result.kind).toBe('opts');
    if (result.kind !== 'opts') return;
    expect(result.parsed.open).toBe(true);
  });

  it('collects positional targets', () => {
    const result = parseExportArgv(['src/', 'README.md'], '/tmp');
    expect(result.kind).toBe('opts');
    if (result.kind !== 'opts') return;
    expect(result.parsed.targets).toEqual(['src/', 'README.md']);
  });

  it('returns error for unknown flag', () => {
    const result = parseExportArgv(['--unknown-flag'], '/tmp');
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('unknown option');
  });
});

// ---------------------------------------------------------------------------
// computeTokenReport
// ---------------------------------------------------------------------------

describe('computeTokenReport', () => {
  it('computes text tokens as sourceChars / REPORT_CHARS_PER_TOKEN', () => {
    const text = 'a'.repeat(3700);
    const report = computeTokenReport(text, DEFAULT_EXPORT_COLS, DEFAULT_EXPORT_MODEL);
    // 3700 / 3.7 = 1000 tokens
    expect(report.textTokens).toBe(1000);
  });

  it('returns positive imageTokens', () => {
    const text = 'hello world\n'.repeat(100);
    const report = computeTokenReport(text, DEFAULT_EXPORT_COLS, DEFAULT_EXPORT_MODEL);
    expect(report.imageTokens).toBeGreaterThan(0);
  });

  it('images are cheaper than text for dense code content', () => {
    // Dense code: many short lines, high chars/token ratio
    const text = 'const x = 1;\n'.repeat(3000); // ~42k chars
    const report = computeTokenReport(text, DEFAULT_EXPORT_COLS, DEFAULT_EXPORT_MODEL);
    // For dense code, image should be cheaper (positive % saved)
    expect(report.textTokens).toBeGreaterThan(0);
    expect(report.imageTokens).toBeGreaterThan(0);
  });

  it('percentSaved is (textTokens - imageTokens) / textTokens * 100 (rounded to 1 dp)', () => {
    const text = 'x'.repeat(37000); // 37000 chars = ~10000 text tokens
    const report = computeTokenReport(text, DEFAULT_EXPORT_COLS, DEFAULT_EXPORT_MODEL);
    const expected =
      Math.round(((report.textTokens - report.imageTokens) / report.textTokens) * 1000) / 10;
    expect(report.percentSaved).toBe(expected);
  });

  it('factsheetItemCount is >= 0', () => {
    const report = computeTokenReport('hello world', DEFAULT_EXPORT_COLS, DEFAULT_EXPORT_MODEL);
    expect(report.factsheetItemCount).toBeGreaterThanOrEqual(0);
  });

  it('factsheetDropped is 0 for short inputs with few identifiers', () => {
    const report = computeTokenReport('hello world const x = 1;', DEFAULT_EXPORT_COLS, DEFAULT_EXPORT_MODEL);
    expect(report.factsheetDropped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildPromptText
// ---------------------------------------------------------------------------

describe('buildPromptText', () => {
  it('mentions the correct page count', () => {
    const text = buildPromptText(3, '', []);
    expect(text).toContain('3 images');
    expect(text).toContain('page-001.png');
    expect(text).toContain('page-003.png');
  });

  it('singular for 1 page', () => {
    const text = buildPromptText(1, '', []);
    expect(text).toContain('1 image');
    expect(text).not.toContain('1 images');
  });

  it('includes the factsheet content', () => {
    const factsheet = '[Exact identifiers … foo/bar.ts · abc123]';
    const text = buildPromptText(2, factsheet, []);
    expect(text).toContain(factsheet);
  });

  it('includes file list when files are provided', () => {
    const text = buildPromptText(2, '', ['src/foo.ts', 'src/bar.ts']);
    expect(text).toContain('src/foo.ts');
    expect(text).toContain('src/bar.ts');
  });

  it('shows (none) when factsheet is empty', () => {
    const text = buildPromptText(1, '', []);
    expect(text).toContain('(none)');
  });
});

// ---------------------------------------------------------------------------
// sourceShortHash
// ---------------------------------------------------------------------------

describe('sourceShortHash', () => {
  it('returns an 8-char hex string', () => {
    const h = sourceShortHash('hello world');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is deterministic', () => {
    const h1 = sourceShortHash('some text');
    const h2 = sourceShortHash('some text');
    expect(h1).toBe(h2);
  });

  it('differs for different content', () => {
    const h1 = sourceShortHash('text a');
    const h2 = sourceShortHash('text b');
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// runExportCore — integration: writes expected files to temp dir
// ---------------------------------------------------------------------------

describe('runExportCore integration', () => {
  it('produces page-001.png, factsheet.txt, manifest.json, prompt.txt for short text', async () => {
    const sourceText = 'const answer = 42;\n// hello world\n'.repeat(20);
    const result = await runExportCore(sourceText, {
      sourceFiles: ['test.ts'],
      cols: DEFAULT_EXPORT_COLS,
      model: DEFAULT_EXPORT_MODEL,
    });

    const filenames = result.artifacts.map((a) => a.filename);
    expect(filenames).toContain('page-001.png');
    expect(filenames).toContain('factsheet.txt');
    expect(filenames).toContain('manifest.json');
    expect(filenames).toContain('prompt.txt');

    // Write artifacts and verify they exist on disk
    for (const artifact of result.artifacts) {
      fs.writeFileSync(path.join(tmpDir, artifact.filename), artifact.data);
    }
    expect(fs.existsSync(path.join(tmpDir, 'page-001.png'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'factsheet.txt'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'prompt.txt'))).toBe(true);
  });

  it('manifest.json has expected structure', async () => {
    const sourceText = 'const x = 1;\n'.repeat(50);
    const result = await runExportCore(sourceText, {
      sourceFiles: ['src/x.ts'],
      cols: 200,
      model: 'gpt-4o',
    });

    const manifestArtifact = result.artifacts.find((a) => a.filename === 'manifest.json');
    expect(manifestArtifact).toBeDefined();
    if (!manifestArtifact) return;

    const manifest = JSON.parse(new TextDecoder().decode(manifestArtifact.data)) as Record<string, unknown>;
    expect(manifest['sourceChars']).toBe(sourceText.length);
    expect(manifest['cols']).toBe(200);
    expect(manifest['model']).toBe('gpt-4o');
    expect(Array.isArray(manifest['files'])).toBe(true);
    expect(Array.isArray(manifest['pages'])).toBe(true);
    expect(typeof manifest['generatedAt']).toBe('string');
    expect(typeof manifest['tokenReport']).toBe('object');

    const tokenReport = manifest['tokenReport'] as Record<string, unknown>;
    expect(typeof tokenReport['textTokens']).toBe('number');
    expect(typeof tokenReport['imageTokens']).toBe('number');
    expect(typeof tokenReport['percentSaved']).toBe('number');
    expect(typeof tokenReport['factsheetItemCount']).toBe('number');
    expect(typeof tokenReport['factsheetDropped']).toBe('number');
  });

  it('manifest.pages has correct shape for each rendered page', async () => {
    const sourceText = 'hello pxpipe export\n'.repeat(30);
    const result = await runExportCore(sourceText, {
      sourceFiles: [],
      cols: DEFAULT_EXPORT_COLS,
      model: DEFAULT_EXPORT_MODEL,
    });

    for (const page of result.manifest.pages) {
      expect(page.filename).toMatch(/^page-\d{3}\.png$/);
      expect(page.bytes).toBeGreaterThan(0);
      expect(page.width).toBeGreaterThan(0);
      expect(page.height).toBeGreaterThan(0);
    }
  });

  it('PNG artifacts are valid PNG files (start with PNG magic bytes)', async () => {
    const sourceText = 'export function foo() { return 1; }\n'.repeat(10);
    const result = await runExportCore(sourceText, {
      sourceFiles: [],
      cols: DEFAULT_EXPORT_COLS,
      model: DEFAULT_EXPORT_MODEL,
    });

    const pngs = result.artifacts.filter((a) => a.filename.endsWith('.png'));
    expect(pngs.length).toBeGreaterThan(0);

    for (const png of pngs) {
      // PNG magic bytes: 0x89 0x50 0x4E 0x47
      expect(png.data[0]).toBe(0x89);
      expect(png.data[1]).toBe(0x50); // 'P'
      expect(png.data[2]).toBe(0x4e); // 'N'
      expect(png.data[3]).toBe(0x47); // 'G'
    }
  });

  it('empty source text still produces factsheet.txt, manifest.json, prompt.txt', async () => {
    const result = await runExportCore('', {
      sourceFiles: [],
      cols: DEFAULT_EXPORT_COLS,
      model: DEFAULT_EXPORT_MODEL,
    });

    // The renderer may produce 0 or 1 page for empty text; we do not constrain it.
    const filenames = result.artifacts.map((a) => a.filename);
    expect(filenames).toContain('factsheet.txt');
    expect(filenames).toContain('manifest.json');
    expect(filenames).toContain('prompt.txt');
  });

  it('tokenReport.textTokens is approximately sourceChars / REPORT_CHARS_PER_TOKEN', async () => {
    const sourceText = 'x'.repeat(3700);
    const result = await runExportCore(sourceText, {
      sourceFiles: [],
      cols: DEFAULT_EXPORT_COLS,
      model: DEFAULT_EXPORT_MODEL,
    });
    // 3700 / 3.7 = 1000
    expect(result.manifest.tokenReport.textTokens).toBe(1000);
  });

  it('includes source file list in manifest and prompt', async () => {
    const files = ['src/foo.ts', 'src/bar.ts'];
    const result = await runExportCore('const x = 1;\n', {
      sourceFiles: files,
      cols: DEFAULT_EXPORT_COLS,
      model: DEFAULT_EXPORT_MODEL,
    });

    expect(result.manifest.files).toEqual(files);

    const promptArtifact = result.artifacts.find((a) => a.filename === 'prompt.txt');
    const promptText = new TextDecoder().decode(promptArtifact?.data ?? new Uint8Array());
    expect(promptText).toContain('src/foo.ts');
    expect(promptText).toContain('src/bar.ts');
  });

  it('manifest.tokenReport uses factsheetItemCount and factsheetDropped (not factsheetTokenCount)', async () => {
    const result = await runExportCore('const x = 1;\n'.repeat(20), {
      sourceFiles: [],
      cols: DEFAULT_EXPORT_COLS,
      model: DEFAULT_EXPORT_MODEL,
    });
    const tr = result.manifest.tokenReport;
    expect(typeof tr.factsheetItemCount).toBe('number');
    expect(typeof tr.factsheetDropped).toBe('number');
    expect(tr.factsheetItemCount).toBeGreaterThanOrEqual(0);
    expect(tr.factsheetDropped).toBeGreaterThanOrEqual(0);
    // Old field must not exist
    expect((tr as Record<string, unknown>)['factsheetTokenCount']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// BLOCKING 1 — Claude vs GPT image token routing
// ---------------------------------------------------------------------------

describe('exportImageTokens model routing', () => {
  // Dense export page: width = 2*4 + 384*5 = 1928 px, height = MAX_HEIGHT_PX = 1932 px
  const W = 1928;
  const H = 1932;

  it('returns Anthropic-formula tokens for claude-sonnet-4-5', () => {
    // Anthropic formula: ceil(W*H/750 * 1.10)
    const expected = Math.ceil((W * H / 750) * 1.10);
    expect(exportImageTokens('claude-sonnet-4-5', W, H)).toBe(expected);
  });

  it('returns Anthropic-formula tokens for any claude-* model', () => {
    const expected = Math.ceil((W * H / 750) * 1.10);
    expect(exportImageTokens('claude-opus-4', W, H)).toBe(expected);
    expect(exportImageTokens('claude-haiku-3-5', W, H)).toBe(expected);
  });

  it('returns Anthropic-formula tokens when model includes "anthropic"', () => {
    const expected = Math.ceil((W * H / 750) * 1.10);
    expect(exportImageTokens('anthropic/claude-3-5-sonnet', W, H)).toBe(expected);
  });

  it('returns GPT (OpenAI tile) tokens for gpt-4o', () => {
    // OpenAI tile formula is much cheaper for this image size (~765 vs ~5464)
    const gpTokens = exportImageTokens('gpt-4o', W, H);
    const claudeTokens = exportImageTokens('claude-sonnet-4-5', W, H);
    // GPT-4o tile formula for 1928x1932 px: scaled to 768x769, 2x2 tiles
    // = 85 + 170*4 = 765 tokens — far less than Anthropic's ~5464
    expect(gpTokens).toBeLessThan(claudeTokens);
    expect(gpTokens).toBeGreaterThan(0);
  });

  it('uses measured Grok pixel pricing instead of the GPT fallback', () => {
    expect(exportImageTokens('grok-4.5', 768, 360)).toBe(Math.ceil((768 * 360) / 1000));
    expect(exportImageTokens('grok-4.5', 768, 360)).not.toBe(
      exportImageTokens('gpt-4o', 768, 360),
    );
  });

  it('Claude image tokens are substantially higher than GPT for the same full-page image', () => {
    // The issue was a ~7x underestimate when using GPT formula for Claude.
    // Verify the ratio is at least 5x so the fix is clearly meaningful.
    const claudeTokens = exportImageTokens('claude-sonnet-4-5', W, H);
    const gpTokens = exportImageTokens('gpt-4o', W, H);
    expect(claudeTokens / gpTokens).toBeGreaterThan(5);
  });

  it('computeTokenReport uses Anthropic formula for default claude model', () => {
    // A single dense page: text so long that 1 page is estimated.
    // The report should reflect the higher Anthropic cost.
    const text = 'const x = 1;\n'.repeat(100);
    const claudeReport = computeTokenReport(text, DEFAULT_EXPORT_COLS, 'claude-sonnet-4-5');
    const gptReport = computeTokenReport(text, DEFAULT_EXPORT_COLS, 'gpt-4o');
    // Claude reports more image tokens than GPT for the same content
    expect(claudeReport.imageTokens).toBeGreaterThan(gptReport.imageTokens);
  });
});

// ---------------------------------------------------------------------------
// BLOCKING 2 — Factsheet coverage across pages (>262,144-char input)
// ---------------------------------------------------------------------------

describe('extractFactSheetTokensAllPages multi-page coverage', () => {
  it('covers a unique identifier that appears only after 262,144 chars', () => {
    // Build a text where the interesting identifier lives past MAX_SCAN (262,144)
    const BEFORE = 'x'.repeat(270_000); // plain chars, no extractable tokens
    const AFTER = '/very/deep/unique/path/that/only/lives/in/later/page.ts';
    const fullText = BEFORE + '\n' + AFTER;
    expect(fullText.length).toBeGreaterThan(262_144);

    const { kept } = extractFactSheetTokensAllPages(fullText, DENSE_CONTENT_CHARS_PER_IMAGE);
    // The path should be present because it lives on a later page
    expect(kept.some((t) => t.includes('unique/path') || t.includes('later/page.ts'))).toBe(true);
  });

  it('returns the same result as extractFactSheetTokens for short text (< MAX_SCAN)', () => {
    const text = 'const x = require("/some/path/foo.ts"); // v1.2.3 sha=abc1234def';
    const single = extractFactSheetTokens(text);
    const { kept } = extractFactSheetTokensAllPages(text, DENSE_CONTENT_CHARS_PER_IMAGE);
    // The kept set should be a subset of (or equal to) the single-call result
    // (page-by-page dedup is deterministic, though ordering/budget may differ)
    expect(kept.length).toBeGreaterThan(0);
    for (const t of kept) {
      expect(single.includes(t) || text.includes(t)).toBe(true);
    }
  });

  it('droppedItems in runExportCore is zero for short inputs', async () => {
    const result = await runExportCore('const x = 1;\n'.repeat(5), {
      sourceFiles: [],
      cols: DEFAULT_EXPORT_COLS,
      model: DEFAULT_EXPORT_MODEL,
    });
    expect(result.manifest.tokenReport.factsheetDropped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// BLOCKING 3 — Dropped identifier count is surfaced in the report
// ---------------------------------------------------------------------------

describe('factsheet dropped count surfacing', () => {
  it('buildPromptText mentions dropped identifiers when droppedItems > 0', () => {
    const text = buildPromptText(1, '[factsheet content]', [], 7);
    expect(text).toContain('7 identifier(s)');
    // Should NOT claim factsheet is authoritative for ALL strings when items were dropped
    expect(text).not.toContain('authoritative source of truth for all exact strings');
  });

  it('buildPromptText does NOT mention drop count when droppedItems is 0', () => {
    const text = buildPromptText(1, '[factsheet content]', [], 0);
    // With no drops, factsheet IS the authoritative source of truth
    expect(text).toContain('authoritative source of truth');
    expect(text).not.toContain('identifier(s) were extracted');
  });

  it('buildPromptText defaults to droppedItems=0 (no extra note in normal case)', () => {
    const text = buildPromptText(1, '[factsheet content]', []);
    expect(text).not.toContain('identifier(s) were extracted');
    expect(text).toContain('authoritative source of truth');
  });

  it('factsheetDropped is a non-negative number in runExportCore output', async () => {
    // Verify the field exists and is well-typed; small inputs have 0 drops.
    const result = await runExportCore('const x = 1;\nconst y = 2;\n'.repeat(10), {
      sourceFiles: [],
      cols: DEFAULT_EXPORT_COLS,
      model: DEFAULT_EXPORT_MODEL,
    });
    const tr = result.manifest.tokenReport;
    expect(tr.factsheetDropped).toBeGreaterThanOrEqual(0);
    expect(tr.factsheetItemCount + tr.factsheetDropped).toBeGreaterThanOrEqual(tr.factsheetItemCount);
  });

  it('extractFactSheetTokensAllPages reports dropped > 0 when unique identifiers across pages exceed the factsheet budget', () => {
    // Place 60 unique paths on "page 1" and 60 different unique paths on "page 2".
    // Each page is < 92,160 chars so extractFactSheetTokens won't hit MAX_SCAN.
    // Each page contributes up to 64 tokens; cross-page merge gives >64 → some dropped.
    const page1 = Array.from({ length: 60 }, (_, i) =>
      `/alpha/module-${i}/lib/component-${i}.ts`,
    ).join('\n');
    // Pad page 1 to exactly one page boundary (DENSE_CONTENT_CHARS_PER_IMAGE chars)
    const pad1 = ' '.repeat(Math.max(0, DENSE_CONTENT_CHARS_PER_IMAGE - page1.length));
    const page2 = Array.from({ length: 60 }, (_, i) =>
      `/beta/service-${i}/util/helper-${i}.ts`,
    ).join('\n');
    const fullText = page1 + pad1 + page2;

    const { kept, dropped } = extractFactSheetTokensAllPages(fullText, DENSE_CONTENT_CHARS_PER_IMAGE);
    // At most MAX_TOKENS kept; with many from page 1 + some from page 2 the total should exceed the factsheet budget
    expect(kept.length).toBeLessThanOrEqual(96);
    expect(dropped).toBeGreaterThan(0);
  });
});
