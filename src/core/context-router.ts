/**
 * Context router: turns the risk classifier into things pxpipe's transform can use.
 *
 * The key integration fact: pxpipe already exposes a per-block `keepSharp(block) =>
 * boolean` hook (transform.ts), consulted on every reminder / tool_result before it
 * gets imaged. So the router doesn't fork the pipeline — `makeKeepSharp(policy)`
 * returns a predicate you drop straight into `transformAnthropicMessages`:
 *
 *     import { makeKeepSharp } from 'pxpipe-proxy/.../context-router.js';
 *     await transformAnthropicMessages({ body, model,
 *       options: { keepSharp: makeKeepSharp('coding-agent') } });
 *
 * The boolean hook covers the two safety-critical lanes (text_only, redact_or_block).
 * The `image_plus_exact_rescue` lane — image the bulk, append a compact exact-token
 * text strip — can't be done through a boolean alone (the hook can't inject a sibling
 * text block), so `routeBlock` also returns the ready-built `rescueStrip` for a caller
 * that walks the request itself. That injection is the one remaining integration step;
 * see docs/CONTEXT_ROUTER.md.
 */

import {
  assessContextRisk,
  type ClassifierOptions,
  type ContextRiskAssessment,
} from './risk-classifier.js';
import { redactSecrets } from './exact-token-extractor.js';

export type ContextPolicy = 'default' | 'coding-agent' | 'research' | 'strict';

/** Per-policy classifier tuning. `coding-agent` protects the most; `research`
 *  compresses hardest; `strict` pins anything with an anchor to text. */
const POLICIES: Record<ContextPolicy, ClassifierOptions> = {
  default: { smallBlockChars: 6000, denseAnchorCoverage: 0.12, strict: false },
  // Code work is anchor-dense (paths, hashes, diffs) — protect aggressively:
  // lower dense threshold so more blocks stay text, larger "small" floor.
  'coding-agent': { smallBlockChars: 8000, denseAnchorCoverage: 0.08, strict: false },
  // Prose-heavy research: image more, only truly dense anchor blocks stay text.
  research: { smallBlockChars: 4000, denseAnchorCoverage: 0.2, strict: false },
  strict: { smallBlockChars: 6000, denseAnchorCoverage: 0.12, strict: true },
};

export interface RouteResult {
  assessment: ContextRiskAssessment;
  /** True → pxpipe must keep this block as text (feed to `keepSharp`). */
  keepAsText: boolean;
  /** Present only for `image_plus_exact_rescue`: append this after the image block. */
  rescueStrip?: string;
}

/**
 * Resolve the router policy from `PXPIPE_CONTEXT_ROUTER`, or null when off.
 * Read per-call (like PXPIPE_MODELS) so the toggle flips live. Edge-safe: `process`
 * may be undefined off-Node. Unknown truthy value → `coding-agent` (fail safe, not
 * silently off — the point of the flag is to protect content).
 *   unset / off / 0 / false / none → null (default; zero behavior change)
 *   on / true / 1                  → 'coding-agent'
 *   strict | research | default | coding-agent → that policy
 */
export function contextRouterPolicyFromEnv(): ContextPolicy | null {
  const raw = typeof process !== 'undefined' ? process.env?.PXPIPE_CONTEXT_ROUTER : undefined;
  if (raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === '' || /^(0|false|no|off|none)$/.test(v)) return null;
  if (v === 'on' || v === 'true' || v === '1') return 'coding-agent';
  if (v === 'redact') return 'coding-agent'; // redaction mode → coding-agent policy
  if (v === 'strict' || v === 'research' || v === 'default') return v;
  if (v === 'coding-agent' || v === 'coding_agent') return 'coding-agent';
  return 'coding-agent';
}

