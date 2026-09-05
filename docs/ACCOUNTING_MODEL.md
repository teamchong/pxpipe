# Provider-neutral accounting model

PXPipe must not describe character reduction as token savings. Accounting is
split into independent evidence classes.

## Evidence priority

1. **Provider-reported** — an original-request baseline from the provider and
   actual provider usage for the transformed request.
2. **Estimated** — provider/model-specific token estimates for both request
   shapes.
3. **Bytes-only** — original and transformed serialized request sizes.
4. **Unavailable** — insufficient evidence; no savings number is emitted.

Provider-reported evidence always wins when both reported and estimated values
exist. Estimates remain available for diagnostics but do not replace the
reported result.

## Provider input semantics

Anthropic reports uncached input, cache creation and cache reads as disjoint
buckets. Physical input tokens are their sum.

OpenAI-compatible providers, Featherless and Google report cached tokens as a
subset of input tokens. The cached bucket must not be added to input again.

For an unknown provider, PXPipe does not guess whether cache buckets are
disjoint or subsets. Provider-reported input normalization therefore fails
closed when cache buckets are supplied for an unknown provider.

A missing Anthropic cache bucket means zero. A bucket that is present but is
negative, non-integral, non-finite or outside JavaScript's safe-integer range
invalidates that provider-reported total instead of being silently treated as
zero.

## Measurement validity

Token counts, byte counts, image-token counts and event counters are discrete
quantities. They must be non-negative safe integers.

Latency values are continuous measurements and may be finite non-negative
fractional milliseconds.

A negative **reduction** is valid evidence: it means the transformed request
expanded relative to the baseline. PXPipe preserves that result instead of
clamping it to zero.

If provider-reported evidence is invalid or incomplete, normalization falls
back to the next complete evidence class rather than manufacturing a result.

## Normalized fields

- original/transformed bytes and compression ratio;
- provider-reported original and actual input tokens;
- provider-reported token reduction and ratio;
- estimated original/actual input tokens and reduction;
- cache-read and cache-write buckets;
- image tokens;
- output and total tokens;
- PXPipe-added latency and model latency as separate inputs;
- fallback count;
- bypass reason;
- provider and model labels.

The normalization API does not infer latency components from wall-clock values,
invent an original token baseline, or guess unknown provider cache semantics.
Callers must supply measured evidence.
