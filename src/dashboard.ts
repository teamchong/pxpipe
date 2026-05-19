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
 *  replay() is called to seed from the JSONL file. */
interface Totals {
  requests: number;
  compressedRequests: number;
  /** Sum of weighted-token cost we actually paid upstream. */
  effectiveInputActual: number;
  /** Sum of estimated cost if we had NOT compressed. */
  effectiveInputBaselineEst: number;
  startedAt: number;
}

/** Empirical per-image token cost (Opus 4.x at our typical 808×1568 render).
 *  history-researcher's round-3 measurement on N=33 cold-miss events from
 *  events.jsonl (2026-05-18) found the real billable cost averages
 *  ~2,300–2,750 tokens per image; we use 2,500 as the working constant.
 *
 *  The documented theoretical max (Anthropic's published `(w*h)/750`
 *  formula) gives ~1,690 tokens for our render shape and underpredicts
 *  what we actually get billed. The prior implementation here was even
 *  more optimistic — `pngBytes / 375` came out to ~190 tokens, off by
 *  ~12×. That bug made the dashboard's "saved" column wildly overstate
 *  the actual cost reduction.
 *
 *  See /tmp/pixelpipe-history-compression.md for the analysis. */
const OPUS_IMAGE_TOKEN_COST = 2500;

/** Estimated token cost of the N images we emit per compressed request.
 *  When the dashboard has accumulated ≥3 cold-miss samples with the new
 *  instrumentation, prefer `imagePixels × β` (live empirical rate) over
 *  the stale flat constant — the constant was measured on Opus pre-4.7
 *  with single-col 508×1559 PNGs, and is wrong by ~3× under multi-col 2. */
function estImageTokens(
  imageCount: number,
  imagePixels: number,
  beta: number | null,
): number {
  if (beta !== null && imagePixels > 0) return Math.round(imagePixels * beta);
  return imageCount * OPUS_IMAGE_TOKEN_COST;
}

/** Compute the weighted "effective" input cost of a single upstream call.
 *  Matches Python's formula: input + cache_create*1.25 + cache_read*0.10.
 *  cache_create is billed at 1.25× to amortize the first-turn cost; cache_read
 *  at 0.10× is Anthropic's published rate. */
function effectiveCost(
  inputTokens: number,
  cacheCreate: number,
  cacheRead: number,
): number {
  return inputTokens + cacheCreate * 1.25 + cacheRead * 0.1;
}

/** Estimate what the call WOULD have cost if we hadn't compressed. Adds back
 *  the text tokens we removed (minus the image tokens we added) at the SAME
 *  cache mix the actual call paid — otherwise cold-cache turns get scored as
 *  if the baseline were warm-cache and savings look tiny.
 *
 *  Uses `imageCount × OPUS_IMAGE_TOKEN_COST` (=2500/image, empirical from
 *  N=33 cold-miss events 2026-05-18) to estimate image tokens. Prior
 *  implementation used `pngBytes / 375` ≈ 190 tokens/image — wrong by
 *  ~12×, which made the "saved" column wildly overstate cost reduction.
 *  See estImageTokens() above for the analysis link.
 */
