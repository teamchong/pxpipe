/** Applicability helpers for pxpipe's production-safe model scope. */

export type PxpipeApplicabilityReason =
  | 'eligible'
  | 'unsupported_model'
  | 'unsupported_method'
  | 'unsupported_path'
  | 'empty_body';

export interface PxpipeApplicabilityInput {
  readonly model?: string | null;
  readonly method?: string | null;
  readonly path?: string | null;
  readonly bodyBytes?: number | null;
}

/** Bracketed variant tags (e.g. `[1m]`) stripped before model matching so base and variant gate identically. */
const VARIANT_TAG = /\[[^\]]*\]/g;

function baseModelId(model: string): string {
  return model.replace(VARIANT_TAG, '');
}

/** Dashboard runtime override; null = fall back to PXPIPE_MODELS env / built-in default. In-memory only. */
let runtimeModelBases: readonly string[] | null = null;

/** Built-in default scope when PXPIPE_MODELS is unset: Fable 5 (Claude) plus
 *  GPT 5.6. GPT 5.5 and Opus 4.8 are intentionally off — same pipeline but
 *  measurably worse at reading imaged content (FINDINGS.md 2026-06-16: Opus 4.8
 *  ~2pp arithmetic, 6/15 dense-hex recall vs Fable's 100/100; GPT 5.5 likewise
 *  degrades on imaged history/context) — so silently imaging them is the wrong
 *  default. Both stay opt-in via the dashboard chips or PXPIPE_MODELS. */
const DEFAULT_MODEL_BASES = ['claude-fable-5', 'gpt-5.6'];

function falsey(v: string): boolean {
  return /^(0|false|no|off|none)$/i.test(v.trim());
}

/** PXPIPE_MODELS env / built-in default, ignoring the runtime override. One CSV
 *  controls every family (Claude + GPT). Resolution (read per-call so scope flips LIVE):
 *  - unset or empty        → built-in default (Fable 5 + GPT 5.6)
 *  - `off`/`0`/`false`/... → compress nothing
 *  - CSV of model bases    → exactly those families (e.g. `claude-fable-5,gpt-5.6`) */
function envOrDefaultBases(): string[] {
  // Edge-safe: `process` is undefined off-Node; `typeof` avoids a ReferenceError.
  const raw = typeof process !== 'undefined' ? process.env?.PXPIPE_MODELS : undefined;
  if (raw === undefined) return [...DEFAULT_MODEL_BASES];
  const trimmed = raw.trim();
  if (!trimmed) return [...DEFAULT_MODEL_BASES];
  if (falsey(trimmed)) return [];
  return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
}

function allowedModelBases(): string[] {
  if (runtimeModelBases !== null) return [...runtimeModelBases];
  return envOrDefaultBases();
}

/** Current effective allowed-model scope (Claude + GPT). */
export function getAllowedModelBases(): string[] {
  return allowedModelBases();
}

/** PXPIPE_MODELS env / default scope, independent of runtime override.
 *  Dashboard unions this into its chip set so env-enabled models are always shown as toggles. */
export function getConfiguredModelBases(): string[] {
  return envOrDefaultBases();
}

/** Set the dashboard runtime override. Empty array = compress nothing; null = clear override. Not persisted. */
export function setAllowedModelBases(list: readonly string[] | null): void {
  runtimeModelBases = list === null ? null : list.map((s) => s.trim()).filter(Boolean);
}

/** Membership test against the single allowed scope. Matches exact base or `-suffix`
 *  alias; [variant] tags stripped first. */
function isAllowed(model: string | null | undefined): boolean {
  if (typeof model !== 'string') return false;
  const base = baseModelId(model);
  return allowedModelBases().some((b) => base === b || base.startsWith(`${b}-`));
}

/** True when pxpipe may transform this Anthropic model. */
export function isPxpipeSupportedModel(model: string | null | undefined): boolean {
  return isAllowed(model);
}

/** True when pxpipe may transform this GPT model. Shares the single PXPIPE_MODELS scope. */
export function isPxpipeSupportedGptModel(model: string | null | undefined): boolean {
  return isAllowed(model);
}

/** Canonical set of Anthropic Messages routes pxpipe transforms. Shared with
 *  createProxy (src/core/proxy.ts) so the public applicability helper and the
 *  proxy router can never disagree on which paths are eligible — they did: the
 *  proxy accepts /anthropic/messages, but the helper's old `endsWith` check
 *  rejected it (and would have wrongly accepted /foo/v1/messages). Exact matches
 *  only, so /v1/messages/count_tokens stays unsupported. */
export function isAnthropicMessagesPath(pathname: string): boolean {
  return pathname === '/v1/messages'
    || pathname === '/anthropic/v1/messages'
    || pathname === '/anthropic/messages';
}

