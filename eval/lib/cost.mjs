/**
 * eval/lib/cost.mjs
 *
 * Token and USD cost estimation for the reflow eval harness.
 * Based on Claude claude-sonnet-4-5 pricing (May 2026).
 *
 * Image token formula: Anthropic charges by pixel area (≈ ⌈w/28⌉·⌈h/28⌉ patches).
 * A full dense ~1928×1928 page ≈ 69×69 = 4761 vision tokens.
 * We use the empirically-measured 1.17 chars/token for text.
 */

// ---------------------------------------------------------------------------
// Model pricing (per-million-token rates, USD) — May 2026
// These are approximate public rates; update if pricing changes.
// ---------------------------------------------------------------------------
export const MODELS = {
  'claude-opus-5': {
    inputPerMtok:  5.00,
    outputPerMtok: 25.00,
    imageTileTokens: 4761,
  },
  'claude-fable-5': {
    inputPerMtok: 10.00,
    outputPerMtok: 50.00,
    imageTileTokens: 4761,
  },
  'claude-sonnet-4-5': {
    inputPerMtok:  3.00,
    outputPerMtok: 15.00,
    imageTileTokens: 4761,   // dense 1928×1928 page = 69×69 patches
  },
  'claude-haiku-4-5': {
    inputPerMtok:  0.80,
    outputPerMtok:  4.00,
    imageTileTokens: 4761,
  },
};

/** Cache multipliers against the model's base input rate. Reads are ~0.1×; writes
 *  are 1.25× at the default 5-minute TTL and 2× at 1 hour. Exposed so callers can
 *  price a cached prefix without hardcoding the ratios. */
export const CACHE_MULTIPLIERS = { read: 0.1, write5m: 1.25, write1h: 2.0 };

/** Per-Mtok rates for a model including the derived cache rates. */
export function modelRates(model) {
  const m = MODELS[model];
  if (!m) return null;
  return {
    input: m.inputPerMtok,
    output: m.outputPerMtok,
    cacheRead: m.inputPerMtok * CACHE_MULTIPLIERS.read,
    cacheWrite5m: m.inputPerMtok * CACHE_MULTIPLIERS.write5m,
    cacheWrite1h: m.inputPerMtok * CACHE_MULTIPLIERS.write1h,
  };
}

/** Characters per token for Claude Code transcripts (empirical, N=354). */
const CHARS_PER_TOKEN = 1.17;

/** Default model for the eval. */
export const DEFAULT_MODEL = 'claude-sonnet-4-5';

// ---------------------------------------------------------------------------
// Core estimators
// ---------------------------------------------------------------------------

/**
 * Estimate tokens for a plain-text string.
 * @param {string} text
 * @returns {number}
 */
export function estimateTextTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate tokens for N rendered PNGs (each dense page ≈ 1928×1928).
 * @param {number} imageCount
 * @param {string} model
 * @returns {number}
 */
export function estimateImageTokens(imageCount, model = DEFAULT_MODEL) {
  const m = MODELS[model] ?? MODELS[DEFAULT_MODEL];
  return imageCount * m.imageTileTokens;
}

/**
 * Rough estimate of how many PNGs renderTextToPngs will produce for a given
 * text, at 100 cols, ATLAS_CELL_H=8px, MAX_HEIGHT_PX=1932.
 * Mirrors the calculation in src/core/render.ts.
 *
 * @param {string} text
 * @param {number} cols  default 100
 * @returns {number}     number of PNG images
 */
export function estimateImageCount(text, cols = 100) {
  const CELL_H = 8;
  const PAD_Y  = 4;
  const MAX_H  = 1932;
  const linesPerImg = Math.max(1, Math.floor((MAX_H - 2 * PAD_Y) / CELL_H));

  // Estimate wrapped line count: chars per row ≈ cols
  const wrappedLines = text
    .split('\n')
    .reduce((acc, line) => acc + Math.max(1, Math.ceil(line.length / cols)), 0);

  return Math.max(1, Math.ceil(wrappedLines / linesPerImg));
}

