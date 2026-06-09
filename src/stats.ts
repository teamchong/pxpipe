/**
 * Aggregate metrics over a stream of TrackEvents. Pure data-layer module —
 * the dashboard's `/api/stats.json` endpoint imports `aggregateEventsFile`
 * + `summaryToJson` from here. There is no longer a CLI entrypoint; the
 * live dashboard at http://127.0.0.1:47821/ surfaces everything this used
 * to print.
 *
 * Node-only (uses node:fs). Streams the file line-by-line so a 100 MB log
 * doesn't blow the heap. The aggregator itself (`newSummary` / `fold`) is
 * pure — fed a sequence of TrackEvents and produces a Summary — so a
 * Workers-side dashboard could reuse it later by extracting it into core/.
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { TrackEvent } from './core/tracker.js';

// ---- pure aggregator ------------------------------------------------------

export interface Summary {
  total: number;
  ok2xx: number;
  err4xx: number;
  err5xx: number;
  compressed: number;
  passthrough: number;
  /** Sum of orig_chars across compressed requests — the bytes we removed
   *  from the text path by rendering to PNG. */
  origCharsTotal: number;
  imageBytesTotal: number;
  /** Aggregated Anthropic token usage. */
  inputTokensTotal: number;
  outputTokensTotal: number;
  cacheCreateTokensTotal: number;
  cacheReadTokensTotal: number;
  /** Number of events whose cache_read_tokens > 0 — i.e. the prompt cache
   *  actually hit. */
  cacheHitEvents: number;
  /** Number of events that carried any usage data at all. Denominator for
   *  cacheHitEvents. */
  eventsWithUsage: number;
  durationMs: number[];
  firstByteMs: number[];
  skipReasons: Map<string, number>;
  byCwd: Map<string, { count: number; origChars: number; imageBytes: number }>;
  /** system_sha8 → number of times seen. High repeat count = cache should
   *  be doing its job. */
  systemShaHist: Map<string, number>;
  unknownTags: Map<string, number>;
}

export function newSummary(): Summary {
  return {
    total: 0,
    ok2xx: 0,
    err4xx: 0,
    err5xx: 0,
    compressed: 0,
    passthrough: 0,
    origCharsTotal: 0,
    imageBytesTotal: 0,
    inputTokensTotal: 0,
    outputTokensTotal: 0,
    cacheCreateTokensTotal: 0,
    cacheReadTokensTotal: 0,
    cacheHitEvents: 0,
    eventsWithUsage: 0,
    durationMs: [],
    firstByteMs: [],
    skipReasons: new Map(),
    byCwd: new Map(),
    systemShaHist: new Map(),
    unknownTags: new Map(),
  };
}

