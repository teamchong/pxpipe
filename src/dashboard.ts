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
 *  this lives in memory and gets serialized on every poll. */
export interface RecentRow {
  ts: number;
  method: string;
  path: string;
  status: number;
  size_in?: number;
  compressed: boolean;
  cc_added?: number;
  expected_image_tokens?: number;
  input_tokens?: number;
  cache_create?: number;
  cache_read?: number;
  effective_actual?: number;
  effective_baseline?: number;
  /** How much the running "saved" total moved on this request. */
  session_saved_so_far_delta?: number;
}

/** Aggregate over the whole session. Reset on process restart unless
 *  replay() is called to seed from the JSONL file.
 *
 *  Cost convention: every "effective cost" number is the FULL dollar-
 *  equivalent bill summed across input + cache_create×1.25 + cache_read×
 *  0.10 + output×5.0 (output rate / input rate ratio on Opus and Sonnet).
 *  saved_pct = (baseline - actual) / baseline, i.e. the share of the
 *  total upstream bill the proxy shaved off — not "% saved on just the
 *  input portion." Output cost is identical in both actual and baseline
 *  (the model produces the same response regardless of prompt
 *  compression), so it cancels in the savings numerator but enlarges
 *  the denominator, dragging saved_pct toward the conservative whole-
 *  bill reading. */
interface Totals {
  requests: number;
  compressedRequests: number;
  /** Sum of full-bill dollar-equivalent cost we actually paid upstream
   *  (input + cache + output, all weighted). */
  effectiveCostActual: number;
  /** Sum of estimated full-bill cost if we had NOT compressed (point). */
  effectiveCostBaseline: number;
  /** Pessimistic-α baseline (p10 of per-sample α, or wide fallback).
   *  Drives `saved_pct_low` — the conservative bound on claimed savings. */
  effectiveCostBaselineLow: number;
  /** Optimistic-α baseline (p90 of per-sample α, or wide fallback).
   *  Drives `saved_pct_high` — the upper bound on claimed savings. */
  effectiveCostBaselineHigh: number;
  /** Number of events that carried both baseline_tokens_measured AND
   *  actual_tokens_measured (i.e. count_tokens succeeded on both sides).
   *  Drives the headline switch: when ≥1, the dashboard reports
   *  saved_pct_measured INSTEAD of the regression estimate. */
  measuredEvents: number;
  /** Cumulative actual cost over the subset of events that had ground-
   *  truth measurement available. Always ≤ effectiveCostActual. */
  effectiveCostActualMeasured: number;
  /** Cumulative MEASURED baseline cost — derived from the actual cost
   *  plus the exact delta-tokens count_tokens reported, billed at the
   *  same cache-mix rate as the actual call. No α estimation involved. */
  effectiveCostBaselineMeasured: number;
  startedAt: number;
}

/*
 * ─────────────────────────────────────────────────────────────────────────
 *  PROVENANCE — every magic number below should trace to one of these:
 *
 *  [docs-pricing]   docs.anthropic.com/en/docs/about-claude/pricing
 *                   Verified 2026-05-19 via WebFetch. The page lists per-model
 *                   per-million-token rates and the cache-tier multipliers.
 *  [docs-vision]    docs.anthropic.com/en/docs/build-with-claude/vision
 *                   Verified 2026-05-19 via WebFetch. Stipulates the image-
 *                   token formula `tokens ≈ width × height / 750` and the
 *                   per-model maxima (Opus 4.7: 4784 tokens / 2576 px edge).
 *  [docs-tokenizer] Same pricing page, note attached to Opus 4.7:
 *                   "Opus 4.7 uses a new tokenizer compared to previous
 *                    versions, contributing to its improved performance on
 *                    a wide range of tasks. This new tokenizer may use up
 *                    to 35% more tokens for the same fixed text."
 *
 *  [empirical]      Constants derived from the proxy's own measurements
 *                   against real upstream usage. These require a proxy run
 *                   under post-walker-fix code to converge — until then
 *                   the dashboard falls back to documented or assumed
 *                   values, and the saved_pct uncertainty band reflects
 *                   the lack of measurement.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** Fallback α brackets used when n<3 cold-miss samples and the regression
 *  can't fire. Picked from "plausible content density" across realistic
 *  Claude Code traffic. Provenance: [docs-tokenizer] notes Opus 4.7 runs
 *  ~35% denser than older models (≈ 3 chars/tok vs ≈ 4 chars/tok English
 *  average), so the brackets span both regimes:
 *    - α_low  = 0.15  (≈ 6.7 chars/tok — prose-heavy)
 *    - α      = 0.33  (≈ 3.0 chars/tok — Opus 4.7 English-text avg per docs)
 *    - α_high = 0.50  (≈ 2.0 chars/tok — JSON-dense / dense tool definitions)
 *  Brackets are deliberately wide so the operator sees "calibrating" rather
 *  than a precise-looking but unfounded number when the regression hasn't
 *  converged. Source: [docs-tokenizer]. */
const FALLBACK_ALPHA = 0.33;
const FALLBACK_ALPHA_LOW = 0.15;
const FALLBACK_ALPHA_HIGH = 0.5;

/** Per-image token cost in the FALLBACK case (no live β fit yet, no
 *  per-image-pixel data). Computed from the published image formula at
 *  our default render shape: single-col 808×1568 = 1.27 MP →
 *  1.27e6 / 750 ≈ 1,690 tokens. Source: [docs-vision] "tokens ≈ width ×
 *  height / 750".
 *
 *  Earlier versions of this file used 2,500 here based on an in-house
 *  measurement against Opus pre-4.7 that didn't reconcile with the docs;
 *  removed pending fresh per-renderer-config measurement under
 *  post-walker-fix code. With pixel data available the dashboard prefers
 *  imagePixels × β (β=1/750 per [docs-vision]) over this fallback. */
const FALLBACK_IMAGE_TOKEN_COST = 1690;

/** Estimated token cost of the N images we emit per compressed request.
 *  Three regimes, in preference order:
 *    1. β fitted from cold-miss events → `imagePixels × β` (live empirical)
 *    2. No β but we have pixel data    → `imagePixels × (1/750)` per [docs-vision]
 *    3. No pixel data at all           → `imageCount × FALLBACK_IMAGE_TOKEN_COST`
 *
 *  Source: [docs-vision] formula `tokens ≈ width × height / 750`. */
