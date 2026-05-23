// Shape of the JSON payloads the Node host emits. Kept here so the components
// don't drift from `src/dashboard.ts` — when the server contract changes, both
// sides update together.

/** /proxy-stats payload — the live counters cards + sub-lines. */
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
  /** DEPRECATED — denominator was filtered to measured-rows-only, which
   *  cherry-picks the wins. Kept on the wire for back-compat. */
  saved_pct_of_total_bill: number;
  /** Honest "share of total bill saved": measured-rows savings ÷ ALL paid
   *  requests in the window (compressed + passthrough + probe-failed). */
  saved_pct_of_all_spend: number;
  all_baseline_equivalent_weighted: number;
  all_actual_input_weighted: number;
  all_output_weighted: number;
  all_usage_requests: number;
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

/** /proxy-recent payload — the table + preview pane. */
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
}

/** /api/sessions.json payload — bulk session aggregate + selection table. */
export interface SessionsPayload {
  sessions: SessionRow[];
  count: number;
}

export interface SessionRow {
  // Mirrors the server's `SessionSummary` (core/sessions.ts) as serialized by
  // `serveSessionsJson`. Field names MUST match the JSON payload exactly —
  // the server is the source of truth here.
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

/** /api/stats.json payload — full-history aggregate. */
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

/** /api/compression POST response. */
export interface CompressionToggleResponse {
  compression_enabled: boolean;
}