export function fold(s: Summary, ev: TrackEvent): Summary {
  s.total++;
  if (ev.status >= 200 && ev.status < 300) s.ok2xx++;
  else if (ev.status >= 400 && ev.status < 500) s.err4xx++;
  else if (ev.status >= 500) s.err5xx++;

  if (ev.compressed === true) {
    s.compressed++;
    if (typeof ev.orig_chars === 'number') s.origCharsTotal += ev.orig_chars;
    if (typeof ev.image_bytes === 'number') s.imageBytesTotal += ev.image_bytes;
  } else if (ev.compressed === false) {
    s.passthrough++;
    if (ev.reason) s.skipReasons.set(ev.reason, (s.skipReasons.get(ev.reason) ?? 0) + 1);
  }

  if (typeof ev.duration_ms === 'number') s.durationMs.push(ev.duration_ms);
  if (typeof ev.first_byte_ms === 'number') s.firstByteMs.push(ev.first_byte_ms);

  const hasUsage =
    typeof ev.input_tokens === 'number' ||
    typeof ev.cache_read_tokens === 'number' ||
    typeof ev.cache_create_tokens === 'number' ||
    typeof ev.output_tokens === 'number';
  if (hasUsage) {
    s.eventsWithUsage++;
    s.inputTokensTotal += ev.input_tokens ?? 0;
    s.outputTokensTotal += ev.output_tokens ?? 0;
    s.cacheCreateTokensTotal += ev.cache_create_tokens ?? 0;
    s.cacheReadTokensTotal += ev.cache_read_tokens ?? 0;
    if ((ev.cache_read_tokens ?? 0) > 0) s.cacheHitEvents++;
  }

  if (ev.cwd) {
    const k = ev.cwd;
    const e = s.byCwd.get(k) ?? { count: 0, origChars: 0, imageBytes: 0 };
    e.count++;
    e.origChars += ev.orig_chars ?? 0;
    e.imageBytes += ev.image_bytes ?? 0;
    s.byCwd.set(k, e);
  }

  if (ev.system_sha8) {
    s.systemShaHist.set(ev.system_sha8, (s.systemShaHist.get(ev.system_sha8) ?? 0) + 1);
  }

  if (ev.unknown_static_tags) {
    for (const t of ev.unknown_static_tags) {
      s.unknownTags.set(t, (s.unknownTags.get(t) ?? 0) + 1);
    }
  }

  return s;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

/** Format a number with thousands separators. Used for big token counts. */
function fmtN(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtPct(num: number, denom: number): string {
  if (denom === 0) return '   —';
  return ((num / denom) * 100).toFixed(1).padStart(4) + '%';
}

// ---- text report ----------------------------------------------------------

export function renderTextReport(s: Summary): string {
  const lines: string[] = [];
  const sortedDur = [...s.durationMs].sort((a, b) => a - b);
  const sortedFB = [...s.firstByteMs].sort((a, b) => a - b);

  lines.push('━━━ pxpipe stats ━━━');
  lines.push('');
  lines.push(`requests:       ${fmtN(s.total)}`);
  lines.push(
    `  2xx:          ${fmtN(s.ok2xx).padStart(8)}   ` +
      `4xx: ${fmtN(s.err4xx).padStart(6)}   5xx: ${fmtN(s.err5xx).padStart(6)}`,
  );
  lines.push(
    `  compressed:   ${fmtN(s.compressed).padStart(8)}  (${fmtPct(s.compressed, s.total)})`,
  );
  lines.push(
    `  passthrough:  ${fmtN(s.passthrough).padStart(8)}  (${fmtPct(s.passthrough, s.total)})`,
  );
  lines.push('');

  lines.push('latency (ms):');
  lines.push(
    `  duration  p50=${percentile(sortedDur, 50)}  p95=${percentile(sortedDur, 95)}  p99=${percentile(sortedDur, 99)}`,
  );
  lines.push(
    `  first-byte p50=${percentile(sortedFB, 50)}  p95=${percentile(sortedFB, 95)}  p99=${percentile(sortedFB, 99)}`,
  );
  lines.push('');

  lines.push('compression:');
  lines.push(`  orig text rendered: ${fmtN(s.origCharsTotal)} chars`);
  lines.push(`  image bytes:        ${fmtN(s.imageBytesTotal)} B`);
  const ratio =
    s.origCharsTotal > 0 ? (s.imageBytesTotal / s.origCharsTotal).toFixed(3) : '—';
  lines.push(`  bytes/char ratio:   ${ratio}`);
  lines.push('');

  lines.push('Anthropic token usage:');
  lines.push(`  input:         ${fmtN(s.inputTokensTotal).padStart(12)}`);
  lines.push(`  output:        ${fmtN(s.outputTokensTotal).padStart(12)}`);
  lines.push(`  cache create:  ${fmtN(s.cacheCreateTokensTotal).padStart(12)}`);
  lines.push(`  cache read:    ${fmtN(s.cacheReadTokensTotal).padStart(12)}`);
  const totalIn =
    s.inputTokensTotal + s.cacheCreateTokensTotal + s.cacheReadTokensTotal;
  lines.push(
    `  cache hit rate (by tokens):  ${fmtPct(s.cacheReadTokensTotal, totalIn)}`,
  );
  lines.push(
    `  cache hit rate (by events):  ${fmtPct(s.cacheHitEvents, s.eventsWithUsage)}`,
  );
  lines.push('');

  if (s.skipReasons.size > 0) {
    lines.push('top skip reasons:');
    const top = [...s.skipReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [reason, count] of top) {
      lines.push(`  ${count.toString().padStart(6)}  ${reason}`);
    }
    lines.push('');
  }

  if (s.byCwd.size > 0) {
    lines.push('top working dirs (by request count):');
    const top = [...s.byCwd.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 10);
    for (const [cwd, e] of top) {
      const cratio = e.origChars > 0 ? (e.imageBytes / e.origChars).toFixed(2) : '—';
      lines.push(`  ${e.count.toString().padStart(6)}  ratio=${cratio}  ${cwd}`);
    }
    lines.push('');
  }

  if (s.systemShaHist.size > 0) {
    lines.push('top system prompts (system_sha8, high count = cache reuse):');
    const top = [...s.systemShaHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [sha, count] of top) {
      lines.push(`  ${count.toString().padStart(6)}  ${sha}`);
    }
    const unique = s.systemShaHist.size;
    const reuseRate =
      s.total > 0 ? (((s.total - unique) / s.total) * 100).toFixed(1) : '—';
    lines.push(`  unique prompts: ${unique}    reuse rate: ${reuseRate}%`);
    lines.push('');
  }

  if (s.unknownTags.size > 0) {
    lines.push('⚠  unknown tag-shaped blocks observed in static slab:');
    const top = [...s.unknownTags.entries()].sort((a, b) => b[1] - a[1]);
    for (const [tag, count] of top) {
      lines.push(`  ${count.toString().padStart(6)}  <${tag}>`);
    }
    lines.push(
      '  → consider adding these to DYNAMIC_BLOCK_TAGS in src/core/transform.ts',
    );
    lines.push('');
  }

  return lines.join('\n');
}

// ---- file-backed aggregation (used by the dashboard) ----------------------

/**
 * Stream an events JSONL file and fold every row into a Summary. Returns the
 * Summary plus a parsed/dropped tally so callers can detect empty/garbage
 * inputs. The dashboard wraps this for the /api/stats.json endpoint.
 *
 * Note: this is a full re-read on every call. The dashboard already has a
 * 50-event ring buffer of the *recent* slice; stats need the full history
 * to compute cache-hit-rate over thousands of requests. ~1.5 MB JSONL
 * streams in well under 100 ms on an SSD.
 */
export async function aggregateEventsFile(
  file: string,
): Promise<{ summary: Summary; parsed: number; dropped: number } | undefined> {
  if (!fs.existsSync(file)) return undefined;
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const summary = newSummary();
  let parsed = 0;
  let dropped = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as TrackEvent;
      fold(summary, ev);
      parsed++;
    } catch {
      dropped++;
    }
  }
  return { summary, parsed, dropped };
}

