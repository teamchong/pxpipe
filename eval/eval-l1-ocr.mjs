#!/usr/bin/env node
/**
 * eval/eval-l1-ocr.mjs  —  Level 1: OCR Fidelity
 *
 * For each text block in eval/corpus/text-blocks.json:
 *   1. Render with renderTextToPngs()         → "baseline" PNGs
 *   2. Render with renderTextToPngsReflow()   → "reflow"   PNGs
 *   3. Send each image set to the Anthropic Messages API asking for verbatim
 *      transcription (reflow system prompt includes the ↵ explanation)
 *   4. Diff each transcription against minifyForRender(source) using
 *      character-level Levenshtein edit distance
 *   5. Aggregate and write eval/results/l1-report.md
 *
 * Flags:
 *   --dry-run     Skip API calls; print what would be sent + use fake scores
 *   --confirm     Required for real API calls (cost confirmation gate)
 *   --max-blocks  Override number of blocks to evaluate (default: all in corpus)
 *   --model       Anthropic model to use (default: claude-sonnet-4-5)
 *   --corpus-dir  Directory containing text-blocks.json (default: eval/corpus)
 *   --out-dir     Results directory (default: eval/results)
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
  options: {
    'dry-run':    { type: 'boolean', default: false },
    'confirm':    { type: 'boolean', default: false },
    'max-blocks': { type: 'string',  default: '0'   }, // 0 = all
    'model':      { type: 'string',  default: 'claude-sonnet-4-5' },
    'corpus-dir': { type: 'string',  default: join(__dirname, 'corpus') },
    'out-dir':    { type: 'string',  default: join(__dirname, 'results') },
    'verbose':    { type: 'boolean', default: false },
    'help':       { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (args.help) {
  console.log(`
Usage: node eval/eval-l1-ocr.mjs [options]

Options:
  --dry-run       Run without API calls (fake scores)
  --confirm       Confirm real API spend (required without --dry-run)
  --max-blocks N  Evaluate at most N blocks (default: all)
  --model NAME    Anthropic model (default: claude-sonnet-4-5)
  --corpus-dir    Path to corpus directory (default: eval/corpus)
  --out-dir       Output directory for results (default: eval/results)
  --verbose       Print per-block progress
  --help          Show this help
`);
  process.exit(0);
}

const DRY_RUN    = args['dry-run'];
const CONFIRMED  = args['confirm'];
const MAX_BLOCKS = parseInt(args['max-blocks'], 10);
const MODEL      = args['model'];
const CORPUS_DIR = resolve(args['corpus-dir']);
const OUT_DIR    = resolve(args['out-dir']);
const VERBOSE    = args['verbose'];

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const { renderTextToPngs, renderTextToPngsReflow, minifyForRender, bytesToBase64 } =
  await import('./lib/render-bridge.mjs');

const { createClient }                     = await import('./lib/anthropic-client.mjs');
const { scoreTranscription, aggregateScores } = await import('./lib/diff.mjs');
const { printCostEstimate, estimateImageCount, DEFAULT_MODEL, estimateL1CallCost } =
  await import('./lib/cost.mjs');

// ---------------------------------------------------------------------------
// Load corpus
// ---------------------------------------------------------------------------

const blocksPath = join(CORPUS_DIR, 'text-blocks.json');
if (!existsSync(blocksPath)) {
  console.error(`[L1] Corpus not found at ${blocksPath}`);
  console.error(`     Run: node eval/extract-corpus.mjs`);
  process.exit(1);
}

let blocks = JSON.parse(readFileSync(blocksPath, 'utf8'));
if (MAX_BLOCKS > 0) blocks = blocks.slice(0, MAX_BLOCKS);
console.log(`[L1] Loaded ${blocks.length} text blocks from corpus`);

// ---------------------------------------------------------------------------
// Cost estimate gate
// ---------------------------------------------------------------------------

const corpus = { l1Blocks: blocks, l2Sessions: [] };
const totalUsd = printCostEstimate(corpus, MODEL);

if (!DRY_RUN && !CONFIRMED) {
  console.error(
    `[L1] Real API calls require --confirm flag.\n` +
    `     Estimated cost: $${totalUsd.toFixed(4)}\n` +
    `     Re-run with: node eval/eval-l1-ocr.mjs --confirm\n` +
    `     Or test without spend: node eval/eval-l1-ocr.mjs --dry-run`,
  );
  process.exit(1);
}

if (DRY_RUN) {
  console.log('[L1] DRY RUN — no API calls will be made\n');
} else {
  console.log(`[L1] CONFIRMED — will spend ~$${totalUsd.toFixed(4)} USD\n`);
}

// ---------------------------------------------------------------------------
// Set up Anthropic client
// ---------------------------------------------------------------------------

const client = createClient({ model: MODEL, dryRun: DRY_RUN });

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const BASELINE_SYSTEM = `You are a precise OCR transcription assistant.
You will be shown an image containing rendered text.
Transcribe the text EXACTLY as it appears — preserve all line breaks, spacing, punctuation, and indentation.
Do not add explanations, commentary, or markdown formatting.
Output only the transcribed text.`;

const REFLOW_SYSTEM = `You are a precise OCR transcription assistant.
You will be shown an image containing rendered text in a special "reflowed" format.
In this format, the glyph ↵ (U+21B5) denotes an original hard line break.
When transcribing:
  - Replace each ↵ with a real newline character
  - Preserve all other spacing and punctuation exactly
  - Do not add explanations, commentary, or markdown formatting
Output only the transcribed text with line breaks restored.`;

// ---------------------------------------------------------------------------
// Per-block evaluation
// ---------------------------------------------------------------------------

/** @type {Array<{ blockIdx: number, charCount: number, baselineScore: object, reflowScore: object, baselineImageCount: number, reflowImageCount: number, dryRun: boolean }>} */
const results = [];

