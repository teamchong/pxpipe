/**
 * Live dashboard for the Node host. Serves the main HTML page, per-session
 * detail pages, and JSON polling endpoints. All "/api/*.json" endpoints
 * recompute from disk on every request — pixelpipe doesn't have a query
 * layer, but a 1.5 MB JSONL streams in well under 100 ms.
 *
 * Legacy live-poll endpoints (left in place, the existing tick() loop uses
 * them):
 *
 *   GET  /, /dashboard               → main HTML page
 *   GET  /proxy-stats                → JSON aggregate over the in-mem ring
 *   GET  /proxy-recent               → JSON ring buffer of recent requests
 *   GET  /proxy-latest-png[?crop=N]  → raw PNG of the latest rendered image
 *
 * New session / cleanup endpoints (added in this PR):
 *
 *   GET  /sessions/${id}             → HTML detail page for one session
 *   GET  /api/sessions.json          → grouped sessions (sha8 + project + counts)
 *   GET  /api/sessions/${id}.json    → events + metadata for one session
 *   GET  /api/disk.json              → events.jsonl + 4xx-bodies disk usage
 *   GET  /api/stats.json             → full-history aggregate (formerly `pixelpipe stats`)
 *   POST /api/sessions/prune         → atomic prune by older-than / keep-last / session
 *
 * Metric formulas and HTML shell originally ported from the Python reference
 * implementation (deleted after live cache-rate validation hit 98.7% by tokens).
 *
 * Node-only by design. Workers host has no dashboard; use Workers Logs.
 *
 * Memory bound: ring buffer cap 50 events + ONE latest PNG (replaced on each
 * compressed request). At a typical 75 KB PNG that's well under 1 MB resident.
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { ProxyEvent } from './core/proxy.js';
import type { TrackEvent } from './core/tracker.js';
import {
  computeActualInputEff,
  computeBaselineInputEff,
} from './core/baseline.js';
import {
  aggregateSessions,
  claudeCodeMap,
  collectSessionEvents,
  diskUsage,
  filterSessions,
  prune,
  redactEvent,
  type ClaudeCodeSessionRef,
  type ListOptions,
  type PruneOptions,
  type SessionsPaths,
  type SessionSummary,
} from './sessions.js';
import { aggregateEventsFile, summaryToJson } from './stats.js';

const RECENT_CAP = 50;

/** One row in the dashboard's "recent requests" table. Compact on purpose —
 *  this lives in memory and gets serialized on every poll.
 *
 *  The "input" numbers (`actual_input`, `baseline_input`) are input-side
 *  only — input + cache_create×1.25 + cache_read×0.10 — because that's
 *  the slice the proxy can move. `output_tokens` is reported separately so
 *  the operator can see what fraction of the bill is unaffected by
 *  compression (and decide whether the headline % makes sense for their
 *  workload). */
export interface RecentRow {
  ts: number;
  method: string;
  path: string;
  status: number;
  size_in?: number;
  compressed: boolean;
  cc_added?: number;
  input_tokens?: number;
  /** From /v1/messages `usage.output_tokens`. Identical with/without
   *  compression — shown so the operator can see why an output-heavy
   *  turn moves the headline less than a cache-create-heavy one. */
  output_tokens?: number;
  cache_create?: number;
  cache_read?: number;
  /** input + cache_create×1.25 + cache_read×0.10, from the upstream usage
   *  block. Missing when the request 4xx'd or wasn't /v1/messages. */
  actual_input?: number;
  /** /v1/messages/count_tokens(originalBody).input_tokens. Missing when the
   *  side-probe failed or the request body wasn't an Anthropic Messages payload. */
  baseline_input?: number;
  /** How much the running "saved" total moved on this request. */
  session_saved_so_far_delta?: number;
}

/** Aggregate over the whole session. Reset on process restart unless
 *  replay() is called to seed from the JSONL file.
 *
 *  The savings numerator is input-only — output is identical with and
 *  without compression, so it cancels. The denominator is the FULL bill
 *  (input + output×5 in input-token-equivalents) so the headline percentage
 *  drops honestly toward zero on output-heavy workloads instead of hiding
 *  the fact that the proxy only moves part of the cost.
 *
 *    Per event (see src/core/baseline.ts for the derivation):
 *      cacheable = baseline_cacheable_tokens || 0     (tokens up to last cache_control)
 *      cold_tail = baseline_tokens − cacheable        (always-cold input on both paths)
 *      cc_u, cr_u = the unproxied path's counterfactual cache_create / cache_read split:
 *                   cr > 0 ?  cc_u = min(cc, cacheable),  cr_u = cacheable − cc_u   (warm turn)
 *                 : cc > 0 ?  cc_u = cacheable,           cr_u = 0                  (cold start)
 *                 :           cc_u = 0,                   cr_u = 0                  (no caching)
 *      baseline_input_eff = cc_u × 1.25 + cr_u × 0.10
 *                         + (cacheable − cc_u − cr_u) × 1.0 + cold_tail × 1.0
 *      actual_input_eff   = input + cache_create×1.25 + cache_read×0.10
 *      output_equiv       = output × 5                (input-token-equivalent at the 5× output rate)
 *      saved              = baseline_input_eff − actual_input_eff
 *      baseline_total     = baseline_input_eff + output_equiv
 *      actual_total       = actual_input_eff + output_equiv
 *
 *    Roll-up:
 *      saved_pct = Σ saved / Σ baseline_total × 100
 *
 *  This is what Anthropic's weekly-limit meter actually counts — input +
 *  output×5 in input-token-equivalents. The dashboard headline matches it
 *  so a "20% saved" number means weekly-limit consumption dropped by 20%,
 *  not "20% off the slice we touched while the other half stayed full." */
interface Totals {
  requests: number;
  compressedRequests: number;
  /** Sum of weighted actual input tokens we paid for, across all events that
   *  also carried a baseline_tokens measurement (input + cache_create×1.25 +
   *  cache_read×0.10). */
  actualInputWeighted: number;
  /** Sum of the cache-aware baseline (see formula above) across the same
   *  events that contributed to `actualInputWeighted`. The honest counter-
   *  factual cost of the unproxied path. */
  baselineInputWeighted: number;
  /** Sum of output_tokens × OUTPUT_TOKEN_RATE across the same events. Added
   *  to BOTH sides of the savings math denominator so the headline % counts
   *  output toward the total bill (it cancels in the numerator — proxy
   *  doesn't touch output). Without this the headline ignores half the
   *  bill on output-heavy sessions. */
  outputWeighted: number;
  startedAt: number;
}

/*
 * ─────────────────────────────────────────────────────────────────────────
 *  PROVENANCE — every magic number below should trace to one of these:
 *
 *  [docs-pricing]   docs.anthropic.com/en/docs/about-claude/pricing
 *                   Verified 2026-05-19 via WebFetch. The page lists per-model
 *                   per-million-token rates and the cache-tier multipliers.
 *
 *  [count_tokens]   docs.anthropic.com/en/api/messages-count-tokens
 *                   The dashboard's baseline number comes from a free side
 *                   call to /v1/messages/count_tokens on the PRE-COMPRESSION
 *                   body. No estimation, no α, no regression.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** Output-token rate multiplier (referenced to the input base rate).
 *  Source: [docs-pricing] — Opus 4.7 lists $5/Mtok input and $25/Mtok
 *  output (5×); Sonnet 4.7 lists $3/Mtok input and $15/Mtok output (5×).
 *  Same ratio holds on Haiku 4.5 ($1/$5). */
const OUTPUT_TOKEN_RATE = 5.0;

/** Per-million-token input rate ASSUMED for the headline dollar figure.
 *  Source: [docs-pricing] — Claude Opus 4.7 base input is $5.00/Mtok.
 *
 *  This is exposed on /proxy-stats as `pricing_assumptions.input_per_mtok`
 *  so the operator can see what we assumed and override if they're
 *  running against a non-default deployment (Bedrock/Vertex add a 10%
 *  premium per [docs-pricing], Sonnet would be $3/Mtok, etc.). The
 *  previous value here was $15/Mtok — that was Opus 3 pricing and over-
 *  stated dollar savings by 3× on Opus 4.x deployments. */
const ASSUMED_INPUT_USD_PER_MTOK = 5.0;

