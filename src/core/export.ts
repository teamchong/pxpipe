/**
 * Core logic for `pxpipe export` — renders a source text to PNG pages, extracts
 * a verbatim factsheet, builds a manifest and paste-ready prompt, and returns a
 * token-cost report + list of artifacts to write.
 *
 * Pure-ish: no argv, no stdout, no process.exit, no fs calls — all I/O is
 * delegated to the thin CLI runner in src/node.ts.
 */

import {
  DENSE_CONTENT_CHARS_PER_IMAGE,
  DENSE_CONTENT_COLS,
  MAX_HEIGHT_PX,
  PAD_X,
  CELL_W,
} from './render.js';
// Dogfood the public SDK: render via the same `./transform` entry external
// consumers import (pxpipe-proxy/transform → renderTextToImages), not the
// internal leaf renderer.
import { renderTextToImages } from './library.js';
import { estimateImageCount, ANTHROPIC_PIXELS_PER_TOKEN, IMAGE_COST_SAFETY_MARGIN, REPORT_CHARS_PER_TOKEN } from './transform.js';
import { openAIVisionTokens } from './openai.js';
import {
  factSheetTextFromEntries,
  extractFactSheetTokensAllPages,
  extractFactSheetEntriesAllPages,
} from './factsheet.js';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const DEFAULT_EXPORT_MODEL = 'claude-sonnet-4-5';
// Chars-per-token for the reporting estimate now lives in transform.ts as
// REPORT_CHARS_PER_TOKEN (single source of truth for all token-estimate constants).
/** Default column width — dense content mode (384 cols = 1928 px). */
export const DEFAULT_EXPORT_COLS: number = DENSE_CONTENT_COLS;

// ---------------------------------------------------------------------------
// Glob matching (no external glob library — node:fs only per convention)
// ---------------------------------------------------------------------------

/**
 * Match a relative file path against a glob pattern.
 * Supported wildcards: `*` (non-separator), `**` (any including `/`), `?` (single non-sep).
 * When the pattern contains no `/`, matching is against the basename only
 * (e.g. `*.ts` matches `src/foo.ts`).
 */
