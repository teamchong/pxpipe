/**
 * Adaptive chars-per-token (CPT) — the store. NODE ONLY.
 *
 * Reads the events pxpipe already logs (`~/.pxpipe/events.jsonl`), turns them
 * into regression samples, runs the fit (`src/core/cpt-fit.ts`), and hands the
 * proxy a resolver the profitability gate can consult.
 *
 * Split rationale: `core/` must stay Workers-safe (no fs), so all disk access
 * lives here. The Workers build never imports this module and therefore always
 * uses the baked constants — documented, intentional divergence.
 *
 * Two tables are learned:
 *   - per `system_sha8` (a project fingerprint), used when that project has
 *     enough events of its own;
 *   - a pooled GLOBAL table over every event, used as the fallback so a brand-new
 *     project still beats the hand-tuned constant on its first request.
 * Resolution order at the gate: explicit host override → per-project → global →
 * baked constant.
 */

import fs from 'node:fs';
import path from 'node:path';
import { defaultPaths, readEvents } from './sessions.js';
import { fitCpt, type CptSample, type CptFitResult } from './core/cpt-fit.js';
import { ANTHROPIC_PATCH_PX } from './core/anthropic-vision.js';
import type { BucketName } from './core/transform.js';

/**
 * Pixels per visual token, used to price the image half of a logged request.
 *
 * Anthropic bills `⌈w/28⌉ × ⌈h/28⌉` patches, but the event log records only the
 * SUM of `w×h` across a request's images, not their individual dimensions — so
 * the exact per-image ceiling cannot be reconstructed. Dividing total pixels by
 * the patch AREA (28² = 784) is the aggregate form of the same grid.
 *
 * This is exact, not an approximation, for pxpipe's own output: pages are
 * 1568×728, and both edges are whole multiples of 28 (56×26 = 1456 patches;
 * 1568×728/784 = 1456). Residual error only appears for height-shrunk pages
 * whose edges aren't multiples of 28, and is bounded by one patch row/column.
 * (The retired `/750` constant was a ~4% continuous fit to this same grid and
 * over-stated image cost, which biased every learned rate.)
 */
const PIXELS_PER_VISUAL_TOKEN = ANTHROPIC_PATCH_PX * ANTHROPIC_PATCH_PX;

/** Key used for the pooled cross-project table in the state file. */
export const GLOBAL_KEY = '*';

export interface CptState {
  /** Fit results keyed by `system_sha8`, plus GLOBAL_KEY for the pooled table. */
  fits: Map<string, CptFitResult>;
  /** mtimeMs of the events file this was built from (cache key). */
  sourceMtimeMs: number;
  builtAt: string;
}

/** `(bucket, systemSha8?) => learned CPT | undefined`. Undefined = use the default. */
export type CptResolver = (bucket: BucketName, systemSha8?: string) => number | undefined;

/** A resolver that never learns anything — the Workers/default behavior. */
export const NO_CPT: CptResolver = () => undefined;

/**
 * Convert one logged event into a regression sample.
 * Returns null when the row lacks the fields the fit needs.
 *
 * `textTokens` removes the image cost we already know exactly, leaving only the
 * text cost whose density we are trying to learn.
 */
export function sampleFromEvent(ev: {
  bucket_chars?: Partial<Record<BucketName, number>>;
  baseline_tokens?: number;
  image_pixels?: number;
}): CptSample | null {
  const buckets = ev.bucket_chars;
  const baseline = ev.baseline_tokens;
  if (!buckets || typeof baseline !== 'number' || !Number.isFinite(baseline)) return null;

  let totalChars = 0;
  for (const v of Object.values(buckets)) totalChars += typeof v === 'number' ? v : 0;
  if (totalChars <= 0) return null;

  const pixels = typeof ev.image_pixels === 'number' ? ev.image_pixels : 0;
  const textTokens = baseline - pixels / PIXELS_PER_VISUAL_TOKEN;
  // A request whose text cost prices out at ≤0 is a broken/partial row.
  if (!Number.isFinite(textTokens) || textTokens <= 0) return null;

  return { bucketChars: buckets, textTokens };
}

/**
 * Stream the event log and fit every project plus the pooled global table.
 * Never throws on a missing/unreadable log — returns an empty state.
 */
