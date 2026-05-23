#!/usr/bin/env node
/**
 * eval/eval-l1-ocr.mjs  —  Level 1: OCR Fidelity
 *
 * For each text block in eval/corpus/text-blocks.json, render it under every
 * variant in VARIANTS, send each image set to the Anthropic Messages API for
 * verbatim transcription, diff against minifyForRender(source) with
 * character-level Levenshtein distance, and write eval/results/l1-report.md.
 *
 * Variants under test: see the VARIANTS array below.
 *
 * Flags:
 *   --dry-run     Skip API calls; print what would be sent + use fake scores
 *   --confirm     Required for real API calls (cost confirmation gate)
 *   --max-blocks  Override number of blocks to evaluate (default: all in corpus)
 *   --variants    Comma-separated list of variant names to run (default: all)
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
    'variants':   { type: 'string',  default: '' },
    'verbose':    { type: 'boolean', default: false },
    'help':       { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (args.help) {
  console.log(`
Usage: node eval/eval-l1-ocr.mjs [options]

Options:
  --dry-run          Run without API calls (fake scores)
  --confirm          Confirm real API spend (required without --dry-run)
  --max-blocks N     Evaluate at most N blocks (default: all)
  --variants NAMES   Comma-separated variant names to run (default: all)
                     Example: --variants baseline,aa-5x8,aa-7x10
  --model NAME       Anthropic model (default: claude-sonnet-4-5)
  --corpus-dir       Path to corpus directory (default: eval/corpus)
  --out-dir          Output directory for results (default: eval/results)
  --verbose          Print per-block progress
  --help             Show this help
`);
  process.exit(0);
}

const DRY_RUN        = args['dry-run'];
const CONFIRMED      = args['confirm'];
const MAX_BLOCKS     = parseInt(args['max-blocks'], 10);
const MODEL          = args['model'];
const CORPUS_DIR     = resolve(args['corpus-dir']);
const OUT_DIR        = resolve(args['out-dir']);
const VERBOSE        = args['verbose'];
const VARIANTS_FILTER = args['variants'];

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const { renderTextToPngs, renderTextToPngsReflow, minifyForRender, bytesToBase64 } =
  await import('./lib/render-bridge.mjs');

const { createClient }                     = await import('./lib/anthropic-client.mjs');
const { scoreTranscription, aggregateScores } = await import('./lib/diff.mjs');
const { printCostEstimate } =
  await import('./lib/cost.mjs');

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

const GRID_NOTE = `
The image also contains faint light-grey horizontal and vertical rule lines forming a grid. These are layout guides ONLY — ignore them completely, never transcribe them as content.`;

const REFLOW_GRID_SYSTEM = REFLOW_SYSTEM + GRID_NOTE;

const BASELINE_PROMPT = 'Transcribe this text verbatim.';
const REFLOW_PROMPT   = 'Transcribe this text verbatim, replacing ↵ with line breaks.';

// ---------------------------------------------------------------------------
// Variants under test
// ---------------------------------------------------------------------------
// Each variant renders the same source differently. `baseline` is the no-reflow
// reference; everything else is a reflow render with a structure aid layered on.
// `render` returns RenderedImage[]; styles are passed straight to the renderer.

const VARIANTS = [
  {
    name:   'baseline',
    render: (src) => renderTextToPngs(src),
    system: BASELINE_SYSTEM,
    prompt: BASELINE_PROMPT,
  },
  {
    name:   'reflow',
    render: (src) => renderTextToPngsReflow(src),
    system: REFLOW_SYSTEM,
    prompt: REFLOW_PROMPT,
  },
  // Cell-pitch sweep. Glyph bitmaps never change (always the 5×8 Spleen
  // atlas); only the layout pitch moves. `WxH` names the cell: W = horizontal
  // advance (5 = native; 4 = glyphs overlap 1px; 6 = 1px gap), H = vertical
  // pitch (8 = native; 9/10/11 = blank rows between text lines).
  {
    name:   'reflow-6x9',
    render: (src) => renderTextToPngsReflow(src, 100, { cellWBonus: 1, cellHBonus: 1 }),
    system: REFLOW_SYSTEM,
    prompt: REFLOW_PROMPT,
  },
  {
    name:   'reflow-7x9',
    render: (src) => renderTextToPngsReflow(src, 100, { cellWBonus: 2, cellHBonus: 1 }),
    system: REFLOW_SYSTEM,
    prompt: REFLOW_PROMPT,
  },
  {
    name:   'reflow-6x10',
    render: (src) => renderTextToPngsReflow(src, 100, { cellWBonus: 1, cellHBonus: 2 }),
    system: REFLOW_SYSTEM,
    prompt: REFLOW_PROMPT,
  },
  {
    name:   'reflow-7x10',
    render: (src) => renderTextToPngsReflow(src, 100, { cellWBonus: 2, cellHBonus: 2 }),
    system: REFLOW_SYSTEM,
    prompt: REFLOW_PROMPT,
  },
  {
    name:   'reflow-8x10',
    render: (src) => renderTextToPngsReflow(src, 100, { cellWBonus: 3, cellHBonus: 2 }),
    system: REFLOW_SYSTEM,
    prompt: REFLOW_PROMPT,
  },
  // AA grayscale variants — use the anti-aliased gray atlas (atlas-gray.ts).
  // `aa-5x8`: bare atlas cell, no cell bonus = the bare atlas cell size.
  // `aa-7x10`: same cell pitch as reflow-7x10 for a fair A/B comparison.
  {
    name:   'aa-5x8',
    render: (src) => renderTextToPngsReflow(src, 100, { aa: true, cellWBonus: 0, cellHBonus: 0 }),
    system: REFLOW_SYSTEM,
    prompt: REFLOW_PROMPT,
  },
  {
    name:   'aa-5x8-color',
    render: (src) => renderTextToPngsReflow(src, 100, { aa: true, cellWBonus: 0, cellHBonus: 0, colorCycle: true }),
    system: REFLOW_SYSTEM,
    prompt: REFLOW_PROMPT,
  },
  {
    name:   'aa-7x10',
    render: (src) => renderTextToPngsReflow(src, 100, { aa: true, cellWBonus: 2, cellHBonus: 2 }),
    system: REFLOW_SYSTEM,
    prompt: REFLOW_PROMPT,
  },
];

const BASELINE_NAME = 'baseline';

// ---------------------------------------------------------------------------
// Apply --variants filter (if specified)
// ---------------------------------------------------------------------------

if (VARIANTS_FILTER) {
  const requested = VARIANTS_FILTER.split(',').map(s => s.trim()).filter(Boolean);
  const validNames = VARIANTS.map(v => v.name);
  const unknown = requested.filter(n => !validNames.includes(n));
  if (unknown.length > 0) {
    console.error(`[L1] Unknown variant(s): ${unknown.join(', ')}`);
    console.error(`     Valid names: ${validNames.join(', ')}`);
    process.exit(1);
  }
  // Filter in-place, preserving VARIANTS array reference for the rest of the script.
  const keep = new Set(requested);
  VARIANTS.splice(0, VARIANTS.length, ...VARIANTS.filter(v => keep.has(v.name)));
}

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
console.log(`[L1] Variants: ${VARIANTS.map(v => v.name).join(', ')}`);

// ---------------------------------------------------------------------------
// Cost estimate gate
// ---------------------------------------------------------------------------
// printCostEstimate models the legacy 2-call (baseline + reflow) shape. Actual
// spend scales by the variant count, so adjust the headline figure.

const corpus = { l1Blocks: blocks, l2Sessions: [] };
const baseUsd = printCostEstimate(corpus, MODEL);
const totalUsd = baseUsd * (VARIANTS.length / 2);
console.log(`[L1] ${VARIANTS.length} variants/block → estimated ~$${totalUsd.toFixed(4)} USD\n`);

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

/** Render one variant, call the API, score the transcription. Returns
 *  { score, imageCount } — or null on a render/API error. */
