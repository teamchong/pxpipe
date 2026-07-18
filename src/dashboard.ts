/**
 * Live dashboard for the Node host. Serves the main HTML page and JSON
 * polling endpoints. All "/api/*.json" endpoints recompute from disk on
 * every request — pxpipe doesn't have a query layer, but a 1.5 MB JSONL
 * streams in well under 100 ms.
 *
 * Legacy live-poll endpoints (left in place, the existing tick() loop uses
 * them):
 *
 *   GET  /, /dashboard               → main HTML page
 *   GET  /proxy-stats                → JSON aggregate over the in-mem ring
 *   GET  /proxy-recent               → JSON ring buffer of recent requests
 *   GET  /proxy-latest-png[?crop=N]  → raw PNG of the latest rendered image
 *
 * Session endpoints (read-only telemetry — no destructive operations):
 *
 *   GET  /api/sessions.json          → grouped sessions (sha8 + project + counts)
 *   GET  /api/stats.json             → full-history aggregate (formerly `pxpipe stats`)
 *
 * Metric formulas and HTML shell originally ported from the Python reference
 * implementation (deleted after live cache-rate validation hit 98.7% by tokens).
 *
 * Node-only by design. Workers host has no dashboard; use Workers Logs.
 *
 * Memory bound: ring buffer cap 50 events + a parallel ring of the last 50
 * rendered PNGs (images are never persisted to disk, so this ring is the
 * only place to view them). At a typical 75 KB PNG that's ~3-4 MB resident;
 * a process restart starts the image ring empty.
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { ProxyEvent } from './core/proxy.js';
import type { TrackEvent } from './core/tracker.js';
import {
  computeActualInputEffWithCacheTier,
  computeBaselineInputEffWithCacheTier,
  deriveBaselineWarmth,
} from './core/baseline.js';
import {
  computeOpenAIActualInputEff,
  computeOpenAIBaselineInputEff,
  computeOpenAIBaselineRawTokens,
  openAIOutputRate,
} from './core/openai-savings.js';
import {
  aggregateSessions,
  claudeCodeMap,
  filterSessions,
  type ClaudeCodeSessionRef,
  type ListOptions,
  type SessionsPaths,
} from './sessions.js';
import { aggregateEventsFile, summaryToJson } from './stats.js';
// Server-rendered UI (htmx + Alpine, vendored). No client bundle - the
// fragments module renders finished HTML from the same payloads the JSON
// endpoints serve.
import {
  renderPage,
  renderToggleFragment,
  renderModelsFragment,
  renderContextMapFragment,
  renderSessionSummaryFragment,
  renderHeaderFragment,
  renderRecentFragment,
  renderLatestFragment,
  renderSessionsFragment,
  renderStatsTableFragment,
  type ContextMapData,
} from './dashboard/fragments.js';
import {
  getAllowedModelBases,
  getConfiguredModelBases,
  isPxpipeSupportedModel,
  setAllowedModelBases,
} from './core/applicability.js';
import type {
  StatsPayload,
  RecentPayload,
  SessionsPayload,
  FullStatsPayload,
  CurrentSessionPayload,
} from './dashboard/types.js';

const RECENT_CAP = 50;

/** How many rendered PNGs to keep in the in-memory image ring. Matches
 *  RECENT_CAP so every visible recent-requests row can still resolve its
 *  image. Images are never written to disk — this ring is the only store. */
const IMAGE_RING_CAP = 800;

/** One rendered image held in the in-memory ring. `id` is a monotonic
 *  counter (never reused) so a RecentRow can reference its image even after
 *  older entries are evicted; the dashboard pulls it via
 *  /proxy-latest-png?id=${id}. */
interface ImageEntry {
  id: number;
  png: Uint8Array;
  /** Human-readable "WxH · NN KB · N images total" line for the caption. */
  meta: string;
  width: number;
  height: number;
  ts: number;
  /** The source text this PNG was rendered from (shared across all pages of
   *  one render; capped upstream at 64 KiB). Lets the dashboard show the
   *  text → image pair so the operator can see what got converted. */
  sourceText?: string;
}

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
  model?: string;
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
  /** Id of the image rendered for this request, if any — resolves against
   *  the image ring via /proxy-latest-png?id=${img_id}. Absent when the
   *  request rendered no image, or once the image has been evicted from the
   *  ring (the id stays on the row but no longer fetches). */
  img_id?: number;
  img_ids?: number[];
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
 *      warm      = did THIS request read a warm cache? (cache_read > 0)
 *      The text counterfactual is WARMTH-AWARE and grounded in OBSERVED cache
 *      state: pxpipe images the cached prefix in place (moves the caller's
 *      cache_control marker onto the image), so image and text share cache fate.
 *      cache_read>0 ⇒ a warm cache existed for both paths; cache_read===0 ⇒ cold
 *      for both, so text re-creates its prefix too (no phantom warm read on a
 *      cold turn — that would fabricate a loss out of a real token win):
 *        warm:  baseline_input_eff = reused×0.10 + grown×observed_create_rate + cold_tail×1.0
 *               where reused = min(prevCacheable, cacheable), grown = cacheable − reused
 *        cold:  baseline_input_eff = cacheable×observed_create_rate + cold_tail×1.0
 *      actual_input_eff   = input + cache_create_5m×1.25 + cache_create_1h×2 + cache_read×0.10
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
/**
 * Per-session aggregate. Same dollar-weighted savings math as the global
 * `Totals` block, but partitioned by `info.firstUserSha8` so the dashboard
 * can show "what's happening RIGHT NOW" instead of stale lifetime numbers.
 * Field names mirror the JSON wire shape served by `serveCurrentSessionJson`.
 */