export function matchGlob(pattern: string, filePath: string): boolean {
  const pat = pattern.replace(/\\/g, '/');
  const fp = filePath.replace(/\\/g, '/').replace(/^\.\//, '');

  if (!pat.includes('/')) {
    // No separator → match basename only
    const sep = fp.lastIndexOf('/');
    const basename = sep >= 0 ? fp.slice(sep + 1) : fp;
    return _globTest(pat, basename);
  }
  return _globTest(pat, fp);
}

function _globTest(pattern: string, str: string): boolean {
  const SPECIAL = new Set<string>([
    '.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\',
  ]);
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === undefined) break;
    const next = pattern[i + 1];
    const nextNext = pattern[i + 2];

    if (ch === '*' && next === '*') {
      if (nextNext === '/') {
        re += '(?:.*/)?';
        i += 3;
      } else {
        re += '.*';
        i += 2;
      }
    } else if (ch === '*') {
      re += '[^/]*';
      i++;
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (SPECIAL.has(ch)) {
      re += '\\' + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  try {
    return new RegExp(`^${re}$`).test(str);
  } catch {
    return false;
  }
}

/**
 * Decide whether a relative file path should be included given include/exclude glob lists.
 * - Exclude patterns are checked first; any match → exclude.
 * - If include patterns are given, at least one must match.
 * - If no include patterns are given, everything passes (unless excluded).
 */
export function shouldIncludeFile(
  filePath: string,
  include: string[],
  exclude: string[],
): boolean {
  if (exclude.some((pat) => matchGlob(pat, filePath))) return false;
  if (include.length > 0) return include.some((pat) => matchGlob(pat, filePath));
  return true;
}

// ---------------------------------------------------------------------------
// Arg parsing (pure — no process.exit, so it is unit-testable)
// ---------------------------------------------------------------------------

export interface ExportParsed {
  targets: string[];
  include: string[];
  exclude: string[];
  git: boolean;
  diff: string | undefined;
  stdin: boolean;
  cols: number;
  out: string;
  model: string;
  json: boolean;
  open: boolean;
}

export type ExportArgvResult =
  | { kind: 'opts'; parsed: ExportParsed }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

/**
 * Parse the argv array for the `export` subcommand.
 * Returns a discriminated union so the caller (node.ts) decides
 * whether to exit, print help, or proceed.
 *
 * @param defaultOut  Base output directory (default: $TMPDIR or /tmp).
 */
export function parseExportArgv(
  argv: string[],
  defaultOut?: string,
): ExportArgvResult {
  const targets: string[] = [];
  const include: string[] = [];
  const exclude: string[] = [];
  let git = false;
  let diff: string | undefined;
  let stdin = false;
  // Locked to the proxy's density — NO CLI knob. Export must render exactly what the
  // proxy ships to the model; the proxy has no width flag, so neither does export.
  const cols = DENSE_CONTENT_COLS;
  let out =
    defaultOut ??
    (typeof process !== 'undefined'
      ? (process.env['TMPDIR'] ?? process.env['TEMP'] ?? '/tmp')
      : '/tmp');
  let model = DEFAULT_EXPORT_MODEL;
  let json = false;
  let open = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) break;

    if (a === '-h' || a === '--help') {
      return { kind: 'help' };
    } else if (a === '--include' || a === '--exclude') {
      i++;
      const val = argv[i];
      if (val === undefined || val.startsWith('-')) {
        return { kind: 'error', message: `${a} requires a value` };
      }
      if (a === '--include') include.push(val);
      else exclude.push(val);
    } else if (a.startsWith('--include=')) {
      const v = a.slice('--include='.length);
      if (!v) return { kind: 'error', message: '--include= requires a non-empty value' };
      include.push(v);
    } else if (a.startsWith('--exclude=')) {
      const v = a.slice('--exclude='.length);
      if (!v) return { kind: 'error', message: '--exclude= requires a non-empty value' };
      exclude.push(v);
    } else if (a === '--git') {
      git = true;
    } else if (a === '--diff') {
      i++;
      const val = argv[i];
      if (val === undefined || val.startsWith('-')) {
        return { kind: 'error', message: '--diff requires a value' };
      }
      diff = val;
    } else if (a.startsWith('--diff=')) {
      const v = a.slice('--diff='.length);
      if (!v) return { kind: 'error', message: '--diff= requires a non-empty value' };
      diff = v;
    } else if (a === '--stdin') {
      stdin = true;
    } else if (a === '--out') {
      i++;
      const val = argv[i];
      if (val === undefined) return { kind: 'error', message: '--out requires a value' };
      out = val;
    } else if (a.startsWith('--out=')) {
      const v = a.slice('--out='.length);
      if (!v) return { kind: 'error', message: '--out= requires a non-empty value' };
      out = v;
    } else if (a === '--model') {
      i++;
      const val = argv[i];
      if (val === undefined) return { kind: 'error', message: '--model requires a value' };
      model = val;
    } else if (a.startsWith('--model=')) {
      const v = a.slice('--model='.length);
      if (!v) return { kind: 'error', message: '--model= requires a non-empty value' };
      model = v;
    } else if (a === '--json') {
      json = true;
    } else if (a === '--open') {
      open = true;
    } else if (a.startsWith('-')) {
      return { kind: 'error', message: `unknown option: ${a}` };
    } else {
      targets.push(a);
    }
  }

  return {
    kind: 'opts',
    parsed: { targets, include, exclude, git, diff, stdin, cols, out, model, json, open },
  };
}

// ---------------------------------------------------------------------------
// Model-routing image-token helper
// ---------------------------------------------------------------------------

/**
 * Per-image vision-token cost for a rendered PNG at the given pixel dimensions.
 *
 * - **Claude / Anthropic models** (`model.startsWith('claude')` or
 *   `model.includes('anthropic')`): uses Anthropic's billing formula
 *   `ceil(width × height / 750 × 1.10)` (the same formula and constants as
 *   `imageTokensForRows` in transform.ts, reusing the exported
 *   `ANTHROPIC_PIXELS_PER_TOKEN` / `IMAGE_COST_SAFETY_MARGIN` consts).
 * - **GPT / o-series models**: delegates to `openAIVisionTokens` which uses the
 *   GPT-4o tile-pricing formula (85 + 170 × tiles after scaling).
 */