async function runVariant(variant, source, reference) {
  let images;
  try {
    images = await variant.render(source);
  } catch (err) {
    console.error(`  ERROR rendering [${variant.name}]: ${err.message}`);
    return null;
  }
  const content = images.map(img => ({
    type:   'image',
    source: { type: 'base64', media_type: 'image/png', data: bytesToBase64(img.png) },
  }));
  content.push({ type: 'text', text: variant.prompt });

  let resp;
  try {
    resp = await client.messages({
      system:     variant.system,
      messages:   [{ role: 'user', content }],
      max_tokens: 2048,
    });
  } catch (err) {
    console.error(`  ERROR calling API [${variant.name}]: ${err.message}`);
    return null;
  }
  const text  = resp.content?.[0]?.text ?? '';
  const score = scoreTranscription({ reference, hypothesis: text });
  return { score, imageCount: images.length };
}

// ---------------------------------------------------------------------------
// Per-block evaluation
// ---------------------------------------------------------------------------

/** @type {Array<{ blockIdx: number, charCount: number, role: string, variants: Record<string, {score: object, imageCount: number}> }>} */
const results = [];

for (let idx = 0; idx < blocks.length; idx++) {
  const block = blocks[idx];
  const source = block.text;
  const reference = minifyForRender(source);

  console.log(`[L1] Block ${idx + 1}/${blocks.length}  (${source.length} chars, role=${block.role})`);

  // All variants for this block run concurrently.
  const settled = await Promise.all(
    VARIANTS.map(v => runVariant(v, source, reference)),
  );

  const variantResults = {};
  let anyMissing = false;
  VARIANTS.forEach((v, i) => {
    if (settled[i]) variantResults[v.name] = settled[i];
    else anyMissing = true;
  });
  if (anyMissing) {
    console.error(`  block ${idx} skipped — a variant failed`);
    continue;
  }

  if (VERBOSE) {
    for (const v of VARIANTS) {
      const r = variantResults[v.name];
      console.log(`  ${v.name.padEnd(20)} acc ${(r.score.charAccuracy * 100).toFixed(1)}%  ` +
        `dist ${r.score.editDistance}  imgs ${r.imageCount}`);
    }
  }

  results.push({
    blockIdx:  idx,
    charCount: source.length,
    role:      block.role,
    variants:  variantResults,
  });
}

