// JSON payload shapes for the dashboard. Single source of truth — update here when src/dashboard.ts changes.

/** /proxy-stats payload. */
export interface StatsPayload {
  port: number;
  uptime_sec: number;
  requests: number;
  compressed_requests: number;
  passthrough: number;
  baseline_input_weighted: number;
  actual_input_weighted: number;
  saved_input_tokens: number;
  /** Back-compat duplicate of `saved_pct_input_only`. */
  saved_pct: number;
  saved_pct_input_only: number;
  /** DEPRECATED — denominator was measured-rows-only (cherry-picks wins). Kept for back-compat. */
  saved_pct_of_total_bill: number;
  /** Measured-rows savings ÷ ALL paid requests (compressed + passthrough + probe-failed). */
  saved_pct_of_all_spend: number;
  all_baseline_equivalent_weighted: number;
  all_actual_input_weighted: number;
  all_output_weighted: number;
  all_usage_requests: number;
  /** Observed cost split: compressed vs passthrough paths on real traffic. `split_sufficient_sample` gates the per-request delta (UI shows caveat below threshold). */
  compressed_paid_requests: number;
  passthrough_paid_requests: number;
  compressed_actual_usd: number;
  passthrough_actual_usd: number;
  compressed_avg_usd_per_request: number;
  passthrough_avg_usd_per_request: number;
  compressed_minus_passthrough_avg_usd: number;
  split_sufficient_sample: boolean;
  split_min_sample_per_bucket: number;
  /** Cache-tier-aware input-side dollar savings. */
  saved_usd: number;
  output_weighted: number;
  baseline_token_equivalent: number;
  actual_token_equivalent: number;
  pricing_assumptions: PricingAssumptions;
  measured_text_chars: number;
  measured_thinking_chars: number;
  measured_tool_use_chars: number;
  measured_redacted_block_count: number;
  events_with_measurement: number;
  uptime_sec_unused?: never; // future-proof
  compression_enabled: boolean;
}

export interface PricingAssumptions {
  input_per_mtok: number;
  output_multiplier: number;
  cache_write_5m_multiplier: number;
  cache_write_1h_multiplier: number;
  cache_read_multiplier: number;
  source: string;
}

/** /proxy-recent payload. */
export interface RecentPayload {
  recent: RecentRow[];
  has_preview: boolean;
  preview_meta: string;
  image_ids?: number[];
}

export interface RecentRow {
  ts: number;
  method: string;
  path: string;
  model?: string;
  status: number;
  size_in?: number;
  compressed: boolean;
  cc_added?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_create?: number;
  cache_read?: number;
  actual_input?: number;
  baseline_input?: number;
  session_saved_so_far_delta?: number;
  img_id?: number;
  img_ids?: number[];
}

/** /api/sessions.json payload. */
export interface SessionsPayload {
  sessions: SessionRow[];
  count: number;
}

export interface SessionRow {
  // Field names MUST match the JSON from serveSessionsJson (core/sessions.ts).
  id: string;
  project: string | null;
  firstSeen: string;
  lastSeen: string;
  requestCount: number;
  charsSaved: number;
  tokensSavedEst: number;
  cacheReadTokens: number;
  jsonlBytes: number;
  sidecarBytes: number;
  claudeCode: ClaudeCodeRef | null;
}

export interface ClaudeCodeRef {
  sessionId: string;
  projectPath: string;
  cwd?: string;
  firstUserPreview?: string;
}

/** /api/stats.json payload. */
export interface FullStatsPayload {
  parsed: number;
  dropped: number;
  summary: FullStatsSummary;
  error?: string;
  path?: string;
}

export interface FullStatsSummary {
  total: number;
  ok2xx: number;
  err4xx: number;
  err5xx: number;
  compressed: number;
  passthrough: number;
  inputTokensTotal: number;
  cacheCreateTokensTotal: number;
  cacheReadTokensTotal: number;
  outputTokensTotal: number;
  cacheHitEvents: number;
  eventsWithBaseline: number;
  origCharsTotal: number;
  imageBytesTotal: number;
  durationP50: number;
  durationP95: number;
  firstByteP50: number;
  firstByteP95: number;
}

/** POST /api/compression response. */
export interface CompressionToggleResponse {
  compression_enabled: boolean;
}

/** /api/current-session.json — aggregates for the most-recently-active session.
 *  Includes session-wide totals needed for the honest saved-% against the full bill (not just measured slice). */
export interface CurrentSessionPayload {
  sessionId: string | null;
  message?: string;
  baselineInputWeighted?: number;
  actualInputWeighted?: number;
  baselineMeasuredCount?: number;
  /** Σ actualInputWeighted over all session requests — honest denominator for saved-% against the full bill. */
  allActualInputWeighted?: number;
  /** Σ outputWeighted over all session requests. */
  allOutputWeighted?: number;
  /** Raw input tokens (no rate weighting): Σ(input+cache_create+cache_read). Cache-blind — kept for the math drawer, NOT the headline (which uses the weighted pair). */
  rawActualTokens?: number;
  /** Σ count_tokens of each body as plain text — the cache-blind baseline side. */
  rawBaselineTokens?: number;
  /** Raw output tokens — shown as an "untouched" note; output is never compressed. */
  rawOutputTokens?: number;
}