function estImageTokens(
  imageCount: number,
  imagePixels: number,
  beta: number | null,
): number {
  if (beta !== null && imagePixels > 0) return Math.round(imagePixels * beta);
  if (imagePixels > 0) return Math.round(imagePixels / 750);
  return imageCount * FALLBACK_IMAGE_TOKEN_COST;
}

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

/** Full-bill dollar-equivalent cost of a single upstream call, summed
 *  across all four token classes:
 *    input × 1.00  +  cache_create × 1.25  +  cache_read × 0.10  +  output × 5.0
 *
 *  Anthropic's published rates: input=1×, cache_create=1.25×, cache_read=
 *  0.10× (all referenced to the input base rate), output=5× the input
 *  rate. Multiply the result by the per-Mtok input rate (e.g. $15/Mtok
 *  on Opus 4.7) to get dollars.
 *
 *  Output is included so that saved_pct reflects the whole bill, not a
 *  fraction of just the part the proxy touches. Output is identical in
 *  both `actual` and `baseline` (same prompt → same response), so it
 *  cancels in the savings numerator but inflates the denominator. */
function effectiveCost(
  inputTokens: number,
  cacheCreate: number,
  cacheRead: number,
  outputTokens: number,
): number {
  return (
    inputTokens
    + cacheCreate * 1.25
    + cacheRead * 0.1
    + outputTokens * OUTPUT_TOKEN_RATE
  );
}

/** Estimate what the call WOULD have cost if we hadn't compressed. Adds back
 *  the text tokens we removed (minus the image tokens we added) at the SAME
 *  cache mix the actual call paid — otherwise cold-cache turns get scored
 *  as if the baseline were warm-cache and savings look tiny.
 *
 *  Image-token cost goes through estImageTokens() which prefers (in order):
 *  live β fit → published 1/750 formula → FALLBACK_IMAGE_TOKEN_COST. Source:
 *  [docs-vision] for the formula and [docs-pricing] for the per-image cap.
 */
function baselineCost(
  actualEff: number,
  compressedChars: number,
  imageCount: number,
  imagePixels: number,
  cacheCreate: number,
  cacheRead: number,
  fit: { alpha: number; beta: number } | null,
  /** Optional α override used by the LOW/HIGH bound computations. When set,
   *  replaces ONLY the chars-per-token side of the math; the image-token
   *  side keeps using whatever regime `fit` selects (β·pixels if fit is
   *  present, 2500/img fallback otherwise). This keeps the three baselines
   *  consistent — they bracket the α-uncertainty alone, not the image-cost
   *  model. Without this knob, swapping fit=null for fit={...,beta:1/750}
   *  on the low/high paths would silently switch the image-cost regime
   *  from "2500/img fallback" to "β·pixels", which can make the low bound
   *  unintuitively GREATER than the point bound. */
  alphaOverride?: number,
): number {
  // compressedChars is the actual text we IMAGE-encoded (static slab +
  // reminders + tool_results that passed the break-even gate). NOT the
  // total origChars — that would include text-only blocks that stayed
  // as text and wouldn't have appeared as `imageCount` either, making
  // the apples-to-apples comparison invalid.
  //
  // When `fit` is non-null we have ≥3 cold-miss samples and trust the
  // measured rates: txtReplaced = compressedChars × α (tokens-per-char),
  // imgTokens = imagePixels × β (tokens-per-pixel). When `fit` is null
  // we fall back to the stale 4-chars-per-token + 2500-tokens-per-image
  // constants, which are still in the right ballpark for Opus pre-4.7
  // single-col workloads.
  const alphaEff = alphaOverride ?? (fit ? fit.alpha : 0.25);
  const txtReplaced = Math.floor(compressedChars * alphaEff);
  const imgTokensEst = estImageTokens(imageCount, imagePixels, fit ? fit.beta : null);
  // extraText CAN be negative when image cost > text cost. Don't clamp —
  // surfaces honest negatives so the operator can see cost-bleed.
  const extraText = txtReplaced - imgTokensEst;
  const cachedTotal = cacheCreate + cacheRead;
  const baselineRate =
    cachedTotal > 0 ? (cacheCreate / cachedTotal) * 1.25 + (cacheRead / cachedTotal) * 0.1 : 0.1;
  return actualEff + extraText * baselineRate;
}

/** One sample for the empirical cost regression. Built from any compressed
 *  request where the full usage triple + new instrumentation (`image_pixels`,
 *  `outgoing_text_chars`) is present. Cache state is NOT a gate — Anthropic's
 *  tokenizer is deterministic on input bytes, so warm hits carry the same
 *  body-token information as cold misses; only the billing differs.
 *
 *  Solves: `tokens ≈ α · text_chars + β · pixels` over N samples via 2×2
 *  normal equations, where `tokens = input + cache_create + cache_read`.
 *  Surfaced live in `/proxy-stats` so the dashboard shows the empirical
 *  chars/token and tokens/image numbers as soon as enough variance
 *  accumulates — replaces the one-shot script that nobody would ever
 *  remember to run. */
interface FitSample {
  tokens: number;
  text_chars: number;
  pixels: number;
}

/** Cap for the fit-sample ring. Fits get noisier with more old data after a
 *  model change, so we keep it short — enough samples for a stable fit
 *  (N≥10 typical) but young enough that a flipped MULTI_COL or model upgrade
 *  flushes through within a few sessions. */
const FIT_SAMPLE_CAP = 50;