export function exportImageTokens(model: string, width: number, height: number): number {
  if (model.startsWith('claude') || model.includes('anthropic')) {
    return Math.ceil((width * height / ANTHROPIC_PIXELS_PER_TOKEN) * IMAGE_COST_SAFETY_MARGIN);
  }
  return openAIVisionTokens(model, width, height);
}

// ---------------------------------------------------------------------------
// Token cost estimate (pure — replicates internal gate formula)
// ---------------------------------------------------------------------------

export interface ExportTokenReport {
  textTokens: number;
  imageTokens: number;
  percentSaved: number;
  /** Count of unique identifier strings extracted across all pages (paths, SHAs, ids, …).
   *  This is a count of items, not an LLM token count. */
  factsheetItemCount: number;
  /** Identifiers extracted across all pages that did not fit within the 64-item
   *  factsheet budget. Zero when all extracted items were kept. */
  factsheetDropped: number;
}

/**
 * Estimate text vs image token cost for `sourceText` without rendering.
 * Uses the same formula as the internal gate:
 *   stripW = 2·PAD_X + cols·CELL_W
 *   imageTokens = estimateImageCount(text, cols) × exportImageTokens(model, stripW, MAX_HEIGHT_PX)
 *   textTokens = sourceText.length / REPORT_CHARS_PER_TOKEN
 *
 * `exportImageTokens` routes to the Anthropic billing formula (width×height/750×1.10)
 * for Claude models, and to the GPT tile-pricing formula for GPT/o-series models.
 *
 * `factsheetItemCount` is the number of unique precision-critical identifier strings
 * extracted across all pages (paths, SHAs, ids, …); it is NOT an LLM token count.
 * `factsheetDropped` is the count of extracted identifiers that did not fit within
 * the 64-item per-export budget.
 */
export function computeTokenReport(
  sourceText: string,
  cols: number,
  model: string,
): ExportTokenReport {
  const stripW = 2 * PAD_X + cols * CELL_W;
  const estImages = estimateImageCount(sourceText, cols, 1, DENSE_CONTENT_CHARS_PER_IMAGE);
  const perStrip = exportImageTokens(model, stripW, MAX_HEIGHT_PX);
  const imageTokens = Math.round(estImages * perStrip);
  const textTokens = Math.round(sourceText.length / REPORT_CHARS_PER_TOKEN);
  const percentSaved =
    textTokens > 0
      ? Math.round(((textTokens - imageTokens) / textTokens) * 1000) / 10
      : 0;
  const { kept, dropped } = extractFactSheetTokensAllPages(sourceText, DENSE_CONTENT_CHARS_PER_IMAGE);
  return {
    textTokens,
    imageTokens,
    percentSaved,
    factsheetItemCount: kept.length,
    factsheetDropped: dropped,
  };
}

// ---------------------------------------------------------------------------
// Artifact types
// ---------------------------------------------------------------------------

export interface ExportPageInfo {
  filename: string;
  bytes: number;
  width: number;
  height: number;
}

export interface ExportManifest {
  sourceChars: number;
  files: string[];
  pages: ExportPageInfo[];
  cols: number;
  model: string;
  generatedAt: string;
  tokenReport: ExportTokenReport;
}

export interface ExportArtifact {
  filename: string;
  data: Uint8Array;
}

export interface ExportResult {
  manifest: ExportManifest;
  artifacts: ExportArtifact[];
}

export interface ExportCoreOptions {
  /** Relative file paths listed in the manifest and prompt (display only). */
  sourceFiles: string[];
  cols: number;
  model: string;
}

// ---------------------------------------------------------------------------
// Prompt template
// ---------------------------------------------------------------------------