export function shouldTransformAnthropicMessages(
  input: PxpipeApplicabilityInput,
): { eligible: boolean; reason: PxpipeApplicabilityReason } {
  if (input.method !== undefined && input.method !== null && input.method.toUpperCase() !== 'POST') {
    return { eligible: false, reason: 'unsupported_method' };
  }
  if (input.path !== undefined && input.path !== null && !isAnthropicMessagesPath(input.path)) {
    return { eligible: false, reason: 'unsupported_path' };
  }
  if (input.bodyBytes !== undefined && input.bodyBytes !== null && input.bodyBytes <= 0) {
    return { eligible: false, reason: 'empty_body' };
  }
  if (!isPxpipeSupportedModel(input.model)) {
    return { eligible: false, reason: 'unsupported_model' };
  }
  return { eligible: true, reason: 'eligible' };
}

// --- C9+C10: coverage routing (heavy one-off vs. light repeatable) ---------
//
// `shouldTransformAnthropicMessages` above answers "is pxpipe allowed to touch
// this request at all" (model/method/path/empty-body gating). The functions
// below answer a narrower, additive question for a request that already
// passed that gate: is this a "heavy" one-off analysis (today's full
// compression is the right call) or a "light" small request that is part of
// an established, repeatable session (where the caller already manages its
// own `cache_control` breakpoints and re-rendering the image would just
// bust a prefix that was about to be reused)? See docs/ROUTING.md for the
// full decision table and rationale. Pure, read-only, and NOT wired into
// `proxy.ts` yet — same status as `shouldTransformAnthropicMessages` itself
// (exported for callers/tests; live wiring is a separate, non-owned change).

/** Routing outcome for `classifyRequestWeight`. */
export type PxpipeRequestWeightTier = 'heavy' | 'light';

export type PxpipeRequestWeightReason =
  | 'large_body'
  | 'stable_prefix_established'
  | 'small_repeated_turn'
  | 'insufficient_signal';

export interface PxpipeRequestWeightInput extends PxpipeApplicabilityInput {
  /** Turn count (`messages.length`). Cheap proxy for "is this an established
   *  multi-turn session, or a cold first shot" — counting array length needs
   *  no block-content parsing. */
  readonly messageCount?: number | null;
  /** `cache_control` marker count already present in the INCOMING (pre-transform)
   *  body — see `countCacheControlMarkers` in measurement.ts. A caller that
   *  already places its own breakpoints is signalling the session expects
   *  prefix reuse across turns. */
  readonly existingCacheControlMarkers?: number | null;
}

export interface PxpipeRequestWeightResult {
  readonly tier: PxpipeRequestWeightTier;
  readonly reason: PxpipeRequestWeightReason;
}

/** Body at/above this size is routed 'heavy' regardless of other signals: at
 *  this size the one-request compression win dominates any hypothetical cache
 *  reuse, and (per the recon brief) large jumps are typically one-off document
 *  dumps / analyses, not steady-state conversation turns. See docs/ROUTING.md. */
export const HEAVY_BODY_BYTES_THRESHOLD = 200_000;

/** Body at/below this size is cheap enough that forcing a re-render is not
 *  worth disturbing an established cache prefix. See docs/ROUTING.md. */
export const LIGHT_BODY_BYTES_THRESHOLD = 32_000;

/** Minimum turn count to call a session "established" when no explicit
 *  `cache_control` marker count is available. See docs/ROUTING.md. */
export const LIGHT_MIN_MESSAGE_COUNT = 2;

/**
 * Classifies an already-eligible request as 'heavy' (full compression, today's
 * unconditional behavior) or 'light' (small + repeatable — respect the
 * caller's existing cache breakpoints instead of re-rendering). Uses only
 * cheap PRE-transform signals (`bodyBytes`, `messageCount`,
 * `existingCacheControlMarkers`): richer signals like `TransformInfo.staticChars`
 * / `dynamicChars` only exist AFTER the transform has already run, so they
 * can't gate the transform itself. Additive and read-only — does not change
 * `shouldTransformAnthropicMessages` or any existing exported behavior.
 * Missing/ambiguous signals default to 'heavy' (today's behavior, unaffected).
 */
export function classifyRequestWeight(
  input: PxpipeRequestWeightInput,
): PxpipeRequestWeightResult {
  const bodyBytes = input.bodyBytes ?? null;
  const messageCount = input.messageCount ?? null;
  const markers = input.existingCacheControlMarkers ?? null;

  if (bodyBytes !== null && bodyBytes >= HEAVY_BODY_BYTES_THRESHOLD) {
    return { tier: 'heavy', reason: 'large_body' };
  }
  if (markers !== null && markers > 0 && (bodyBytes === null || bodyBytes <= LIGHT_BODY_BYTES_THRESHOLD)) {
    return { tier: 'light', reason: 'stable_prefix_established' };
  }
  if (
    bodyBytes !== null && bodyBytes <= LIGHT_BODY_BYTES_THRESHOLD
    && messageCount !== null && messageCount >= LIGHT_MIN_MESSAGE_COUNT
  ) {
    return { tier: 'light', reason: 'small_repeated_turn' };
  }
  return { tier: 'heavy', reason: 'insufficient_signal' };
}