/**
 * Estimate total USD cost for a single L1 OCR call.
 *
 * One call sends:
 *   system prompt (~100 tokens) + image (imageCount tiles) + transcription ask (~20 tokens)
 *   → output: transcription of source text
 *
 * @param {{ text: string, imageCount: number }} params
 * @param {string} model
 * @returns {{ inputTokens: number, outputTokens: number, usd: number }}
 */
export function estimateL1CallCost({ text, imageCount }, model = DEFAULT_MODEL) {
  const m = MODELS[model] ?? MODELS[DEFAULT_MODEL];
  const inputTokens =
    100 +                              // system prompt
    estimateImageTokens(imageCount, model) +
    20;                                // task instruction
  const outputTokens = estimateTextTokens(text) + 10; // transcription + overhead

  const usd =
    (inputTokens  / 1_000_000) * m.inputPerMtok +
    (outputTokens / 1_000_000) * m.outputPerMtok;

  return { inputTokens, outputTokens, usd };
}

/**
 * Estimate total USD cost for a single L2 session replay call.
 *
 * One call sends:
 *   history (as images) + question text → answer (scored by judge)
 *   Plus a judge call: system (~200) + original answer + reflow answer → verdict
 *
 * @param {{ historyText: string, historyImageCount: number, questionText: string, expectedAnswer: string }} params
 * @param {string} model
 * @returns {{ inputTokens: number, outputTokens: number, judgeTokens: number, usd: number }}
 */
export function estimateL2SessionCost(
  { historyText, historyImageCount, questionText, expectedAnswer },
  model = DEFAULT_MODEL,
) {
  const m = MODELS[model] ?? MODELS[DEFAULT_MODEL];

  // Replay call (baseline): history images + question → answer
  const replayInput =
    estimateImageTokens(historyImageCount, model) +
    estimateTextTokens(questionText) +
    50;
  const replayOutput = estimateTextTokens(expectedAnswer) + 20;

  // Replay call (reflow): same but reflow images (fewer images, same token charge per image)
  const reflowImageCount = Math.max(1, Math.ceil(historyImageCount * 0.55)); // ~45% fewer
  const reflowInput =
    estimateImageTokens(reflowImageCount, model) +
    estimateTextTokens(questionText) +
    50;
  const reflowOutput = replayOutput; // same answer length

  // Judge call: both answers → verdict
  const judgeInput =
    200 +                                          // system/rubric
    estimateTextTokens(expectedAnswer) +           // reference
    estimateTextTokens(expectedAnswer) * 2 +       // two candidate answers
    50;
  const judgeOutput = 150;                        // verdict + reasoning

  const totalInput  = replayInput + reflowInput + judgeInput;
  const totalOutput = replayOutput + reflowOutput + judgeOutput;

  const usd =
    (totalInput  / 1_000_000) * m.inputPerMtok +
    (totalOutput / 1_000_000) * m.outputPerMtok;

  return {
    inputTokens:  totalInput,
    outputTokens: totalOutput,
    judgeTokens:  judgeInput + judgeOutput,
    usd,
  };
}

// ---------------------------------------------------------------------------
// Budget summary printer
// ---------------------------------------------------------------------------

/**
 * Print a formatted cost summary and return the total USD.
 *
 * @param {{ l1Blocks: any[], l2Sessions: any[] }} corpus
 * @param {string} model
 * @returns {number} total USD
 */