// ---------------------------------------------------------------------------
// Aggregate (per variant)
// ---------------------------------------------------------------------------

/** @type {Record<string, {agg: object, imageCount: number}>} */
const perVariant = {};
for (const v of VARIANTS) {
  const scores = results.map(r => r.variants[v.name].score);
  const imageCount = results.reduce((s, r) => s + r.variants[v.name].imageCount, 0);
  perVariant[v.name] = { agg: aggregateScores(scores), imageCount };
}

const baselineImgTotal = Math.max(1, perVariant[BASELINE_NAME]?.imageCount ?? 1);
function imageSavingsPct(name) {
  return (1 - perVariant[name].imageCount / baselineImgTotal) * 100;
}

// ---------------------------------------------------------------------------
// Write report
// ---------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });

const baselineMean = perVariant[BASELINE_NAME]?.agg.meanAccuracy ?? 0;

const reportLines = [
  `# L1 OCR Fidelity Report`,
  ``,
  `**Generated:** ${new Date().toISOString()}  `,
  `**Model:** ${MODEL}  `,
  `**Dry run:** ${DRY_RUN}  `,
  `**Blocks evaluated:** ${results.length}`,
  ``,
  `## Summary (per variant)`,
  ``,
  `| Variant | Mean Acc | Median Acc | Min Acc | Δ vs baseline | Image savings |`,
  `|---------|----------|-----------|---------|---------------|---------------|`,
  ...VARIANTS.map(v => {
    const a = perVariant[v.name].agg;
    const delta = (a.meanAccuracy - baselineMean) * 100;
    return `| ${v.name} | ${(a.meanAccuracy * 100).toFixed(2)}% | ${(a.medianAccuracy * 100).toFixed(2)}% | ${(a.minAccuracy * 100).toFixed(2)}% | ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}pp | ${imageSavingsPct(v.name).toFixed(1)}% |`;
  }),
  ``,
  `## Interpretation`,
  ``,
  `- **baseline** is the no-reflow reference; **reflow** is the regression to fix.`,
  `- A variant **ships** if its mean accuracy is within −2pp of baseline AND its image savings are > 0%.`,
  `- \`Δ vs baseline\` of \`reflow\` quantifies the damage; the structure-aid variants should claw it back.`,
  ``,
  `## Per-Block Accuracy`,
  ``,
  `| Block | Chars | Role | ${VARIANTS.map(v => v.name).join(' | ')} |`,
  `|-------|-------|------|${VARIANTS.map(() => '------').join('|')}|`,
  ...results.map(r =>
    `| ${r.blockIdx + 1} | ${r.charCount} | ${r.role} | ` +
    VARIANTS.map(v => `${(r.variants[v.name].score.charAccuracy * 100).toFixed(1)}%`).join(' | ') +
    ` |`
  ),
  ``,
  DRY_RUN ? `> ⚠️  **Dry-run mode**: scores are simulated with artificial OCR noise (~3% error rate). Real scores require \`--confirm\`.` : '',
];

const reportPath = join(OUT_DIR, 'l1-report.md');
writeFileSync(reportPath, reportLines.join('\n'), 'utf8');

const jsonPath = join(OUT_DIR, 'l1-results.json');
writeFileSync(jsonPath, JSON.stringify({ results, perVariant, dryRun: DRY_RUN }, null, 2), 'utf8');

// ---------------------------------------------------------------------------
// Console summary
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(64)}`);
console.log(`  L1 OCR FIDELITY SUMMARY  (${DRY_RUN ? 'DRY RUN' : 'REAL'})`);
console.log(`${'─'.repeat(64)}`);
console.log(`  Blocks evaluated: ${results.length}`);
for (const v of VARIANTS) {
  const a = perVariant[v.name].agg;
  const delta = (a.meanAccuracy - baselineMean) * 100;
  console.log(`  ${v.name.padEnd(20)} ${(a.meanAccuracy * 100).toFixed(2)}%  ` +
    `(${delta >= 0 ? '+' : ''}${delta.toFixed(2)}pp)  savings ${imageSavingsPct(v.name).toFixed(1)}%`);
}
console.log(`  Report: ${reportPath}`);
console.log(`${'─'.repeat(64)}\n`);