export class DashboardState {
  private recent: RecentRow[] = [];
  private fitSamples: FitSample[] = [];
  private totals: Totals = {
    requests: 0,
    compressedRequests: 0,
    effectiveCostActual: 0,
    effectiveCostBaseline: 0,
    effectiveCostBaselineLow: 0,
    effectiveCostBaselineHigh: 0,
    measuredEvents: 0,
    effectiveCostActualMeasured: 0,
    effectiveCostBaselineMeasured: 0,
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

  /** Fold one event into the running totals + ring buffer. */
  update(ev: ProxyEvent): void {
    // Stash the image bytes before they get GC'd by the request finishing.
    if (ev.info) this.captureImage(ev.info);

    const u = ev.usage;
    const info = ev.info;
    const compressed = info?.compressed === true;

    // No upstream usage data → we can still count the request, but skip the
    // savings math (Python does the same).
    const inp = u?.input_tokens ?? 0;
    const out = u?.output_tokens ?? 0;
    const cc = u?.cache_creation_input_tokens ?? 0;
    const cr = u?.cache_read_input_tokens ?? 0;
    const haveUsage = u !== undefined && (inp > 0 || out > 0 || cc > 0 || cr > 0);

    const eff = haveUsage ? effectiveCost(inp, cc, cr, out) : 0;
    // Pull the current empirical fit BEFORE recording — when this event is
    // itself a cold miss it'll feed back into the next request's fit, but
    // for this baseline calc we use whatever rate we have so far. Null
    // until ≥3 cold-miss samples accumulate; baselineCost falls back to
    // the stale constants in that case.
    const fit = this.fitCosts();
    const imgPx = (info as { imagePixels?: number } | undefined)?.imagePixels ?? 0;
    // Three parallel baselines: point estimate + low/high uncertainty band.
    // When fit is present we use its α (point) and the per-sample p10/p90
    // as the band (alpha_low / alpha_high). When fit is null we use the
    // FALLBACK_ALPHA brackets so the /proxy-stats range is always defined
    // (operator sees "calibrating" range with explicit wide bounds,
    // never a fake-precise single number).
    //
    // CRITICAL: we pass the SAME `fit` to all three calls and use the
    // `alphaOverride` knob to vary only the chars-per-token side. This
    // keeps the image-cost regime consistent across point/low/high so the
    // bounds bracket α-uncertainty alone. Mixing regimes (e.g. β·pixels
    // for low + 2500/img for point) made saved_pct_low > saved_pct in an
    // earlier draft — that's silently incoherent.
    const fitPoint = fit ? { alpha: fit.alpha, beta: fit.beta } : null;
    const aLow = fit ? fit.alpha_low : FALLBACK_ALPHA_LOW;
    const aHigh = fit ? fit.alpha_high : FALLBACK_ALPHA_HIGH;
    const args: [number, number, number, number, number, number] = [
      eff,
      info?.compressedChars ?? 0,
      info?.imageCount ?? 0,
      imgPx,
      cc,
      cr,
    ];
    const baselineEff = haveUsage && compressed ? baselineCost(...args, fitPoint) : eff;
    const baselineEffLow =
      haveUsage && compressed ? baselineCost(...args, fitPoint, aLow) : eff;
    const baselineEffHigh =
      haveUsage && compressed ? baselineCost(...args, fitPoint, aHigh) : eff;

    const prevSaved = this.totals.effectiveCostBaseline - this.totals.effectiveCostActual;
    this.totals.requests += 1;
    if (compressed) this.totals.compressedRequests += 1;
    this.totals.effectiveCostActual += eff;
    this.totals.effectiveCostBaseline += baselineEff;
    this.totals.effectiveCostBaselineLow += baselineEffLow;
    this.totals.effectiveCostBaselineHigh += baselineEffHigh;

    // Ground-truth measurement path: when the proxy fired count_tokens on
    // both bodies and got real numbers back, fold those into a SEPARATE
    // cumulative pair. The dashboard reports saved_pct_measured from these
    // when ≥1 event has them. No α/β estimation — the delta is exact.
    const measBase = (info as { baselineTokensMeasured?: number } | undefined)?.baselineTokensMeasured;
    const measActual = (info as { actualTokensMeasured?: number } | undefined)?.actualTokensMeasured;
    if (
      haveUsage
      && typeof measBase === 'number'
      && typeof measActual === 'number'
      && measBase >= 0
      && measActual >= 0
    ) {
      const deltaTokens = measBase - measActual;
      // Bill the delta at the same cache-mix rate the actual call paid.
      // When the call had no cache activity (cc=0 and cr=0), fall back to
      // 0.1× (cache_read rate) — the most conservative cache-mix choice.
      const cachedTotal = cc + cr;
      const billRate =
        cachedTotal > 0
          ? (cc / cachedTotal) * 1.25 + (cr / cachedTotal) * 0.1
          : 0.1;
      const measuredBaselineEff = eff + deltaTokens * billRate;
      this.totals.measuredEvents += 1;
      this.totals.effectiveCostActualMeasured += eff;
      this.totals.effectiveCostBaselineMeasured += measuredBaselineEff;
    }

    const savedNow = this.totals.effectiveCostBaseline - this.totals.effectiveCostActual;

    const row: RecentRow = {
      ts: Date.now() / 1000,
      method: ev.method,
      path: ev.path,
      status: ev.status,
      compressed,
      cc_added: compressed ? 1 : undefined, // we always emit exactly one cache_control
      expected_image_tokens: compressed
        ? estImageTokens(info?.imageCount ?? 0, imgPx, fit ? fit.beta : null)
        : undefined,
      input_tokens: haveUsage ? inp : undefined,
      cache_create: haveUsage ? cc : undefined,
      cache_read: haveUsage ? cr : undefined,
      effective_actual: haveUsage ? round1(eff) : undefined,
      effective_baseline: haveUsage ? round1(baselineEff) : undefined,
      session_saved_so_far_delta: haveUsage ? round1(savedNow - prevSaved) : undefined,
    };
    this.recent.push(row);
    if (this.recent.length > RECENT_CAP) this.recent.splice(0, this.recent.length - RECENT_CAP);

    // Sample for the empirical cost regression. Anthropic's tokenizer is
    // deterministic on input bytes — cache state changes BILLING (cache_read
    // is discounted), not token count. The total token count of the full
    // body is `input + cache_create + cache_read` regardless of how it was
    // split across cached/uncached portions, so any request with the full
    // usage triple + our new (image_pixels, outgoing_text_chars) pair is a
    // valid (LHS, design-row) for solving `tokens ≈ α·text_chars + β·pixels`.
    //
    // (Earlier this code required `cache_read === 0` — a "true cold miss".
    // That was wrong: it locked the fit out of normal traffic because warm
    // hits are the steady state. The OLS solver's collinearity guard catches
    // degenerate samples where pixels/text_chars don't vary, so relaxing
    // here can't produce a garbage fit — it just produces null until we
    // accumulate enough variance.)
    //
    // The 1000-token floor filters out trivial no-system requests where the
    // tokenizer overhead dominates the body cost.
    const pixels = (info as { imagePixels?: number } | undefined)?.imagePixels;
    const textChars = (info as { outgoingTextChars?: number } | undefined)?.outgoingTextChars;
    const totalTokens = haveUsage ? inp + cc + cr : 0;
    if (
      compressed &&
      haveUsage &&
      totalTokens > 1000 &&
      typeof pixels === 'number' &&
      pixels > 0 &&
      typeof textChars === 'number' &&
      textChars > 0
    ) {
      this.fitSamples.push({ tokens: totalTokens, text_chars: textChars, pixels });
      if (this.fitSamples.length > FIT_SAMPLE_CAP) {
        this.fitSamples.splice(0, this.fitSamples.length - FIT_SAMPLE_CAP);
      }
    }
  }

  /** Solve the empirical cost regression over the current fit-sample ring.
   *  Returns `null` when:
   *    - fewer than 3 samples (2×2 normal equations under-determined)
   *    - design matrix is too collinear to identify α and β separately
   *    - the fit produces degenerate (negative) rates
   *
   *  COLLINEARITY GUARD: the regression solves `tokens ≈ α·text + β·pixels`,
   *  which only identifies α and β separately when BOTH columns have enough
   *  variance. The typical-failure case is a single Claude Code session
   *  sending warm hits — `pixels` stays constant (same cached image) so OLS
   *  can't separate text cost from image cost. We measure variance via the
   *  coefficient of variation (stdev/mean) on each column and require both
   *  > 5%. Below that, the joint fit is unstable enough that the headline
   *  saved_pct can wander by ±15 pp across consecutive samples — strictly
   *  worse than showing the stale-constants fallback (stable wrong vs.
   *  unstable wrong).
   *
   *  THREE-MODE LADDER (most → least preferred):
   *    1. `'joint'`        — α and β both fit by OLS. Needs CV ≥ 5% on both
   *                          columns. The honest answer when traffic supplies
   *                          enough variance across distinct cached images.
   *    2. `'constrained'`  — β pinned to Anthropic's published 1/750 rate
   *                          (≈ 0.001333 tokens/pixel for the default tiling).
   *                          Solves α only via 1-D OLS on residuals
   *                          `tokens - β·pixels = α·text`. Used when the
   *                          pixels column is collinear (single cached image
   *                          dominating the ring). Still gives a *measured*
   *                          α; only β leans on Anthropic's docs.
   *    3. `null`           — even constrained fit can't run (text column
   *                          also collinear, or n<3). Caller falls back to
   *                          the stale 4-chars/tok + 2500-tok/img constants.
   *
   *  The returned `mode` field tells the dashboard HTML which regime it's
   *  showing so the operator can distinguish "honest empirical 25%" from
   *  "constrained, β-pinned 25%" from "stale-constants wandering 25%". */
  fitCosts(): {
    alpha: number;
    /** p10 of per-sample residual α across the fit ring. Drives the
     *  conservative bound on saved_pct so the dashboard can be honest
     *  about uncertainty instead of forcing a single number. */
    alpha_low: number;
    /** p90 of per-sample residual α across the fit ring. */
    alpha_high: number;
    beta: number;
    chars_per_token: number;
    chars_per_token_low: number;
    chars_per_token_high: number;
    pixels_per_token: number;
    single_col_tokens_per_img: number;
    multicol2_tokens_per_img: number;
    n: number;
    mode: 'joint' | 'constrained';
    /** Coefficient of variation (stdev/mean) on outgoing_text_chars across
     *  the fit-sample ring. Reported as a unitless ratio. Operator uses
     *  this to judge confidence in α: ≥5% = robust, 1-5% = thin but
     *  measured, <1% = essentially a mean ratio estimator. */
    text_cv: number;
    /** Coefficient of variation on image_pixels. Zero in steady-state
     *  single-session warm-cache traffic (same cached image every turn).
     *  Non-zero signals cross-session variance or cache-rotation events
     *  reached the fit ring. */
    pixels_cv: number;
  } | null {
    const samples = this.fitSamples;
    const n = samples.length;
    if (n < 3) return null;

    // First pass: column means + sums-of-squares for the OLS normal eqns.
    let sumX = 0;
    let sumP = 0;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    let sxt = 0;
    let syt = 0;
    for (const s of samples) {
      sumX += s.text_chars;
      sumP += s.pixels;
      sxx += s.text_chars * s.text_chars;
      sxy += s.text_chars * s.pixels;
      syy += s.pixels * s.pixels;
      sxt += s.text_chars * s.tokens;
      syt += s.pixels * s.tokens;
    }

    // Collinearity check: coefficient of variation on each column. var =
    // Σx²/n − (Σx/n)². If either column has CV < 5%, the design matrix is
    // near-singular and the joint fit is statistically meaningless even
    // though det != 0 numerically.
    const meanX = sumX / n;
    const meanP = sumP / n;
    const varX = Math.max(0, sxx / n - meanX * meanX);
    const varP = Math.max(0, syy / n - meanP * meanP);
    const cvX = meanX > 0 ? Math.sqrt(varX) / meanX : 0;
    const cvP = meanP > 0 ? Math.sqrt(varP) / meanP : 0;
    // Joint mode threshold: 5% on BOTH columns. Below that, OLS can't tell
    // whether token cost is coming from text or pixels and the α/β split
    // wanders ±15 pp per sample (HANDOFF "What's blocking calibration").
    const MIN_CV_JOINT = 0.05;
    // Constrained mode floor: any non-zero text variance is mathematically
    // sufficient — with β pinned we're fitting `α = Σ(r·x)/Σ(x²)` through
    // the origin, which is numerically stable at any cvX > 0. The 0.1%
    // floor is purely defensive against pathological "all six samples are
    // byte-identical" scenarios where the formula degenerates.
    //
    // We surface text_cv on the response so the operator sees confidence
    // directly in the badge instead of relying on a threshold to gatekeep:
    // 1% CV is thin but measured, 5% CV is robust, 0.5% CV is mostly the
    // mean-residual-over-mean-text ratio estimator. All honest, just
    // different signal/noise ratios — the operator can interpret.
    //
    // Verified live 2026-05-19: real steady-state single-session traffic
    // has 1-2% text CV turn-to-turn. The earlier 2% floor blocked the fit
    // from ever firing on representative production load.
    const MIN_CV_CONSTRAINED = 0.001;

    // Anthropic's published per-pixel rate for the default image tiling:
    // 1 token per ~750 pixels (≈ 0.001333). Used by the constrained fallback
    // when the live pixels column doesn't vary enough for joint OLS to
    // identify β separately. See the THREE-MODE LADDER docstring above.
    const ANTHROPIC_BETA = 1 / 750;

    /** Build the per-sample residual α distribution given a known β. Each
     *  sample yields `α_i = (tokens_i - β·pixels_i) / text_chars_i` — the
     *  α we'd infer from that single event alone, treating image cost as
     *  known. p10/p90 of this distribution gives an honest empirical
     *  uncertainty band on α without doing a bootstrap.
     *
     *  Negative or non-finite values are filtered: they'd come from
     *  numerical noise on tiny text_chars, and we'd rather under-report
     *  the band than have it contaminated by garbage samples. */
    const perSampleAlpha = (betaUsed: number): { low: number; high: number } => {
      const ratios: number[] = [];
      for (const s of samples) {
        if (s.text_chars <= 0) continue;
        const r = (s.tokens - betaUsed * s.pixels) / s.text_chars;
        if (Number.isFinite(r) && r > 0) ratios.push(r);
      }
      if (ratios.length === 0) return { low: 0, high: 0 };
      ratios.sort((a, b) => a - b);
      // Use min/max for n≤3, p10/p90 for larger samples. The dashboard
      // operator sees the bracket grow tighter as more events stream in.
      const idxLow = ratios.length <= 3 ? 0 : Math.floor(ratios.length * 0.1);
      const idxHigh = ratios.length <= 3 ? ratios.length - 1 : Math.floor(ratios.length * 0.9);
      return { low: ratios[idxLow]!, high: ratios[idxHigh]! };
    };

    // ---- Mode 1: joint OLS (both columns vary) ----
    if (cvX >= MIN_CV_JOINT && cvP >= MIN_CV_JOINT) {
      const det = sxx * syy - sxy * sxy;
      if (det !== 0) {
        const alpha = (syy * sxt - sxy * syt) / det;
        const beta = (sxx * syt - sxy * sxt) / det;
        // Guard against degenerate fits (negative rates mean the data is too
        // noisy / multi-modal to give a clean linear answer).
        if (alpha > 0 && beta > 0) {
          const band = perSampleAlpha(beta);
          // Order-clamp + positive-clamp the bracket against the central
          // point estimate so a single noisy sample can't make low > point
          // or high < point.
          const aLow = Math.max(0.01, Math.min(band.low, alpha));
          const aHigh = Math.max(alpha, band.high);
          return {
            alpha: round4(alpha),
            alpha_low: round4(aLow),
            alpha_high: round4(aHigh),
            beta: round4(beta * 1000) / 1000, // β is tiny — keep 6 sig figs effectively
            chars_per_token: round1(1 / alpha),
            chars_per_token_low: round1(1 / aHigh),  // inverse: high α → low chars/tok
            chars_per_token_high: round1(1 / aLow),
            pixels_per_token: Math.round(1 / beta),
            single_col_tokens_per_img: Math.round(508 * 1559 * beta),
            multicol2_tokens_per_img: Math.round(1028 * 1559 * beta),
            n,
            mode: 'joint',
            text_cv: round4(cvX),
            pixels_cv: round4(cvP),
          };
        }
      }
      // Joint fit was degenerate (negative rate or singular matrix) — fall
      // through to constrained fit rather than returning null. Better to
      // show a β-pinned answer than the stale-constants regime.
    }

    // ---- Mode 2: constrained (β pinned to Anthropic's 1/750), solve α only ----
    // Needs only the text column to vary. Subtract the assumed-known image
    // cost from each sample's total tokens, then do a 1-D OLS through the
    // origin: residual ≈ α · text_chars.
    //
    //   α* = Σ(residual_i · text_i) / Σ(text_i²)
    //      = (sxt − β · sxy) / sxx
    //
    // (derivation: minimize Σ(α·x − r)² → dL/dα = 0 → α = Σxr / Σx²
    //  where r_i = tokens_i − β · pixels_i, so Σx·r = sxt − β·sxy.)
    if (cvX < MIN_CV_CONSTRAINED || sxx === 0) return null;
    const alphaConstrained = (sxt - ANTHROPIC_BETA * sxy) / sxx;
    if (alphaConstrained <= 0) return null;
    const bandConstrained = perSampleAlpha(ANTHROPIC_BETA);
    const aLowC = Math.max(0.01, Math.min(bandConstrained.low, alphaConstrained));
    const aHighC = Math.max(alphaConstrained, bandConstrained.high);
    return {
      alpha: round4(alphaConstrained),
      alpha_low: round4(aLowC),
      alpha_high: round4(aHighC),
      beta: round4(ANTHROPIC_BETA * 1000) / 1000,
      chars_per_token: round1(1 / alphaConstrained),
      chars_per_token_low: round1(1 / aHighC),
      chars_per_token_high: round1(1 / aLowC),
      pixels_per_token: Math.round(1 / ANTHROPIC_BETA),
      single_col_tokens_per_img: Math.round(508 * 1559 * ANTHROPIC_BETA),
      multicol2_tokens_per_img: Math.round(1028 * 1559 * ANTHROPIC_BETA),
      n,
      mode: 'constrained',
      text_cv: round4(cvX),
      pixels_cv: round4(cvP),
    };
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
      const row: RecentRow = {
        ts: Date.parse(t.ts) / 1000,
        method: t.method,
        path: t.path,
        status: t.status,
        compressed: t.compressed === true,
        cc_added: t.compressed === true ? 1 : undefined,
        // Replay path uses the FIT-LESS form: historical rows don't get
        // re-scored as the live fit evolves. Only fresh events flowing
        // through record() benefit from the empirical rates.
        expected_image_tokens:
          t.compressed === true
            ? estImageTokens(t.image_count ?? 0, (t as { image_pixels?: number }).image_pixels ?? 0, null)
            : undefined,
        input_tokens: t.input_tokens,
        cache_create: t.cache_create_tokens,
        cache_read: t.cache_read_tokens,
        effective_actual:
          t.input_tokens !== undefined
            ? round1(
                effectiveCost(
                  t.input_tokens ?? 0,
                  t.cache_create_tokens ?? 0,
                  t.cache_read_tokens ?? 0,
                  (t as { output_tokens?: number }).output_tokens ?? 0,
                ),
              )
            : undefined,
      };
      this.recent.push(row);
      // DELIBERATELY do NOT seed the cold-miss ring from historical events.
      // Old events may carry the new instrumentation but come from a
      // different renderer config (cell size, multiCol, atlas profile) or
      // a different model (Opus 4.6 vs 4.7 tokenizer). Mixing them into the
      // fit gives a misleading α/β that lags behind reality. Each restart
      // starts the fit window empty and refills from live traffic — this
      // way flipping `multiCol`, bumping the cell size, or upgrading to a
      // new model auto-flushes stale samples on the next restart.
    }
  }

