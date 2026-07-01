import { isPxpipeSupportedModel } from './applicability.js';
import { countCacheControlMarkers } from './measurement.js';
import {
  renderTextToPngsWithCharLimit,
  renderTextToPngsMultiCol,
  measureContentCols,
  maxFittingCols,
  reflow,
  DENSE_CONTENT_COLS,
  DENSE_CONTENT_CHARS_PER_IMAGE,
  DENSE_RENDER_STYLE,
  MAX_HEIGHT_PX,
  type RenderStyle,
} from './render.js';
import {
  transformRequest,
  type TransformInfo,
  type TransformOptions,
  type KeepSharpBlock,
  type RecoverableBlock,
} from './transform.js';

export type { KeepSharpBlock, RecoverableBlock };

export type BytesLike = Uint8Array | ArrayBuffer | ArrayBufferView;

export interface PxpipeOptions
  extends Pick<
    TransformOptions,
    'charsPerToken' | 'historyAmortizationHorizon' | 'keepSharp' | 'emitRecoverable'
  > {
  /** Test/debug-only bypass. Product hosts should prefer their dashboard setting. */
  readonly compress?: boolean;
}

export interface PxpipeTransformInput {
  readonly body: BytesLike;
  /** Resolved upstream model when available; aliases are accepted for applicability checks. */
  readonly model?: string | null;
  readonly requestId?: string;
  readonly options?: PxpipeOptions;
}

export type PxpipeReason =
  | 'applied'
  | 'unsupported_model'
  | 'parse_error'
  | 'below_min_chars'
  | 'below_min_tokens'
  | 'not_profitable'
  | 'compress_disabled'
  | 'image_limit'
  | 'transform_error'
  | 'passthrough';

export interface PxpipeTransformResult {
  readonly body: Uint8Array;
  readonly applied: boolean;
  readonly reason: PxpipeReason;
  readonly detail?: string;
  readonly info: TransformInfo;
  readonly cache: {
    readonly ownsCacheControl: boolean;
    readonly markerCount: number;
  };
}

function toUint8Array(bytes: BytesLike): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function emptyInfo(reason: string): TransformInfo {
  return {
    compressed: false,
    reason,
    origChars: 0,
    compressedChars: 0,
    imageCount: 0,
    imageBytes: 0,
    staticChars: 0,
    dynamicChars: 0,
    dynamicBlockCount: 0,
    droppedChars: 0,
  };
}

function classifyReason(info: TransformInfo): PxpipeReason {
  if (info.compressed) return 'applied';
  const r = info.reason ?? '';
  if (r.startsWith('parse_error')) return 'parse_error';
  if (r.startsWith('compress=false')) return 'compress_disabled';
  if (r.startsWith('below_min_chars')) return 'below_min_chars';
  if (r.startsWith('below_min_tokens')) return 'below_min_tokens';
  if (r.startsWith('not_profitable')) return 'not_profitable';
  if (r.includes('image') && r.includes('limit')) return 'image_limit';
  return 'passthrough';
}

/**
 * Library wrapper for the Anthropic Messages transformer: model gate, machine-readable
 * reasons, and cache_control ownership flag (prevents hosts stacking a second injector).
 */
export async function transformAnthropicMessages(
  input: PxpipeTransformInput,
): Promise<PxpipeTransformResult> {
  const original = toUint8Array(input.body);
  if (!isPxpipeSupportedModel(input.model)) {
    return {
      body: original,
      applied: false,
      reason: 'unsupported_model',
      detail: input.model ?? undefined,
      info: emptyInfo('unsupported_model'),
      cache: { ownsCacheControl: false, markerCount: countCacheControlMarkers(original) },
    };
  }

  try {
    const { body, info } = await transformRequest(original, input.options);
    const reason = classifyReason(info);
    const markerCount = countCacheControlMarkers(body);
    return {
      body,
      applied: info.compressed,
      reason,
      detail: info.reason,
      info,
      cache: {
        ownsCacheControl: info.compressed && markerCount > 0,
        markerCount,
      },
    };
  } catch (e) {
    return {
      body: original,
      applied: false,
      reason: 'transform_error',
      detail: e instanceof Error ? e.message : String(e),
      info: emptyInfo(`transform_error: ${e instanceof Error ? e.message : String(e)}`),
      cache: { ownsCacheControl: false, markerCount: countCacheControlMarkers(original) },
    };
  }
}

// ---------------------------------------------------------------------------
// Public render primitive
// ---------------------------------------------------------------------------

