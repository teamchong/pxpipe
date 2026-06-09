/**
 * Runtime-agnostic event sink for pxpipe.
 *
 * The proxy core emits a `ProxyEvent` per request. A Tracker is the host's
 * decision about *where* those events go — local JSONL file on Node, console
 * (= Workers Logs) on Cloudflare. The shape of the persisted record is the
 * same on both sides so analysis tooling (`pxpipe stats`, downstream
 * aggregation) doesn't care which runtime produced it.
 *
 * Privacy: we never emit raw user text or the system prompt. Only sizes,
 * counts, durations, parsed env fields (cwd / branch / platform), and short
 * sha256 prefixes. All callable from Node 18+ and Workers.
 */

import type { ProxyEvent } from './proxy.js';
import { bytesToBase64 } from './png.js';

/** The flat record shape that lands in JSONL / log lines. Adding a field
 *  here is a non-breaking change for readers. */
export interface TrackEvent {
  ts: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  first_byte_ms?: number;

  // From TransformInfo:
  compressed?: boolean;
  reason?: string;
  orig_chars?: number;
  /** Sum of text-chars actually replaced by image blocks this request (static
   *  slab + reminders + tool_results). Apples-to-apples with image_count for
   *  savings math: textTokens(compressed_chars/4) vs imageTokens(image_count×2500). */
  compressed_chars?: number;
  image_count?: number;
  image_bytes?: number;
  /** Total pixel area summed across all rendered images. Pairs with
   *  `cache_create_tokens` on cold-miss events for empirical px/token. */
  image_pixels?: number;
  /** Total TEXT chars remaining in the outgoing transformed body (every
   *  `text` block across system + messages, including tool_result text that
   *  didn't compress). Pairs with `image_pixels` so a regression over N
   *  cold-misses solves both `chars_per_token` (α) and `pixels_per_token` (β)
   *  for the live model. */
  outgoing_text_chars?: number;
  static_chars?: number;
  dynamic_chars?: number;
  dynamic_block_count?: number;
  /** Image count attributable to compressing `<system-reminder>` blocks in
   *  the first user message. */
  reminder_imgs?: number;
  /** Image count attributable to compressing tool_result content. */
  tool_result_imgs?: number;
  /** Number of tool_result blocks where the source text exceeded the
   *  per-tool_result image budget and was truncated before rendering. */
  truncated_tool_results?: number;
  /** Total chars elided by paging across all tool_results this request. */
  omitted_chars?: number;
  /** Variant C history-image: how many messages got collapsed into the
   *  prepended synthetic user message this request. Absent when not. */
  collapsed_turns?: number;
  /** Variant C: total chars of text serialized into the history image(s)
   *  before render. Absent when no collapse happened. */
  collapsed_chars?: number;
  /** Variant C: number of PNG image blocks emitted for the history. Folded
   *  into `image_count` too — surfaced separately so dashboards can
   *  attribute image-count growth to history vs system-slab vs reminders. */
  collapsed_images?: number;
  /** Variant C: why the history collapse didn't run (or did). Diagnostic. */
  history_reason?: string;
  /** Codepoints rendered into images that weren't in the glyph atlas. A
   *  spike here means users are typing glyphs we don't ship — consider
   *  switching ATLAS_PROFILE to `full-bmp`. */
  dropped_chars?: number;
  /** Top-20 dropped codepoints by frequency for this request, keyed
   *  `U+HHHH`. Only present when `dropped_chars > 0`. Lets the operator
   *  identify which Unicode blocks to add to the atlas profile without
   *  having to capture & inspect the request body. */
  dropped_codepoints_top?: Record<string, number>;
  /** Counters for blocks that DIDN'T get image-compressed this request. Lets
   *  the operator tune the break-even threshold and spot if the
   *  not-profitable bucket grows (= renderer-config change needed). Only
   *  emitted when at least one counter > 0. */
  passthrough_reasons?: { below_threshold?: number; not_profitable?: number };
  /** Tag names found in the static slab we don't recognize. Canary for
   *  Claude Code releases that add new dynamic tags. */
  unknown_static_tags?: string[];
  /** Per-bucket sum of TEXT chars that flowed through each gate call site,
   *  bucketed by content shape so a marginal cpt can be learned per bucket.
   *  Buckets are `static_slab`, `reminder`, `tool_result_{structured,log,prose}`,
   *  and `history`. Only present when at least one bucket fired (in particular,
   *  this is `undefined` on uncompressed requests). Used by the rolling-cpt
   *  task (#18) to refine the marginal cpt per bucket instead of relying on a
   *  single global constant. */
  bucket_chars?: Partial<Record<
    'static_slab' | 'reminder' |
    'tool_result_structured' | 'tool_result_log' | 'tool_result_prose' |
    'history',
    number
  >>;
  /** Variant C history bucket: chars of TEXT that fed the history-image's
   *  renderer. Surfaced separately so the regression can credit history-image
   *  text growth even on no-collapse turns (when this is 0). Pairs with the
   *  history-bucket entry in `bucket_chars`. */
  history_text_chars?: number;
  /** Variant C: sha8 of the concatenated history-image base64 emitted this
   *  request. The quantized collapse boundary is supposed to keep this
   *  byte-identical for a full `collapseChunk` window — so an UNCHANGED hash
   *  across consecutive `collapsed` events is ground-truth proof the upstream
   *  prompt cache can `cache_read` the history prefix (0.1x) instead of
   *  re-billing `cache_create` (1.25x). A hash that moves every turn ⟹ the
   *  cache-key drift bug (#28) is back. Absent on no-collapse turns. */
  history_image_sha8?: string;

