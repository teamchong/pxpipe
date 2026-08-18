export type AccountingProvider = 'anthropic' | 'openai' | 'google' | 'featherless' | 'unknown';
export type SavingsEvidence = 'provider-reported' | 'estimated' | 'bytes-only' | 'unavailable';

export interface AccountingInput {
  provider: AccountingProvider;
  model?: string;
  originalBytes?: number;
  transformedBytes?: number;
  estimatedOriginalInputTokens?: number;
  estimatedTransformedInputTokens?: number;
  providerBaselineInputTokens?: number;
  providerInputTokens?: number;
  providerOutputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  imageTokens?: number;
  proxyAddedLatencyMs?: number;
  modelLatencyMs?: number;
  fallbackCount?: number;
  bypassReason?: string;
}

export interface NormalizedAccounting {
  provider: AccountingProvider;
  model?: string;
  bytes: {
    original?: number;
    transformed?: number;
    reduced?: number;
    compressionRatio?: number;
  };
  tokens: {
    providerReportedOriginalInput?: number;
    providerReportedActualInput?: number;
    providerReportedReduced?: number;
    estimatedOriginalInput?: number;
    estimatedActualInput?: number;
    estimatedReduced?: number;
    cacheRead?: number;
    cacheWrite?: number;
    image?: number;
    output?: number;
    total?: number;
  };
  savings: {
    evidence: SavingsEvidence;
    inputTokensReduced?: number;
    inputReductionRatio?: number;
  };
  latency: {
    proxyAddedMs?: number;
    modelMs?: number;
  };
  fallbackCount: number;
  bypassReason?: string;
}

/**
 * Token counts, byte counts and event counters come from discrete quantities.
 * Reject fractions, unsafe integers and non-finite values instead of coercing
 * malformed telemetry into apparently precise accounting.
 */
function nonNegativeCount(value: number | undefined): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
}

/**
 * Latency is a continuous measurement and may legitimately contain fractional
 * milliseconds, so it only requires a finite non-negative number.
 */
function nonNegativeMeasure(value: number | undefined): number | undefined {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    ? value
    : undefined;
}

function difference(before: number | undefined, after: number | undefined): number | undefined {
  if (before === undefined || after === undefined) return undefined;
  return before - after;
}

function ratio(reduced: number | undefined, baseline: number | undefined): number | undefined {
  if (reduced === undefined || baseline === undefined || baseline <= 0) return undefined;
  return reduced / baseline;
}

function safeSum(values: readonly number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total) || total < 0) return undefined;
  }
  return total;
}

function suppliedInvalidCount(value: number | undefined): boolean {
  return value !== undefined && nonNegativeCount(value) === undefined;
}

/**
 * Normalize the provider's reported input usage into physical input tokens.
 *
 * Provider usage buckets are not shaped identically:
 *
 * - Anthropic reports uncached input, cache creation and cache reads as
 *   disjoint buckets. Physical input is their sum.
 * - OpenAI-compatible providers and Google report cached tokens as a subset of
 *   the input count. Adding the cache bucket would double-count it.
 * - Featherless follows its OpenAI-compatible usage shape.
 * - An unknown provider is accepted only when no cache bucket semantics need
 *   to be inferred. If cache buckets are supplied, normalization fails closed.
 *
 * Missing Anthropic cache buckets mean zero. A PRESENT but malformed bucket is
 * different: it invalidates the provider-reported total instead of silently
 * turning corrupted telemetry into savings evidence.
 */
export function providerActualInputTokens(input: AccountingInput): number | undefined {
  const reported = nonNegativeCount(input.providerInputTokens);
  if (reported === undefined) return undefined;

  const cacheRead = nonNegativeCount(input.cacheReadTokens);
  const cacheWrite = nonNegativeCount(input.cacheWriteTokens);

  if (input.provider === 'anthropic') {
    if (
      suppliedInvalidCount(input.cacheReadTokens)
      || suppliedInvalidCount(input.cacheWriteTokens)
    ) {
      return undefined;
    }

    return safeSum([
      reported,
      cacheRead ?? 0,
      cacheWrite ?? 0,
    ]);
  }

  if (input.provider === 'unknown') {
    // No provider-specific cache semantics are known. If cache telemetry is
    // present, guessing subset-vs-disjoint would manufacture precision.
    if (
      input.cacheReadTokens !== undefined
      || input.cacheWriteTokens !== undefined
    ) {
      return undefined;
    }

    return reported;
  }

  // OpenAI, Google and Featherless input totals already include their cache
  // subsets. Cache buckets remain diagnostic fields only.
  return reported;
}

