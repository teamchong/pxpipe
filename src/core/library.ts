import { isPxpipeSupportedModel } from './applicability.js';
import { countCacheControlMarkers } from './measurement.js';
import { transformRequest, type TransformInfo, type TransformOptions } from './transform.js';

export type BytesLike = Uint8Array | ArrayBuffer | ArrayBufferView;

export interface PxpipeOptions extends Pick<TransformOptions, 'charsPerToken' | 'historyAmortizationHorizon'> {
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
  if (r.startsWith('not_profitable')) return 'not_profitable';
  if (r.includes('image') && r.includes('limit')) return 'image_limit';
  return 'passthrough';
}

/**
 * Library-first wrapper around pxpipe's Anthropic Messages transformer.
 * It performs the Opus-4.6/4.7-only model gate, returns machine-readable reasons,
 * and reports cache_control ownership so hosts such as ocproxy do not stack a
 * second cache injector on top of pxpipe's image breakpoint.
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