export class DashboardState {
  private recent: RecentRow[] = [];
  private totals: Totals = {
    requests: 0,
    compressedRequests: 0,
    actualInputWeighted: 0,
    baselineInputWeighted: 0,
    outputWeighted: 0,
    startedAt: Date.now() / 1000,
  };
  private latestPng: Uint8Array | null = null;
  private latestPngMeta = '';
  private latestPngWidth = 0;
  private latestPngHeight = 0;
  /** Runtime kill switch for compression. When false, the proxy forwards
   *  /v1/messages unchanged to upstream — pure passthrough, no images,
   *  no transforms. Controlled by the dashboard "passthrough" toggle so
   *  the operator can disable the proxy's transform instantly when
   *  upstream is unhealthy or when triaging a bad release. In-memory
   *  only — restart resets to true. */
  private compressionEnabled = true;
  setCompressionEnabled(on: boolean): void {
    this.compressionEnabled = on;
  }
  getCompressionEnabled(): boolean {
    return this.compressionEnabled;
  }
  /** Resolved disk paths for the events.jsonl + 4xx-bodies sidecar dir. The
   *  new sessions / cleanup endpoints need this; legacy callers that don't
   *  pass `paths` opt out of those endpoints by returning 503. */
  private readonly paths: SessionsPaths | undefined;

  /** Test hook: when set, /api/sessions.json and /api/sessions/${id}.json
   *  call this instead of `claudeCodeMap()` with the real `~/.claude/projects/`
   *  path. Lets unit tests run in tens of ms instead of scanning hundreds of
   *  the developer's actual Claude Code session files. */
  private readonly ccMapFn: () => Promise<Map<string, ClaudeCodeSessionRef>>;

  constructor(
    paths?: SessionsPaths,
    ccMapFn?: () => Promise<Map<string, ClaudeCodeSessionRef>>,
  ) {
    this.paths = paths;
    this.ccMapFn = ccMapFn ?? (() => claudeCodeMap());
  }

  /** Stash the latest rendered image (called from onRequest with the raw
   *  ProxyEvent before info.firstImagePng is dropped by toTrackEvent). */
  captureImage(info: NonNullable<ProxyEvent['info']>): void {
    if (!info.firstImagePng) return;
    this.latestPng = info.firstImagePng;
    this.latestPngWidth = info.firstImageWidth ?? 0;
    this.latestPngHeight = info.firstImageHeight ?? 0;
    const kb = (info.firstImagePng.length / 1024).toFixed(1);
    this.latestPngMeta =
      `${this.latestPngWidth}×${this.latestPngHeight} · ${kb} KB · ` +
      `${info.imageCount ?? 0} image${info.imageCount === 1 ? '' : 's'} total`;
  }

  /** Fold one event into the running totals + ring buffer.
   *
   *  Savings math is gated on a per-request `baseline_tokens` measurement
   *  from the parallel count_tokens probe AND an upstream usage block.
   *  When either is missing, we still count the request but skip its
   *  savings contribution — no estimation. */
  update(ev: ProxyEvent): void {
    // Stash the image bytes before they get GC'd by the request finishing.
    if (ev.info) this.captureImage(ev.info);

    const u = ev.usage;
    const info = ev.info;
    const compressed = info?.compressed === true;

    const inp = u?.input_tokens ?? 0;
    const out = u?.output_tokens ?? 0;
    const cc = u?.cache_creation_input_tokens ?? 0;
    const cr = u?.cache_read_input_tokens ?? 0;
    const haveUsage = u !== undefined && (inp > 0 || out > 0 || cc > 0 || cr > 0);
    const baseline = info?.baselineTokens;
    const haveBaseline = typeof baseline === 'number' && baseline > 0;

    // Weighted INPUT cost we actually paid this turn.
    const actualInputEff = haveUsage ? computeActualInputEff(inp, cc, cr) : 0;

    // Cache-aware baseline: decompose the unproxied counterfactual into
    // (cacheable_prefix, cold_tail) using the second count_tokens probe,
    // then split the prefix into (cc_u, cr_u) using the SAME absolute
    // cc bucket the proxied path paid this turn — because user-typed
    // content (the new tail that becomes cc) is NOT compressed, so its
    // absolute token count is approximately the same on both paths.
    // See src/core/baseline.ts for the full derivation and the May-2026
    // regression that motivated the rewrite.
    const baselineInputEff =
      haveBaseline && haveUsage
        ? computeBaselineInputEff(
            baseline,
            info?.baselineCacheableTokens ?? 0,
            cc,
            cr,
          )
        : 0;

    // Output tokens are identical with/without compression — the proxy never
    // touches the response body. They show up on BOTH sides of the savings
    // ratio at their actual rate (OUTPUT_TOKEN_RATE × input rate) so the
    // denominator reflects the full bill the user actually pays. Without
    // this, an output-heavy turn would silently inflate the "saved %"
    // headline relative to what Anthropic's weekly limit meters as token
    // consumption (input + output × 5).
    const outputEquiv = haveUsage ? out * OUTPUT_TOKEN_RATE : 0;

    this.totals.requests += 1;
    if (compressed) this.totals.compressedRequests += 1;

    if (haveBaseline && haveUsage) {
      this.totals.baselineInputWeighted += baselineInputEff;
      this.totals.actualInputWeighted += actualInputEff;
      this.totals.outputWeighted += outputEquiv;
    }

    const row: RecentRow = {
      ts: Date.now() / 1000,
      method: ev.method,
      path: ev.path,
      status: ev.status,
      compressed,
      cc_added: compressed ? 1 : undefined,
      input_tokens: haveUsage ? inp : undefined,
      output_tokens: haveUsage ? out : undefined,
      cache_create: haveUsage ? cc : undefined,
      cache_read: haveUsage ? cr : undefined,
      actual_input: haveUsage ? round1(actualInputEff) : undefined,
      baseline_input: haveBaseline && haveUsage ? round1(baselineInputEff) : undefined,
      session_saved_so_far_delta:
        haveBaseline && haveUsage ? round1(baselineInputEff - actualInputEff) : undefined,
    };
    this.recent.push(row);
    if (this.recent.length > RECENT_CAP) this.recent.splice(0, this.recent.length - RECENT_CAP);
  }


