import { isPxpipeSupportedModel } from './applicability.js';
import { countCacheControlMarkers } from './measurement.js';
import {
  renderTextToPngsWithCharLimit,
  measureContentCols,
  reflow,
  renderCellHeight,
  renderCellWidth,
  computeCanvasGeometry,
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
import { resolveGptProfile } from './gpt-model-profiles.js';
import { resolveGeminiProfile, isGeminiModel } from './gemini-model-profiles.js';

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
    const { body, info } = await transformRequest(original, { ...input.options, model: input.model ?? undefined });
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
  /** Model whose complete built-in render profile supplies defaults. */
  readonly model?: string;
  /** Explicit target canvas width in pixels (e.g., 1912, 1536, 1024, 768). */
  readonly width?: number;
  /** Wrap-width cap. Defaults to the model profile when `model` is set. */
  readonly cols?: number;
  /** Number of parallel columns across the canvas (1 or 2). Default 1. */
  readonly columns?: number;
  /** Shrink the canvas to the widest actual line (default true). `false` keeps the
   *  full `cols` width — the proxy's eval-backed full-canvas behavior. */
  readonly shrink?: boolean;
  /** Reflow the text before rendering (minify + join hard newlines with the ↵ sentinel so
   *  short lines pack into full-width rows). This is the proxy's dense history format and is
   *  what `pxpipe export` uses. Default false (raw one-line-per-row). */
  readonly reflow?: boolean;
  /** Max source chars per page. Default DENSE_CONTENT_CHARS_PER_IMAGE. */
  readonly maxCharsPerImage?: number;
  /** Render style. Defaults to the model profile when `model` is set. */
  readonly style?: RenderStyle;
  /** Max page height. Defaults to the model profile when `model` is set. */
  readonly maxHeightPx?: number;
}

export interface RenderedTextImage {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly lines: number;
  readonly chars: number;
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
 * renderer the proxy uses internally. Sizes a narrow canvas to the content (`shrink`).
 * Returns raw PNG bytes + pixel dimensions, ready to write to disk or wrap in
 * image blocks. This is the surface SDK consumers should use instead of reaching into
 * the internal leaf renderers in `render.ts`.
 */
export async function renderTextToImages(
  text: string,
  opts: RenderTextToImagesOptions = {},
): Promise<RenderTextToImagesResult> {
  const profile = opts.model
    ? isGeminiModel(opts.model)
      ? resolveGeminiProfile(opts.model)
      : resolveGptProfile(opts.model)
    : undefined;

  const style = opts.style ?? profile?.style ?? DENSE_RENDER_STYLE;
  const cellW = renderCellWidth(style);
  const cellH = renderCellHeight(style);

  // Use opts.width directly so we don't reverse-engineer and add 8px
  const targetWidth = opts.width ?? (opts.cols !== undefined ? opts.cols * cellW + 8 : (isGeminiModel(opts.model) ? 1536 : 1568));
  const targetHeight = opts.maxHeightPx ?? profile?.maxHeightPx ?? MAX_HEIGHT_PX;

  // Auto-calculate optimal capacity based on active font cell size
  const geom = computeCanvasGeometry(targetWidth, targetHeight, cellW, cellH);
  const maxCols = Math.max(1, (opts.cols ?? geom.cols) | 0);
  const maxHeightPx = Math.max(1, targetHeight | 0);
  const numColumns = opts.columns === 2 ? 2 : 1;

  // Scaled line and character budget (accounts for exact lines without early split)
  // Double the character budget headroom so lineLimit doesn't trigger a page split early
  // 2-column mode doubles the line & character capacity per image
  const maxLines = numColumns === 2 ? geom.lines * 2 : geom.lines;
  const dynamicCharBudget = maxLines * maxCols * 2;
  const maxChars = opts.maxCharsPerImage ?? Math.max(DENSE_CONTENT_CHARS_PER_IMAGE, dynamicCharBudget);

  // Reflow (the proxy's dense default; opt-in here): minify trailing whitespace + collapse
  // blank-line runs, then join hard newlines with the ↵ sentinel so short lines PACK into
  // full-width rows instead of one-line-per-row with a ragged right margin. Indentation is
  // preserved (minifyForRender only touches trailing ws), so code stays readable and the ↵
  // marks every real newline so the text is fully reconstructable. This is exactly what the
  // proxy's history path does before rendering — without it, a 384-col canvas holding ~25-col
  // code lines wastes ~75% of every row, which is why raw exports looked sparse. reflow()
  // bails (→ raw text) only if the source already contains ↵, which is vanishingly rare.
  const source = opts.reflow ? reflow(text) ?? text : text;

  // Measure the content width. Reflowed source is one joined full-width line, so this is
  // byte-identical to the proxy's history render.
  const cols = opts.shrink === false ? maxCols : measureContentCols(source, maxCols);

  // Pass targetWidth to lock image framebuffer to exact pixel width
  const imgs = await renderTextToPngsWithCharLimit(source, cols, maxChars, style, maxHeightPx, undefined, numColumns, targetWidth);

  let droppedChars = 0;
  let pixels = 0;
  for (const im of imgs) {
    droppedChars += im.droppedChars;
    pixels += im.width * im.height;
  }
  return {
    pages: imgs.map((im) => ({
      png: im.png,
      width: im.width,
      height: im.height,
      lines: Math.max(1, Math.floor((im.height - (geom.padYTop + geom.padYBottom)) / cellH)),
      chars: im.charsRendered,
    })),
    droppedChars,
    pixels,
  };
}