interface SessionTotals {
  sessionId: string;
  // Dollar-weighted accumulators. baseline/actual are the SAME math as the
  // global `Totals.allBaselineEquivalentWeighted` / `allActualInputWeighted`,
  // but scoped to a single session. Output is excluded because the proxy
  // doesn't touch it.
  baselineInputWeighted: number;
  actualInputWeighted: number;
  // Honest denominator for the headline: count of requests that contributed
  // to `baselineInputWeighted` (events that carried a baseline measurement,
  // matching the global `Totals.baselineMeasuredCount`).
  baselineMeasuredCount: number;
  // ALL-rows session totals (measured + unmeasured + passthrough). These pair
  // up to form the full session bill in $ — used as the honest denominator
  // for saved-% so the ratio matches the global `saved_pct_of_all_spend`
  // math but scoped to a single session. Mirrors the global
  // `Totals.allActualInputWeighted` / `allOutputWeighted` accumulators.
  allActualInputWeighted: number;
  allOutputWeighted: number;
  // RAW token sums — NO rate weighting, NO baseline construction. The honest,
  // server-sourced compression: 1 − rawActualTokens/rawBaselineTokens.
  //   rawActualTokens   = Σ(input + cache_create + cache_read)  (real usage)
  //   rawBaselineTokens = Σ baseline_tokens                     (count_tokens of
  //                       the SAME body as text)
  // Two real numbers, one division — nothing in between to get wrong. This is
  // the headline; the weighted $ figures are diagnostics below it.
  rawActualTokens: number;
  rawBaselineTokens: number;
  // Raw output tokens (the model's reply). pxpipe does NOT compress output, so
  // the HONEST total reduction adds it to BOTH sides:
  //   1 − (rawActual + rawOutput) / (rawBaseline + rawOutput)
  // Headlining input-only would cherry-pick the part that compresses.
  rawOutputTokens: number;
}

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
  /** Sum of weighted COUNTERFACTUAL input tokens across ALL requests
   *  with a usage block. For measured rows: cache-aware baseline (what the
   *  unproxied path would have billed). For unmeasured/probe-failed rows:
   *  actual_input_eff (best available estimate — these rows didn't run
   *  pxpipe or we can't measure what it would have cost, so the
   *  counterfactual ≈ actual).
   *
   *  This is the right denominator for "share of bill saved": dividing
   *  by what-you-would-have-paid is bounded at 100% (you can't save more
   *  than you would have spent). Dividing by what-you-DID-pay is not
   *  bounded — a single big cold-miss compressed request can make
   *  saved/actual exceed 100% because pxpipe shrunk the actual to
   *  near zero. */
  allBaselineEquivalentWeighted: number;
  /** Sum of weighted ACTUAL input tokens across the same all-rows set.
   *  Kept for the diagnostic sub-line and the back-compat saved_usd math. */
  allActualInputWeighted: number;
  /** Sum of output_tokens × OUTPUT_TOKEN_RATE across the same all-rows set.
   *  Output is identical with/without compression, so it appears in both
   *  numerator and denominator at the same value and cancels in the savings
   *  numerator. Included in the denominator so the headline drops honestly
   *  toward zero on output-heavy workloads. */
  allOutputWeighted: number;
  /** Count of requests that contributed to allActualInputWeighted (had a
   *  usage block). Lets the UI annotate "N of M paid requests". */
  allUsageRequests: number;
  /** Direct compressed-vs-passthrough actual-cost split. No counterfactuals,
   *  no probe gating — just sum what each path actually billed.
   *
   *  These accumulate over `haveUsage` rows only (same gate as the all-rows
   *  counters above) and partition that set by `info.compressed`. The point
   *  is to answer "did the compressed path actually cost less per request
   *  than the passthrough path, on real traffic" without inventing a
   *  counterfactual. Selection bias is real (the gate decides which path
   *  each turn lands on), so the UI surfaces sample counts so the operator
   *  can judge sufficiency — the dashboard does not auto-claim significance. */
  compressedPaidRequests: number;
  compressedActualInputWeighted: number;
  compressedOutputWeighted: number;
  passthroughPaidRequests: number;
  passthroughActualInputWeighted: number;
  passthroughOutputWeighted: number;
  /** Sum of ground-truth output character counts from the SSE/JSON scanner
   *  (see `OutputMeasurement` in proxy.ts). These three accumulators are
   *  independent of Anthropic's `usage.output_tokens` — they let the operator
   *  compare what we measured vs what Anthropic billed and surface the gap
   *  the redacted_thinking opaque blocks create. Counted in Unicode code
   *  units (UTF-16 string .length). */
  textCharsMeasured: number;
  thinkingCharsMeasured: number;
  toolUseCharsMeasured: number;
  /** Number of `redacted_thinking` content blocks we saw. We can't read
   *  their length (server-encrypted bytes) so we count blocks instead. */
  redactedBlockCountMeasured: number;
  /** How many events contributed measurement counters. Lets the UI annotate
   *  the panel ("N of M events measured") when the scanner fell back. */
  eventsWithMeasurement: number;
  startedAt: number;
}

