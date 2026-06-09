/** Applicability helpers for pixelpipe's production-safe model scope. */

export type PixelpipeApplicabilityReason =
  | 'eligible'
  | 'unsupported_model'
  | 'unsupported_method'
  | 'unsupported_path'
  | 'empty_body';

export interface PixelpipeApplicabilityInput {
  readonly model?: string | null;
  readonly method?: string | null;
  readonly path?: string | null;
  readonly bodyBytes?: number | null;
}

/** Pixelpipe's validated production scope: Fable 5 only.
 * Measured 2026-06-09: Fable 5 reads pixelpipe renders at 100/100 on the
 * novel-arithmetic eval (Opus 4.8: 93/100) and bills the same image tokens
 * (w·h/750, same tokenizer as Opus 4.7+). Opus is disabled — its ~7% read
 * tax is the wrong trade now that a tax-free model exists. Mythos 5 is
 * unmeasured (no access). Suffix aliases such as `claude-fable-5-high` are
 * accepted because hosts may check either the client alias or the resolved
 * upstream model. */
export function isPixelpipeSupportedModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && /^claude-fable-5(?:-|$)/.test(model);
}

/** GPT image-tokenization has not been validated across the whole OpenAI
 *  model matrix. Keep the new OpenAI path scoped to the requested GPT 5.5
 *  family until production telemetry says it is safe to widen. */
export function isPixelpipeSupportedGptModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && /^gpt-5\.5(?:-|$)/.test(model);
}

export function shouldTransformAnthropicMessages(
  input: PixelpipeApplicabilityInput,
): { eligible: boolean; reason: PixelpipeApplicabilityReason } {
  if (input.method !== undefined && input.method !== null && input.method.toUpperCase() !== 'POST') {
    return { eligible: false, reason: 'unsupported_method' };
  }
  if (input.path !== undefined && input.path !== null && !input.path.endsWith('/v1/messages')) {
    return { eligible: false, reason: 'unsupported_path' };
  }
  if (input.bodyBytes !== undefined && input.bodyBytes !== null && input.bodyBytes <= 0) {
    return { eligible: false, reason: 'empty_body' };
  }
  if (!isPixelpipeSupportedModel(input.model)) {
    return { eligible: false, reason: 'unsupported_model' };
  }
  return { eligible: true, reason: 'eligible' };
}