/**
 * True when `PXPIPE_CONTEXT_ROUTER=redact` — the operator has opted into the
 * redaction lane (mask the secret value in place and image the rest, recovering the
 * savings a secret-bearing block would otherwise lose). Opt-in because redaction
 * MUTATES content: a secret false-positive replaces that token with `[redacted-secret]`
 * rather than merely keeping it as text, so it's a knowing trade of a rare localized
 * content loss for compression. Default (`=on`) stays keep-text.
 */
export function contextRouterRedactFromEnv(): boolean {
  const raw = typeof process !== 'undefined' ? process.env?.PXPIPE_CONTEXT_ROUTER : undefined;
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'redact';
}

/** Route a single block's text under a policy. */
export function routeBlock(text: string, policy: ContextPolicy = 'default'): RouteResult {
  const assessment = assessContextRisk(text, POLICIES[policy]);
  const { decision } = assessment;
  const keepAsText = decision === 'text_only' || decision === 'redact_or_block';
  const result: RouteResult = { assessment, keepAsText };
  if (decision === 'image_plus_exact_rescue') {
    result.rescueStrip = buildRescueStrip(assessment);
  }
  return result;
}

/**
 * Drop-in for pxpipe's `TransformOptions.keepSharp`. Returns `true` (keep as text)
 * for the safety-critical decisions, letting pxpipe image everything else as usual.
 *
 * Note: `image_plus_exact_rescue` blocks return `false` here — they get imaged. To
 * ALSO preserve their exact tokens you must append `routeBlock(text).rescueStrip`
 * at the call site; a boolean hook can't do that on its own. Use policy `'strict'`
 * if you'd rather never image an anchor-bearing block than manage rescue strips.
 */
export function makeKeepSharp(
  policy: ContextPolicy = 'default',
): (block: { text: string }) => boolean {
  return (block) => {
    if (!block || typeof block.text !== 'string') return false;
    return routeBlock(block.text, policy).keepAsText;
  };
}

/**
 * Redaction hooks — the savings-recovering alternative to keeping a whole
 * secret-bearing block as text. Returns a `{ keepSharp, redactBlock }` pair:
 *
 * - `keepSharp` keeps only NON-secret `text_only` blocks (dense/high-risk) as text.
 *   Secret blocks return `false` here so they proceed to the image path...
 * - `redactBlock` masks the secret VALUE in those blocks (→ `[redacted-secret]`) so
 *   pxpipe images the masked text: safe (no secret in pixels) AND compressed.
 *
 * A block with a secret that is ALSO dense stays text (keepSharp true via text_only?
 * no — secret forces redact_or_block, so keepSharp is false and redactBlock masks it,
 * then the normal gate decides image-vs-not on the masked text). Net: secrets never
 * image un-masked and never force a large block fully to text.
 */
export function makeRedactingHooks(policy: ContextPolicy = 'default'): {
  keepSharp: (block: { text: string }) => boolean;
  redactBlock: (block: { text: string }) => string | null;
} {
  return {
    keepSharp: (block) => {
      if (!block || typeof block.text !== 'string') return false;
      // Only non-secret text_only stays text; secrets fall through to redactBlock.
      return routeBlock(block.text, policy).assessment.decision === 'text_only';
    },
    redactBlock: (block) => {
      if (!block || typeof block.text !== 'string') return null;
      if (routeBlock(block.text, policy).assessment.decision !== 'redact_or_block') return null;
      const { redacted, count } = redactSecrets(block.text);
      return count > 0 ? redacted : null;
    },
  };
}

/**
 * Compact text carrying the exact tokens from an imaged block. Kept small on
 * purpose — one line per token, deduped — so it doesn't erase the image savings.
 * Secrets are already masked in the assessment; this never prints a raw secret.
 */
export function buildRescueStrip(assessment: ContextRiskAssessment): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const t of assessment.exactTokens) {
    const line = `- ${t.kind}: ${t.value}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  if (lines.length === 0) return '';
  return ['Exact tokens preserved from imaged context:', ...lines].join('\n');
}