export async function buildCptState(eventsFile?: string): Promise<CptState> {
  const file = eventsFile ?? defaultPaths().eventsFile;
  const fits = new Map<string, CptFitResult>();
  let sourceMtimeMs = 0;
  try {
    sourceMtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return { fits, sourceMtimeMs: 0, builtAt: new Date().toISOString() };
  }

  const bySystem = new Map<string, CptSample[]>();
  const pooled: CptSample[] = [];
  try {
    for await (const { ev } of readEvents(file)) {
      const sample = sampleFromEvent(ev as Parameters<typeof sampleFromEvent>[0]);
      if (!sample) continue;
      pooled.push(sample);
      const key = (ev as { system_sha8?: string }).system_sha8;
      if (key) {
        const list = bySystem.get(key);
        if (list) list.push(sample);
        else bySystem.set(key, [sample]);
      }
    }
  } catch {
    // Partial read still yields a usable (smaller) fit.
  }

  for (const [key, samples] of bySystem) {
    const fit = fitCpt(samples);
    if (Object.keys(fit.cpt).length > 0) fits.set(key, fit);
  }
  const globalFit = fitCpt(pooled);
  if (Object.keys(globalFit.cpt).length > 0) fits.set(GLOBAL_KEY, globalFit);

  return { fits, sourceMtimeMs, builtAt: new Date().toISOString() };
}

/** Persist the learned tables next to the events log, for inspection + the dashboard. */
export function writeCptState(state: CptState, stateFile?: string): void {
  const file = stateFile ?? path.join(path.dirname(defaultPaths().eventsFile), 'cpt-state.jsonl');
  const lines: string[] = [];
  for (const [key, fit] of state.fits) {
    lines.push(
      JSON.stringify({
        system_sha8: key,
        updated_at: state.builtAt,
        n_events: fit.nSamples,
        condition: Number.isFinite(fit.conditionEstimate)
          ? Number(fit.conditionEstimate.toFixed(1))
          : null,
        cpt: fit.cpt,
        rejected: fit.rejected,
      }),
    );
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
  } catch {
    // Persisting is a convenience, never a hard requirement.
  }
}

/** Build a resolver over an already-computed state. Per-project first, then pooled. */
export function resolverFor(state: CptState): CptResolver {
  if (state.fits.size === 0) return NO_CPT;
  return (bucket, systemSha8) => {
    if (systemSha8) {
      const own = state.fits.get(systemSha8)?.cpt[bucket];
      if (typeof own === 'number') return own;
    }
    const pooledCpt = state.fits.get(GLOBAL_KEY)?.cpt[bucket];
    return typeof pooledCpt === 'number' ? pooledCpt : undefined;
  };
}

/**
 * Process-lifetime cached resolver. Refits only when the events file has grown
 * (mtime change) and at most every `minRefitMs`, so a busy proxy never pays the
 * scan cost per request.
 *
 * ponytail: full re-fit over the whole log on refresh, no streaming/incremental
 * update. Logs are ≤ ~1e5 rows and refits are throttled to minutes, so this is
 * milliseconds; switch to an incremental XᵀX accumulator if the log outgrows RAM.
 */
export function createCachedCptResolver(opts?: {
  eventsFile?: string;
  minRefitMs?: number;
  persist?: boolean;
}): { resolver: CptResolver; refresh: () => Promise<CptState | null> } {
  const minRefitMs = opts?.minRefitMs ?? 5 * 60_000;
  let state: CptState | null = null;
  let resolver: CptResolver = NO_CPT;
  let lastAttempt = 0;
  let inFlight: Promise<CptState | null> | null = null;

  const refresh = async (): Promise<CptState | null> => {
    if (inFlight) return inFlight;
    const now = Date.now();
    if (now - lastAttempt < minRefitMs) return state;
    lastAttempt = now;
    inFlight = (async () => {
      try {
        const file = opts?.eventsFile ?? defaultPaths().eventsFile;
        let mtime = 0;
        try {
          mtime = fs.statSync(file).mtimeMs;
        } catch {
          return state;
        }
        if (state && mtime === state.sourceMtimeMs) return state;
        const next = await buildCptState(file);
        state = next;
        resolver = resolverFor(next);
        if (opts?.persist !== false) writeCptState(next);
        return next;
      } catch {
        return state;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  // Indirect so callers keep one stable function identity across refreshes.
  return { resolver: (bucket, sha) => resolver(bucket, sha), refresh };
}