export function printCostEstimate(corpus, model = DEFAULT_MODEL, l1VariantCount = 2) {
  const { l1Blocks, l2Sessions } = corpus;
  let totalUsd = 0;
  // L1 runs one call per VARIANT per block, not the fixed baseline+reflow pair this
  // estimator was written against — with the current 11 variants that understated
  // the bill 5.5×. Callers pass the real count; the per-block cost below still
  // prices that pair, so scale it by variants/2.
  const variants = Math.max(1, l1VariantCount | 0);
  const variantScale = variants / 2;

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║          COST ESTIMATE (before real run)         ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Model: ${model}`);
  const rates = modelRates(model);
  if (rates) {
    console.log(`  Pricing: $${rates.input}/Mtok input, $${rates.output}/Mtok output`);
    console.log(`           $${rates.cacheRead.toFixed(2)}/Mtok cache read, ` +
                `$${rates.cacheWrite5m.toFixed(2)} (5m) / $${rates.cacheWrite1h.toFixed(2)} (1h) cache write`);
  } else {
    // Previously this printed "$?/Mtok" and then silently priced the run at
    // DEFAULT_MODEL's rates — a confidently wrong number. Say so instead.
    console.log(`  Pricing: UNKNOWN for ${model} — no entry in MODELS.`);
    console.log(`           Totals below use ${DEFAULT_MODEL} rates and are NOT this model's cost.`);
  }

  // L1
  let l1Total = { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 };
  for (const block of l1Blocks) {
    const baselineImgs = estimateImageCount(block.text);
    const reflowImgs   = Math.max(1, Math.ceil(baselineImgs * 0.55));
    // Two calls per block: baseline + reflow
    const base = estimateL1CallCost({ text: block.text, imageCount: baselineImgs }, model);
    const refl = estimateL1CallCost({ text: block.text, imageCount: reflowImgs   }, model);
    l1Total.inputTokens  += base.inputTokens  + refl.inputTokens;
    l1Total.outputTokens += base.outputTokens + refl.outputTokens;
    l1Total.usd          += base.usd          + refl.usd;
    l1Total.calls        += 2;
  }
  // Scale the baseline+reflow pair up to the real variant count.
  l1Total.inputTokens  = Math.round(l1Total.inputTokens  * variantScale);
  l1Total.outputTokens = Math.round(l1Total.outputTokens * variantScale);
  l1Total.usd         *= variantScale;
  l1Total.calls        = l1Blocks.length * variants;
  totalUsd += l1Total.usd;

  console.log(`\n  ── L1 OCR Fidelity (${l1Blocks.length} blocks x ${variants} variants) ──`);
  console.log(`     API calls:     ${l1Total.calls}`);
  console.log(`     Input tokens:  ${l1Total.inputTokens.toLocaleString()}`);
  console.log(`     Output tokens: ${l1Total.outputTokens.toLocaleString()}`);
  console.log(`     Estimated cost: $${l1Total.usd.toFixed(4)}`);

  // L2
  let l2Total = { inputTokens: 0, outputTokens: 0, usd: 0, sessions: 0 };
  for (const session of l2Sessions) {
    const histImgs = estimateImageCount(session.historyText);
    const cost = estimateL2SessionCost({
      historyText:       session.historyText,
      historyImageCount: histImgs,
      questionText:      session.questionText,
      expectedAnswer:    session.expectedAnswer,
    }, model);
    l2Total.inputTokens  += cost.inputTokens;
    l2Total.outputTokens += cost.outputTokens;
    l2Total.usd          += cost.usd;
    l2Total.sessions     += 1;
  }
  totalUsd += l2Total.usd;

  console.log(`\n  ── L2 Session Replay (${l2Sessions.length} sessions × 3 calls each) ──`);
  console.log(`     Sessions:      ${l2Total.sessions}`);
  console.log(`     Input tokens:  ${l2Total.inputTokens.toLocaleString()}`);
  console.log(`     Output tokens: ${l2Total.outputTokens.toLocaleString()}`);
  console.log(`     Estimated cost: $${l2Total.usd.toFixed(4)}`);

  console.log(`\n  ── TOTAL ──`);
  console.log(`     Estimated USD:  $${totalUsd.toFixed(4)}`);
  console.log('');

  return totalUsd;
}