export function normalizeAccounting(input: AccountingInput): NormalizedAccounting {
  const originalBytes = nonNegativeCount(input.originalBytes);
  const transformedBytes = nonNegativeCount(input.transformedBytes);
  const bytesReduced = difference(originalBytes, transformedBytes);

  const providerOriginal = nonNegativeCount(input.providerBaselineInputTokens);
  const providerActual = providerActualInputTokens(input);
  const providerReduced = difference(providerOriginal, providerActual);

  const estimatedOriginal = nonNegativeCount(input.estimatedOriginalInputTokens);
  const estimatedActual = nonNegativeCount(input.estimatedTransformedInputTokens);
  const estimatedReduced = difference(estimatedOriginal, estimatedActual);

  let evidence: SavingsEvidence = 'unavailable';
  let inputTokensReduced: number | undefined;
  let inputReductionRatio: number | undefined;

  if (providerReduced !== undefined) {
    evidence = 'provider-reported';
    inputTokensReduced = providerReduced;
    inputReductionRatio = ratio(providerReduced, providerOriginal);
  } else if (estimatedReduced !== undefined) {
    evidence = 'estimated';
    inputTokensReduced = estimatedReduced;
    inputReductionRatio = ratio(estimatedReduced, estimatedOriginal);
  } else if (bytesReduced !== undefined) {
    evidence = 'bytes-only';
  }

  const cacheRead = nonNegativeCount(input.cacheReadTokens);
  const cacheWrite = nonNegativeCount(input.cacheWriteTokens);
  const image = nonNegativeCount(input.imageTokens);
  const output = nonNegativeCount(input.providerOutputTokens);

  const total = providerActual !== undefined && output !== undefined
    ? safeSum([providerActual, output])
    : undefined;

  const proxyAddedMs = nonNegativeMeasure(input.proxyAddedLatencyMs);
  const modelMs = nonNegativeMeasure(input.modelLatencyMs);

  return {
    provider: input.provider,
    ...(input.model ? { model: input.model } : {}),

    bytes: {
      ...(originalBytes !== undefined ? { original: originalBytes } : {}),
      ...(transformedBytes !== undefined ? { transformed: transformedBytes } : {}),
      ...(bytesReduced !== undefined ? { reduced: bytesReduced } : {}),
      ...(
        originalBytes !== undefined
        && originalBytes > 0
        && transformedBytes !== undefined
          ? { compressionRatio: transformedBytes / originalBytes }
          : {}
      ),
    },

    tokens: {
      ...(providerOriginal !== undefined
        ? { providerReportedOriginalInput: providerOriginal }
        : {}),
      ...(providerActual !== undefined
        ? { providerReportedActualInput: providerActual }
        : {}),
      ...(providerReduced !== undefined
        ? { providerReportedReduced: providerReduced }
        : {}),
      ...(estimatedOriginal !== undefined
        ? { estimatedOriginalInput: estimatedOriginal }
        : {}),
      ...(estimatedActual !== undefined
        ? { estimatedActualInput: estimatedActual }
        : {}),
      ...(estimatedReduced !== undefined
        ? { estimatedReduced }
        : {}),
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
      ...(image !== undefined ? { image } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(total !== undefined ? { total } : {}),
    },

    savings: {
      evidence,
      ...(inputTokensReduced !== undefined
        ? { inputTokensReduced }
        : {}),
      ...(inputReductionRatio !== undefined
        ? { inputReductionRatio }
        : {}),
    },

    latency: {
      ...(proxyAddedMs !== undefined ? { proxyAddedMs } : {}),
      ...(modelMs !== undefined ? { modelMs } : {}),
    },

    fallbackCount: nonNegativeCount(input.fallbackCount) ?? 0,

    ...(input.bypassReason ? { bypassReason: input.bypassReason } : {}),
  };
}
