/**
 * Anonymized event shapes extracted from production `events.jsonl`.
 *
 * Source: a real Claude Code session against pxpipe, 2026-05-19 → 2026-05-20.
 * Each fixture captures the *shape* of an event (orig_chars, image_count,
 * baseline_tokens, gate decision) without any user content. Tests rebuild
 * synthetic text that matches the density (chars/row, lines-per-image) and
 * assert the gate makes the same accept/reject decision.
 *
 * ## Why these matter
 *
 * `SLAB_CHARS_PER_TOKEN = 2.0` and `HISTORY_CHARS_PER_TOKEN = 2.0` are frozen
 * empirical fits from Opus 4.7 production samples. The synthetic `'A'.repeat(N)` shapes
 * elsewhere in the suite prove the *math* is wired correctly; these prove the
 * *constants* still match real Claude Code traffic. If a future model variant
 * (Sonnet 4.6 vs Opus 4.7) tokenizes differently and the textbook 4 chars/token
 * rule drifts even further, these fixtures will be the first to fail.
 *
 * ## How to refresh
 *
 * Run `scripts/extract-real-shapes.ts` (TODO) against a fresh `events.jsonl`
 * and update the constants below. Keep the comment block above each shape
 * pointing to the date range and event count it represents.
 */

export interface RealShape {
  /** Human-readable label for test output. */
  readonly name: string;
  /** Total source text chars across system + tool docs + history slabs that hit the call site. */
  readonly origChars: number;
  /** Static `numCols` setting that was active when the event was recorded. */
  readonly numCols: number;
  /** Approximate average chars per text-row (after `renderTextToPngs` wraps at `cols`). */
  readonly approxCharsPerRow: number;
  /** What the gate decided. `'accept'` = compress; `'reject'` = pass through as text. */
  readonly decision: 'accept' | 'reject';
  /** Which gate path fired. `'slab'` uses `SLAB_CHARS_PER_TOKEN`, `'history'` uses `HISTORY_CHARS_PER_TOKEN`. */
  readonly gate: 'slab' | 'history';
  /** What `count_tokens` measured (Anthropic's billing oracle for the unproxied body). */
  readonly baselineTokens?: number;
  /** Source event date for traceability. */
  readonly capturedAt: string;
}

/**
 * The production-shape slab that motivated the `e8545a9` fix.
 *
 * Before the fix: gate used the textbook `chars/token=4` and rejected dense
 * Claude Code slabs because it under-counted text cost. The current Opus-4.7
 * gate uses `SLAB_CHARS_PER_TOKEN = 2.0`, which remains a lower-bound
 * estimate versus real `count_tokens` (~99k tokens for this body, cpt≈1.62)
 * while making this shape a clear ACCEPT. We compress when we know we'll win;
 * we don't risk net-losers.
 */
export const PRODUCTION_SLAB_161K: RealShape = {
  name: 'production slab (161k chars, multi-col)',
  origChars: 161101,
  numCols: 2,
  approxCharsPerRow: 52, // 8 images × 195 lines/image × 2 cols ≈ 3120 rows
  decision: 'accept',
  gate: 'slab',
  baselineTokens: 99478,
  capturedAt: '2026-05-20',
};

/**
 * Newline-heavy code/tool-doc slab (~135k chars, ~19 chars/row).
 *
 * Same call site as `PRODUCTION_SLAB_161K` but very different text shape:
 * lots of short lines (function signatures, JSON keys). Image count grows
 * because each newline forces a visual row even at cols=100.
 *
 * ## Synthetic vs real divergence
 *
 * The production event for this shape was compressed (gate accepted), but
 * the synthetic `'A'.repeat(19)` lines we generate from the shape don't
 * capture the real density. The synthetic form still overruns the text-token
 * budget under the conservative cpt=2.0 gate, so it REJECTS.
 *
 * The fixture pins the gate's decision on the *synthetic* shape, not the
 * production outcome. Real text at this density (mixed line lengths, dense
 * monospace runs) packed into fewer rows than uniform `'A'` lines do. If a
 * future renderer/atlas change flips this synthetic shape to ACCEPT, the
 * fixture will fire and we can decide whether the change is intended.
 */
export const PRODUCTION_SLAB_135K_DENSE: RealShape = {
  name: 'production slab (135k chars, newline-heavy)',
  origChars: 130665,
  numCols: 2,
  approxCharsPerRow: 19, // ~6877 rows → ~18 images at 195 lines/image × 2 cols
  decision: 'reject',
  gate: 'slab',
  capturedAt: '2026-05-20',
};

