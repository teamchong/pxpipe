/** Applicability helpers for pxpipe's production-safe model scope. */

import { isMisresolvedModelId } from './gpt-model-profiles.js';

export type PxpipeApplicabilityReason =
  | 'eligible'
  | 'unsupported_model'
  | 'unsupported_method'
  | 'unsupported_path'
  | 'empty_body';

export type PxpipeSafetyScope = 'coding-safe' | 'balanced' | 'aggressive' | 'passthrough';

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

/** Model bases imaged with no configuration at all.
 *
 * Exported so documentation can be checked against it instead of restating it. */
export const DEFAULT_MODEL_BASES = ['claude-fable-5', 'gemini-3.6-flash'];

function falsey(v: string): boolean {
  return /^(0|false|no|off|none)$/i.test(v.trim());
}

/** PXPIPE_MODELS env / built-in default, ignoring the runtime override. */
function envOrDefaultBases(): string[] {
  const raw = typeof process !== 'undefined' ? process.env?.PXPIPE_MODELS : undefined;
  if (raw === undefined) return [...DEFAULT_MODEL_BASES];
  const trimmed = raw.trim();
  if (!trimmed) return [...DEFAULT_MODEL_BASES];
  if (falsey(trimmed)) return [];
  return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
}

function configuredModelBases(): string[] {
  if (runtimeModelBases !== null) return [...runtimeModelBases];
  return envOrDefaultBases();
}

function parseSafetyScope(raw: string | undefined): PxpipeSafetyScope {
  const value = (raw ?? '').trim().toLowerCase();
  // Backward-compatible: an unset profile keeps upstream's existing policy.
  if (!value || value === 'aggressive' || value === 'legacy') return 'aggressive';
  if (value === 'safe' || value === 'coding' || value === 'coding-safe') return 'coding-safe';
  if (value === 'balanced') return 'balanced';
  if (value === 'off' || value === 'disabled' || value === 'passthrough') return 'passthrough';
  // Startup validation reports the bad profile; the applicability gate itself
  // fails closed rather than broadening model eligibility.
  return 'passthrough';
}

function activeSafetyScope(): PxpipeSafetyScope {
  const raw = typeof process !== 'undefined' ? process.env?.PXPIPE_PROFILE : undefined;
  return parseSafetyScope(raw);
}

/** Gateways qualify ids with routing segments such as `google/gemini-3.6-flash`. */
function unqualifiedModelId(base: string): string | null {
  const slash = base.lastIndexOf('/');
  return slash >= 0 ? base.slice(slash + 1) : null;
}

function modelBaseMatches(id: string, candidate: string): boolean {
  const target = candidate.toLowerCase();
  return id === target || id.startsWith(`${target}-`);
}

function safetyAllowsConfiguredBase(candidate: string, scope: PxpipeSafetyScope): boolean {
  if (scope === 'passthrough') return false;
  if (scope === 'aggressive') return true;
  const base = baseModelId(candidate).toLowerCase();
  const unqualified = unqualifiedModelId(base);
  // Safe profiles do not promote an explicitly configured experimental model.
  // They are limited to the same evidence-backed bases upstream enables by default.
  return DEFAULT_MODEL_BASES.some((safe) =>
    modelBaseMatches(base, safe)
      || (unqualified !== null && modelBaseMatches(unqualified, safe)),
  );
}

function allowedModelBasesForScope(scope: PxpipeSafetyScope): string[] {
  return configuredModelBases().filter((candidate) => safetyAllowsConfiguredBase(candidate, scope));
}

function allowedModelBases(): string[] {
  return allowedModelBasesForScope(activeSafetyScope());
}

/** Current effective allowed-model scope (Claude + GPT). */
export function getAllowedModelBases(): string[] {
  return allowedModelBases();
}

/** PXPIPE_MODELS env / default scope, independent of runtime override. */
export function getConfiguredModelBases(): string[] {
  return envOrDefaultBases();
}

/** Set the dashboard runtime override. Empty array = compress nothing; null = clear override. Not persisted. */
export function setAllowedModelBases(list: readonly string[] | null): void {
  runtimeModelBases = list === null ? null : list.map((s) => s.trim()).filter(Boolean);
}

function isAllowedForScope(
  model: string | null | undefined,
  scope: PxpipeSafetyScope,
): boolean {
  if (typeof model !== 'string') return false;
  const base = baseModelId(model).toLowerCase();
  if (isMisresolvedModelId(base)) return false;
  const unqualified = unqualifiedModelId(base);
  return allowedModelBasesForScope(scope).some((candidate) => {
    const target = candidate.toLowerCase();
    return modelBaseMatches(base, target)
      || (unqualified !== null && modelBaseMatches(unqualified, target));
  });
}

/** Pure model gate for a caller-selected semantic profile. */
export function isPxpipeSupportedModelForScope(
  model: string | null | undefined,
  scope: PxpipeSafetyScope,
): boolean {
  return isAllowedForScope(model, scope);
}

/** True when pxpipe may transform this Anthropic model under the active profile. */
export function isPxpipeSupportedModel(model: string | null | undefined): boolean {
  return isAllowedForScope(model, activeSafetyScope());
}

/** True when pxpipe may transform this GPT model under the active profile. */
export function isPxpipeSupportedGptModel(model: string | null | undefined): boolean {
  return isAllowedForScope(model, activeSafetyScope());
}

/** Canonical set of Anthropic Messages routes pxpipe transforms. */
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
