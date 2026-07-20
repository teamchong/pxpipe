/**
 * Runtime-agnostic event sink for pxpipe.
 * Per-request JSONL record — same shape on Node (file) and Workers (console.log).
 * Never emits raw text; only sizes, counts, durations, env fields, and sha256 prefixes.
 */

import type { ProxyEvent } from './proxy.js';
import { bytesToBase64 } from './png.js';

/** Flat record persisted per request. Adding a field is non-breaking for readers. */
export interface TrackEvent {
  ts: string;
  method: string;
  path: string;
  /** Top-level request model when present. */
  model?: string;
  accounting_provider?: 'anthropic' | 'openai';
  status: number;
  duration_ms: number;
  first_byte_ms?: number;

  // From TransformInfo:
  compressed?: boolean;
  reason?: string;
  orig_chars?: number;
  /** Text-chars replaced by image blocks (slab + reminders + tool_results).
   *  Compare with image_count: textTokens(n/4) vs imageTokens(n×2500). */
  compressed_chars?: number;
  image_count?: number;
  image_bytes?: number;
  /** Total pixel area across all rendered images; pairs with cache_create_tokens for px/token regression. */
  image_pixels?: number;
  /** GPT only: vision tokens billed for rendered images. */
  image_tokens?: number;
  /** GPT only: o200k text tokens the imaged/stripped content would have cost. */
  baseline_imaged_tokens?: number;
  /** GPT-only pxpipe-added native text, absent from the unproxied request. */
  native_injected_tokens?: number;
  /** TEXT chars in the outgoing body (all text blocks, incl. non-compressed tool_results).
   *  With image_pixels, a regression over cold-miss events solves chars_per_token (α) and pixels_per_token (β). */
  outgoing_text_chars?: number;
  /** Local o200k decomposition of the original OpenAI Responses request. */
  responses_composition?: NonNullable<NonNullable<ProxyEvent['info']>['responsesComposition']>;
  static_chars?: number;
  dynamic_chars?: number;
  dynamic_block_count?: number;
  /** Images from compressing <system-reminder> blocks in the first user message. */
  reminder_imgs?: number;
  /** Images from compressing tool_result content. */
  tool_result_imgs?: number;
  /** Chars of tool docs moved to the system-text Tool Reference (not imaged). */
  tool_docs_chars?: number;
  /** tool_result blocks where text exceeded the per-result image budget and was truncated. */
  truncated_tool_results?: number;
  /** Chars elided by paging across all tool_results this request. */
  omitted_chars?: number;
  /** History-image: messages collapsed into the synthetic prepended user message. */
  collapsed_turns?: number;
  /** Total chars serialized into history image(s) before render. */
  collapsed_chars?: number;
  /** PNG blocks emitted for the history; also folded into image_count. */
  collapsed_images?: number;
  /** Why history collapse didn't run (or did). Diagnostic. */
  history_reason?: string;
  /** Codepoints not in the glyph atlas. A spike means users type glyphs we don't ship — widen ATLAS_PROFILE. */
  dropped_chars?: number;
  /** Top-20 dropped codepoints (U+HHHH keys) by frequency. Only present when dropped_chars > 0. */
  dropped_codepoints_top?: Record<string, number>;
  /** Blocks that weren't image-compressed this request; only emitted when at least one counter > 0. */
  passthrough_reasons?: { below_threshold?: number; not_profitable?: number };
  /** Unrecognized tag names in the static slab — canary for Claude Code releases adding new dynamic tags. */
  unknown_static_tags?: string[];
  /** Slab tags whose content changed within a session — proven per-turn dynamics busting the image cache. */
  churning_static_tags?: string[];
  /** Per-bucket TEXT chars through each gate call site (static_slab, reminder, tool_result_*, history).
   *  Undefined on uncompressed requests; enables per-bucket cpt regression. */
  bucket_chars?: Partial<Record<
    'static_slab' | 'reminder' |
    'tool_result_structured' | 'tool_result_log' | 'tool_result_prose' |
    'history',
    number
  >>;
  /** Adaptive CPT: which chars-per-token source each gate bucket used this request
   *  (`host` = caller-pinned, `learned` = fitted from telemetry, `default` = baked
   *  constant), and the value it ran with. Lets a shadow-mode/eval run attribute a
   *  decision change to the learned rate. Absent when no gate bucket fired. */
  cpt_source?: Partial<Record<string, 'host' | 'learned' | 'default'>>;
  cpt_used?: Partial<Record<string, number>>;
  /** TEXT chars that fed the history-image renderer; separate from bucket_chars because it credits a synthetic message. */
  history_text_chars?: number;
  /** sha8 of the collapsed history image. Unchanged across turns proves the prompt cache is hitting (cache_read).
   *  A drifting hash means the collapse boundary is unstable. Absent on no-collapse turns. */
  history_image_sha8?: string;
  /** sha8 of the exact cacheable prefix sent (tools+system+imaged prefix, live
   *  tail excluded). Changes turn-over-turn within a session ⇒ pxpipe-side cache
   *  bust; stable while cache_create spikes ⇒ upstream eviction. See #11. */
  cache_prefix_sha8?: string;
  /** Approx chars in that pinned prefix (growth vs pure-invalidation split). */
  cache_prefix_bytes?: number;

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