  // From TransformInfo.env:
  cwd?: string;
  is_git_repo?: boolean;
  git_branch?: string;
  platform?: string;
  os_version?: string;
  today?: string;

  // Fingerprints:
  system_sha8?: string;
  claude_md_sha8?: string;
  first_user_sha8?: string;

  // From Anthropic Usage:
  input_tokens?: number;
  output_tokens?: number;
  cache_create_tokens?: number;
  cache_read_tokens?: number;
  /** Cache_create split by tier — 1.25x (5-min) and 2x (1-hour) input rates.
   *  Their sum equals `cache_create_tokens` when both fields are present. */
  cache_create_5m_tokens?: number;
  cache_create_1h_tokens?: number;
  /** Server-side web search calls billed per-request (not per-token). */
  web_search_requests?: number;

  /** Ground-truth output measurement from streaming the response body
   *  ourselves. `text_chars_measured` / `thinking_chars_measured` /
   *  `tool_use_chars_measured` count Unicode code units of the corresponding
   *  payloads (`text_delta`, `thinking_delta`, `input_json_delta` for SSE;
   *  `content[].text` / `.thinking` / JSON-encoded `.input` for non-stream).
   *  `redacted_block_count_measured` is the number of `redacted_thinking`
   *  blocks Anthropic returned — chars are unavailable for these (the field
   *  is opaque server-encrypted bytes), so they get a low/mid/high estimate
   *  at the dashboard layer instead of a precise char count. Independent of
   *  Anthropic's `usage.output_tokens` — gives a real ruler against the
   *  redacted_thinking-inflated bill that surfaced the May-2026 weekly-meter
   *  audit. Absent on requests that didn't yield a body we could scan (no
   *  upstream response, 5xx, unknown content-type). */
  text_chars_measured?: number;
  thinking_chars_measured?: number;
  tool_use_chars_measured?: number;
  redacted_block_count_measured?: number;

  /** Ground-truth pre-compression token count from a parallel call to
   *  /v1/messages/count_tokens on the ORIGINAL request body. The endpoint
   *  is free (no billing). Absent when the probe failed; those events are
   *  excluded from the dashboard's savings rollup. */
  baseline_tokens?: number;
  /** Second baseline probe: input_tokens of the original body TRUNCATED at
   *  the last `cache_control` marker. With `baseline_tokens` it decomposes
   *  the unproxied path's cost into (cacheable_prefix, cold_tail) so the
   *  dashboard can apply the SAME cache class the actual request landed in
   *  for a true apples-to-apples counterfactual. Absent when the original
   *  body has no cache_control markers (cacheable=0, the whole body is the
   *  cold tail). */
  baseline_cacheable_tokens?: number;
  /** Status of the cache-aware baseline probes for this request. See
   *  TransformInfo.baselineProbeStatus for semantics. Dashboards must only
   *  attribute "$ saved" to rows with status === 'ok'. */
  baseline_probe_status?: 'ok' | 'partial' | 'failed';

  // Errors:
  error?: string;
  /** First ~2 KiB of the upstream response body for 4xx requests. Lets us
   *  see what Anthropic actually rejected without re-running the request. */
  error_body?: string;
  /** sha256[0..8] of the TRANSFORMED outgoing request body. Set on every
   *  /v1/messages POST. Lets future debuggers correlate identical payloads
   *  across requests without persisting bodies. */
  req_body_sha8?: string;
  /** Gzipped+base64'd TRANSFORMED outgoing request body for 4xx requests,
   *  when it fits inline (≤ TRACK_BODY_INLINE_MAX after base64). The Node
   *  host redirects oversized bodies to a sidecar (see req_body_sample_path)
   *  before this serializer runs. */
  req_body_sample_b64?: string;
  /** Filesystem path to a gzipped sidecar copy of the TRANSFORMED outgoing
   *  request body, set by the Node host when the inline cap is exceeded.
   *  Workers never set this (no fs); they just drop the sample. */
  req_body_sample_path?: string;
}

