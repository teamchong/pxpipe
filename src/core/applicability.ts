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

/** Pixelpipe's validated production scope: Opus 4.7 and newer in the 4.x line
 * (4.7, 4.8, …). 4.6 is intentionally excluded; 5.x is excluded pending
 * validation, because the image tokenizer can change across major versions —
 * widen the regex once a newer major is measured. Suffix aliases such as
 * `claude-opus-4-7-high` are accepted because hosts may check either the
 * client alias or the resolved upstream model. */
export function isPixelpipeSupportedModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && /^claude-opus-4-(?:[7-9]|[1-9]\d)(?:-|$)/.test(model);
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