/**
 * The largest production slab we have data for. ~16 chars/row — almost all
 * newlines (deeply nested JSON or tabular tool output).
 *
 * At cpt=4 textbook estimate the text is badly undercounted; even at the
 * current conservative cpt=2.0, this newline-heavy synthetic shape still
 * REJECTS under the gate's image-cost math, and production confirms
 * this: the event has `compressed=true` because by the time the slab grew
 * that large the *real* token count (count_tokens ≈ image_cost) had crossed
 * over. The gate is conservative; the regression test pins that the gate
 * stays conservative on this shape.
 */
export const PRODUCTION_SLAB_169K_HEAVY: RealShape = {
  name: 'production slab (169k chars, very dense)',
  origChars: 169632,
  numCols: 2,
  approxCharsPerRow: 16, // ~10602 rows → ~28 images at 195 lines/image × 2 cols
  // At numCols=2 the gate uses `numCols × imageCount × 5500` so the threshold
  // doubles — and even the built-in 2.0 cpt estimate doesn't clear it. Pass-through.
  decision: 'reject',
  gate: 'slab',
  capturedAt: '2026-05-20',
};

/**
 * Tiny request below `MIN_COMPRESS_CHARS` (default 2000). Should skip the
 * gate entirely via the pre-filter — exposed here so the integration test
 * can confirm the pre-filter still fires before the gate sees these shapes.
 *
 * These ~140-char events come from cache-warm follow-up turns where the
 * static slab is already cached and the only fresh content is the new user
 * message.
 */
export const BELOW_MIN_CHARS_TINY: RealShape = {
  name: 'below MIN_COMPRESS_CHARS (tiny user turn)',
  origChars: 142,
  numCols: 2,
  approxCharsPerRow: 60,
  decision: 'reject', // pre-filter, not the gate
  gate: 'slab',
  capturedAt: '2026-05-20',
};

/**
 * Borderline below-threshold (1123 chars). Confirms the 2000-char cutoff
 * actually fires at this size and isn't accidentally letting it through to
 * the gate.
 */
export const BELOW_MIN_CHARS_BORDERLINE: RealShape = {
  name: 'below MIN_COMPRESS_CHARS (borderline)',
  origChars: 1123,
  numCols: 2,
  approxCharsPerRow: 60,
  decision: 'reject', // pre-filter
  gate: 'slab',
  capturedAt: '2026-05-19',
};

/**
 * Long-running session where the closed-prefix history grew past the
 * 4-breakpoint cache cliff. The collapsed body folded 549 turns
 * (537k chars) into one synthetic prepended user message + image block.
 *
 * Pinned here so the regression test confirms the `historyReason:
 * 'collapsed'` path stays healthy under `HISTORY_CHARS_PER_TOKEN = 2.0`.
 * Same workload as the slab fix; this exercises the *different* call site.
 */
export const HISTORY_COLLAPSED_LONG_SESSION: RealShape = {
  name: 'history collapsed (549 turns, 537k chars)',
  origChars: 161101, // post-collapse static slab size
  numCols: 2,
  approxCharsPerRow: 52,
  decision: 'accept',
  gate: 'history',
  baselineTokens: 389587,
  capturedAt: '2026-05-20',
};

/** Every real shape in one array for parameterised tests. */
export const ALL_REAL_SHAPES: readonly RealShape[] = [
  PRODUCTION_SLAB_161K,
  PRODUCTION_SLAB_135K_DENSE,
  PRODUCTION_SLAB_169K_HEAVY,
  BELOW_MIN_CHARS_TINY,
  BELOW_MIN_CHARS_BORDERLINE,
  HISTORY_COLLAPSED_LONG_SESSION,
] as const;

/**
 * Build synthetic text that matches a shape's density. Each line is `approxCharsPerRow`
 * 'A' characters long; total length is padded/trimmed to `origChars`. The renderer
 * sees the same row count as the real event (within ±1 row from rounding), which
 * is what the gate's image-count math actually keys off.
 */
export function synthesizeText(shape: RealShape): string {
  if (shape.origChars <= 0) return '';
  const lineLen = Math.max(1, shape.approxCharsPerRow);
  const line = 'A'.repeat(lineLen);
  const parts: string[] = [];
  let acc = 0;
  while (acc < shape.origChars) {
    const remaining = shape.origChars - acc;
    if (remaining <= lineLen) {
      parts.push('A'.repeat(remaining));
      acc += remaining;
    } else {
      parts.push(line);
      acc += lineLen + 1; // +1 for the \n
    }
  }
  let out = parts.join('\n');
  // Trim/pad to exact char count
  if (out.length > shape.origChars) out = out.slice(0, shape.origChars);
  else if (out.length < shape.origChars) out += 'A'.repeat(shape.origChars - out.length);
  return out;
}