export function buildPromptText(
  pageCount: number,
  factsheet: string,
  files: string[],
  droppedItems: number = 0,
): string {
  const lastPageStr = String(pageCount).padStart(3, '0');
  const fileSection =
    files.length > 0
      ? `Source files (${files.length}):\n${files.map((f) => `  ${f}`).join('\n')}\n\n`
      : '';

  const factsheetNote =
    droppedItems > 0
      ? `2. For any path, file name, identifier, hash, version number, or other precision-critical\n` +
        `   value: check factsheet.txt first — identifiers listed there are verbatim exact.\n` +
        `   Note: ${droppedItems} identifier(s) were extracted but not captured due to the 64-item\n` +
        `   budget — OCR carefully for any exact values not listed in factsheet.txt.\n`
      : `2. For any path, file name, identifier, hash, version number, or other precision-critical\n` +
        `   value: use the verbatim text from factsheet.txt, NOT what you read off the image.\n` +
        `   factsheet.txt is the authoritative source of truth for all exact strings.\n`;

  return (
    `These ${pageCount} image${pageCount !== 1 ? 's' : ''} contain source code/text rendered as PNG pages by pxpipe.\n\n` +
    fileSection +
    `Instructions for the reading agent:\n` +
    `1. Read the images in order: page-001.png through page-${lastPageStr}.png.\n` +
    factsheetNote +
    `3. Treat the content as if you had read the source files directly.\n\n` +
    `Factsheet (verbatim identifiers — quote from here, not from image pixels):\n` +
    (factsheet || '(none)') +
    '\n'
  );
}

// ---------------------------------------------------------------------------
// Simple hash for output directory naming
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash — deterministic, no crypto dep. */
function fnv32a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

/** 8-char hex hash of the first 512 chars + length of `text`. */
export function sourceShortHash(text: string): string {
  const sample = text.slice(0, 512) + '\x00' + String(text.length);
  return fnv32a(sample).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Core export runner (pure-ish: no fs, no argv, no stdout)
// ---------------------------------------------------------------------------

export async function runExportCore(
  sourceText: string,
  opts: ExportCoreOptions,
): Promise<ExportResult> {
  const generatedAt = new Date().toISOString();
  const enc = new TextEncoder();

  // Render to PNG pages via the public SDK primitive. shrink=true sizes the canvas
  // to the widest line so short-line code isn't padded to full width; multiCol='auto'
  // packs as many columns side-by-side as fit. Same render surface shipped to external
  // SDK consumers (pxpipe-proxy/transform).
  const { pages: images } = await renderTextToImages(sourceText, {
    cols: opts.cols,
    shrink: true,
    multiCol: 'auto',
    reflow: true,
  });

  // Compute token costs using actual rendered image dimensions (more accurate than estimate).
  // exportImageTokens routes to the Anthropic billing formula for claude-* models and to
  // the GPT tile-pricing formula for GPT/o-series models.
  const textTokens = Math.round(sourceText.length / REPORT_CHARS_PER_TOKEN);
  let imageTokens = 0;
  for (const img of images) {
    imageTokens += exportImageTokens(opts.model, img.width, img.height);
  }
  imageTokens = Math.round(imageTokens);
  const percentSaved =
    textTokens > 0
      ? Math.round(((textTokens - imageTokens) / textTokens) * 1000) / 10
      : 0;

  // Extract factsheet tokens across ALL pages so identifiers from page 3+ are covered.
  const { kept: fsKept, dropped: fsDropped } = extractFactSheetEntriesAllPages(
    sourceText,
    DENSE_CONTENT_CHARS_PER_IMAGE,
  );
  const fsText = factSheetTextFromEntries(fsKept);
  const tokenReport: ExportTokenReport = {
    textTokens,
    imageTokens,
    percentSaved,
    factsheetItemCount: fsKept.length,
    factsheetDropped: fsDropped,
  };

  // Build artifacts
  const artifacts: ExportArtifact[] = [];
  const pages: ExportPageInfo[] = [];

  for (const [i, img] of images.entries()) {
    const filename = `page-${String(i + 1).padStart(3, '0')}.png`;
    artifacts.push({ filename, data: img.png });
    pages.push({
      filename,
      bytes: img.png.byteLength,
      width: img.width,
      height: img.height,
    });
  }

  // factsheet.txt
  artifacts.push({ filename: 'factsheet.txt', data: enc.encode(fsText) });

  // manifest.json
  const manifest: ExportManifest = {
    sourceChars: sourceText.length,
    files: opts.sourceFiles,
    pages,
    cols: opts.cols,
    model: opts.model,
    generatedAt,
    tokenReport,
  };
  artifacts.push({
    filename: 'manifest.json',
    data: enc.encode(JSON.stringify(manifest, null, 2)),
  });

  // prompt.txt
  const promptText = buildPromptText(images.length, fsText, opts.sourceFiles, fsDropped);
  artifacts.push({ filename: 'prompt.txt', data: enc.encode(promptText) });

  return { manifest, artifacts };
}
