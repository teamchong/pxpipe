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

/** Bracketed variant tags that don't change reading behavior and so must not
 *  affect the gate — e.g. the context-window tag in `claude-opus-4-8[1m]`.
 *  Stripped before matching so a base model and its `[1m]` form gate alike. */
const VARIANT_TAG = /\[[^\]]*\]/g;

function baseModelId(model: string): string {
  return model.replace(VARIANT_TAG, '');
}

/** Base model ids pxpipe is allowed to transform, from `PXPIPE_MODELS`
 *  (comma-separated). Defaults to Fable 5 only — the validated production
 *  scope. Read per call so the scope can be widened/narrowed by env alone,
 *  no rebuild or restart.
 *
 *  Validated 2026-06-09: Fable 5 reads pxpipe renders at 100/100 on the
 *  novel-arithmetic eval (Opus 4.8: 93/100) and bills the same image tokens
 *  (w·h/750, same tokenizer as Opus 4.7+). Opus was the original scope but
 *  carried a ~7% read tax, so it was dropped once a tax-free model existed.
 *  Re-tested 2026-06-16 on a newer Opus 4.8 snapshot: improved to 98/100
 *  (-2pp) on arithmetic and 6/15 (was 0/15) on dense-hex recall, but still
 *  taxed and still silently confabulating vs Fable's 100/100 and 13/15 — so
 *  the default stays Fable-only.
 *  To re-enable it (e.g. while re-evaluating a newer Opus snapshot):
 *    PXPIPE_MODELS=claude-fable-5,claude-opus-4-8
 *  Mythos 5 is unmeasured (no access). */
function allowedModelBases(): string[] {
  const raw = process.env.PXPIPE_MODELS;
  return (raw && raw.trim() ? raw : 'claude-fable-5')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when pxpipe is allowed to transform requests for this model. A model
 *  matches an allowed base when it equals the base or extends it with a
 *  `-suffix` alias (`claude-fable-5-high`) — hosts may send either the client
 *  alias or the resolved upstream id. Bracketed variant tags (`[1m]`) are
 *  stripped first so `claude-opus-4-8[1m]` matches its base. */
export function isPxpipeSupportedModel(model: string | null | undefined): boolean {
  if (typeof model !== 'string') return false;
  const base = baseModelId(model);
  return allowedModelBases().some((b) => base === b || base.startsWith(`${b}-`));
}

/** GPT image-tokenization has not been validated across the whole OpenAI
 *  model matrix. Keep the new OpenAI path scoped to the requested GPT 5.5
 *  family until production telemetry says it is safe to widen. */
export function isPxpipeSupportedGptModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && /^gpt-5\.5(?:-|$)/.test(model);
}

export function shouldTransformAnthropicMessages(
  input: PxpipeApplicabilityInput,
): { eligible: boolean; reason: PxpipeApplicabilityReason } {
  if (input.method !== undefined && input.method !== null && input.method.toUpperCase() !== 'POST') {
    return { eligible: false, reason: 'unsupported_method' };
  }
  if (input.path !== undefined && input.path !== null && !input.path.endsWith('/v1/messages')) {
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