  // From Anthropic/OpenAI Usage:
  input_tokens?: number;
  output_tokens?: number;
  cache_create_tokens?: number;
  cache_read_tokens?: number;
  /** OpenAI prompt-cache hits (subset of input_tokens), from input/prompt_tokens_details.cached_tokens. */
  cached_tokens?: number;
  /** Cache_create split by tier — 1.25x (5-min) and 2x (1-hour) input rates.
   *  Their sum equals `cache_create_tokens` when both fields are present. */
  cache_create_5m_tokens?: number;
  cache_create_1h_tokens?: number;
  /** Server-side web search calls billed per-request (not per-token). */
  web_search_requests?: number;

  /** Model stop reason ("end_turn", "tool_use", "max_tokens", "refusal", …).
   *  OpenAI finish_reason ("stop", "length", "content_filter", …) lands in the same field. */
  stop_reason?: string;
  /** True when the stop reason indicates a safety classifier fired ("refusal" /
   *  "content_filter"). Refusal rows emit almost no output and would otherwise
   *  read as "cheap" — scorers MUST fail cost comparisons on these rows, and a
   *  cluster of them after a transform change means the imaged prompt itself is
   *  tripping the classifier (see transform.ts reasoning_extraction notes). */
  safety_flagged?: boolean;

  /** Ground-truth output chars measured by streaming the response body ourselves — independent of
   *  usage.output_tokens. redacted_block_count_measured counts opaque server-encrypted blocks;
   *  dashboard applies a low/mid/high estimate for those. Absent on non-scannable responses. */
  text_chars_measured?: number;
  thinking_chars_measured?: number;
  tool_use_chars_measured?: number;
  redacted_block_count_measured?: number;

  /** count_tokens on the ORIGINAL body (free endpoint). Absent on probe failure; excluded from savings rollup. */
  baseline_tokens?: number;
  /** count_tokens on the original body truncated at the last cache_control marker — gives cacheable_prefix_tokens.
   *  With baseline_tokens, decomposes unproxied cost into (cacheable_prefix, cold_tail). Absent when no markers. */
  baseline_cacheable_tokens?: number;
  /** Probe outcome. Dashboards must only attribute "$ saved" to rows where status === 'ok'. */
  baseline_probe_status?: 'ok' | 'partial' | 'failed';

  // Errors:
  error?: string;
  /** First ~2 KiB of the upstream 4xx response body. */
  error_body?: string;
  /** sha256[0..8] of the TRANSFORMED outgoing body — correlates payloads without persisting them. */
  req_body_sha8?: string;
  /** Gzipped+base64 TRANSFORMED body for 4xx, inlined when ≤ TRACK_BODY_INLINE_MAX. Node host writes sidecar for larger bodies. */
  req_body_sample_b64?: string;
  /** Node host only: path to gzipped sidecar when inline cap exceeded. Workers drop oversized samples. */
  req_body_sample_path?: string;
}

/** Max inline base64 body per JSONL row (32 KiB). Larger goes to sidecar (Node) or is dropped (Workers). */
export const TRACK_BODY_INLINE_MAX = 32 * 1024;

/** Hosts implement this to persist events. */
export interface Tracker {
  emit(ev: TrackEvent): void | Promise<void>;
  /** Optional: flush any buffered writes (file rotation, etc.). */
  flush?(): void | Promise<void>;
}