/** Max base64-encoded length we'll inline in a single JSONL row. 32 KiB keeps
 *  the dashboard's per-row parse cost manageable while still holding the
 *  ~170 KiB raw bodies we've seen post-gzip+base64. Anything larger goes to
 *  a sidecar file (Node host) or gets dropped (Workers host). */
export const TRACK_BODY_INLINE_MAX = 32 * 1024;

/** Hosts implement this to persist events. */
export interface Tracker {
  emit(ev: TrackEvent): void | Promise<void>;
  /** Optional: flush any buffered writes (file rotation, etc.). */
  flush?(): void | Promise<void>;
}

/** Convert the in-memory ProxyEvent into the flat persisted shape. Lives in
 *  core so Node and Worker hosts can't drift from each other. */
export function toTrackEvent(ev: ProxyEvent): TrackEvent {
  const info = ev.info;
  const env = info?.env;
  const u = ev.usage;
  const out: TrackEvent = {
    ts: new Date().toISOString(),
    method: ev.method,
    path: ev.path,
    status: ev.status,
    duration_ms: ev.durationMs,
  };
  if (ev.firstByteMs !== undefined) out.first_byte_ms = ev.firstByteMs;
  if (ev.error) out.error = ev.error;
  if (ev.errorBody) out.error_body = ev.errorBody;
  if (ev.reqBodySha8) out.req_body_sha8 = ev.reqBodySha8;
  // Body sample: prefer the sidecar path (set by the Node host); else inline
  // the gzipped+base64'd body if it fits; else drop (Workers cap, or no body).
  if (ev.reqBodySamplePath) {
    out.req_body_sample_path = ev.reqBodySamplePath;
  } else if (ev.reqBodyGz && ev.reqBodyGz.byteLength > 0) {
    const b64 = bytesToBase64(ev.reqBodyGz);
    if (b64.length <= TRACK_BODY_INLINE_MAX) {
      out.req_body_sample_b64 = b64;
    }
    // else: too big and no sidecar — drop it. (Workers path; on Node the host
    // should have written the sidecar before this serializer ran.)
  }

  if (info) {
    if (info.compressed !== undefined) out.compressed = info.compressed;
    if (info.reason) out.reason = info.reason;
    if (info.origChars !== undefined) out.orig_chars = info.origChars;
    if (info.compressedChars !== undefined && info.compressedChars > 0) {
      out.compressed_chars = info.compressedChars;
    }
    if (info.imageCount !== undefined) out.image_count = info.imageCount;
    if (info.imageBytes !== undefined) out.image_bytes = info.imageBytes;
    if (info.imagePixels !== undefined && info.imagePixels > 0) {
      out.image_pixels = info.imagePixels;
    }
    if (info.outgoingTextChars !== undefined && info.outgoingTextChars > 0) {
      out.outgoing_text_chars = info.outgoingTextChars;
    }
    if (info.staticChars !== undefined) out.static_chars = info.staticChars;
    if (info.dynamicChars !== undefined) out.dynamic_chars = info.dynamicChars;
    if (info.dynamicBlockCount !== undefined) out.dynamic_block_count = info.dynamicBlockCount;
    if (info.reminderImgs !== undefined) out.reminder_imgs = info.reminderImgs;
    if (info.toolResultImgs !== undefined) out.tool_result_imgs = info.toolResultImgs;
    if (info.truncatedToolResults !== undefined && info.truncatedToolResults > 0) {
      out.truncated_tool_results = info.truncatedToolResults;
    }
    if (info.omittedChars !== undefined && info.omittedChars > 0) {
      out.omitted_chars = info.omittedChars;
    }
    if (info.collapsedTurns !== undefined && info.collapsedTurns > 0) {
      out.collapsed_turns = info.collapsedTurns;
    }
    if (info.collapsedChars !== undefined && info.collapsedChars > 0) {
      out.collapsed_chars = info.collapsedChars;
    }
    if (info.collapsedImages !== undefined && info.collapsedImages > 0) {
      out.collapsed_images = info.collapsedImages;
    }
    if (info.historyReason !== undefined) {
      out.history_reason = info.historyReason;
    }
    if (info.droppedChars !== undefined && info.droppedChars > 0) {
      out.dropped_chars = info.droppedChars;
    }
    if (info.droppedCodepointsTop && Object.keys(info.droppedCodepointsTop).length > 0) {
      out.dropped_codepoints_top = info.droppedCodepointsTop;
    }
    if (info.passthroughReasons) {
      const pr = info.passthroughReasons;
      if ((pr.below_threshold ?? 0) > 0 || (pr.not_profitable ?? 0) > 0) {
        out.passthrough_reasons = pr;
      }
    }
    if (info.bucketChars && Object.keys(info.bucketChars).length > 0) {
      // Phase 1 (Task #18): per-bucket char attribution. Empty object is omitted
      // so noop-pass requests stay lean; presence means at least one gate fired.
      out.bucket_chars = info.bucketChars;
    }
    if (info.historyTextChars !== undefined && info.historyTextChars > 0) {
      // Variant C history-image text length, surfaced separately from the
      // bucket map because history credits a synthetic prepended user message.
      out.history_text_chars = info.historyTextChars;
    }
    if (info.historyImageSha) {
      // Byte-stability fingerprint of the collapsed history image — lets the
      // dashboard verify the prompt cache is actually being hit (unchanged
      // hash across collapsed turns) rather than drifting every request.
      out.history_image_sha8 = info.historyImageSha;
    }
    if (info.unknownStaticTags && info.unknownStaticTags.length > 0)
      out.unknown_static_tags = info.unknownStaticTags;
    if (info.systemSha8) out.system_sha8 = info.systemSha8;
    if (info.claudeMdSha8) out.claude_md_sha8 = info.claudeMdSha8;
    if (info.firstUserSha8) out.first_user_sha8 = info.firstUserSha8;
    if (info.baselineTokens !== undefined && info.baselineTokens > 0) {
      out.baseline_tokens = info.baselineTokens;
    }
    if (
      info.baselineCacheableTokens !== undefined
      && info.baselineCacheableTokens > 0
    ) {
      out.baseline_cacheable_tokens = info.baselineCacheableTokens;
    }
    if (info.baselineProbeStatus !== undefined) {
      out.baseline_probe_status = info.baselineProbeStatus;
    }
  }
  if (env) {
    if (env.cwd) out.cwd = env.cwd;
    if (env.isGitRepo !== undefined) out.is_git_repo = env.isGitRepo;
    if (env.gitBranch) out.git_branch = env.gitBranch;
    if (env.platform) out.platform = env.platform;
    if (env.osVersion) out.os_version = env.osVersion;
    if (env.today) out.today = env.today;
  }
  if (u) {
    if (u.input_tokens !== undefined) out.input_tokens = u.input_tokens;
    if (u.output_tokens !== undefined) out.output_tokens = u.output_tokens;
    if (u.cache_creation_input_tokens !== undefined)
      out.cache_create_tokens = u.cache_creation_input_tokens;
    if (u.cache_read_input_tokens !== undefined)
      out.cache_read_tokens = u.cache_read_input_tokens;
    // Anthropic returns a nested `cache_creation` block that splits the
    // `cache_creation_input_tokens` total across the 5-min (1.25x rate) and
    // 1-hour (2x rate) ephemeral tiers. Useful for honest cost math when the
    // session ever opts into the 1h cache class.
    if (u.cache_creation) {
      if (u.cache_creation.ephemeral_5m_input_tokens !== undefined)
        out.cache_create_5m_tokens = u.cache_creation.ephemeral_5m_input_tokens;
      if (u.cache_creation.ephemeral_1h_input_tokens !== undefined)
        out.cache_create_1h_tokens = u.cache_creation.ephemeral_1h_input_tokens;
    }
    // Server-side tools (e.g. web_search) bill per-request, not per-token.
    if (u.server_tool_use?.web_search_requests !== undefined)
      out.web_search_requests = u.server_tool_use.web_search_requests;
  }
  // Ground-truth output measurement from streaming the response body. These
  // numbers are independent of Anthropic's `usage.output_tokens` and let us
  // give a low/mid/high range against the redacted_thinking-inflated bill.
  // Absent on requests that didn't yield a body we could scan (no body,
  // upstream 5xx, unknown content-type).
  const m = ev.measurement;
  if (m) {
    if (m.textChars > 0) out.text_chars_measured = m.textChars;
    if (m.thinkingChars > 0) out.thinking_chars_measured = m.thinkingChars;
    if (m.toolUseChars > 0) out.tool_use_chars_measured = m.toolUseChars;
    if (m.redactedBlockCount > 0)
      out.redacted_block_count_measured = m.redactedBlockCount;
  }
  return out;
}

/** Tracker that writes one JSON line per call to the given function. Used
 *  by the Worker host (sinkFn = console.log). The Node host uses a richer
 *  file-backed implementation that handles rotation. */
export class JsonLogTracker implements Tracker {
  constructor(private readonly sink: (line: string) => void = (s) => console.log(s)) {}
  emit(ev: TrackEvent): void {
    try {
      this.sink(JSON.stringify(ev));
    } catch {
      /* swallow — tracker must never break a request */
    }
  }
}

/** Tracker that drops everything. Used when PXPIPE_TRACK=0. */
export const noopTracker: Tracker = { emit() {} };