function baselineCost(
  actualEff: number,
  compressedChars: number,
  imageCount: number,
  imagePixels: number,
  cacheCreate: number,
  cacheRead: number,
  fit: { alpha: number; beta: number } | null,
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
  const txtReplaced = fit
    ? Math.floor(compressedChars * fit.alpha)
    : Math.floor(compressedChars / 4);
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
    effectiveInputActual: 0,
    effectiveInputBaselineEst: 0,
    startedAt: Date.now() / 1000,
  };
  private latestPng: Uint8Array | null = null;
  private latestPngMeta = '';
  private latestPngWidth = 0;
  private latestPngHeight = 0;
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

    const eff = haveUsage ? effectiveCost(inp, cc, cr) : 0;
    // Pull the current empirical fit BEFORE recording — when this event is
    // itself a cold miss it'll feed back into the next request's fit, but
    // for this baseline calc we use whatever rate we have so far. Null
    // until ≥3 cold-miss samples accumulate; baselineCost falls back to
    // the stale constants in that case.
    const fit = this.fitCosts();
    const imgPx = (info as { imagePixels?: number } | undefined)?.imagePixels ?? 0;
    const baselineEff =
      haveUsage && compressed
        ? baselineCost(
            eff,
            info?.compressedChars ?? 0,
            info?.imageCount ?? 0,
            imgPx,
            cc,
            cr,
            fit ? { alpha: fit.alpha, beta: fit.beta } : null,
          )
        : eff;

    const prevSaved = this.totals.effectiveInputBaselineEst - this.totals.effectiveInputActual;
    this.totals.requests += 1;
    if (compressed) this.totals.compressedRequests += 1;
    this.totals.effectiveInputActual += eff;
    this.totals.effectiveInputBaselineEst += baselineEff;
    const savedNow = this.totals.effectiveInputBaselineEst - this.totals.effectiveInputActual;

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
    beta: number;
    chars_per_token: number;
    pixels_per_token: number;
    single_col_tokens_per_img: number;
    multicol2_tokens_per_img: number;
    n: number;
    mode: 'joint' | 'constrained';
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
    const MIN_CV = 0.05;

    // Anthropic's published per-pixel rate for the default image tiling:
    // 1 token per ~750 pixels (≈ 0.001333). Used by the constrained fallback
    // when the live pixels column doesn't vary enough for joint OLS to
    // identify β separately. See the THREE-MODE LADDER docstring above.
    const ANTHROPIC_BETA = 1 / 750;

    // ---- Mode 1: joint OLS (both columns vary) ----
    if (cvX >= MIN_CV && cvP >= MIN_CV) {
      const det = sxx * syy - sxy * sxy;
      if (det !== 0) {
        const alpha = (syy * sxt - sxy * syt) / det;
        const beta = (sxx * syt - sxy * sxt) / det;
        // Guard against degenerate fits (negative rates mean the data is too
        // noisy / multi-modal to give a clean linear answer).
        if (alpha > 0 && beta > 0) {
          return {
            alpha: round4(alpha),
            beta: round4(beta * 1000) / 1000, // β is tiny — keep 6 sig figs effectively
            chars_per_token: round1(1 / alpha),
            pixels_per_token: Math.round(1 / beta),
            single_col_tokens_per_img: Math.round(508 * 1559 * beta),
            multicol2_tokens_per_img: Math.round(1028 * 1559 * beta),
            n,
            mode: 'joint',
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
    if (cvX < MIN_CV || sxx === 0) return null;
    const alphaConstrained = (sxt - ANTHROPIC_BETA * sxy) / sxx;
    if (alphaConstrained <= 0) return null;
    return {
      alpha: round4(alphaConstrained),
      beta: round4(ANTHROPIC_BETA * 1000) / 1000,
      chars_per_token: round1(1 / alphaConstrained),
      pixels_per_token: Math.round(1 / ANTHROPIC_BETA),
      single_col_tokens_per_img: Math.round(508 * 1559 * ANTHROPIC_BETA),
      multicol2_tokens_per_img: Math.round(1028 * 1559 * ANTHROPIC_BETA),
      n,
      mode: 'constrained',
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
    const saved = this.totals.effectiveInputBaselineEst - this.totals.effectiveInputActual;
    const pct =
      this.totals.effectiveInputBaselineEst > 0
        ? (saved / this.totals.effectiveInputBaselineEst) * 100
        : 0;
    const uptimeSec = Date.now() / 1000 - this.totals.startedAt;
    const payload = {
      requests: this.totals.requests,
      compressed_requests: this.totals.compressedRequests,
      effective_input_actual: round1(this.totals.effectiveInputActual),
      effective_input_baseline_est: round1(this.totals.effectiveInputBaselineEst),
      saved_effective_tokens: round1(saved),
      saved_pct: round1(pct),
      saved_usd_opus47: round4((saved * 15.0) / 1e6),
      uptime_sec: uptimeSec,
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
    });
    return jsonResponse(report);
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

<div class="grid">
  <div class="card"><div class="label">requests</div>
    <div class="value" id="m_req">0</div>
    <div class="small" id="m_req_sub">— compressed</div>
  </div>
  <div class="card"><div class="label">tokens saved</div>
    <div class="value pos" id="m_saved">0</div>
    <div class="small" id="m_saved_sub">effective input tokens</div>
  </div>
  <div class="card"><div class="label">$ saved (opus 4.7)</div>
    <div class="value pos" id="m_usd">$0.00</div>
    <div class="small" id="m_usd_sub">at $15/M input tokens</div>
  </div>
  <div class="card"><div class="label">reduction</div>
    <div class="value pos" id="m_pct">0%</div>
    <div class="small" id="m_pct_sub">vs uncompressed baseline</div>
    <div class="small" id="m_pct_regime" style="margin-top:4px;color:#6e7681"></div>
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
  <table>
    <thead>
      <tr>
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
    document.getElementById('m_req').textContent = s.requests;
    document.getElementById('m_req_sub').textContent = \`\${s.compressed_requests} compressed\`;
    document.getElementById('m_saved').textContent = numFmt(s.saved_effective_tokens);
    document.getElementById('m_saved_sub').textContent =
      \`\${numFmt(s.effective_input_actual)} paid · \${numFmt(s.effective_input_baseline_est)} baseline\`;
    document.getElementById('m_usd').textContent = \`$\${s.saved_usd_opus47.toFixed(4)}\`;
    document.getElementById('m_pct').textContent = \`\${s.saved_pct.toFixed(1)}%\`;
    // Surface which cost-model regime the headline number came from. Three
    // states (mirror the THREE-MODE LADDER in dashboard.ts fitCosts):
    //   joint        — α and β both measured (≥10 samples = high confidence)
    //   constrained  — α measured, β pinned to Anthropic's 1/750
    //   stale        — no fit yet, using hardcoded 4-chars/tok + 2500-tok/img
    // Operator can tell at a glance if the number is grounded or guessed.
    const fit = s.cost_fit;
    const regime = document.getElementById('m_pct_regime');
    if (!fit) {
      regime.textContent = 'stale constants (no fit yet)';
      regime.style.color = '#d29922'; // amber: be skeptical
    } else if (fit.mode === 'joint') {
      const tier = fit.n >= 10 ? 'high' : 'tentative';
      regime.textContent = \`empirical · joint OLS (n=\${fit.n}, \${tier})\`;
      regime.style.color = fit.n >= 10 ? '#3fb950' : '#d29922';
    } else {
      regime.textContent = \`constrained · α-only (n=\${fit.n}, β pinned 1/750)\`;
      regime.style.color = '#58a6ff'; // blue: measured but partial
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

// ---- session table: diff-render row by row -------------------------------
//
// Smooth updates: keep a Map<id, <tr>> across ticks. On each refresh we walk
// the new sessions list and update text in-place when an id already has a
// row; rows for vanished ids are removed; new ids get appended in last_seen
// order. This avoids the visible flash that an innerHTML wipe would cause.
const sessRowEls = new Map();

function sessRowHtml(s) {
  const cc = s.claudeCode;
  const ccLabel = cc
    ? '<span title="' + escapeHtml(cc.projectPath) + '/' + escapeHtml(cc.sessionId) + '">'
      + escapeHtml(cc.sessionId.slice(0,8)) + '...</span>'
    : '<span style="color:#6e7681">-</span>';
  const disk = fmtBytes((s.jsonlBytes||0) + (s.sidecarBytes||0));
  const projShort = s.project ? escapeHtml(shortPath(s.project)) : '<span style="color:#6e7681">-</span>';
  return ''
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
// One delegated listener handles every row's del button. Survives diff renders.
document.getElementById('sess_rows').addEventListener('click', (ev) => {
  const t = ev.target;
  if (t && t.dataset && t.dataset.del) deleteSession(t.dataset.del);
});

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