/**
 * Convert a Summary to a JSON-serializable shape for the dashboard's
 * /api/stats.json endpoint. JSON.stringify drops Map entries silently, so
 * we materialize the top-N entries of each map into plain [key, value]
 * tuples. Caps each map at 20 entries to keep the response bounded.
 */
export function summaryToJson(s: Summary): Record<string, unknown> {
  const topN = <K, V>(m: Map<K, V>, n = 20): [K, V][] =>
    [...m.entries()].slice(0, n);
  const sortedDur = [...s.durationMs].sort((a, b) => a - b);
  const sortedFB = [...s.firstByteMs].sort((a, b) => a - b);
  return {
    total: s.total,
    ok2xx: s.ok2xx,
    err4xx: s.err4xx,
    err5xx: s.err5xx,
    compressed: s.compressed,
    passthrough: s.passthrough,
    origCharsTotal: s.origCharsTotal,
    imageBytesTotal: s.imageBytesTotal,
    inputTokensTotal: s.inputTokensTotal,
    outputTokensTotal: s.outputTokensTotal,
    cacheCreateTokensTotal: s.cacheCreateTokensTotal,
    cacheReadTokensTotal: s.cacheReadTokensTotal,
    cacheHitEvents: s.cacheHitEvents,
    eventsWithUsage: s.eventsWithUsage,
    durationP50: percentile(sortedDur, 50),
    durationP95: percentile(sortedDur, 95),
    firstByteP50: percentile(sortedFB, 50),
    firstByteP95: percentile(sortedFB, 95),
    skipReasons: topN(s.skipReasons),
    byCwd: topN(s.byCwd),
    systemShaHist: topN(s.systemShaHist),
    unknownTags: topN(s.unknownTags),
  };
}