  /** On startup, fold the last N entries from the JSONL events file back
   *  into the ring buffer so a process restart doesn't show an empty table.
   *  Cumulative totals are *not* restored (the file may have rotated, and
   *  double-counting is worse than starting fresh). */
  async replay(filePath: string): Promise<void> {
    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
    } catch {
      return; // no file yet, nothing to replay
    }
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const tail: TrackEvent[] = [];
    for await (const line of rl) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as TrackEvent;
        tail.push(ev);
        if (tail.length > RECENT_CAP) tail.shift();
      } catch {
        /* skip malformed line */
      }
    }
    for (const t of tail) {
      const inp = t.input_tokens ?? 0;
      const out = t.output_tokens ?? 0;
      const cc = t.cache_create_tokens ?? 0;
      const cr = t.cache_read_tokens ?? 0;
      const haveUsage = inp > 0 || out > 0 || cc > 0 || cr > 0;
      const baseline = (t as { baseline_tokens?: number }).baseline_tokens;
      const cacheable = (t as { baseline_cacheable_tokens?: number })
        .baseline_cacheable_tokens ?? 0;
      const haveBaseline = typeof baseline === 'number' && baseline > 0;
      const actualInputEff = haveUsage ? computeActualInputEff(inp, cc, cr) : 0;
      const baselineInputEff =
        haveBaseline && haveUsage
          ? computeBaselineInputEff(baseline as number, cacheable, cc, cr)
          : 0;
      // Output tokens land in the row for the table; totals are not
      // restored on replay (see header comment on cumulative totals).
      const row: RecentRow = {
        ts: Date.parse(t.ts) / 1000,
        method: t.method,
        path: t.path,
        status: t.status,
        compressed: t.compressed === true,
        cc_added: t.compressed === true ? 1 : undefined,
        input_tokens: t.input_tokens,
        output_tokens: t.output_tokens,
        cache_create: t.cache_create_tokens,
        cache_read: t.cache_read_tokens,
        actual_input: haveUsage ? round1(actualInputEff) : undefined,
        baseline_input:
          haveBaseline && haveUsage ? round1(baselineInputEff) : undefined,
      };
      this.recent.push(row);
    }
  }

  // ---- HTTP handlers ------------------------------------------------------

  serveStats(): Response {
    // Two headline numbers, derived from the same per-event accumulators:
    //
    //   saved_pct_input_only = Σ saved / Σ baseline_input_eff × 100
    //     What the proxy actually saved on the slice it can move (input).
    //     Numerator = input tokens we didn't pay for (cache-aware).
    //     Denominator = input tokens we WOULD have paid (cache-aware).
    //     Output is excluded because the proxy doesn't touch it.
    //
    //   saved_pct_of_total_bill = Σ saved / Σ (baseline_input + output × 5) × 100
    //     What share of the TOTAL bill the proxy saved. Honest counter to the
    //     input-only number: on output-heavy sessions (long thinking blocks,
    //     big edits) the percentage shrinks because output dominates.
    //
    //   token_equivalent_total = Σ (actual_input + output × 5)
    //     What Anthropic's weekly limit actually meters — input × 1.0 +
    //     output × 5.0 (the same ratio as the per-MTok price card). This is
    //     the number that moves your "%% used this week" indicator.
    const baseline = this.totals.baselineInputWeighted;
    const actual = this.totals.actualInputWeighted;
    const output = this.totals.outputWeighted; // already × OUTPUT_TOKEN_RATE
    const saved = baseline - actual;
    const pctInput = baseline > 0 ? (saved / baseline) * 100 : 0;
    const baselineTotal = baseline + output;
    const actualTotal = actual + output;
    const pctTotal = baselineTotal > 0 ? (saved / baselineTotal) * 100 : 0;
    const uptimeSec = Date.now() / 1000 - this.totals.startedAt;
    const payload = {
      requests: this.totals.requests,
      compressed_requests: this.totals.compressedRequests,
      baseline_input_weighted: Math.round(baseline),
      actual_input_weighted: Math.round(actual),
      saved_input_tokens: Math.round(saved),
      // saved_pct kept for back-compat with existing dashboard HTML; it is
      // the input-only number. New code should read saved_pct_input_only.
      saved_pct: round1(pctInput),
      saved_pct_input_only: round1(pctInput),
      saved_pct_of_total_bill: round1(pctTotal),
      saved_usd: round4((saved * ASSUMED_INPUT_USD_PER_MTOK) / 1e6),
      output_weighted: Math.round(output),
      baseline_token_equivalent: Math.round(baselineTotal),
      actual_token_equivalent: Math.round(actualTotal),
      pricing_assumptions: {
        input_per_mtok: ASSUMED_INPUT_USD_PER_MTOK,
        output_multiplier: OUTPUT_TOKEN_RATE,
        cache_write_5m_multiplier: 1.25,
        cache_write_1h_multiplier: 2.0,
        cache_read_multiplier: 0.1,
        source: 'docs.anthropic.com/en/docs/about-claude/pricing (verified 2026-05-19)',
      },
      uptime_sec: uptimeSec,
      compression_enabled: this.compressionEnabled,
    };
    return new Response(JSON.stringify(payload, null, 2), {
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    });
  }

  serveRecent(): Response {
    const payload = {
      recent: this.recent,
      has_preview: this.latestPng !== null,
      preview_meta: this.latestPngMeta,
    };
    return new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    });
  }

  servePng(): Response {
    // Cropping is done client-side via CSS (object-position + overflow:hidden).
    // Python decoded the PNG to crop server-side; we skip that to avoid
    // pulling a PNG decoder back in — the CSS approach renders identically.
    if (!this.latestPng) {
      return new Response('no image yet', { status: 404 });
    }
    return new Response(this.latestPng as unknown as BodyInit, {
      headers: { 'content-type': 'image/png', 'cache-control': 'no-cache' },
    });
  }

  serveHtml(port: number): Response {
    return new Response(DASHBOARD_HTML.replace(/__PORT__/g, String(port)), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  // ---- session / cleanup endpoints --------------------------------------
  //
  // Every endpoint below recomputes from disk on demand. The dashboard polls
  // these on a 5s cadence, which is fine for a single-user dev tool — even at
  // ~3k events / 1.5 MB the round-trip is <100ms on a warm SSD.

  /** GET /api/sessions.json — grouped sessions enriched with the Claude Code
   *  cross-reference. The body is paged via top-level `sessions` array; the
   *  client renders the table row-by-row. */
  async serveSessionsJson(opts: ListOptions = {}): Promise<Response> {
    if (!this.paths) return notConfigured('sessions');
    const [{ sessions }, ccMap] = await Promise.all([
      aggregateSessions(this.paths),
      this.ccMapFn(),
    ]);
    const rows = filterSessions(sessions, opts);
    const enriched = rows.map((s) => ({
      ...s,
      claudeCode: ccMap.get(s.id) ?? null,
    }));
    return jsonResponse({ sessions: enriched, count: enriched.length });
  }

  /** GET /api/sessions/${id}.json — events for one session + its Claude Code
   *  ref. Bodies are redacted by default (set ?include_bodies=1 to opt in). */
  async serveSessionJson(
    id: string,
    includeBodies: boolean,
  ): Promise<Response> {
    if (!this.paths) return notConfigured('session detail');
    const [events, ccMap] = await Promise.all([
      collectSessionEvents(this.paths, id),
      this.ccMapFn(),
    ]);
    if (events.length === 0) {
      return jsonResponse({ error: 'session not found', id }, 404);
    }
    return jsonResponse({
      id,
      claudeCode: ccMap.get(id) ?? null,
      includeBodies,
      events: events.map((e) => redactEvent(e, includeBodies)),
    });
  }

  /** GET /sessions/${id} — HTML detail page (uses /api/sessions/${id}.json). */
  serveSessionHtml(id: string, port: number): Response {
    const html = SESSION_DETAIL_HTML.replace(/__PORT__/g, String(port)).replace(
      /__SESSION_ID__/g,
      escapeHtml(id),
    );
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  /** GET /api/disk.json — current on-disk usage. */
  serveDiskJson(): Response {
    if (!this.paths) return notConfigured('disk usage');
    const d = diskUsage(this.paths);
    return jsonResponse({ ...d, paths: this.paths });
  }

  /** GET /api/stats.json — full-history aggregate. Migrated from the
   *  former `pixelpipe stats` CLI. */
  async serveApiStats(): Promise<Response> {
    if (!this.paths) return notConfigured('stats');
    const result = await aggregateEventsFile(this.paths.eventsFile);
    if (!result) {
      return jsonResponse({
        error: 'no events file yet',
        path: this.paths.eventsFile,
      }, 404);
    }
    return jsonResponse({
      parsed: result.parsed,
      dropped: result.dropped,
      summary: summaryToJson(result.summary),
    });
  }

  /** POST /api/sessions/prune — destructive but confirmed client-side. The
   *  client UI shows a `confirm()` dialog before calling this with
   *  `force: true`. We still default force=false at the wire level. */
  async handlePrune(body: PruneOptions): Promise<Response> {
    if (!this.paths) return notConfigured('prune');
    const report = await prune(this.paths, {
      force: body.force === true,
      olderThanDays: body.olderThanDays,
      keepLast: body.keepLast,
      sessionId: body.sessionId,
      sessionIds: Array.isArray(body.sessionIds) ? body.sessionIds : undefined,
    });
    return jsonResponse(report);
  }

  /** POST /api/compression — flip the runtime kill switch.
   *  Body: { enabled: boolean }. Returns the new state. In-memory only;
   *  restart resets to true. */
  handleCompressionToggle(body: { enabled?: unknown }): Response {
    const on = body.enabled === true;
    this.compressionEnabled = on;
    return jsonResponse({ compression_enabled: on });
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    },
  });
}