/** Convert a ProxyEvent to its flat persisted shape. Shared in core so Node/Worker hosts stay in sync. */
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
  if (ev.model) out.model = ev.model;
  if (ev.accountingProvider) out.accounting_provider = ev.accountingProvider;
  if (ev.firstByteMs !== undefined) out.first_byte_ms = ev.firstByteMs;
  if (ev.error) out.error = ev.error;
  if (ev.errorBody) out.error_body = ev.errorBody;
  if (ev.reqBodySha8) out.req_body_sha8 = ev.reqBodySha8;
  // Body sample: sidecar path (Node) > inline base64 if it fits > drop (Workers, oversized).
  if (ev.reqBodySamplePath) {
    out.req_body_sample_path = ev.reqBodySamplePath;
  } else if (ev.reqBodyGz && ev.reqBodyGz.byteLength > 0) {
    const b64 = bytesToBase64(ev.reqBodyGz);
    if (b64.length <= TRACK_BODY_INLINE_MAX) {
      out.req_body_sample_b64 = b64;
    }
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
    if (info.imageTokens !== undefined && info.imageTokens > 0) {
      out.image_tokens = info.imageTokens;
    }
    if (info.baselineImagedTokens !== undefined && info.baselineImagedTokens > 0) {
      out.baseline_imaged_tokens = info.baselineImagedTokens;
    }
    if (info.nativeInjectedTokens !== undefined && info.nativeInjectedTokens > 0) {
      out.native_injected_tokens = info.nativeInjectedTokens;
    }
    if (info.outgoingTextChars !== undefined && info.outgoingTextChars > 0) {
      out.outgoing_text_chars = info.outgoingTextChars;
    }
    if (info.responsesComposition) {
      out.responses_composition = info.responsesComposition;
    }
    if (info.staticChars !== undefined) out.static_chars = info.staticChars;
    if (info.dynamicChars !== undefined) out.dynamic_chars = info.dynamicChars;
    if (info.dynamicBlockCount !== undefined) out.dynamic_block_count = info.dynamicBlockCount;
    if (info.reminderImgs !== undefined) out.reminder_imgs = info.reminderImgs;
    if (info.toolResultImgs !== undefined) out.tool_result_imgs = info.toolResultImgs;
    if (info.toolDocsChars !== undefined) out.tool_docs_chars = info.toolDocsChars;
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
      // Omit empty object so noop-pass requests stay lean; presence means at least one gate fired.
      out.bucket_chars = info.bucketChars;
    }
    // Adaptive CPT: only emitted when a learned rate actually reached a gate, so
    // default-constant traffic keeps byte-identical rows.
    if (info.cptSource && Object.values(info.cptSource).some((s) => s === 'learned')) {
      out.cpt_source = info.cptSource;
      if (info.cptUsed) out.cpt_used = info.cptUsed;
    }
    if (info.historyTextChars !== undefined && info.historyTextChars > 0) {
      out.history_text_chars = info.historyTextChars;
    }
    if (info.historyImageSha) {
      out.history_image_sha8 = info.historyImageSha;
    }
    if (info.cachePrefixSha8) out.cache_prefix_sha8 = info.cachePrefixSha8;
    if (info.cachePrefixBytes !== undefined) out.cache_prefix_bytes = info.cachePrefixBytes;
    if (info.unknownStaticTags && info.unknownStaticTags.length > 0)
      out.unknown_static_tags = info.unknownStaticTags;
    if (info.churningStaticTags && info.churningStaticTags.length > 0)
      out.churning_static_tags = info.churningStaticTags;
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
    if (u.cached_tokens !== undefined)
      out.cached_tokens = u.cached_tokens;
    // cache_creation splits cache_creation_input_tokens across 5-min (1.25x) and 1-hour (2x) tiers.
    if (u.cache_creation) {
      if (u.cache_creation.ephemeral_5m_input_tokens !== undefined)
        out.cache_create_5m_tokens = u.cache_creation.ephemeral_5m_input_tokens;
      if (u.cache_creation.ephemeral_1h_input_tokens !== undefined)
        out.cache_create_1h_tokens = u.cache_creation.ephemeral_1h_input_tokens;
    }
    if (u.server_tool_use?.web_search_requests !== undefined)
      out.web_search_requests = u.server_tool_use.web_search_requests;
  }
  const m = ev.measurement;
  if (m) {
    if (m.textChars > 0) out.text_chars_measured = m.textChars;
    if (m.thinkingChars > 0) out.thinking_chars_measured = m.thinkingChars;
    if (m.toolUseChars > 0) out.tool_use_chars_measured = m.toolUseChars;
    if (m.redactedBlockCount > 0)
      out.redacted_block_count_measured = m.redactedBlockCount;
  }
  if (ev.stopReason) {
    out.stop_reason = ev.stopReason;
    if (SAFETY_STOP_REASONS.has(ev.stopReason)) out.safety_flagged = true;
  }
  return out;
}

/** Stop reasons that mean a safety classifier fired (Anthropic / OpenAI spellings). */
const SAFETY_STOP_REASONS = new Set(['refusal', 'content_filter']);

/** Writes one JSON line per event. Worker host uses console.log; Node host uses a file-backed variant. */
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