  // ---- HTTP handlers ------------------------------------------------------

  serveStats(): Response {
    const saved = this.totals.effectiveCostBaseline - this.totals.effectiveCostActual;
    const savedLow = this.totals.effectiveCostBaselineLow - this.totals.effectiveCostActual;
    const savedHigh = this.totals.effectiveCostBaselineHigh - this.totals.effectiveCostActual;
    const pct =
      this.totals.effectiveCostBaseline > 0
        ? (saved / this.totals.effectiveCostBaseline) * 100
        : 0;
    // Bounds: use the BOUND'S OWN denominator so each rate is internally
    // consistent (a "low baseline" world should compare against itself,
    // not against the point baseline). Both clamped at 0% downside —
    // negative savings (baseline-low < actual) means our pessimistic α
    // attributed less to text than we actually paid; surface as 0 rather
    // than a negative percentage that confuses the operator.
    const pctLow =
      this.totals.effectiveCostBaselineLow > 0
        ? Math.max(0, (savedLow / this.totals.effectiveCostBaselineLow) * 100)
        : 0;
    const pctHigh =
      this.totals.effectiveCostBaselineHigh > 0
        ? Math.max(0, (savedHigh / this.totals.effectiveCostBaselineHigh) * 100)
        : 0;
    const uptimeSec = Date.now() / 1000 - this.totals.startedAt;
    const payload = {
      requests: this.totals.requests,
      compressed_requests: this.totals.compressedRequests,
      // Full-bill dollar-equivalent totals: input + cache + output, all
      // weighted by Anthropic's published per-class multipliers. saved_pct
      // is the share of THIS denominator we shaved off, so it answers
      // "what fraction of my total upstream bill did the proxy reduce?"
      effective_cost_actual: round1(this.totals.effectiveCostActual),
      effective_cost_baseline: round1(this.totals.effectiveCostBaseline),
      effective_cost_baseline_low: round1(this.totals.effectiveCostBaselineLow),
      effective_cost_baseline_high: round1(this.totals.effectiveCostBaselineHigh),
      saved_effective_tokens: round1(saved),
      saved_effective_tokens_low: round1(Math.max(0, savedLow)),
      saved_effective_tokens_high: round1(Math.max(0, savedHigh)),
      saved_pct: round1(pct),
      // Honest uncertainty band on the headline saved_pct. Derived from
      // per-sample α p10/p90 when ≥3 fit samples exist, else from wide
      // FALLBACK_ALPHA brackets. When (high - low) ≥ 5pp the dashboard
      // shows the range INSTEAD of the point — being honest beats being
      // precise-looking.
      saved_pct_low: round1(pctLow),
      saved_pct_high: round1(pctHigh),
      // Ground-truth measurement path. Populated ONLY when ≥1 event
      // carried both baseline_tokens_measured AND actual_tokens_measured
      // (i.e. count_tokens succeeded on both probes). No estimation:
      // saved_pct_measured = (baseline_measured - actual_measured) / baseline_measured.
      // When non-null, the HTML headline displays these instead of the
      // regression estimate.
      measured_events: this.totals.measuredEvents,
      effective_cost_actual_measured:
        this.totals.measuredEvents > 0 ? round1(this.totals.effectiveCostActualMeasured) : null,
      effective_cost_baseline_measured:
        this.totals.measuredEvents > 0 ? round1(this.totals.effectiveCostBaselineMeasured) : null,
      saved_effective_tokens_measured:
        this.totals.measuredEvents > 0
          ? round1(this.totals.effectiveCostBaselineMeasured - this.totals.effectiveCostActualMeasured)
          : null,
      saved_pct_measured:
        this.totals.measuredEvents > 0 && this.totals.effectiveCostBaselineMeasured > 0
          ? round1(
              ((this.totals.effectiveCostBaselineMeasured - this.totals.effectiveCostActualMeasured)
                / this.totals.effectiveCostBaselineMeasured) * 100,
            )
          : null,
      // Headline dollar number. Uses the ASSUMED input rate published
      // in `pricing_assumptions` below so the operator can verify what we
      // multiplied by. Drops the "_opus47" suffix because the rate is now
      // configurable rather than hardcoded to a specific model.
      saved_usd_estimated: round4((saved * ASSUMED_INPUT_USD_PER_MTOK) / 1e6),
      pricing_assumptions: {
        input_per_mtok: ASSUMED_INPUT_USD_PER_MTOK,
        output_multiplier: OUTPUT_TOKEN_RATE,
        cache_write_5m_multiplier: 1.25,
        cache_write_1h_multiplier: 2.0,
        cache_read_multiplier: 0.1,
        source: 'docs.anthropic.com/en/docs/about-claude/pricing (verified 2026-05-19)',
      },
      uptime_sec: uptimeSec,
      // Runtime kill switch. When false, the proxy is in PASSTHROUGH
      // mode — /v1/messages forwards untransformed. Dashboard renders a
      // red banner so the operator knows the proxy is intentionally
      // not compressing.
      compression_enabled: this.compressionEnabled,
      // Empirical cost fit — null until ≥3 cold-miss events with the new
      // instrumentation accumulate. When present, contains the live model's
      // chars/token and per-image-shape token cost so the dashboard can
      // re-ground its stale 2,500/img and 4-chars/tok constants from data
      // instead of guessing.
      cost_fit: this.fitCosts(),
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
  <div class="card"><div class="label">tokens saved</div>
    <div class="value pos" id="m_saved">0</div>
    <div class="small" id="m_saved_sub">effective tokens (full bill)</div>
    <details class="math"><summary>show calculation</summary>
      <div class="formula" id="m_saved_math"></div>
    </details>
  </div>
  <div class="card"><div class="label">$ saved (estimated)</div>
    <div class="value pos" id="m_usd">$0.00</div>
    <div class="small" id="m_usd_sub">at $5/M input tokens (Opus 4.7)</div>
    <details class="math"><summary>show calculation</summary>
      <div class="formula" id="m_usd_math"></div>
    </details>
  </div>
  <div class="card"><div class="label">reduction</div>
    <div class="value pos" id="m_pct">0%</div>
    <div class="small" id="m_pct_sub">share of total bill saved</div>
    <div class="small" id="m_pct_regime" style="margin-top:4px;color:#6e7681"></div>
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
          <th class="num">cc</th><th class="num">img tok</th>
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
    document.getElementById('m_saved').textContent = numFmt(s.saved_effective_tokens);
    document.getElementById('m_saved_sub').textContent =
      \`\${numFmt(s.effective_cost_actual)} paid · \${numFmt(s.effective_cost_baseline)} baseline\`;
    // $ saved card: mirror the % card's range behavior. We have
    // saved_effective_tokens_{low,high} already in the payload; compute
    // the corresponding $ low/high by applying the same input rate. Show
    // a range when low/high differ from the point by ≥ 1¢; collapse to a
    // single $ otherwise. Keeps the headline consistent with %.
    const inRate = s.pricing_assumptions && s.pricing_assumptions.input_per_mtok;
    const usdPoint = s.saved_usd_estimated;
    const usdLo = (typeof s.saved_effective_tokens_low === 'number' && typeof inRate === 'number')
      ? (s.saved_effective_tokens_low * inRate) / 1e6 : usdPoint;
    const usdHi = (typeof s.saved_effective_tokens_high === 'number' && typeof inRate === 'number')
      ? (s.saved_effective_tokens_high * inRate) / 1e6 : usdPoint;
    const usdSpread = Math.abs(usdHi - usdLo);
    const usdShowRange = usdSpread >= 0.01;
    document.getElementById('m_usd').textContent = usdShowRange
      ? \`$\${usdLo.toFixed(2)}–$\${usdHi.toFixed(2)}\`
      : \`$\${usdPoint.toFixed(4)}\`;
    if (typeof inRate === 'number') {
      document.getElementById('m_usd_sub').textContent = usdShowRange
        ? \`point $\${usdPoint.toFixed(4)} · at $\${inRate}/M input tokens\`
        : \`at $\${inRate}/M input tokens · see pricing_assumptions\`;
    }
    // Headline priority:
    //   1. Ground-truth measured saved_pct (count_tokens on both bodies) —
    //      no estimation, exact tokenizer output. Shown when ≥1 event has
    //      both measurements (the count_tokens probes are unconditional).
    //   2. Otherwise (every probe failed so far), honest uncertainty range
    //      from per-sample α p10/p90. When spread ≥5pp we show the range
    //      INSTEAD of the point estimate; tight spread collapses to point.
    const haveMeasured =
      typeof s.saved_pct_measured === 'number' && (s.measured_events ?? 0) > 0;
    if (haveMeasured) {
      document.getElementById('m_pct').textContent = \`\${s.saved_pct_measured.toFixed(1)}%\`;
      document.getElementById('m_pct_sub').textContent =
        \`measured · count_tokens on \${s.measured_events} request\${s.measured_events === 1 ? '' : 's'}\`;
    } else {
      const pctPoint = s.saved_pct;
      const pctLo = (typeof s.saved_pct_low === 'number') ? s.saved_pct_low : pctPoint;
      const pctHi = (typeof s.saved_pct_high === 'number') ? s.saved_pct_high : pctPoint;
      const spread = pctHi - pctLo;
      const showRange = spread >= 5;
      document.getElementById('m_pct').textContent = showRange
        ? \`\${pctLo.toFixed(0)}–\${pctHi.toFixed(0)}%\`
        : \`\${pctPoint.toFixed(1)}%\`;
      document.getElementById('m_pct_sub').textContent = showRange
        ? \`point \${pctPoint.toFixed(1)}% · estimated · share of total bill saved\`
        : 'estimated · share of total bill saved';
    }

    // Populate "show calculation" blocks under each savings card. Three
    // sections, each lays out the formula with the live numbers wired in.
    // The intent is full transparency: any number on the headline cards
    // can be derived from what's shown here.
    renderSavingsMath(s);
    // Surface which cost-model regime the headline number came from. Three
    // states (mirror the THREE-MODE LADDER in dashboard.ts fitCosts):
    //   joint        — α and β both measured (≥10 samples = high confidence)
    //   constrained  — α measured, β pinned to Anthropic's 1/750
    //   stale        — no fit yet, using hardcoded 4-chars/tok + 2500-tok/img
    // Operator can tell at a glance if the number is grounded or guessed.
    const fit = s.cost_fit;
    const regime = document.getElementById('m_pct_regime');
    if (!fit) {
      // Headline shows a wide range from FALLBACK_ALPHA brackets — make it
      // explicit that we're calibrating, not claiming a precise number.
      regime.textContent = 'calibrating · need 3+ cold-miss samples for empirical α';
      regime.style.color = '#d29922'; // amber: be skeptical
    } else {
      // Show text_cv as a percentage so the operator can judge α-confidence
      // at a glance: >=5% is robust, 1-5% is thin but measured, <1% is
      // essentially a mean-ratio estimator. Same number on both modes
      // since they use the same residual signal.
      const cvPct = (fit.text_cv * 100).toFixed(1);
      if (fit.mode === 'joint') {
        const tier = fit.n >= 10 ? 'high' : 'tentative';
        regime.textContent =
          \`empirical · joint OLS (n=\${fit.n}, text CV \${cvPct}%, \${tier})\`;
        regime.style.color = fit.n >= 10 ? '#3fb950' : '#d29922';
      } else {
        // Constrained mode: color tracks text_cv since β is pinned and
        // confidence in the headline depends on text variance alone.
        const robust = fit.text_cv >= 0.05;
        const thin = fit.text_cv >= 0.01;
        regime.textContent =
          \`constrained · α-only (n=\${fit.n}, text CV \${cvPct}%, β pinned 1/750)\`;
        regime.style.color = robust ? '#58a6ff' : (thin ? '#d29922' : '#8b949e');
      }
    }
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
        \`<td class="num">\${numFmt(e.expected_image_tokens || 0)}</td>\` +
        \`<td class="num">\${numFmt(e.effective_actual || 0)}</td>\` +
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
// Renders the "show calculation" blocks beneath each savings card. Every
// number on the headline cards can be derived from one of these panels.
// No estimation hidden behind a black box — operator can copy the values
// into a calculator and reproduce the headline byte-identically.
function renderSavingsMath(s) {
  const pa = s.pricing_assumptions || {};
  const haveMeasured = typeof s.saved_pct_measured === 'number' && (s.measured_events || 0) > 0;

  // ---- tokens-saved card --------------------------------------------------
  // effective_cost = input + cache_create×1.25 + cache_read×0.10 + output×5
  //                  ↑ summed per request, weighted by Anthropic's rate table
  // saved_tokens   = baseline_total − actual_total
  const savedTokensRows = [
    fmtRow('actual_paid', s.effective_cost_actual, '(input + cc·1.25 + cr·0.10 + out·5)'),
    fmtRow('baseline_est', s.effective_cost_baseline, '(actual + α·compressed_chars × rate)'),
    fmtRow('saved', s.saved_effective_tokens, '<span class="op">=</span> baseline − actual'),
  ];
  if (typeof s.saved_pct_low === 'number' && typeof s.saved_pct_high === 'number') {
    savedTokensRows.push(fmtRow(
      'range', \`\${s.saved_pct_low}% – \${s.saved_pct_high}%\`,
      '(low/high bounds from recent traffic\\'s chars-per-token spread)'
    ));
  }
  document.getElementById('m_saved_math').innerHTML =
    '<div><span class="k">formula:</span> <span class="v">saved = baseline − actual</span></div>'
    + '<div><span class="k">weights:</span> <span class="v">input ×1.0, cc ×1.25, cr ×0.10, output ×5.0</span></div>'
    + '<div style="height:6px"></div>'
    + savedTokensRows.join('')
    + '<span class="src">numbers in effective tokens, multiply by per-Mtok rate for $</span>';

  // ---- $ saved card -------------------------------------------------------
  const inRate = pa.input_per_mtok;
  const outMult = pa.output_multiplier;
  const usdRows = [
    fmtRow('saved_tokens', s.saved_effective_tokens, '(effective, full bill)'),
    fmtRow('input_rate', \`$\${inRate}/Mtok\`, '(Opus 4.7 base input)'),
    fmtRow('saved_usd',
           \`$\${(s.saved_usd_estimated || 0).toFixed(4)}\`,
           '<span class="op">=</span> saved_tokens × input_rate / 1e6'),
  ];
  document.getElementById('m_usd_math').innerHTML =
    '<div><span class="k">formula:</span> <span class="v">$ = saved_tokens × $'
      + inRate + '/Mtok</span></div>'
    + '<div><span class="k">rate ratios:</span> <span class="v">'
      + 'output ×' + outMult + ', 5m cache write ×' + pa.cache_write_5m_multiplier
      + ', 1h cache write ×' + pa.cache_write_1h_multiplier
      + ', cache read ×' + pa.cache_read_multiplier
      + '</span></div>'
    + '<div style="height:6px"></div>'
    + usdRows.join('')
    + '<span class="src">source: ' + escapeHtml(pa.source || 'docs.anthropic.com pricing') + '</span>';

  // ---- reduction (%) card -------------------------------------------------
  const pctRows = [];
  if (haveMeasured) {
    pctRows.push(fmtRow('baseline_tokens', s.effective_cost_baseline_measured,
                        '(count_tokens on pre-transform body, summed)'));
    pctRows.push(fmtRow('actual_tokens', s.effective_cost_actual_measured,
                        '(count_tokens on post-transform body, summed)'));
    pctRows.push(fmtRow('saved_tokens', s.saved_effective_tokens_measured,
                        '<span class="op">=</span> baseline − actual'));
    pctRows.push(fmtRow('saved_pct', s.saved_pct_measured + '%',
                        '<span class="op">=</span> saved / baseline × 100'));
    pctRows.push(fmtRow('measured_events', s.measured_events,
                        '(events where count_tokens succeeded on both bodies)'));
  } else {
    pctRows.push(fmtRow('baseline_est', s.effective_cost_baseline,
                        '(α × compressed_chars × cache-mix-rate, summed)'));
    pctRows.push(fmtRow('actual_paid', s.effective_cost_actual, '(weighted upstream usage, summed)'));
    pctRows.push(fmtRow('saved', s.saved_effective_tokens,
                        '<span class="op">=</span> baseline − actual'));
    pctRows.push(fmtRow('saved_pct', s.saved_pct + '%',
                        '<span class="op">=</span> saved / baseline × 100'));
    if (typeof s.saved_pct_low === 'number' && typeof s.saved_pct_high === 'number') {
      pctRows.push(fmtRow('range', \`\${s.saved_pct_low}% – \${s.saved_pct_high}%\`,
                          '(low/high bounds from recent traffic\\'s chars-per-token spread)'));
    }
  }
  // Image-cost formula reference — applies on the actual side because
  // each image we emit costs ~width×height/750 tokens upstream.
  const imgFormula =
    '<div><span class="k">image cost:</span> <span class="v">tokens ≈ width × height / 750</span>'
      + ' <span class="k">(per docs-vision)</span></div>';
  document.getElementById('m_pct_math').innerHTML =
    '<div><span class="k">formula:</span> <span class="v">'
      + 'saved_pct = (baseline − actual) / baseline × 100</span></div>'
    + imgFormula
    + '<div style="height:6px"></div>'
    + pctRows.join('')
    + '<span class="src">'
      + (haveMeasured
          ? 'measured · count_tokens ground truth, no estimation'
          : 'estimated · α-regression from cold-miss events')
      + '</span>';
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