function notConfigured(what: string): Response {
  // The dashboard was constructed without SessionsPaths (e.g. a legacy host
  // that doesn't track to disk). Return 503 so the client can surface a
  // helpful error rather than failing silently.
  return jsonResponse(
    { error: `${what} unavailable: dashboard not configured with event paths` },
    503,
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Server-side HTML escape for values we interpolate into the session-detail
 *  template. Kept tiny on purpose: we only emit text into attributes / text
 *  nodes, no rich markup. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

/** Result of route-matching a dashboard URL. The legacy `kind` values
 *  (html/stats/recent/png) stay; new routes return a dedicated kind plus an
 *  optional sessionId for the dynamic /sessions/${id} + /api/sessions/${id}
 *  variants. */
export type DashboardRoute =
  | { kind: 'html' }
  | { kind: 'stats' } // /proxy-stats — legacy live counter
  | { kind: 'recent' } // /proxy-recent — legacy ring buffer
  | { kind: 'png' } // /proxy-latest-png
  | { kind: 'api-sessions' } // /api/sessions.json
  | { kind: 'api-session'; sessionId: string } // /api/sessions/${id}.json
  | { kind: 'api-disk' } // /api/disk.json
  | { kind: 'api-stats' } // /api/stats.json
  | { kind: 'api-prune' } // /api/sessions/prune (POST)
  | { kind: 'api-compression' } // /api/compression (POST {enabled}) — runtime kill switch
  | { kind: 'session-html'; sessionId: string }; // /sessions/${id}

/** Match dashboard paths (handle query strings on /proxy-latest-png). */
export function dashboardPath(pathname: string): DashboardRoute | null {
  if (pathname === '/' || pathname === '/dashboard') return { kind: 'html' };
  if (pathname === '/proxy-stats') return { kind: 'stats' };
  if (pathname === '/proxy-recent') return { kind: 'recent' };
  if (pathname === '/proxy-latest-png') return { kind: 'png' };
  if (pathname === '/api/sessions.json') return { kind: 'api-sessions' };
  if (pathname === '/api/disk.json') return { kind: 'api-disk' };
  if (pathname === '/api/stats.json') return { kind: 'api-stats' };
  if (pathname === '/api/sessions/prune') return { kind: 'api-prune' };
  if (pathname === '/api/compression') return { kind: 'api-compression' };
  // /api/sessions/${id}.json — id is [a-f0-9]{1,16} (sha8 prefix) plus
  // '<unknown>' literal. Reject anything else to keep paths sanitized.
  const apiSess = /^\/api\/sessions\/([A-Za-z0-9<>_-]{1,32})\.json$/.exec(pathname);
  if (apiSess) return { kind: 'api-session', sessionId: apiSess[1]! };
  const sessHtml = /^\/sessions\/([A-Za-z0-9<>_-]{1,32})$/.exec(pathname);
  if (sessHtml) return { kind: 'session-html', sessionId: sessHtml[1]! };
  return null;
}

// ---- inline HTML template -------------------------------------------------

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>pixelpipe — live dashboard</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #0d1117; color: #c9d1d9;
         font: 14px/1.45 -apple-system,BlinkMacSystemFont,"SF Mono",Menlo,monospace; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.01em; }
  .sub { color: #6e7681; font-size: 12px; margin-bottom: 22px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 22px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px;
          padding: 14px 16px; }
  .card .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
                 color: #8b949e; margin-bottom: 6px; }
  .card .value { font-size: 24px; font-weight: 600; color: #e6edf3; font-variant-numeric: tabular-nums; }
  .card .small { font-size: 11px; color: #6e7681; margin-top: 4px; }
  .pos { color: #3fb950 !important; }
  /* Collapsible "show calculation" block — exposes the exact math the
     headline number came from. Native <details>, no JS needed. */
  .math { margin-top: 10px; font-size: 11px; }
  .math summary { color: #58a6ff; cursor: pointer; user-select: none;
                  list-style: none; outline: none; }
  .math summary::-webkit-details-marker { display: none; }
  .math summary::before { content: "▸ "; color: #6e7681; font-size: 9px; }
  .math[open] summary::before { content: "▾ "; }
  .math summary:hover { color: #79c0ff; }
  .math .formula { background: #0d1117; border: 1px solid #21262d;
                   border-radius: 6px; padding: 8px 10px; margin-top: 6px;
                   font: 11px/1.5 "SF Mono",Menlo,monospace; color: #c9d1d9;
                   white-space: pre-wrap; word-break: break-word; }
  .math .formula .k { color: #8b949e; }       /* label */
  .math .formula .v { color: #e6edf3; }       /* value */
  .math .formula .op { color: #f0883e; }      /* operator / "=" */
  .math .formula .src { color: #6e7681; font-size: 10px; display: block;
                        margin-top: 6px; border-top: 1px solid #21262d;
                        padding-top: 6px; }
  .panel { background: #161b22; border: 1px solid #30363d; border-radius: 10px;
           padding: 14px 16px; margin-bottom: 14px; }
  .panel h2 { font-size: 13px; font-weight: 600; color: #8b949e; margin: 0 0 10px;
              text-transform: uppercase; letter-spacing: 0.08em; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; color: #6e7681; font-weight: 500; padding: 6px 8px;
       border-bottom: 1px solid #30363d; font-variant-numeric: tabular-nums; }
  th.num { text-align: right; }
  td { padding: 6px 8px; border-bottom: 1px solid #21262d; font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom: none; }
  td.num { text-align: right; }
  td.good { color: #3fb950; }
  td.warn { color: #d29922; }
  td.bad  { color: #f85149; }
  /* Crop the preview to its top-left at native resolution. The full image is
     1466x1568, which would be unreadably small if scaled down to the panel. */
  .preview-crop { width: 100%; height: 480px; overflow: hidden;
                  background: #fff; border: 1px solid #30363d; border-radius: 4px; padding: 4px; }
  .preview-crop img { display: block; image-rendering: pixelated;
                      width: auto; height: auto; max-width: none; }
  .row { display: grid; grid-template-columns: 2fr 1fr; gap: 14px; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr 1fr; } .row { grid-template-columns: 1fr; } }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
         background: #3fb950; margin-right: 6px; vertical-align: middle;
         animation: pulse 2s infinite; }
  @keyframes pulse { 50% { opacity: 0.4; } }
</style>
</head>
<body>
<h1><span class="dot"></span>pixelpipe</h1>
<div class="sub" id="sub">connecting...</div>

<!--
  Passthrough banner. Hidden by default; shown in red when the dashboard
  state has compressionEnabled=false. Runtime kill switch for when
  upstream is unhealthy or the operator wants to bypass compression.
-->
<div id="passthrough_banner" style="display:none;margin-bottom:16px;padding:10px 14px;background:#3c1618;border:1px solid #f85149;border-radius:6px;color:#f85149">
  <strong>PASSTHROUGH MODE</strong> — compression disabled. Every /v1/messages forwards unchanged to upstream. No image encoding, no break-even gate, no transforms.
</div>

<!--
  Compression toggle (always visible). Sits above the savings cards so
  the operator can flip it without scrolling. Persists in memory only —
  restart resets to enabled.
-->
<div style="margin-bottom:14px;display:flex;align-items:center;gap:10px">
  <button id="toggle_btn" type="button"
    style="background:#21262d;color:#c9d1d9;border:1px solid #30363d;padding:6px 14px;cursor:pointer;border-radius:6px;font:inherit">
    loading...
  </button>
  <span class="small" id="toggle_hint" style="color:#6e7681">runtime kill switch · not persisted across restart</span>
</div>

<div class="grid">
  <div class="card"><div class="label">requests</div>
    <div class="value" id="m_req">0</div>
    <div class="small" id="m_req_sub">— compressed</div>
  </div>
  <div class="card"><div class="label">input tokens saved</div>
    <div class="value pos" id="m_saved">0</div>
    <div class="small" id="m_saved_sub">cache-aware, input-side only</div>
    <details class="math"><summary>show calculation</summary>
      <div class="formula" id="m_saved_math"></div>
    </details>
  </div>
  <div class="card"><div class="label">$ saved</div>
    <div class="value pos" id="m_usd">$0.00</div>
    <div class="small" id="m_usd_sub">at $5/M input tokens (Opus 4.7)</div>
    <details class="math"><summary>show calculation</summary>
      <div class="formula" id="m_usd_math"></div>
    </details>
  </div>
  <div class="card"><div class="label">share of total bill saved</div>
    <div class="value pos" id="m_pct">0%</div>
    <div class="small" id="m_pct_sub">total bill (input + output×5) · input-only: <span id="m_pct_total">0%</span></div>
    <details class="math"><summary>show calculation</summary>
      <div class="formula" id="m_pct_math"></div>
    </details>
  </div>
</div>

<div class="row">
  <div class="panel">
    <h2>recent requests</h2>
    <table>
      <thead>
        <tr>
          <th>#</th><th>status</th><th>path</th>
          <th class="num">cc</th><th class="num">baseline</th>
          <th class="num">actual</th><th class="num">saved</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <div class="panel">
    <h2>latest rendered image</h2>
    <div id="preview_wrap"><div class="sub">(none yet)</div></div>
    <div class="small" id="preview_meta" style="margin-top:8px;color:#6e7681"></div>
  </div>
</div>

<div class="panel" style="margin-bottom:22px">
  <h2>sessions <span class="small" id="sess_count" style="color:#6e7681"></span></h2>
  <div class="small" id="sess_status" style="margin-bottom:12px;color:#6e7681">loading...</div>
  <!--
    Bulk-action bar. Industry-standard pattern (Gmail / GitHub / Linear /
    Vercel): hidden when selection is empty; slides in showing the count
    and the destructive action when ≥1 row is checked. Replaces the
    normal per-row controls so the bulk action is unmissable.
  -->
  <div id="sess_action_bar" style="display:none;margin-bottom:10px;padding:8px 12px;background:#1f2a37;border:1px solid #30363d;border-radius:6px;align-items:center;gap:12px">
    <span class="small" id="sess_action_count" style="color:#c9d1d9">0 selected</span>
    <button id="sess_action_delete" type="button" style="background:#21262d;color:#f85149;border:1px solid #30363d;padding:4px 12px;cursor:pointer">Delete selected</button>
    <button id="sess_action_clear" type="button" style="background:transparent;color:#6e7681;border:1px solid #30363d;padding:4px 12px;cursor:pointer">Clear (Esc)</button>
    <span class="small" style="color:#6e7681;margin-left:auto">Shift-click to range-select</span>
  </div>
  <table>
    <thead>
      <tr>
        <th style="width:24px"><input type="checkbox" id="sess_select_all" title="Select all visible" /></th>
        <th>session</th>
        <th>project</th>
        <th>claude code</th>
        <th>first seen</th>
        <th>last seen</th>
        <th class="num">reqs</th>
        <th class="num">tokens saved</th>
        <th class="num">cache read</th>
        <th class="num">disk</th>
        <th></th>
      </tr>
    </thead>
    <tbody id="sess_rows"></tbody>
  </table>
</div>

<div class="row">
  <div class="panel">
    <h2>stats <span class="small" style="color:#6e7681">(full history)</span></h2>
    <div class="small" id="stats_status" style="margin-bottom:12px;color:#6e7681">loading...</div>
    <table>
      <tbody id="stats_rows"></tbody>
    </table>
  </div>
  <div class="panel">
    <h2>cleanup</h2>
    <div class="small" id="disk_status" style="margin-bottom:12px;color:#6e7681">loading...</div>
    <table>
      <tbody id="disk_rows"></tbody>
    </table>
    <div style="margin-top:14px;display:flex;gap:8px;align-items:center">
      <label class="small" for="prune_days" style="color:#6e7681">prune older than</label>
      <select id="prune_days" style="background:#0d1117;color:#c9d1d9;border:1px solid #30363d;padding:4px">
        <option value="7">7 days</option>
        <option value="30" selected>30 days</option>
        <option value="90">90 days</option>
      </select>
      <button id="prune_btn" type="button" style="background:#21262d;color:#c9d1d9;border:1px solid #30363d;padding:6px 12px;cursor:pointer">prune</button>
    </div>
    <div class="small" id="prune_result" style="margin-top:10px;color:#6e7681"></div>
  </div>
</div>

<script>
async function tick() {
  try {
    const s = await fetch('/proxy-stats').then(r => r.json());
    const r = await fetch('/proxy-recent').then(r => r.json());
    document.getElementById('sub').textContent =
      \`port :__PORT__   ·   uptime \${formatDuration(s.uptime_sec)}   ·   live\`;

    // Compression kill-switch UI: banner + button text track server state.
    const compOn = s.compression_enabled !== false;
    document.getElementById('passthrough_banner').style.display = compOn ? 'none' : 'block';
    const btn = document.getElementById('toggle_btn');
    btn.textContent = compOn ? 'Disable compression (passthrough)' : 'Enable compression';
    btn.style.color = compOn ? '#c9d1d9' : '#f85149';
    btn.style.borderColor = compOn ? '#30363d' : '#f85149';

    document.getElementById('m_req').textContent = s.requests;
    document.getElementById('m_req_sub').textContent = \`\${s.compressed_requests} compressed\`;
    // Effective-tokens card: input-side tokens we didn't have to pay for
    // (cache-aware). This is the part of the bill the proxy actually moves —
    // showing the BIG saved number on the headline without hiding that output
    // also lands on the weekly limit. The sub-line gives the full picture:
    // counterfactual baseline (input only) and the output cost that's
    // identical with or without compression (proxy doesn't touch responses).
    document.getElementById('m_saved').textContent = numFmt(s.saved_input_tokens);
    document.getElementById('m_saved_sub').textContent =
      \`input-only · baseline \${numFmt(s.baseline_input_weighted)} · output \${numFmt(s.output_weighted)} (unchanged by proxy)\`;
    // $ saved card: input-side savings × input rate. Output cancels (proxy
    // doesn't touch the response body) so dollar savings are input-only.
    const inRate = s.pricing_assumptions && s.pricing_assumptions.input_per_mtok;
    document.getElementById('m_usd').textContent = \`$\${(s.saved_usd || 0).toFixed(4)}\`;
    if (typeof inRate === 'number') {
      document.getElementById('m_usd_sub').textContent =
        \`saved \${numFmt(s.saved_input_tokens)} input tokens at $\${inRate}/M\`;
    }
    // Share-of-bill card: lead with the HONEST total-bill number so a heavy
    // output session doesn't look like a 73% win when it isn't.
    // saved_pct_of_total_bill = saved_input / (baseline_input + output×5) × 100
    // The sub-line keeps the input-only number visible for cache-quality
    // diagnostics (the input-only % is what tells you whether compression is
    // doing its job, independent of how output-heavy the session is).
    document.getElementById('m_pct').textContent = \`\${(s.saved_pct_of_total_bill || 0).toFixed(1)}%\`;
    document.getElementById('m_pct_total').textContent =
      \`\${(s.saved_pct_input_only || 0).toFixed(1)}%\`;

    // Populate "show calculation" blocks under each savings card.
    renderSavingsMath(s);
    const tbody = document.getElementById('rows');
    tbody.innerHTML = '';
    let i = 0;
    for (const e of r.recent.slice().reverse()) {
      const tr = document.createElement('tr');
      const statusCls = e.status >= 500 ? 'bad' : e.status >= 400 ? 'warn' : 'good';
      const saved = (e.session_saved_so_far_delta || 0);
      tr.innerHTML =
        \`<td>\${++i}</td>\` +
        \`<td class="num \${statusCls}">\${e.status}</td>\` +
        \`<td>\${escapeHtml((e.path || '').slice(0,40))}</td>\` +
        \`<td class="num">\${e.cc_added ?? '—'}</td>\` +
        \`<td class="num">\${e.baseline_input != null ? numFmt(e.baseline_input) : '—'}</td>\` +
        \`<td class="num">\${e.actual_input != null ? numFmt(e.actual_input) : '—'}</td>\` +
        \`<td class="num pos">\${saved > 0 ? '+' + numFmt(saved) : '—'}</td>\`;
      tbody.appendChild(tr);
    }
    if (r.has_preview) {
      const wrap = document.getElementById('preview_wrap');
      wrap.innerHTML =
        '<div class="preview-crop">' +
        '<img src="/proxy-latest-png?t=' + Date.now() + '">' +
        '</div>';
      document.getElementById('preview_meta').textContent =
        (r.preview_meta || '') + ' — showing top-left at native resolution';
    }
  } catch (e) {
    document.getElementById('sub').textContent = 'proxy unreachable';
  }
}
function numFmt(n) {
  n = Math.round(Number(n) || 0);
  return n.toLocaleString();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
function formatDuration(s) {
  s = Math.floor(s);
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return (h>0?h+'h ':'') + (m>0?m+'m ':'') + sec + 's';
}
function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
  if (n < 1024*1024*1024) return (n/(1024*1024)).toFixed(1) + ' MB';
  return (n/(1024*1024*1024)).toFixed(2) + ' GB';
}
function fmtTs(iso) {
  if (!iso) return '-';
  return String(iso).replace('T', ' ').slice(0, 19);
}
function shortPath(p) {
  if (!p) return '-';
  const parts = String(p).split('/');
  return parts[parts.length - 1] || p;
}

// ---- savings math panels -------------------------------------------------
//
// Renders the "show calculation" blocks beneath each savings card. The
// baseline is CACHE-AWARE — per event we measure:
//   baseline_input_eff = cacheable × weight + cold_tail × 1.0
//     cacheable  = count_tokens(originalBody truncated at last cache_control)
//     cold_tail  = count_tokens(originalBody) − cacheable
//     weight     = matches the actual response's cache class
//                  (cr>0 → 0.10, cc>0 → 1.25, neither → 1.0)
//   actual_input_eff = input + cache_create×1.25 + cache_read×0.10
// Both probes are free. Output is excluded — identical with or without
// compression. No α, no fit, no estimation.
function renderSavingsMath(s) {
  const pa = s.pricing_assumptions || {};

  // ---- tokens-saved card --------------------------------------------------
  document.getElementById('m_saved_math').innerHTML =
    '<div><span class="k">formula:</span> <span class="v">saved = baseline − actual</span></div>'
    + '<div><span class="k">weights:</span> <span class="v">input ×1.0, cache_create ×1.25, cache_read ×0.10</span></div>'
    + '<div style="height:6px"></div>'
    + fmtRow('baseline', s.baseline_input_weighted, '(cache-aware: cacheable·weight + cold_tail)')
    + fmtRow('actual', s.actual_input_weighted, '(input + cc·1.25 + cr·0.10 from usage)')
    + fmtRow('saved', s.saved_input_tokens, '<span class="op">=</span> baseline − actual')
    + '<span class="src">output excluded — identical with/without compression</span>';

  // ---- $ saved card -------------------------------------------------------
  const inRate = pa.input_per_mtok;
  document.getElementById('m_usd_math').innerHTML =
    '<div><span class="k">formula:</span> <span class="v">$ = saved × $'
      + inRate + '/Mtok</span></div>'
    + '<div style="height:6px"></div>'
    + fmtRow('saved_tokens', s.saved_input_tokens, '(cache-aware, input-side)')
    + fmtRow('input_rate', \`$\${inRate}/Mtok\`, '(Opus 4.7 base input)')
    + fmtRow('saved_usd',
             \`$\${(s.saved_usd || 0).toFixed(4)}\`,
             '<span class="op">=</span> saved_tokens × input_rate / 1e6')
    + '<span class="src">source: ' + escapeHtml(pa.source || 'docs.anthropic.com pricing') + '</span>';

  // ---- reduction (%) card -------------------------------------------------
  document.getElementById('m_pct_math').innerHTML =
    '<div><span class="k">formula:</span> <span class="v">'
      + 'saved_pct = (baseline − actual) / baseline × 100</span></div>'
    + '<div><span class="k">per event:</span> <span class="v">'
      + 'baseline = cacheable·weight + cold_tail, weight matches actual cache class</span></div>'
    + '<div style="height:6px"></div>'
    + fmtRow('baseline', s.baseline_input_weighted, '(cache-aware counterfactual)')
    + fmtRow('actual', s.actual_input_weighted, '(weighted upstream usage)')
    + fmtRow('saved', s.saved_input_tokens, '<span class="op">=</span> baseline − actual')
    + fmtRow('saved_pct', (s.saved_pct || 0).toFixed(1) + '%',
             '<span class="op">=</span> saved / baseline × 100')
    + '<span class="src">measured · no estimation</span>';
}

function fmtRow(key, val, note) {
  const v = (typeof val === 'number') ? numFmt(val) : String(val ?? '—');
  return '<div><span class="k">' + key + ':</span> '
    + '<span class="v">' + escapeHtml(v) + '</span> '
    + '<span class="k">' + (note || '') + '</span></div>';
}

// ---- session table: diff-render row by row -------------------------------
//
// Smooth updates: keep a Map<id, <tr>> across ticks. On each refresh we walk
// the new sessions list and update text in-place when an id already has a
// row; rows for vanished ids are removed; new ids get appended in last_seen
// order. This avoids the visible flash that an innerHTML wipe would cause.
const sessRowEls = new Map();

// ---- session selection state machine -------------------------------------
//
// Industry-standard multi-select-and-delete pattern (Gmail / GitHub /
// Linear): per-row checkbox + header 3-state checkbox + shift-click range
// + contextual action bar + Esc-clears. Selection survives diff-renders by
// being keyed on session id, not DOM nodes — when renderSessions rewrites a
// row's innerHTML we re-apply checked state from selectedSessionIds.
const selectedSessionIds = new Set();
// IDs in the order they appear in the most recent render. Needed for
// shift-click range selection (pick rows between two ids).
let sessionIdOrder = [];
// The last id the operator clicked or checked. Anchor for shift-click.
let lastClickedSessionId = null;

function updateSessActionBar() {
  const bar = document.getElementById('sess_action_bar');
  const countEl = document.getElementById('sess_action_count');
  const n = selectedSessionIds.size;
  if (n === 0) {
    bar.style.display = 'none';
  } else {
    bar.style.display = 'flex';
    countEl.textContent = n + ' selected';
  }
  // Header checkbox tri-state: empty / indeterminate / all.
  const head = document.getElementById('sess_select_all');
  if (head) {
    const total = sessionIdOrder.length;
    if (n === 0) { head.checked = false; head.indeterminate = false; }
    else if (n >= total) { head.checked = true; head.indeterminate = false; }
    else { head.checked = false; head.indeterminate = true; }
  }
}

function setSessionSelected(id, on) {
  if (on) selectedSessionIds.add(id);
  else selectedSessionIds.delete(id);
  const box = document.querySelector('input.sess_check[data-id="' + cssEscape(id) + '"]');
  if (box) box.checked = on;
  updateSessActionBar();
}

function cssEscape(s) {
  // Sufficient for our use case (session ids are hex-ish + dashes).
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
}

function reapplySessionSelectionState() {
  // After a diff-render, re-attach checked state from the source-of-truth
  // Set. Also drop selections for sessions that vanished from the table.
  const seen = new Set(sessionIdOrder);
  for (const id of [...selectedSessionIds]) {
    if (!seen.has(id)) selectedSessionIds.delete(id);
  }
  document.querySelectorAll('input.sess_check').forEach((box) => {
    box.checked = selectedSessionIds.has(box.dataset.id);
  });
  updateSessActionBar();
}

function sessRowHtml(s) {
  const cc = s.claudeCode;
  const ccLabel = cc
    ? '<span title="' + escapeHtml(cc.projectPath) + '/' + escapeHtml(cc.sessionId) + '">'
      + escapeHtml(cc.sessionId.slice(0,8)) + '...</span>'
    : '<span style="color:#6e7681">-</span>';
  const disk = fmtBytes((s.jsonlBytes||0) + (s.sidecarBytes||0));
  const projShort = s.project ? escapeHtml(shortPath(s.project)) : '<span style="color:#6e7681">-</span>';
  // The checkbox CHECKED state is restored from selectedSessionIds in
  // renderSessions, NOT baked into this HTML. That way diff-renders
  // don't clobber the operator's in-progress selection.
  return ''
    + '<td><input type="checkbox" class="sess_check" data-id="' + escapeHtml(s.id) + '" /></td>'
    + '<td><a href="/sessions/' + encodeURIComponent(s.id) + '" style="color:#58a6ff">'
    +   escapeHtml(s.id) + '</a></td>'
    + '<td>' + projShort + '</td>'
    + '<td class="small">' + ccLabel + '</td>'
    + '<td class="small">' + escapeHtml(fmtTs(s.firstSeen)) + '</td>'
    + '<td class="small">' + escapeHtml(fmtTs(s.lastSeen)) + '</td>'
    + '<td class="num">' + numFmt(s.requestCount) + '</td>'
    + '<td class="num">' + numFmt(s.tokensSavedEst) + '</td>'
    + '<td class="num">' + numFmt(s.cacheReadTokens) + '</td>'
    + '<td class="num">' + escapeHtml(disk) + '</td>'
    + '<td><button type="button" data-del="' + escapeHtml(s.id) + '" '
    +    'style="background:#21262d;color:#f85149;border:1px solid #30363d;padding:2px 8px;cursor:pointer;font-size:11px">del</button></td>';
}

function renderSessions(payload) {
  const rows = (payload && payload.sessions) || [];
  document.getElementById('sess_count').textContent = '(' + rows.length + ')';
  document.getElementById('sess_status').textContent =
    rows.length === 0 ? 'no sessions yet - send a request through the proxy' : '';
  const tbody = document.getElementById('sess_rows');
  const seen = new Set();
  let prev = null;
  for (const s of rows) {
    seen.add(s.id);
    let tr = sessRowEls.get(s.id);
    const html = sessRowHtml(s);
    if (!tr) {
      tr = document.createElement('tr');
      tr.innerHTML = html;
      sessRowEls.set(s.id, tr);
      if (prev && prev.nextSibling) tbody.insertBefore(tr, prev.nextSibling);
      else tbody.appendChild(tr);
    } else if (tr.dataset.last !== html) {
      // Only rewrite when content changed - avoids selection / focus thrash.
      tr.innerHTML = html;
    }
    tr.dataset.last = html;
    prev = tr;
  }
  // Drop rows for sessions that vanished (most likely just pruned).
  for (const [id, tr] of [...sessRowEls.entries()]) {
    if (!seen.has(id)) {
      tr.remove();
      sessRowEls.delete(id);
    }
  }
  // Selection bookkeeping: capture display order for shift-click range, and
  // re-apply checked state on every render (innerHTML rewrites lose it).
  sessionIdOrder = rows.map((s) => s.id);
  reapplySessionSelectionState();
}

// ---- stats table ---------------------------------------------------------

function renderStats(payload) {
  const status = document.getElementById('stats_status');
  if (!payload || payload.error) {
    status.textContent = payload && payload.error ? payload.error : '(no data)';
    return;
  }
  status.textContent = numFmt(payload.parsed) + ' events parsed';
  const s = payload.summary;
  const totalIn = (s.inputTokensTotal||0) + (s.cacheCreateTokensTotal||0) + (s.cacheReadTokensTotal||0);
  const hitRateTok = totalIn > 0 ? ((s.cacheReadTokensTotal / totalIn) * 100).toFixed(1) + '%' : '-';
  const hitRateEv = s.eventsWithUsage > 0 ? ((s.cacheHitEvents / s.eventsWithUsage) * 100).toFixed(1) + '%' : '-';
  const charRatio = s.origCharsTotal > 0 ? (s.imageBytesTotal / s.origCharsTotal).toFixed(3) : '-';
  const rows = [
    ['requests',        numFmt(s.total)],
    ['  2xx / 4xx / 5xx', numFmt(s.ok2xx) + ' / ' + numFmt(s.err4xx) + ' / ' + numFmt(s.err5xx)],
    ['compressed',      numFmt(s.compressed)],
    ['passthrough',     numFmt(s.passthrough)],
    ['input tokens',    numFmt(s.inputTokensTotal)],
    ['cache create',    numFmt(s.cacheCreateTokensTotal)],
    ['cache read',      numFmt(s.cacheReadTokensTotal)],
    ['cache hit (tok)', hitRateTok],
    ['cache hit (ev)',  hitRateEv],
    ['orig chars',      numFmt(s.origCharsTotal)],
    ['image bytes',     numFmt(s.imageBytesTotal)],
    ['bytes/char',      charRatio],
    ['latency p50/p95', numFmt(s.durationP50) + ' / ' + numFmt(s.durationP95) + ' ms'],
    ['first-byte p50/p95', numFmt(s.firstByteP50) + ' / ' + numFmt(s.firstByteP95) + ' ms'],
  ];
  const tbody = document.getElementById('stats_rows');
  const next = rows.map(([k,v]) =>
    '<tr><td>' + escapeHtml(k) + '</td><td class="num">' + escapeHtml(String(v)) + '</td></tr>'
  ).join('');
  if (tbody.dataset.last !== next) {
    tbody.innerHTML = next;
    tbody.dataset.last = next;
  }
}

// ---- disk usage panel ----------------------------------------------------

function renderDisk(payload) {
  const status = document.getElementById('disk_status');
  if (!payload || payload.error) {
    status.textContent = payload && payload.error ? payload.error : '(no data)';
    return;
  }
  status.textContent = fmtBytes(payload.totalBytes) + ' on disk';
  const rows = [
    ['events.jsonl', fmtBytes(payload.eventsJsonlBytes), payload.paths.eventsFile],
    ['4xx-bodies/', fmtBytes(payload.sidecarsBytes) + ' (' + payload.sidecarCount + ' files)', payload.paths.sidecarDir],
  ];
  const tbody = document.getElementById('disk_rows');
  const next = rows.map(([k, v, p]) =>
    '<tr><td>' + escapeHtml(k) + '</td><td class="num">' + escapeHtml(v) + '</td><td class="small" style="color:#6e7681">' + escapeHtml(p) + '</td></tr>'
  ).join('');
  if (tbody.dataset.last !== next) {
    tbody.innerHTML = next;
    tbody.dataset.last = next;
  }
}

// ---- destructive actions: confirm + POST ---------------------------------

async function pruneOlderThan() {
  const days = parseInt(document.getElementById('prune_days').value, 10);
  // Dry-run first to compute the impact summary for the confirm prompt.
  const dryR = await fetch('/api/sessions/prune', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ olderThanDays: days, force: false }),
  }).then(r => r.json());
  if (!dryR.sessionsRemoved || dryR.sessionsRemoved.length === 0) {
    document.getElementById('prune_result').textContent = 'nothing older than ' + days + ' days';
    return;
  }
  const msg = 'Prune ' + dryR.sessionsRemoved.length + ' sessions ('
    + numFmt(dryR.eventsRemoved) + ' events, '
    + fmtBytes(dryR.jsonlBytesFreed + dryR.sidecarBytesFreed)
    + ') older than ' + days + ' days?\\n\\nThis cannot be undone.';
  if (!window.confirm(msg)) return;
  const realR = await fetch('/api/sessions/prune', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ olderThanDays: days, force: true }),
  }).then(r => r.json());
  document.getElementById('prune_result').textContent =
    'removed ' + realR.sessionsRemoved.length + ' sessions, '
    + numFmt(realR.eventsRemoved) + ' events, '
    + fmtBytes(realR.jsonlBytesFreed + realR.sidecarBytesFreed);
  tickSlow();
}

async function deleteSession(id) {
  const tr = sessRowEls.get(id);
  let detail = '';
  if (tr) {
    const cells = tr.querySelectorAll('td');
    detail = ' (' + (cells[5] ? cells[5].textContent : '?') + ' events, '
      + (cells[8] ? cells[8].textContent : '?') + ')';
  }
  if (!window.confirm('Delete session ' + id + detail + '?\\n\\nThis cannot be undone.')) return;
  const r = await fetch('/api/sessions/prune', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: id, force: true }),
  }).then(r => r.json());
  document.getElementById('prune_result').textContent =
    'removed session ' + id + ' - ' + numFmt(r.eventsRemoved) + ' events, '
    + fmtBytes(r.jsonlBytesFreed + r.sidecarBytesFreed);
  tickSlow();
}

document.getElementById('prune_btn').addEventListener('click', () => {
  pruneOlderThan().catch(e => {
    document.getElementById('prune_result').textContent = 'error: ' + e.message;
  });
});

// Toggle compression kill switch. Reads the current state from the
// button text (which tick() keeps in sync with the server), then POSTs
// the opposite. Server returns new state and the next tick() repaints.
document.getElementById('toggle_btn').addEventListener('click', async () => {
  const btn = document.getElementById('toggle_btn');
  const currentlyOn = btn.textContent.startsWith('Disable');
  const next = !currentlyOn;
  if (!next) {
    if (!window.confirm('Disable compression?\\n\\n/v1/messages will forward unchanged to upstream. Use this when upstream is unhealthy or to A/B test the proxy. Restart resets to enabled.')) return;
  }
  btn.disabled = true;
  try {
    await fetch('/api/compression', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
    // Force an immediate refresh so the banner/button update without
    // waiting for the next 1s tick.
    tick();
  } catch (e) {
    window.alert('failed to toggle: ' + e.message);
  } finally {
    btn.disabled = false;
  }
});
// One delegated listener handles every row's del button + per-row checkbox.
// Survives diff renders.
document.getElementById('sess_rows').addEventListener('click', (ev) => {
  const t = ev.target;
  if (!t) return;
  // Per-row delete button.
  if (t.dataset && t.dataset.del) { deleteSession(t.dataset.del); return; }
  // Per-row checkbox toggle. Shift-click does range select between this row
  // and the last-clicked anchor (Gmail / GitHub convention).
  if (t.classList && t.classList.contains('sess_check')) {
    const id = t.dataset.id;
    if (ev.shiftKey && lastClickedSessionId && lastClickedSessionId !== id) {
      const a = sessionIdOrder.indexOf(lastClickedSessionId);
      const b = sessionIdOrder.indexOf(id);
      if (a >= 0 && b >= 0) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        // Range select propagates the clicked checkbox's new state to all
        // rows in [lo, hi]. Matches macOS Finder / Gmail behavior.
        const on = t.checked;
        for (let i = lo; i <= hi; i++) setSessionSelected(sessionIdOrder[i], on);
      }
    } else {
      setSessionSelected(id, t.checked);
    }
    lastClickedSessionId = id;
  }
});

// Header checkbox: select-all / clear-all on visible rows. Tri-state is
// driven from updateSessActionBar(); the operator's click always either
// selects all (when 0 or some) or clears all (when all selected).
document.getElementById('sess_select_all').addEventListener('click', (ev) => {
  const target = ev.currentTarget;
  const turnOn = !!target.checked;
  for (const id of sessionIdOrder) {
    if (turnOn) selectedSessionIds.add(id);
    else selectedSessionIds.delete(id);
  }
  document.querySelectorAll('input.sess_check').forEach((box) => {
    box.checked = turnOn;
  });
  updateSessActionBar();
});

// Action bar: bulk delete + clear-selection.
document.getElementById('sess_action_delete').addEventListener('click', () => {
  bulkDeleteSelectedSessions().catch((e) => {
    document.getElementById('prune_result').textContent = 'error: ' + e.message;
  });
});
document.getElementById('sess_action_clear').addEventListener('click', () => {
  selectedSessionIds.clear();
  reapplySessionSelectionState();
});

// Esc clears the selection — fast escape hatch when the operator changed
// their mind. Only fires when no input/textarea has focus so it doesn't
// trample text input.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (selectedSessionIds.size === 0) return;
  selectedSessionIds.clear();
  reapplySessionSelectionState();
});

async function bulkDeleteSelectedSessions() {
  const ids = [...selectedSessionIds];
  if (ids.length === 0) return;
  // Confirm modal: count + a sample of session ids so the operator can
  // sanity-check what they're about to delete. Show first 3, "and N more".
  const sample = ids.slice(0, 3).map((id) => id.slice(0, 12)).join(', ');
  const more = ids.length > 3 ? ' and ' + (ids.length - 3) + ' more' : '';
  if (!window.confirm(
    'Delete ' + ids.length + ' session' + (ids.length === 1 ? '' : 's') + '?\\n\\n'
    + sample + more + '\\n\\nThis cannot be undone.'
  )) return;
  const r = await fetch('/api/sessions/prune', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionIds: ids, force: true }),
  }).then(r => r.json());
  document.getElementById('prune_result').textContent =
    'removed ' + numFmt(r.sessionsRemoved.length) + ' sessions, '
    + numFmt(r.eventsRemoved) + ' events, '
    + fmtBytes(r.jsonlBytesFreed + r.sidecarBytesFreed);
  selectedSessionIds.clear();
  tickSlow();
}

// ---- slow tick (5s) - sessions / stats / disk ----------------------------

async function tickSlow() {
  try {
    const [sess, stats, disk] = await Promise.all([
      fetch('/api/sessions.json').then(r => r.json()).catch(() => null),
      fetch('/api/stats.json').then(r => r.json()).catch(() => null),
      fetch('/api/disk.json').then(r => r.json()).catch(() => null),
    ]);
    if (sess) renderSessions(sess);
    if (stats) renderStats(stats);
    if (disk) renderDisk(disk);
  } catch (e) {
    // Slow tick errors are non-fatal - fast tick still updates 'sub'.
  }
}
tick(); setInterval(tick, 2000);
tickSlow(); setInterval(tickSlow, 5000);
</script>
</body></html>
`;

// ---- session detail HTML template ----------------------------------------
//
// Standalone page served at /sessions/${id}. Reuses the same dark theme as
// the main dashboard for visual continuity. The body content is one panel
// with the session header + an event table; data is fetched from
// /api/sessions/${id}.json on load. A checkbox toggles `?include_bodies=1`
// for privacy-sensitive 4xx body samples.

const SESSION_DETAIL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>pixelpipe - session __SESSION_ID__</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #0d1117; color: #c9d1d9;
         font: 14px/1.45 -apple-system,BlinkMacSystemFont,"SF Mono",Menlo,monospace; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.01em; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .sub { color: #6e7681; font-size: 12px; margin-bottom: 22px; }
  .panel { background: #161b22; border: 1px solid #30363d; border-radius: 10px;
           padding: 14px 16px; margin-bottom: 14px; }
  .meta { display: grid; grid-template-columns: 140px 1fr; gap: 4px 14px;
          font-size: 12px; }
  .meta .k { color: #6e7681; }
  .meta .v { color: #c9d1d9; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; color: #6e7681; font-weight: 500; padding: 6px 8px;
       border-bottom: 1px solid #30363d; }
  td { padding: 6px 8px; border-bottom: 1px solid #21262d; vertical-align: top;
       font-variant-numeric: tabular-nums; }
  td.num { text-align: right; }
  tr:last-child td { border-bottom: none; }
  .json-cell { color: #6e7681; max-width: 600px; overflow: hidden;
               text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
  .json-cell.open { white-space: pre-wrap; word-break: break-all; color: #c9d1d9; }
  .ctrls { display: flex; gap: 12px; align-items: center; margin: 14px 0; }
  .ctrls label { font-size: 12px; color: #6e7681; }
</style>
</head>
<body>
<h1><a href="/">pixelpipe</a> &rarr; session __SESSION_ID__</h1>
<div class="sub" id="header_sub">loading...</div>

<div class="panel">
  <div class="meta" id="meta"></div>
</div>

<div class="ctrls">
  <label><input type="checkbox" id="include_bodies"> include 4xx body samples (privacy: may contain raw user code)</label>
  <button type="button" id="del_btn" style="background:#21262d;color:#f85149;border:1px solid #30363d;padding:4px 12px;cursor:pointer;font-size:12px">delete this session</button>
</div>

<div class="panel">
  <table>
    <thead>
      <tr>
        <th>#</th><th>ts</th><th>status</th><th>path</th>
        <th class="num">orig chars</th><th class="num">img bytes</th>
        <th class="num">cache read</th><th>raw</th>
      </tr>
    </thead>
    <tbody id="ev_rows"></tbody>
  </table>
</div>

<script>
const SESSION_ID = '__SESSION_ID__';

function numFmt(n) {
  return (Math.round(Number(n) || 0)).toLocaleString();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
  return (n/(1024*1024)).toFixed(1) + ' MB';
}

async function load() {
  const includeBodies = document.getElementById('include_bodies').checked;
  const url = '/api/sessions/' + encodeURIComponent(SESSION_ID) + '.json'
    + (includeBodies ? '?include_bodies=1' : '');
  let payload;
  try {
    payload = await fetch(url).then(r => r.json());
  } catch (e) {
    document.getElementById('header_sub').textContent = 'fetch error: ' + e.message;
    return;
  }
  if (payload.error) {
    document.getElementById('header_sub').textContent = payload.error;
    return;
  }
  const evs = payload.events || [];
  document.getElementById('header_sub').textContent =
    evs.length + ' events  -  ' + (includeBodies ? 'body samples shown' : 'body samples redacted');

  const meta = document.getElementById('meta');
  const cc = payload.claudeCode;
  const first = evs[0] || {};
  const last = evs[evs.length-1] || {};
  const metaRows = [
    ['session', SESSION_ID],
    ['events', evs.length],
    ['project (cwd)', first.cwd || '-'],
    ['first seen', first.ts || '-'],
    ['last seen', last.ts || '-'],
  ];
  if (cc) {
    metaRows.push(['claude code session', cc.sessionId]);
    metaRows.push(['claude code project', cc.projectPath]);
    metaRows.push(['first user preview', cc.firstUserPreview]);
  } else {
    metaRows.push(['claude code', 'no matching ~/.claude/projects/ session']);
  }
  meta.innerHTML = metaRows.map(([k, v]) =>
    '<div class="k">' + escapeHtml(String(k)) + '</div><div class="v">' + escapeHtml(String(v)) + '</div>'
  ).join('');

  const tbody = document.getElementById('ev_rows');
  tbody.innerHTML = evs.map((e, i) => {
    const cls = e.status >= 500 ? 'bad' : e.status >= 400 ? 'warn' : '';
    const raw = escapeHtml(JSON.stringify(e));
    return '<tr>'
      + '<td>' + (i+1) + '</td>'
      + '<td class="small">' + escapeHtml(String(e.ts || '')) + '</td>'
      + '<td class="' + cls + '">' + escapeHtml(String(e.status || '')) + '</td>'
      + '<td>' + escapeHtml(String(e.path || '')) + '</td>'
      + '<td class="num">' + numFmt(e.orig_chars) + '</td>'
      + '<td class="num">' + numFmt(e.image_bytes) + '</td>'
      + '<td class="num">' + numFmt(e.cache_read_tokens) + '</td>'
      + '<td><div class="json-cell" onclick="this.classList.toggle(\\'open\\')">' + raw + '</div></td>'
      + '</tr>';
  }).join('');
}

document.getElementById('include_bodies').addEventListener('change', load);
document.getElementById('del_btn').addEventListener('click', async () => {
  if (!window.confirm('Delete session ' + SESSION_ID + ' and all its events?\\n\\nThis cannot be undone.')) return;
  const r = await fetch('/api/sessions/prune', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION_ID, force: true }),
  }).then(r => r.json());
  alert('removed ' + numFmt(r.eventsRemoved) + ' events, ' + fmtBytes(r.jsonlBytesFreed + r.sidecarBytesFreed));
  window.location.href = '/';
});
load();
</script>
</body></html>
`;