function emptyTotals(startedAt = Date.now() / 1000): Totals {
  return {
    requests: 0,
    compressedRequests: 0,
    actualInputWeighted: 0,
    baselineInputWeighted: 0,
    outputWeighted: 0,
    allBaselineEquivalentWeighted: 0,
    allActualInputWeighted: 0,
    allOutputWeighted: 0,
    allUsageRequests: 0,
    compressedPaidRequests: 0,
    compressedActualInputWeighted: 0,
    compressedOutputWeighted: 0,
    passthroughPaidRequests: 0,
    passthroughActualInputWeighted: 0,
    passthroughOutputWeighted: 0,
    textCharsMeasured: 0,
    thinkingCharsMeasured: 0,
    toolUseCharsMeasured: 0,
    redactedBlockCountMeasured: 0,
    eventsWithMeasurement: 0,
    startedAt,
  };
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
 *  Source: https://docs.claude.com/en/docs/about-claude/pricing — Opus 4.7
 *  input is $5/Mtok (same as Opus 4.5 / 4.6; the previous "$2.50" value
 *  here was a regression). Cache-write 5m = $6.25/Mtok (1.25×),
 *  cache-read = $0.50/Mtok (0.10×).
 *
 *  This is exposed on /proxy-stats as `pricing_assumptions.input_per_mtok`
 *  so the operator can see what we assumed and override if they're
 *  running against a non-default deployment (Bedrock/Vertex add a 10%
 *  premium; Sonnet would be $3/Mtok, etc.).
 *
 *  NOTE: Opus 4.7 uses a different tokenizer than 4.5/4.6 (per
 *  docs.claude.com/en/docs/about-claude/pricing), so even at the same
 *  $/Mtok rate, the same string maps to a different token count. The
 *  honest oracle for "tokens in this body" is `count_tokens` against the
 *  actual target model; do not trust hardcoded chars-per-token or
 *  tokens-per-image constants on 4.7 without verifying against the
 *  upstream probe. */
// 2026-06-09: gate is Fable-5-only and Fable 5 bills $10/MTok input,
// so the dashboard dollar figure uses that rate. Output tokens are
// excluded entirely (the proxy can't move them), so this still
// understates the real bill - treat it as "input-side $ saved".
export const ASSUMED_INPUT_USD_PER_MTOK = 10.0;

/** Route per-event accounting by upstream. OpenAI paths use the GPT cost
 *  model (vision-token imaging, automatic 0.1× prefix cache, no count_tokens
 *  probe, 8× output); everything else uses the Anthropic cache-aware baseline.
 *  Anthropic paths are `/v1/messages[/count_tokens]`; neither word appears. */
function isOpenAIEvent(
  path: string | undefined,
  accountingProvider?: 'anthropic' | 'openai',
): boolean {
  if (accountingProvider) return accountingProvider === 'openai';
  if (!path) return false;
  return path.includes('responses') || path.includes('chat/completions');
}

/** Cache-aware eff bundle for one GPT event. Shared by the live `update()`
 *  and `replay()` paths so both read identical per-row numbers. Pure: takes
 *  plain scalars (replay has no Usage/TransformInfo objects, only JSONL fields).
 *
 *  GPT differs from Anthropic on every axis: input_tokens already INCLUDES the
 *  cached subset (`cachedTokens`), there is no cache-create premium, the cached
 *  prefix reads at ~0.1×, and the baseline is the measured `baselineImagedTokens`
 *  (o200k text-token cost of the imaged content) vs the vision-token `imageTokens`
 *  pxpipe actually paid — not a count_tokens probe. No per-session warmth state:
 *  OpenAI caching is automatic/prefix-based and the discount is already folded
 *  into the cached-input rate. See src/core/openai-savings.ts. */
function gptEff(args: {
  model: string | undefined;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  imageTokens: number;
  baselineImagedTokens: number;
  nativeInjectedTokens: number;
  compressed: boolean;
}): {
  haveUsage: boolean;
  haveBaseline: boolean;
  creditSaving: boolean;
  actualInputEff: number;
  baselineInputEff: number;
  outputEquiv: number;
  rawActual: number;
  rawBaseline: number;
} {
  const { model, inputTokens: inp, outputTokens: out, cachedTokens: cached } = args;
  const { imageTokens, baselineImagedTokens, nativeInjectedTokens, compressed } = args;
  const haveUsage = inp > 0 || out > 0;
  // The transform measured what the imaged content would have cost as o200k
  // text; without it there is no counterfactual to credit.
  const haveBaseline = baselineImagedTokens > 0;
  const actualInputEff = haveUsage ? computeOpenAIActualInputEff(inp, cached, model) : 0;
  const creditSaving = haveBaseline && haveUsage && compressed;
  const baselineInputEff = creditSaving
    ? computeOpenAIBaselineInputEff(
        inp, cached, imageTokens, baselineImagedTokens, model, nativeInjectedTokens,
      )
    : actualInputEff;
  const outputEquiv = haveUsage ? out * openAIOutputRate(model) : 0;
  // Raw, rate-free token counts for the session's compression ratio and the
  // Details panel: actual = what we sent; baseline = the text-only equivalent.
  const rawActual = inp;
  const rawBaseline = computeOpenAIBaselineRawTokens(
    inp, imageTokens, baselineImagedTokens, nativeInjectedTokens,
  );
  return {
    haveUsage,
    haveBaseline,
    creditSaving,
    actualInputEff,
    baselineInputEff,
    outputEquiv,
    rawActual,
    rawBaseline,
  };
}

export class DashboardState {
  private recent: RecentRow[] = [];
  /** Per-session dollar-weighted totals, keyed by `info.firstUserSha8`. The
   *  dashboard surfaces ONLY the most-recently-active session via the
   *  `serveCurrentSessionJson` endpoint — older sessions linger in the Map
   *  so a tab refresh during a brief lull still finds the previous session,
   *  but get evicted at `SESSION_CAP` to bound memory in long-running hosts. */
  private sessions: Map<string, SessionTotals> = new Map();
  /** sha8 of the most-recently-active session id. null when no events have
   *  ever carried a `firstUserSha8` (e.g. a cold start with only passthrough
   *  hits that the upstream probe never tagged). */
  private currentSessionId: string | null = null;
  /** Per-session prior prefix size for the cache-aware TEXT baseline. Warm/cold
   *  comes only from the server-observed cache_read on the actual request; this
   *  map is used only after cr>0 to split the text counterfactual into reused vs
   *  grown prefix tokens. Reconstructed identically in replay() from persisted
   *  timestamps, so live and restored numbers agree. Capped with sessions. */
  private baselineWarmth: Map<string, { ts: number; cacheable: number; prefixSha?: string }> = new Map();
  /** Max age for reusing a prior prefix size after cr>0 has proved warmth. */
  private static readonly CACHE_TTL_SEC = 300;
  /** Hard cap on `sessions` Map entries. Keeps memory bounded in
   *  long-running deployments. 50 sessions × ~13 numeric fields each is
   *  comfortably under a MB even with fat bucket/passthrough histograms. */
  private static readonly SESSION_CAP = 50;
  private readonly startedAt = Date.now() / 1000;
  /** Lifetime accounting partitioned by exact model id. The dashboard sums
   * only currently enabled model families, so toggling a model updates the
   * overall numbers without discarding its history. */
  private readonly totalsByModel = new Map<string, Totals>();
  /** Bounded ring of the most recently rendered images (last IMAGE_RING_CAP).
   *  Each request that rendered an image pushes one entry; the matching
   *  RecentRow carries `img_id` so the dashboard can pull any image still in
   *  the ring via /proxy-latest-png?id=N. In-memory only — images are never
   *  persisted, so a restart starts this empty. */
  private images: ImageEntry[] = [];
  /** Monotonic image id source. Never reset, never reused — an evicted id
   *  stays dangling on its RecentRow rather than pointing at a new image. */
  private nextImageId = 1;
  /** Runtime kill switch for compression. When false, the proxy forwards
   *  /v1/messages unchanged to upstream — pure passthrough, no images,
   *  no transforms. Controlled by the dashboard "passthrough" toggle so
   *  the operator can toggle the proxy's transform instantly.
   *
   *  Defaults to TRUE since 2026-06-09: scope is Fable 5 only, which reads
   *  renders at 100/100 (no Opus read tax) with the same image billing, and
   *  the live proxy record measured ~68% real input-token savings on dense
   *  traffic — the old off-default rationale ("cache-illusory savings")
   *  cited the superseded dead verdict. Grok stays opt-in until quality
   *  matches Fable. Verbatim recall is still lossy; the dashboard toggle
   *  remains the kill switch. See FINDINGS.md. */
  private compressionEnabled = true;
  /** Recent requests' transform breakdowns, for the Context Map panel + its
   *  history selector. In-memory ring, newest last. */
  private contextHistory: ContextMapData[] = [];
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

  private totalsForModel(model: string | undefined): Totals {
    const key = model ?? '';
    let totals = this.totalsByModel.get(key);
    if (!totals) {
      totals = emptyTotals(this.startedAt);
      this.totalsByModel.set(key, totals);
    }
    return totals;
  }

  private enabledTotals(): Totals {
    const combined = emptyTotals(this.startedAt);
    for (const [model, totals] of this.totalsByModel) {
      if (!isPxpipeSupportedModel(model)) continue;
      for (const key of Object.keys(combined) as Array<keyof Totals>) {
        if (key !== 'startedAt') combined[key] += totals[key];
      }
    }
    return combined;
  }

  /** Stash every rendered image into the ring (called from onRequest with the
   *  raw ProxyEvent before info.firstImagePng is dropped by toTrackEvent).
   *  Returns the assigned image ids in render order; empty array when there
   *  are no images. The caller stamps ids[0] onto the RecentRow as `img_id`
   *  for back-compat and the full list as `img_ids`. */
  captureImage(info: NonNullable<ProxyEvent['info']>): number[] {
    const pngs = info.imagePngs ?? (info.firstImagePng ? [info.firstImagePng] : []);
    if (pngs.length === 0) return [];
    const dims =
      info.imageDims ??
      (info.firstImagePng
        ? [{ width: info.firstImageWidth ?? 0, height: info.firstImageHeight ?? 0 }]
        : []);
    const ids: number[] = [];
    for (let i = 0; i < pngs.length; i++) {
      const id = this.nextImageId++;
      const width = dims[i]?.width ?? 0;
      const height = dims[i]?.height ?? 0;
      const kb = (pngs[i]!.length / 1024).toFixed(1);
      const meta = `${width}×${height} · ${kb} KB · image ${i + 1}/${pngs.length}`;
      this.images.push({
        id,
        png: pngs[i]!,
        meta,
        width,
        height,
        ts: Date.now() / 1000,
        sourceText: info.imageSourceTexts?.[i] ?? info.imageSourceText,
      });
      ids.push(id);
    }
    // Evict the oldest entries past the cap. splice() keeps insertion order
    // so images[images.length - 1] is always the latest render.
    if (this.images.length > IMAGE_RING_CAP) {
      this.images.splice(0, this.images.length - IMAGE_RING_CAP);
    }
    return ids;
  }

  /** Fold one event into the running totals + ring buffer.
   *
   *  Savings math is gated on a per-request `baseline_tokens` measurement
   *  from the parallel count_tokens probe AND an upstream usage block.
   *  When either is missing, we still count the request but skip its
   *  savings contribution — no estimation. */
  update(ev: ProxyEvent): void {
    // Stash the image bytes before they get GC'd by the request finishing.
    // The returned id (if any) is stamped onto this request's RecentRow so
    // the dashboard can pull the exact image that request rendered.
    const imgIds = ev.info ? this.captureImage(ev.info) : [];
    const imgId = imgIds[0];

    const u = ev.usage;
    const info = ev.info;
    const compressed = info?.compressed === true;
    const totals = this.totalsForModel(ev.model);

    const inp = u?.input_tokens ?? 0;
    const out = u?.output_tokens ?? 0;
    const cc = u?.cache_creation_input_tokens ?? 0;
    const cc5m = u?.cache_creation?.ephemeral_5m_input_tokens;
    const cc1h = u?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const cr = u?.cache_read_input_tokens ?? 0;
    const gpt = isOpenAIEvent(ev.path, ev.accountingProvider);

    // Unified per-row accounting, filled by the provider branch below. The
    // downstream totals / per-session / recent-row code reads only these —
    // it never re-derives cache math, so Anthropic and GPT can't drift.
    let haveUsage: boolean;
    let haveBaseline: boolean;
    let creditSaving: boolean;
    let actualInputEff: number;
    let baselineInputEff: number;
    let outputEquiv: number;
    let rawActual: number; // raw tokens sent (session ratio + Details realInput)
    let rawBaseline: number; // raw text-only counterfactual tokens
    let baselineForRow: number; // baseline token count for contextHistory/recent
    let cacheReadForRow: number; // tokens to surface in the "Cache hits" column
    let warmForRow: boolean; // did the TEXT baseline read warm? Server-observed:
    // Anthropic cr>0 or GPT cached_tokens>0. Drives Context Map narration.

    if (gpt) {
      // GPT cost model: no count_tokens probe, no cache-create premium, no
      // per-session warmth — the discount is automatic and folded into the
      // cached-input rate. Baseline is the measured imaged-vs-text delta.
      const e = gptEff({
        model: ev.model,
        inputTokens: inp,
        outputTokens: out,
        cachedTokens: u?.cached_tokens ?? 0,
        imageTokens: info?.imageTokens ?? 0,
        baselineImagedTokens: info?.baselineImagedTokens ?? 0,
        nativeInjectedTokens: info?.nativeInjectedTokens ?? 0,
        compressed,
      });
      haveUsage = e.haveUsage;
      haveBaseline = e.haveBaseline;
      creditSaving = e.creditSaving;
      actualInputEff = e.actualInputEff;
      baselineInputEff = e.baselineInputEff;
      outputEquiv = e.outputEquiv;
      rawActual = e.rawActual;
      rawBaseline = e.rawBaseline;
      baselineForRow = e.rawBaseline;
      cacheReadForRow = u?.cached_tokens ?? 0;
      // GPT's prefix discount is automatic: cached_tokens>0 ⇒ it read warm.
      warmForRow = (u?.cached_tokens ?? 0) > 0;
    } else {
      haveUsage = u !== undefined && (inp > 0 || out > 0 || cc > 0 || cr > 0);
      const baseline = info?.baselineTokens;

      // Honest gating: only attribute savings when BOTH baseline probes
      // resolved (status === 'ok'). When the cacheable-prefix probe failed
      // (status === 'partial') we previously fell through to cacheable=0,
      // which silently charges the unproxied counterfactual the cold-input
      // rate on tokens that actually would have been cache-discounted —
      // fabricating "$ saved". Excluding the row is the only honest move
      // until the probe succeeds.
      const probeOk = info?.baselineProbeStatus === 'ok'
        // Back-compat: hosts that haven't adopted baselineProbeStatus yet
        // still see fields land; we accept legacy rows where the full-body
        // probe resolved AND (either no markers existed OR cacheable did too).
        || (info?.baselineProbeStatus === undefined && baseline !== undefined && baseline > 0);
      haveBaseline = typeof baseline === 'number' && baseline > 0 && probeOk;

      // Weighted INPUT cost we actually paid this turn.
      actualInputEff = haveUsage
        ? computeActualInputEffWithCacheTier(inp, cc, cr, cc1h, cc5m)
        : 0;

      // pxpipe only reduces input by imaging the static slab. An UNCOMPRESSED
      // row had its body forwarded untouched, so its unproxied counterfactual
      // IS exactly what it paid — crediting the cache-modeled baseline there
      // (which prices the prefix at the cache-READ rate) fabricates savings on
      // passthrough traffic. Only credit the counterfactual when the row was
      // actually compressed AND we have a usable probe.
      creditSaving = haveBaseline && haveUsage && compressed;

      // Cache-aware, server-observed baseline. INVARIANT: pxpipe is credited ONLY
      // for the text it imaged away — NEVER for caching. The imagined text path
      // gets the same observed cache state as the actual request: cr>0 means warm
      // for both, cr===0 means cold for both. No wall-clock-only inference.
      // Uncompressed rows fall back to actualInputEff → zero savings.
      const cacheable = info?.baselineCacheableTokens ?? 0;
      // If cr>0 proved warmth, a completed prior with the same prefix refines the
      // reused/grown split for the text baseline. Use request start for that
      // lookup; an overlapping request that had not completed could not provide a
      // prior prefix size for this in-flight request.
      const sidNow = info?.firstUserSha8;
      const prefixShaNow = info?.systemSha8;
      const completionSec = Date.now() / 1000;
      const requestStartSec = completionSec - Math.max(0, ev.durationMs || 0) / 1000;
      const warmthPrev =
        typeof sidNow === 'string' && sidNow.length > 0
          ? this.baselineWarmth.get(sidNow)
          : undefined;
      // Warmth itself is cr-only; prior state only estimates the warm split.
      // Centralised in deriveBaselineWarmth so update()/replay()/sessions can't drift.
      const { warm, prevCacheable } = deriveBaselineWarmth(
        warmthPrev,
        requestStartSec,
        cacheable,
        cr,
        DashboardState.CACHE_TTL_SEC,
        prefixShaNow,
      );
      baselineInputEff = creditSaving
        ? computeBaselineInputEffWithCacheTier(
            baseline as number,
            cacheable,
            inp,
            cc,
            cr,
            warm,
            prevCacheable,
            cc1h,
            cc5m,
          )
        : actualInputEff;
      // Record this completed turn's prefix size for future cr>0 split estimates.
      // Carry the prior cacheable when this row has no probe.
      if (typeof sidNow === 'string' && sidNow.length > 0 && haveUsage) {
        this.baselineWarmth.set(sidNow, {
          ts: completionSec,
          cacheable: cacheable > 0 ? cacheable : (warmthPrev?.cacheable ?? 0),
          prefixSha: prefixShaNow ?? warmthPrev?.prefixSha,
        });
        if (this.baselineWarmth.size > DashboardState.SESSION_CAP) {
          const firstKey = this.baselineWarmth.keys().next().value;
          if (firstKey !== undefined) this.baselineWarmth.delete(firstKey);
        }
      }

      // Output tokens are identical with/without compression — the proxy never
      // touches the response body. They show up on BOTH sides of the savings
      // ratio at their actual rate (OUTPUT_TOKEN_RATE × input rate) so the
      // denominator reflects the full bill the user actually pays. Without
      // this, an output-heavy turn would silently inflate the "saved %"
      // headline relative to what Anthropic's weekly limit meters as token
      // consumption (input + output × 5).
      outputEquiv = haveUsage ? out * OUTPUT_TOKEN_RATE : 0;
      rawActual = inp + cc + cr;
      rawBaseline = baseline ?? 0;
      baselineForRow = baseline ?? 0;
      cacheReadForRow = cr;
      warmForRow = warm; // server-observed cache read (cr>0)
    }

    // Record the request's transform breakdown for the Context Map panel. This
    // runs AFTER the eff-tokens are computed so the Details headline reads the
    // SAME cache-weighted pair as the recent row's As-text / Sent / Saved
    // columns (baselineInputEff / actualInputEff) — the two panels can no longer
    // disagree. Raw counts are kept for the cache-blind sub-line. Gate on
    // haveUsage so an in-flight request doesn't render a bogus "-100%".
    if (info && haveUsage && imgId !== undefined) {
      // Key by the request's first image id so the recent table's "view" link
      // (which carries that id) maps straight to this breakdown.
      this.contextHistory.push({
        id: imgId,
        baselineTokens: baselineForRow,
        realInput: rawActual,
        baselineInputEff,
        actualInputEff,
        haveBaseline,
        cacheRead: cacheReadForRow,
        warm: warmForRow,
        output: out,
        imageCount: info.imageCount ?? 0,
        baselineImagedTokens: info.baselineImagedTokens,
        buckets: { ...(info.bucketChars ?? {}) },
        imageIds: [...imgIds],
        compressed,
        model: ev.model,
        responsesComposition: info.responsesComposition,
        responsesUnexplainedTokens: info.responsesComposition
          ? Math.max(0, rawBaseline - info.responsesComposition.totalLocal)
          : undefined,
      });
      // Keep in lockstep with RECENT_CAP so every "view" link in the recent
      // table resolves to a real breakdown (was 30 < 50, so older visible rows
      // silently fell back to the latest request's data).
      if (this.contextHistory.length > RECENT_CAP) {
        this.contextHistory.splice(0, this.contextHistory.length - RECENT_CAP);
      }
    }

    totals.requests += 1;
    if (compressed) totals.compressedRequests += 1;

    // Measured headline: only compressed rows with a usable probe. An
    // uncompressed row contributes zero saved (baseline === actual), so
    // including it here would only dilute the "saved on rows we moved" %.
    if (creditSaving) {
      totals.baselineInputWeighted += baselineInputEff;
      totals.actualInputWeighted += actualInputEff;
      totals.outputWeighted += outputEquiv;
    }
    // All-rows COUNTERFACTUAL spend, ungated on the probe — the honest
    // denominator for "did pxpipe move my real bill". Measured rows
    // contribute their cache-aware baseline (what the unproxied path
    // would have billed); unmeasured/probe-failed/passthrough rows
    // contribute their actual input (pxpipe either didn't run or we
    // can't measure the counterfactual, so actual ≈ baseline). This
    // keeps the ratio bounded at 100% — you can't save more than you
    // would have paid.
    if (haveUsage) {
      // baselineInputEff already folds the uncompressed/probe-failed fallback
      // to actualInputEff, so passthrough rows contribute zero saved here.
      totals.allBaselineEquivalentWeighted += baselineInputEff;
      totals.allActualInputWeighted += actualInputEff;
      totals.allOutputWeighted += outputEquiv;
      totals.allUsageRequests += 1;
      // Direct observed compressed-vs-passthrough split. No counterfactual,
      // no probe gating — just partition the paid-rows set by which path
      // actually ran this turn. Headline answers "is the compressed path
      // cheaper per request on real traffic". Selection bias (the gate
      // routes each turn) is real; sample counts go to the UI so the
      // operator can judge sufficiency.
      if (compressed) {
        totals.compressedPaidRequests += 1;
        totals.compressedActualInputWeighted += actualInputEff;
        totals.compressedOutputWeighted += outputEquiv;
      } else {
        totals.passthroughPaidRequests += 1;
        totals.passthroughActualInputWeighted += actualInputEff;
        totals.passthroughOutputWeighted += outputEquiv;
      }
    }

    // Per-session aggregation. Uses the SAME baseline/actual/output math as
    // the global accumulators above, partitioned by `info.firstUserSha8`
    // so the dashboard's "current session" panel can show what's happening
    // RIGHT NOW instead of stale lifetime numbers. Untagged events (no
    // firstUserSha8 — cold start, passthrough probe failures) are skipped
    // rather than bucketed into a synthetic "unknown" session.
    const sid = info?.firstUserSha8;
    if (typeof sid === 'string' && sid.length > 0) {
      this.currentSessionId = sid;
      let s = this.sessions.get(sid);
      if (!s) {
        s = {
          sessionId: sid,
          baselineInputWeighted: 0,
          actualInputWeighted: 0,
          baselineMeasuredCount: 0,
          allActualInputWeighted: 0,
          allOutputWeighted: 0,
          rawActualTokens: 0,
          rawBaselineTokens: 0,
          rawOutputTokens: 0,
        };
        this.sessions.set(sid, s);
        // Cap memory — drop the first (oldest by insertion order) session
        // when over budget. We no longer track lastSeen privately on the
        // class — insertion order is a fine proxy because `currentSessionId`
        // (set above on every update) is what the serve path uses to pick
        // the most-recent session, not a scan of `this.sessions`.
        if (this.sessions.size > DashboardState.SESSION_CAP) {
          const firstKey = this.sessions.keys().next().value;
          if (firstKey !== undefined) this.sessions.delete(firstKey);
        }
      }
      // Reuse the same haveUsage / haveBaseline guards + the
      // baselineInputEff / actualInputEff locals computed earlier in
      // update() so the lifetime totals block (above) and the per-session
      // block (here) read the same values. Re-deriving them here would
      // duplicate the cache-aware-baseline math and invite drift.
      if (creditSaving) {
        s.baselineInputWeighted += baselineInputEff;
        s.actualInputWeighted += actualInputEff;
        s.baselineMeasuredCount += 1;
        // RAW, rate-free compression: real tokens sent vs the same body as text.
        s.rawActualTokens += rawActual;
        s.rawBaselineTokens += rawBaseline;
        s.rawOutputTokens += out; // not compressed; added to BOTH sides for the honest total
      }
      // ALL-rows session bill — mirrors the global `if (haveUsage)` block
      // above (allActualInputWeighted / allOutputWeighted). Used as the
      // honest denominator for the session's saved-% so caching wins on
      // unmeasured requests still count toward "what you actually paid".
      if (haveUsage) {
        s.allActualInputWeighted += actualInputEff;
        s.allOutputWeighted += outputEquiv;
      }
    }

    // Measurement totals are independent of usage/baseline gating — they
    // accumulate whenever the scanner produced numbers. The scanner sets
    // measurement to undefined on 5xx (no body to scan) and on unknown
    // content-types; we count an event as "measured" when it has any.
    const m = ev.measurement;
    if (m) {
      totals.textCharsMeasured += m.textChars;
      totals.thinkingCharsMeasured += m.thinkingChars;
      totals.toolUseCharsMeasured += m.toolUseChars;
      totals.redactedBlockCountMeasured += m.redactedBlockCount;
      totals.eventsWithMeasurement += 1;
    }

    const row: RecentRow = {
      ts: Date.now() / 1000,
      method: ev.method,
      path: ev.path,
      model: ev.model,
      status: ev.status,
      compressed,
      cc_added: compressed ? 1 : undefined,
      input_tokens: haveUsage ? inp : undefined,
      output_tokens: haveUsage ? out : undefined,
      cache_create: haveUsage ? cc : undefined,
      cache_read: haveUsage ? cacheReadForRow : undefined,
      actual_input: haveUsage ? round1(actualInputEff) : undefined,
      baseline_input: creditSaving ? round1(baselineInputEff) : undefined,
      session_saved_so_far_delta:
        creditSaving ? round1(baselineInputEff - actualInputEff) : undefined,
      img_id: imgId,
      img_ids: imgIds,
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
    // Replay mirrors the live update() warmth logic (per-session baselineWarmth,
    // cr-grounded) so it produces byte-identical per-row numbers to update().
    for (const t of tail) {
      const inp = t.input_tokens ?? 0;
      const out = t.output_tokens ?? 0;
      const cc = t.cache_create_tokens ?? 0;
      const cc5m = t.cache_create_5m_tokens;
      const cc1h = t.cache_create_1h_tokens ?? 0;
      const cr = t.cache_read_tokens ?? 0;
      const compressed = t.compressed === true;
      const gpt = isOpenAIEvent(t.path, t.accounting_provider);

      // Same unified accounting as update(); see the branch comments there.
      let haveUsage: boolean;
      let haveBaseline: boolean;
      let creditSaving: boolean;
      let actualInputEff: number;
      let baselineInputEff: number;
      let rawActual: number;
      let rawBaseline: number;
      let baselineForRow: number;
      let cacheReadForRow: number;
      let warmForRow: boolean; // text-baseline warmth for the Context Map narration

      if (gpt) {
        const e = gptEff({
          model: t.model,
          inputTokens: inp,
          outputTokens: out,
          cachedTokens: (t as { cached_tokens?: number }).cached_tokens ?? 0,
          imageTokens: (t as { image_tokens?: number }).image_tokens ?? 0,
          baselineImagedTokens:
            (t as { baseline_imaged_tokens?: number }).baseline_imaged_tokens ?? 0,
          nativeInjectedTokens:
            (t as { native_injected_tokens?: number }).native_injected_tokens ?? 0,
          compressed,
        });
        haveUsage = e.haveUsage;
        haveBaseline = e.haveBaseline;
        creditSaving = e.creditSaving;
        actualInputEff = e.actualInputEff;
        baselineInputEff = e.baselineInputEff;
        rawActual = e.rawActual;
        rawBaseline = e.rawBaseline;
        baselineForRow = e.rawBaseline;
        cacheReadForRow = (t as { cached_tokens?: number }).cached_tokens ?? 0;
        warmForRow = ((t as { cached_tokens?: number }).cached_tokens ?? 0) > 0;
      } else {
        haveUsage = inp > 0 || out > 0 || cc > 0 || cr > 0;
        const baseline = (t as { baseline_tokens?: number }).baseline_tokens;
        const cacheable = (t as { baseline_cacheable_tokens?: number })
          .baseline_cacheable_tokens ?? 0;
        const probeStatus = (t as { baseline_probe_status?: string }).baseline_probe_status;
        // Same gating rule as update(): require an explicit 'ok' status when
        // present; fall back to "have a baseline number" for legacy JSONL.
        const probeOk = probeStatus === 'ok'
          || (probeStatus === undefined && typeof baseline === 'number' && baseline > 0);
        haveBaseline = typeof baseline === 'number' && baseline > 0 && probeOk;
        actualInputEff = haveUsage
          ? computeActualInputEffWithCacheTier(inp, cc, cr, cc1h, cc5m)
          : 0;
        // Mirror update(): only credit the cache-modeled counterfactual on
        // compressed rows. Uncompressed/passthrough rows fall back to the
        // actual cost so they show zero saved (no fabricated savings).
        creditSaving = haveBaseline && haveUsage && compressed;
        // Warm/cold is reconstructed from server-observed cr only. Persisted
        // completion ts + duration_ms are used only to find a prior prefix size
        // for the reused/grown split after cr>0 has proved warmth.
        const sidR = (t as { first_user_sha8?: string }).first_user_sha8;
        const prefixShaR = (t as { system_sha8?: string }).system_sha8;
        const completionSecR = Date.parse(t.ts) / 1000;
        const requestStartSecR = completionSecR - Math.max(0, t.duration_ms || 0) / 1000;
        const warmthPrevR =
          typeof sidR === 'string' && sidR.length > 0 ? this.baselineWarmth.get(sidR) : undefined;
        // Same cr-only warmth as update(); prior state only refines the split.
        const { warm: warmR, prevCacheable: prevCacheableR } = deriveBaselineWarmth(
          warmthPrevR,
          requestStartSecR,
          cacheable,
          cr,
          DashboardState.CACHE_TTL_SEC,
          prefixShaR,
        );
        baselineInputEff = creditSaving
          ? computeBaselineInputEffWithCacheTier(
              baseline as number,
              cacheable,
              inp,
              cc,
              cr,
              warmR,
              prevCacheableR,
              cc1h,
              cc5m,
            )
          : actualInputEff;
        if (typeof sidR === 'string' && sidR.length > 0 && haveUsage) {
          this.baselineWarmth.set(sidR, {
            ts: completionSecR,
            cacheable: cacheable > 0 ? cacheable : (warmthPrevR?.cacheable ?? 0),
            prefixSha: prefixShaR ?? warmthPrevR?.prefixSha,
          });
          if (this.baselineWarmth.size > DashboardState.SESSION_CAP) {
            const firstKey = this.baselineWarmth.keys().next().value;
            if (firstKey !== undefined) this.baselineWarmth.delete(firstKey);
          }
        }
        rawActual = inp + cc + cr;
        rawBaseline = baseline ?? 0;
        baselineForRow = baseline ?? 0;
        cacheReadForRow = cr;
        warmForRow = warmR; // server-observed cache read
      }
      // Rebuild the Context Map breakdown so old rows keep their "Saved" value
      // and "Details" link after a restart. The PNG ring is in-memory and gone,
      // so thumbnails can't return (imageIds: [], flagged `restored`) — but the
      // headline %, buckets and Saved delta all reconstruct from the persisted
      // event with the same cache-weighted math as the live update() path.
      const imageCount = (t as { image_count?: number }).image_count ?? 0;
      let imgId: number | undefined;
      if (compressed && haveUsage && (imageCount > 0 || rawBaseline > 0)) {
        imgId = this.nextImageId++;
        this.contextHistory.push({
          id: imgId,
          baselineTokens: baselineForRow,
          realInput: rawActual,
          baselineInputEff,
          actualInputEff,
          haveBaseline,
          cacheRead: cacheReadForRow,
          warm: warmForRow,
          output: out,
          imageCount,
          baselineImagedTokens: (t as { baseline_imaged_tokens?: number }).baseline_imaged_tokens,
          buckets: { ...((t as { bucket_chars?: Record<string, number> }).bucket_chars ?? {}) },
          imageIds: [], // PNG ring is in-memory; not restorable across restart
          compressed,
          model: t.model,
          responsesComposition: (t as { responses_composition?: ContextMapData['responsesComposition'] }).responses_composition,
          responsesUnexplainedTokens: (t as { responses_composition?: ContextMapData['responsesComposition'] }).responses_composition
            ? Math.max(0, rawBaseline - ((t as { responses_composition?: ContextMapData['responsesComposition'] }).responses_composition?.totalLocal ?? 0))
            : undefined,
          restored: true,
        });
        if (this.contextHistory.length > RECENT_CAP) {
          this.contextHistory.splice(0, this.contextHistory.length - RECENT_CAP);
        }
      }
      const row: RecentRow = {
        ts: Date.parse(t.ts) / 1000,
        method: t.method,
        path: t.path,
        model: t.model,
        status: t.status,
        compressed,
        cc_added: compressed ? 1 : undefined,
        input_tokens: t.input_tokens,
        output_tokens: t.output_tokens,
        cache_create: t.cache_create_tokens,
        cache_read: gpt ? cacheReadForRow : t.cache_read_tokens,
        actual_input: haveUsage ? round1(actualInputEff) : undefined,
        baseline_input:
          creditSaving ? round1(baselineInputEff) : undefined,
        session_saved_so_far_delta:
          creditSaving ? round1(baselineInputEff - actualInputEff) : undefined,
        img_id: imgId,
        img_ids: imgId !== undefined ? [imgId] : undefined,
      };
      this.recent.push(row);
    }
  }

  // ---- HTTP handlers ------------------------------------------------------

  /**
   * Per-session "what's happening right now" payload backing the
   * `SessionSummary` panel. Scopes the dollar-weighted savings ratio + the
   * per-bucket char attribution + the passthrough-reason histogram to the
   * most-recently-active session (tracked via `info.firstUserSha8`) so the
   * top-of-dashboard headline reflects the live session rather than stale
   * lifetime aggregates from a previous run.
   *
   * Returns `{ sessionId: null, message: 'no active session yet' }` when no
   * events have been received yet (or the first events were all untagged —
   * cold start, probe failures) — `update()` only sets `currentSessionId`
   * when a `firstUserSha8`-tagged event lands. The client renders a stale
   * panel rather than zeroes when a session goes idle (NO `lastSeen >
   * threshold` check here; see comment in `update()` for the rationale).
   */
  serveCurrentSessionJson(): Response {
    if (!this.currentSessionId) {
      return jsonResponse({
        sessionId: null,
        message: 'no active session yet',
      });
    }
    const s = this.sessions.get(this.currentSessionId);
    if (!s) {
      return jsonResponse({ sessionId: null, message: 'no active session yet' });
    }
    // Headline payload: the same dollar-weighted baseline/actual input
    // accumulators the global Totals block exposes, plus the honest
    // denominator (`baselineMeasuredCount` — only requests that carried a
    // baseline measurement). We ALSO ship the ALL-rows session bill
    // (`allActualInputWeighted` + `allOutputWeighted`) so the Svelte panel
    // can compute saved-% against the full session bill instead of just
    // the measured slice — matching the global `saved_pct_of_all_spend`
    // math but scoped to one session. The Svelte panel does the dollar
    // conversion itself so we don't round-trip pricing through the wire.
    return jsonResponse({
      sessionId: s.sessionId,
      baselineInputWeighted: s.baselineInputWeighted,
      actualInputWeighted: s.actualInputWeighted,
      baselineMeasuredCount: s.baselineMeasuredCount,
      allActualInputWeighted: s.allActualInputWeighted,
      allOutputWeighted: s.allOutputWeighted,
      rawActualTokens: s.rawActualTokens,
      rawBaselineTokens: s.rawBaselineTokens,
      rawOutputTokens: s.rawOutputTokens,
    });
  }

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
    const totals = this.enabledTotals();
    const baseline = totals.baselineInputWeighted;
    const actual = totals.actualInputWeighted;
    const output = totals.outputWeighted; // already × OUTPUT_TOKEN_RATE
    const saved = baseline - actual;
    const pctInput = baseline > 0 ? (saved / baseline) * 100 : 0;
    const baselineTotal = baseline + output;
    const actualTotal = actual + output;
    const pctTotal = baselineTotal > 0 ? (saved / baselineTotal) * 100 : 0;

    // Share-of-all-spend: honest denominator. The numerator can only credit
    // savings against rows where we have a probe baseline (otherwise it's
    // estimation), but the denominator MUST include every request the user
    // actually paid for — including passthrough rows, probe-failed rows,
    // and untransformed turns the gate said no to. Otherwise the headline
    // answers "did pxpipe help on the rows where it ran" instead of
    // "did pxpipe move my real bill". The first is a cherry-pick.
    const allBaselineEquiv = totals.allBaselineEquivalentWeighted;
    const allActual = totals.allActualInputWeighted;
    const allOutput = totals.allOutputWeighted;
    // Denominator = counterfactual all-rows bill: what the user would have
    // paid with no pxpipe. Bounded ratio at 100%; a single cold-miss
    // compressed request on an otherwise empty session shows ~99% saved,
    // not 280%.
    const allCounterfactualBill = allBaselineEquiv + allOutput;
    const pctAllSpend =
      allCounterfactualBill > 0 ? (saved / allCounterfactualBill) * 100 : 0;

    // Direct observed split — actual $ per request, partitioned by which
    // path ran. Token-equivalent (input × 1.0 + cache_create × 1.25 +
    // cache_read × 0.10 + output × 5) → $ at the assumed Opus 4.7 input
    // rate. Same $/Mtok rate is applied to both buckets, so the bias from
    // the rate assumption cancels in the delta. Selection bias from the
    // gate is NOT cancelled — the operator interprets that via the
    // sample-count caveat below.
    const compressedTokenEquiv =
      totals.compressedActualInputWeighted +
      totals.compressedOutputWeighted;
    const passthroughTokenEquiv =
      totals.passthroughActualInputWeighted +
      totals.passthroughOutputWeighted;
    const compressedActualUsd =
      (compressedTokenEquiv * ASSUMED_INPUT_USD_PER_MTOK) / 1e6;
    const passthroughActualUsd =
      (passthroughTokenEquiv * ASSUMED_INPUT_USD_PER_MTOK) / 1e6;
    const compressedAvgUsd =
      totals.compressedPaidRequests > 0
        ? compressedActualUsd / totals.compressedPaidRequests
        : 0;
    const passthroughAvgUsd =
      totals.passthroughPaidRequests > 0
        ? passthroughActualUsd / totals.passthroughPaidRequests
        : 0;
    // Sufficient-sample threshold is a soft heuristic. 20 paid requests per
    // bucket is enough to see a real effect on Opus 4.7 traffic (a single
    // big cold-miss can dominate at lower n). Below this, the UI shows the
    // bucket numbers but hides the delta and surfaces "small sample".
    const SUFFICIENT = 20;
    const splitSufficient =
      totals.compressedPaidRequests >= SUFFICIENT &&
      totals.passthroughPaidRequests >= SUFFICIENT;
    const splitDeltaUsd = compressedAvgUsd - passthroughAvgUsd;

    const uptimeSec = Date.now() / 1000 - totals.startedAt;
    const payload = {
      requests: totals.requests,
      compressed_requests: totals.compressedRequests,
      baseline_input_weighted: Math.round(baseline),
      actual_input_weighted: Math.round(actual),
      saved_input_tokens: Math.round(saved),
      // saved_pct kept for back-compat with existing dashboard HTML; it is
      // the input-only number. New code should read saved_pct_input_only.
      saved_pct: round1(pctInput),
      saved_pct_input_only: round1(pctInput),
      saved_pct_of_total_bill: round1(pctTotal),
      // Honest "share of total bill saved" — measured-rows numerator over
      // ALL paid requests in the denominator (compressed + passthrough +
      // probe-failed). This is the number users actually want when they
      // ask "is pxpipe helping". Negative when flap-pollution from
      // passthrough turns exceeds the collapse win on measured turns.
      saved_pct_of_all_spend: round1(pctAllSpend),
      all_baseline_equivalent_weighted: Math.round(allBaselineEquiv),
      all_actual_input_weighted: Math.round(allActual),
      all_output_weighted: Math.round(allOutput),
      all_usage_requests: totals.allUsageRequests,
      // Direct observed split — replaces "share of spend saved" as the
      // headline. Total actual $ and average $/req per path, plus a delta
      // gated on `split_sufficient_sample`. No counterfactual: each
      // bucket is what each path actually billed.
      compressed_paid_requests: totals.compressedPaidRequests,
      passthrough_paid_requests: totals.passthroughPaidRequests,
      compressed_actual_usd: round4(compressedActualUsd),
      passthrough_actual_usd: round4(passthroughActualUsd),
      compressed_avg_usd_per_request: round4(compressedAvgUsd),
      passthrough_avg_usd_per_request: round4(passthroughAvgUsd),
      compressed_minus_passthrough_avg_usd: round4(splitDeltaUsd),
      split_sufficient_sample: splitSufficient,
      split_min_sample_per_bucket: SUFFICIENT,
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
      // Honest output measurement — char counts from the SSE/JSON scanner,
      // independent of Anthropic's `usage.output_tokens`. Surfaces the gap
      // the May-2026 weekly-meter audit hypothesized (redacted_thinking adds
      // billed tokens that we can't see). `events_with_measurement` lets the
      // operator weigh how representative the numbers are; when it's near
      // `requests`, the gap is real. When it's 0, the scanner never landed
      // (5xx-heavy session, no /v1/messages traffic).
      measured_text_chars: totals.textCharsMeasured,
      measured_thinking_chars: totals.thinkingCharsMeasured,
      measured_tool_use_chars: totals.toolUseCharsMeasured,
      measured_redacted_block_count: totals.redactedBlockCountMeasured,
      events_with_measurement: totals.eventsWithMeasurement,
      uptime_sec: uptimeSec,
      compression_enabled: this.compressionEnabled,
    };
    return new Response(JSON.stringify(payload, null, 2), {
      headers: { 'content-type': 'application/json' },
    });
  }

  serveRecent(): Response {
    const latest = this.images[this.images.length - 1];
    const payload = {
      recent: this.recent,
      has_preview: latest !== undefined,
      preview_meta: latest?.meta ?? '',
      // Image ids currently resident in the ring. The dashboard uses this to
      // tell which RecentRow.img_id values still resolve — older ones have
      // been evicted and their "view" button should be disabled.
      image_ids: this.images.map((im) => im.id),
    };
    return new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json' },
    });
  }

  /** GET /proxy-latest-png[?id=N] — raw PNG from the image ring. With no id
   *  (or an unknown id) the latest render is returned; ?id=N pulls that
   *  specific image while it's still in the ring. 404 once evicted. */
  servePng(id?: number): Response {
    // Cropping is done client-side via CSS (object-position + overflow:hidden).
    // Python decoded the PNG to crop server-side; we skip that to avoid
    // pulling a PNG decoder back in — the CSS approach renders identically.
    const entry =
      id !== undefined
        ? this.images.find((im) => im.id === id)
        : this.images[this.images.length - 1];
    if (!entry) {
      return new Response('no image yet', { status: 404 });
    }
    return new Response(entry.png as unknown as BodyInit, {
      headers: { 'content-type': 'image/png', 'cache-control': 'no-cache' },
    });
  }

  /** GET /api/image-source[?id=N] — the source text the PNG was rendered
   *  from, so the operator can see the text → image conversion side by side.
   *  Falls back to the latest image; 404 if evicted or text wasn't captured. */
  serveImageSource(id?: number): Response {
    const entry =
      id !== undefined
        ? this.images.find((im) => im.id === id)
        : this.images[this.images.length - 1];
    if (!entry || entry.sourceText === undefined) {
      return new Response(JSON.stringify({ error: 'no source text' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ id: entry.id, meta: entry.meta, source_text: entry.sourceText }),
      { headers: { 'content-type': 'application/json' } },
    );
  }

  serveHtml(port: number): Response {
    return htmlResponse(renderPage(port));
  }

  /** GET /fragments/<name> — server-rendered htmx fragments. Each one reuses
   *  the corresponding JSON endpoint's payload (via Response.json()) so the
   *  HTML and JSON surfaces can't drift apart. */
  async serveFragment(name: string, url: URL, port: number): Promise<Response> {
    switch (name) {
      case 'toggle':
        return htmlResponse(renderToggleFragment(this.compressionEnabled));
      case 'models':
        return htmlResponse(
          renderModelsFragment(
            getAllowedModelBases(),
            getConfiguredModelBases(),
            this.compressionEnabled,
          ),
        );
      case 'context-map': {
        const reqParam = url.searchParams.get('req');
        if (reqParam) {
          // Explicit request: show ONLY that one. If its breakdown was evicted
          // or never recorded (no usage on that completion), say so — don't
          // silently fall back to the latest request's data under its label.
          const found = this.contextHistory.find((h) => h.id === Number(reqParam));
          return htmlResponse(renderContextMapFragment(found, this.contextHistory, !found));
        }
        // No specific request → default to the latest.
        return htmlResponse(
          renderContextMapFragment(this.contextHistory[this.contextHistory.length - 1], this.contextHistory),
        );
      }
      case 'session-summary': {
        // Lifetime hero — same cumulative payload as the header strip so the
        // headline and the "$ saved" tiles never disagree and it stops jumping.
        const s = (await this.serveStats().json()) as StatsPayload;
        return htmlResponse(renderSessionSummaryFragment(s));
      }
      case 'header': {
        const s = (await this.serveStats().json()) as StatsPayload;
        return htmlResponse(renderHeaderFragment(s, port));
      }
      case 'recent': {
        const r = (await this.serveRecent().json()) as RecentPayload;
        return htmlResponse(renderRecentFragment(r));
      }
      case 'latest': {
        const r = (await this.serveRecent().json()) as RecentPayload;
        const pinRaw = url.searchParams.get('pin');
        const pinNum = pinRaw != null && pinRaw !== '' ? Number(pinRaw) : NaN;
        const pin = Number.isFinite(pinNum) ? pinNum : null;
        const showSource = url.searchParams.get('source') === '1';
        let sourceText: string | null = null;
        if (showSource) {
          const entry =
            pin != null
              ? this.images.find((im) => im.id === pin)
              : this.images[this.images.length - 1];
          sourceText = entry?.sourceText ?? null;
        }
        return htmlResponse(renderLatestFragment({ payload: r, pin, showSource, sourceText }));
      }
      case 'sessions': {
        const res = await this.serveSessionsJson();
        if (!res.ok) return htmlResponse(`<div class="status">sessions unavailable</div>`);
        const p = (await res.json()) as SessionsPayload;
        return htmlResponse(renderSessionsFragment(p));
      }
      case 'stats': {
        const res = await this.serveApiStats();
        const p = (await res.json()) as FullStatsPayload;
        return htmlResponse(renderStatsTableFragment(p));
      }
      default:
        return new Response('unknown fragment', { status: 404 });
    }
  }

  // ---- session / cleanup endpoints --------------------------------------
  //
  // Every endpoint below recomputes from disk on demand. The dashboard polls
  // these on a 5s cadence, which is fine for a single-user dev tool — even at
  // ~3k events / 1.5 MB the round-trip is <100ms on a warm SSD.

  /** GET /api/sessions.json — grouped sessions enriched with the Claude Code
   *  cross-reference. The body is the top-level `sessions` array; the client
   *  renders a bar chart of the top savers. */
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

  /** GET /api/stats.json — full-history aggregate. Migrated from the
   *  former `pxpipe stats` CLI. */
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

  /** POST /api/compression — flip the runtime kill switch.
   *  Body: { enabled: boolean }. Returns the new state. In-memory only;
   *  restart resets to the default (on). */
  handleCompressionToggle(body: { enabled?: unknown }): Response {
    const on = body.enabled === true;
    this.compressionEnabled = on;
    return jsonResponse({ compression_enabled: on });
  }

  /** POST /fragments/models — add/remove ONE model (Claude or GPT) from the
   *  runtime compress scope. In-memory only; restart resets to the PXPIPE_MODELS
   *  env / built-in default. The model checks read this live. */
  handleModelsToggle(model: string, on: boolean): void {
    const next = new Set(getAllowedModelBases());
    if (on) next.add(model);
    else next.delete(model);
    setAllowedModelBases([...next]);
  }

  /** POST /fragments/models with {list} — replace the WHOLE runtime compress
   *  scope from the PXPIPE_MODELS textbox. Same CSV shape as the env var;
   *  empty or off/false/0/no/none = compress nothing. In-memory only. */
  handleModelsSet(csv: string): void {
    const trimmed = csv.trim();
    const bases =
      !trimmed || /^(0|false|no|off|none)$/i.test(trimmed)
        ? []
        : trimmed.split(',').map((s) => s.trim()).filter(Boolean);
    setAllowedModelBases(bases);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
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

/** Result of route-matching a dashboard URL. The legacy `kind` values
 *  (html/stats/recent/png) stay alongside the `/api/*` JSON endpoints. */
export type DashboardRoute =
  | { kind: 'html' }
  | { kind: 'stats' } // /proxy-stats — legacy live counter
  | { kind: 'recent' } // /proxy-recent — legacy ring buffer
  | { kind: 'png' } // /proxy-latest-png
  | { kind: 'api-sessions' } // /api/sessions.json
  | { kind: 'api-stats' } // /api/stats.json
  | { kind: 'current-session' } // /api/current-session.json
  | { kind: 'api-compression' } // /api/compression (POST {enabled}) — runtime kill switch
  | { kind: 'api-image-source' } // /api/image-source[?id=N] — source text behind a rendered PNG
  | { kind: 'fragment'; name: string }; // /fragments/<name> — server-rendered htmx panels

/** Match dashboard paths (handle query strings on /proxy-latest-png). */
export function dashboardPath(pathname: string): DashboardRoute | null {
  if (pathname === '/' || pathname === '/dashboard') return { kind: 'html' };
  if (pathname === '/proxy-stats') return { kind: 'stats' };
  if (pathname === '/proxy-recent') return { kind: 'recent' };
  if (pathname === '/proxy-latest-png') return { kind: 'png' };
  if (pathname === '/api/sessions.json') return { kind: 'api-sessions' };
  if (pathname === '/api/stats.json') return { kind: 'api-stats' };
  if (pathname === '/api/current-session.json') return { kind: 'current-session' };
  if (pathname === '/api/compression') return { kind: 'api-compression' };
  if (pathname === '/api/image-source') return { kind: 'api-image-source' };
  if (pathname.startsWith('/fragments/')) {
    return { kind: 'fragment', name: pathname.slice('/fragments/'.length) };
  }
  return null;
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