for (let idx = 0; idx < blocks.length; idx++) {
  const block = blocks[idx];
  const source = block.text;
  const reference = minifyForRender(source);

  console.log(`[L1] Block ${idx + 1}/${blocks.length}  (${source.length} chars, role=${block.role})`);

  // --- Render both ways ---
  let baselineImages, reflowImages;
  try {
    [baselineImages, reflowImages] = await Promise.all([
      renderTextToPngs(source),
      renderTextToPngsReflow(source),
    ]);
  } catch (err) {
    console.error(`  ERROR rendering block ${idx}: ${err.message}`);
    continue;
  }

  if (VERBOSE) {
    console.log(`  baseline: ${baselineImages.length} PNG(s), reflow: ${reflowImages.length} PNG(s)`);
  }

  if (!DRY_RUN && VERBOSE) {
    console.log(`  Sending to API …`);
  }

  // --- Baseline OCR call ---
  const baselineApiContent = baselineImages.map(img => ({
    type:   'image',
    source: { type: 'base64', media_type: 'image/png', data: bytesToBase64(img.png) },
  }));
  baselineApiContent.push({ type: 'text', text: 'Transcribe this text verbatim.' });

  // --- Reflow OCR call ---
  const reflowApiContent = reflowImages.map(img => ({
    type:   'image',
    source: { type: 'base64', media_type: 'image/png', data: bytesToBase64(img.png) },
  }));
  reflowApiContent.push({ type: 'text', text: 'Transcribe this text verbatim, replacing ↵ with line breaks.' });

  let baselineResp, reflowResp;
  try {
    [baselineResp, reflowResp] = await Promise.all([
      client.messages({
        system:     BASELINE_SYSTEM,
        messages:   [{ role: 'user', content: baselineApiContent }],
        max_tokens: 2048,
      }),
      client.messages({
        system:     REFLOW_SYSTEM,
        messages:   [{ role: 'user', content: reflowApiContent }],
        max_tokens: 2048,
      }),
    ]);
  } catch (err) {
    console.error(`  ERROR calling API for block ${idx}: ${err.message}`);
    continue;
  }

  const baselineText = baselineResp.content?.[0]?.text ?? '';
  const reflowText   = reflowResp.content?.[0]?.text ?? '';

  const baselineScore = scoreTranscription({ reference, hypothesis: baselineText });
  const reflowScore   = scoreTranscription({ reference, hypothesis: reflowText   });

  if (VERBOSE) {
    console.log(`  baseline accuracy: ${(baselineScore.charAccuracy * 100).toFixed(1)}%  ` +
      `edit dist: ${baselineScore.editDistance}`);
    console.log(`  reflow   accuracy: ${(reflowScore.charAccuracy   * 100).toFixed(1)}%  ` +
      `edit dist: ${reflowScore.editDistance}`);
  }

  results.push({
    blockIdx:           idx,
    charCount:          source.length,
    role:               block.role,
    baselineImageCount: baselineImages.length,
    reflowImageCount:   reflowImages.length,
    baselineScore,
    reflowScore,
    dryRun:             DRY_RUN,
  });
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

const baselineAgg = aggregateScores(results.map(r => r.baselineScore));
const reflowAgg   = aggregateScores(results.map(r => r.reflowScore));

const imageSavingsPct = results.length > 0
  ? (1 - results.reduce((s, r) => s + r.reflowImageCount, 0) /
         Math.max(1, results.reduce((s, r) => s + r.baselineImageCount, 0))) * 100
  : 0;

// ---------------------------------------------------------------------------
// Write report
// ---------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });

const reportLines = [
  `# L1 OCR Fidelity Report`,
  ``,
  `**Generated:** ${new Date().toISOString()}  `,
  `**Model:** ${MODEL}  `,
  `**Dry run:** ${DRY_RUN}  `,
  `**Blocks evaluated:** ${results.length}`,
  ``,
  `## Summary`,
  ``,
  `| Metric | Baseline | Reflow | Delta |`,
  `|--------|----------|--------|-------|`,
  `| Mean char accuracy | ${(baselineAgg.meanAccuracy   * 100).toFixed(2)}% | ${(reflowAgg.meanAccuracy   * 100).toFixed(2)}% | ${((reflowAgg.meanAccuracy   - baselineAgg.meanAccuracy)   * 100).toFixed(2)}pp |`,
  `| Median char accuracy | ${(baselineAgg.medianAccuracy * 100).toFixed(2)}% | ${(reflowAgg.medianAccuracy * 100).toFixed(2)}% | ${((reflowAgg.medianAccuracy - baselineAgg.medianAccuracy) * 100).toFixed(2)}pp |`,
  `| Min char accuracy | ${(baselineAgg.minAccuracy    * 100).toFixed(2)}% | ${(reflowAgg.minAccuracy    * 100).toFixed(2)}% | ${((reflowAgg.minAccuracy    - baselineAgg.minAccuracy)    * 100).toFixed(2)}pp |`,
  `| Macro accuracy (all chars) | ${(baselineAgg.macroAccuracy * 100).toFixed(2)}% | ${(reflowAgg.macroAccuracy * 100).toFixed(2)}% | ${((reflowAgg.macroAccuracy - baselineAgg.macroAccuracy) * 100).toFixed(2)}pp |`,
  `| Total edit distance | ${baselineAgg.totalEdits} | ${reflowAgg.totalEdits} | ${reflowAgg.totalEdits - baselineAgg.totalEdits} |`,
  `| Image count savings | — | ${imageSavingsPct.toFixed(1)}% fewer images | |`,
  ``,
  `## Interpretation`,
  ``,
  `- **≥ −2pp accuracy delta** → reflow comprehension is acceptable (within noise)`,
  `- **< −5pp accuracy delta** → reflow OCR is materially worse; investigate before shipping`,
  `- **Image savings** → higher is better (fewer images = lower token cost per call)`,
  ``,
  `## Per-Block Results`,
  ``,
  `| Block | Chars | Role | Baseline PNGs | Reflow PNGs | Baseline Acc | Reflow Acc | Δ Accuracy |`,
  `|-------|-------|------|--------------|-------------|-------------|-----------|-----------|`,
  ...results.map(r =>
    `| ${r.blockIdx + 1} | ${r.charCount} | ${r.role} | ${r.baselineImageCount} | ${r.reflowImageCount} | ${(r.baselineScore.charAccuracy * 100).toFixed(1)}% | ${(r.reflowScore.charAccuracy * 100).toFixed(1)}% | ${((r.reflowScore.charAccuracy - r.baselineScore.charAccuracy) * 100).toFixed(1)}pp |`
  ),
  ``,
  DRY_RUN ? `> ⚠️  **Dry-run mode**: scores are simulated with artificial OCR noise (~3% error rate). Real scores require \`--confirm\`.` : '',
];

const reportPath = join(OUT_DIR, 'l1-report.md');
writeFileSync(reportPath, reportLines.join('\n'), 'utf8');

// Also write raw JSON for programmatic use
const jsonPath = join(OUT_DIR, 'l1-results.json');
writeFileSync(jsonPath, JSON.stringify({ results, baselineAgg, reflowAgg, imageSavingsPct, dryRun: DRY_RUN }, null, 2), 'utf8');

// ---------------------------------------------------------------------------
// Console summary
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(60)}`);
console.log(`  L1 OCR FIDELITY SUMMARY  (${DRY_RUN ? 'DRY RUN' : 'REAL'})`);
console.log(`${'─'.repeat(60)}`);
console.log(`  Blocks evaluated:    ${results.length}`);
console.log(`  Baseline mean acc:   ${(baselineAgg.meanAccuracy * 100).toFixed(2)}%`);
console.log(`  Reflow   mean acc:   ${(reflowAgg.meanAccuracy   * 100).toFixed(2)}%`);
console.log(`  Accuracy delta:      ${((reflowAgg.meanAccuracy - baselineAgg.meanAccuracy) * 100).toFixed(2)}pp`);
console.log(`  Image savings:       ${imageSavingsPct.toFixed(1)}%`);
console.log(`  Report:              ${reportPath}`);
console.log(`${'─'.repeat(60)}\n`);
