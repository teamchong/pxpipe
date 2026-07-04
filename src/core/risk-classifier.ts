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
  /** Exact-token char coverage above which a large block routes `text_only`
   *  instead of image_plus_exact_rescue (the rescue strip would be too big to pay
   *  off). Default 0.12. */
  denseAnchorCoverage?: number;
  /** Strict mode: ANY exact anchor forces `text_only` (max fidelity, min savings). */
  strict?: boolean;
}

const DEFAULTS: Required<ClassifierOptions> = {
  smallBlockChars: 6000,
  denseAnchorCoverage: 0.12,
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

/** Fraction of `text` covered by non-secret exact-token spans. Secrets excluded —
 *  they're masked (value length ≠ span length) and drive the critical path anyway. */
function anchorCoverage(text: string, tokens: readonly ExactToken[]): number {
  if (!text.length) return 0;
  let covered = 0;
  for (const t of tokens) {
    if (t.kind === 'secret_like') continue;
    covered += t.end - t.start;
  }
  return covered / text.length;
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
  const coverage = anchorCoverage(text, exactTokens);

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

  // 5. Large block WITH anchors. Density decides: dense → text_only (rescue strip
  //    wouldn't pay off); sparse → image the bulk + rescue the anchors.
  if (coverage >= o.denseAnchorCoverage) {
    reasons.push(`dense_anchors(coverage=${coverage.toFixed(3)}>=${o.denseAnchorCoverage})`);
    return { risk: 'high', decision: 'text_only', reasons, exactTokens, compressible: false };
  }

  reasons.push(`sparse_anchors(coverage=${coverage.toFixed(3)},n=${highRiskTokens.length})`);
  return { risk: 'medium', decision: 'image_plus_exact_rescue', reasons, exactTokens, compressible: true };
}
