/**
 * Deterministic risk/route classifier for a single context block, run BEFORE
 * pxpipe's image conversion. Wraps the exact-token extractor with size + density
 * logic and emits a routing decision.
 *
 * The critical guard here is the density fallback (handoff flaw #1): the
 * `image_plus_exact_rescue` lane only saves tokens when exact anchors are SPARSE.
 * If a block is dense with paths/hashes/line-numbers (a diff, a stack dump, a
 * config), the rescue strip approaches the size of the original text — so imaging
 * it AND appending the strip costs more than just keeping it as text. When anchor
 * coverage crosses DENSE_ANCHOR_COVERAGE we route `text_only` instead. Without this
 * the feature is self-defeating on exactly the blocks it's meant to protect.
 */

import {
  extractExactTokens,
  hasSecret,
  type ExactToken,
} from './exact-token-extractor.js';
import { MAX_TOKENS as FACTSHEET_RESCUE_BUDGET } from './factsheet.js';

export type ContextRisk = 'low' | 'medium' | 'high' | 'critical';

export type ContextRoutingDecision =
  | 'text_only'
  | 'image_only'
  | 'image_plus_exact_rescue'
  | 'summary_candidate'
  | 'redact_or_block';

export interface ContextRiskAssessment {
  risk: ContextRisk;
  decision: ContextRoutingDecision;
  reasons: string[];
  exactTokens: ExactToken[];
  /** True when the decision lets pxpipe image the bulk (image_only / image_plus_exact_rescue). */
  compressible: boolean;
}

export interface ClassifierOptions {
  /** Blocks at or under this many chars route `text_only`: below pxpipe's own
   *  break-even (~6k) imaging can't profit anyway, so keep them exact for free.
   *  Default 6000 (matches transform.ts minReminderChars/minToolResultChars). */
  smallBlockChars?: number;
  /** Max number of DISTINCT high-risk anchors a large block may carry and still be
   *  imaged. The rescue mechanism (pxpipe's factsheet) preserves at most this many
   *  distinct exact tokens as text next to the image; above it, the overflow anchors
   *  would survive only as (mis-OCR-able) pixels, so the block routes `text_only`.
   *  Defaults to the factsheet's real cap (`MAX_TOKENS`, 64) — this is the measured
   *  gate: it asks the actual rescue's capacity, not a heuristic coverage guess. */
  rescueBudget?: number;
  /** Strict mode: ANY exact anchor forces `text_only` (max fidelity, min savings). */
  strict?: boolean;
}

const DEFAULTS: Required<ClassifierOptions> = {
  smallBlockChars: 6000,
  rescueBudget: FACTSHEET_RESCUE_BUDGET,
  strict: false,
};

/** Kinds that make a block dangerous to image without an exact copy nearby. */
const HIGH_RISK_KINDS = new Set<ExactToken['kind']>([
  'command',
  'path',
  'hash',
  'uuid',
  'line_number',
  'url',
  'version',
  'error_code',
]);

/** Count of DISTINCT values among the given tokens. The factsheet dedupes before it
 *  rescues, so N identical paths cost ONE rescue slot — what matters for "can the
 *  rescue preserve every anchor?" is the distinct count, not the raw occurrence count. */
function distinctValues(tokens: readonly ExactToken[]): number {
  return new Set(tokens.map((t) => t.value)).size;
}

/**
 * Classify a context block. Deterministic, no model calls. Returns the risk level,
 * the routing decision, the exact tokens to preserve, and human-readable reasons.
 */
export function assessContextRisk(
  text: string,
  opts: ClassifierOptions = {},
): ContextRiskAssessment {
  const o = { ...DEFAULTS, ...opts };
  const reasons: string[] = [];

  if (typeof text !== 'string' || text.length === 0) {
    return { risk: 'low', decision: 'text_only', reasons: ['empty_block'], exactTokens: [], compressible: false };
  }

  const exactTokens = extractExactTokens(text);
  const highRiskTokens = exactTokens.filter((t) => HIGH_RISK_KINDS.has(t.kind));

  // 1. Secrets → critical, never image. Redact/block regardless of size.
  if (hasSecret(exactTokens)) {
    reasons.push('secret_like_content');
    return { risk: 'critical', decision: 'redact_or_block', reasons, exactTokens, compressible: false };
  }

  // 2. Strict mode: any anchor at all pins the block to text.
  if (o.strict && exactTokens.length > 0) {
    reasons.push('strict_mode_any_anchor');
    return { risk: 'high', decision: 'text_only', reasons, exactTokens, compressible: false };
  }

  // 3. Small block → keep exact for free (pxpipe wouldn't profitably image it).
  if (text.length <= o.smallBlockChars) {
    reasons.push(`small_block(${text.length}<=${o.smallBlockChars})`);
    const risk: ContextRisk = highRiskTokens.length > 0 ? 'high' : 'low';
    return { risk, decision: 'text_only', reasons, exactTokens, compressible: false };
  }

  // 4. Large block, no exact anchors → safe to image wholesale.
  if (highRiskTokens.length === 0) {
    reasons.push('large_low_risk_prose');
    return { risk: 'low', decision: 'image_only', reasons, exactTokens, compressible: true };
  }

  // 5. Large block WITH anchors. Measured against the rescue's real capacity: if the
  //    block has more DISTINCT high-risk anchors than the factsheet can preserve
  //    (`rescueBudget`), imaging drops the overflow to OCR → keep text. Otherwise the
  //    rescue covers every anchor, so image the bulk + rescue is safe and cheap.
  const distinct = distinctValues(highRiskTokens);
  if (distinct > o.rescueBudget) {
    reasons.push(`anchors_exceed_rescue_budget(${distinct}>${o.rescueBudget})`);
    return { risk: 'high', decision: 'text_only', reasons, exactTokens, compressible: false };
  }

  reasons.push(`rescuable_anchors(${distinct}<=${o.rescueBudget})`);
  return { risk: 'medium', decision: 'image_plus_exact_rescue', reasons, exactTokens, compressible: true };
}