export interface RenderTextToImagesOptions {
  /** Wrap-width cap in cols. Default DENSE_CONTENT_COLS (384). */
  readonly cols?: number;
  /** Shrink the canvas to the widest actual line (default true). `false` keeps the
   *  full `cols` width — the proxy's eval-backed full-canvas behavior. */
  readonly shrink?: boolean;
  /** Columns to pack side-by-side. `'auto'` (default) packs as many as fit the width
   *  cap; a number forces that count (clamped to what fits). */
  readonly multiCol?: number | 'auto';
  /** Reflow the text before rendering (minify + join hard newlines with the ↵ sentinel so
   *  short lines pack into full-width rows). This is the proxy's dense history format and is
   *  what `pxpipe export` uses. Default false (raw one-line-per-row). */
  readonly reflow?: boolean;
  /** Max source chars per page. Default DENSE_CONTENT_CHARS_PER_IMAGE. */
  readonly maxCharsPerImage?: number;
  /** Render style. Default DENSE_RENDER_STYLE (bare 5×8 cell, anti-aliased). */
  readonly style?: RenderStyle;
  /** Max page height in px. Default MAX_HEIGHT_PX (728 — Anthropic 1568-edge / ~1.15 MP safe). */
  readonly maxHeightPx?: number;
}

export interface RenderedTextImage {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface RenderTextToImagesResult {
  readonly pages: RenderedTextImage[];
  /** Codepoints absent from the glyph atlas (rendered as blank cells). */
  readonly droppedChars: number;
  /** Σ width×height across all pages. */
  readonly pixels: number;
}

/**
 * Render arbitrary text to dense PNG pages — the public, documented entry for the
 * renderer the proxy uses internally. Sizes a narrow canvas to the content (`shrink`)
 * and packs multiple columns (`multiCol`) so short-line content isn't priced at full
 * width. Returns raw PNG bytes + pixel dimensions, ready to write to disk or wrap in
 * image blocks. This is the surface SDK consumers should use instead of reaching into
 * the internal leaf renderers in `render.ts`.
 */
export async function renderTextToImages(
  text: string,
  opts: RenderTextToImagesOptions = {},
): Promise<RenderTextToImagesResult> {
  const maxCols = Math.max(1, (opts.cols ?? DENSE_CONTENT_COLS) | 0);
  const style = opts.style ?? DENSE_RENDER_STYLE;
  const maxHeightPx = opts.maxHeightPx ?? MAX_HEIGHT_PX;
  const maxChars = opts.maxCharsPerImage ?? DENSE_CONTENT_CHARS_PER_IMAGE;

  // Reflow (the proxy's dense default; opt-in here): minify trailing whitespace + collapse
  // blank-line runs, then join hard newlines with the ↵ sentinel so short lines PACK into
  // full-width rows instead of one-line-per-row with a ragged right margin. Indentation is
  // preserved (minifyForRender only touches trailing ws), so code stays readable and the ↵
  // marks every real newline so the text is fully reconstructable. This is exactly what the
  // proxy's history path does before rendering — without it, a 384-col canvas holding ~25-col
  // code lines wastes ~75% of every row, which is why raw exports looked sparse. reflow()
  // bails (→ raw text) only if the source already contains ↵, which is vanishingly rare.
  const source = opts.reflow ? reflow(text) ?? text : text;

  // Width/columns: measure the content, then pack as many side-by-side columns as fit the
  // width cap (auto) or the caller's explicit count. Reflowed source is one ↵-joined full-
  // width line, so this collapses to a single dense 384-col column — byte-identical to the
  // proxy's history render (renderTextToPngsWithCharLimit at DENSE_CONTENT_COLS).
  const cols = opts.shrink === false ? maxCols : measureContentCols(source, maxCols);
  const requestedCols =
    opts.multiCol === undefined || opts.multiCol === 'auto'
      ? Math.max(1, maxFittingCols(cols))
      : Math.max(1, opts.multiCol | 0);
  const numCols = cols < maxCols ? 1 : requestedCols;

  const imgs =
    numCols > 1
      ? await renderTextToPngsMultiCol(source, cols, numCols)
      : await renderTextToPngsWithCharLimit(source, cols, maxChars, style, maxHeightPx);

  let droppedChars = 0;
  let pixels = 0;
  for (const im of imgs) {
    droppedChars += im.droppedChars;
    pixels += im.width * im.height;
  }
  return {
    pages: imgs.map((im) => ({ png: im.png, width: im.width, height: im.height })),
    droppedChars,
    pixels,
  };
}
