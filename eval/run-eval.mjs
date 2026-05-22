#!/usr/bin/env node
/**
 * eval/run-eval.mjs  —  Top-level orchestrator
 *
 * Runs corpus extraction, then L1 and/or L2 evals, then writes a combined
 * summary report.
 *
 * Usage:
 *   node eval/run-eval.mjs [--level 1|2|all] [--dry-run] [--confirm] [options]
 *
 * Examples:
 *   # Dry run (no API key needed):
 *   node eval/run-eval.mjs --dry-run
 *
 *   # Cost estimate only (no API calls, no --confirm needed):
 *   node eval/run-eval.mjs --estimate-only
 *
 *   # Real L1-only run:
 *   node eval/run-eval.mjs --level 1 --confirm
 *
 *   # Full run:
 *   node eval/run-eval.mjs --level all --confirm
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
  options: {
    'level':          { type: 'string',  default: 'all' },  // 1 | 2 | all
    'dry-run':        { type: 'boolean', default: false },
    'confirm':        { type: 'boolean', default: false },
    'estimate-only':  { type: 'boolean', default: false },
    'max-blocks':     { type: 'string',  default: '20'  },
    'max-sessions':   { type: 'string',  default: '10'  },
    'model':          { type: 'string',  default: 'claude-sonnet-4-5' },
    'judge-model':    { type: 'string',  default: '' },
    'corpus-dir':     { type: 'string',  default: join(__dirname, 'corpus') },
    'out-dir':        { type: 'string',  default: join(__dirname, 'results') },
    'skip-extract':   { type: 'boolean', default: false },
    'verbose':        { type: 'boolean', default: false },
    'help':           { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (args.help) {
  console.log(`
Usage: node eval/run-eval.mjs [options]

Options:
  --level 1|2|all    Which eval level(s) to run (default: all)
  --dry-run          Run without API calls (fake scores, no API key needed)
  --confirm          Confirm real API spend (required for live runs)
  --estimate-only    Print cost estimate and exit (no API calls)
  --max-blocks N     L1: max text blocks (default: 20)
  --max-sessions N   L2: max sessions (default: 10)
  --model NAME       Anthropic model (default: claude-sonnet-4-5)
  --judge-model NAME Judge model for L2 (default: same as --model)
  --corpus-dir DIR   Corpus directory (default: eval/corpus)
  --out-dir DIR      Results output directory (default: eval/results)
  --skip-extract     Skip corpus extraction (use existing corpus)
  --verbose          Verbose output
  --help             Show this help
`);
  process.exit(0);
}

const LEVEL        = args['level'];
const DRY_RUN      = args['dry-run'];
const CONFIRMED    = args['confirm'];
const ESTIMATE_ONLY = args['estimate-only'];

const log = (...a) => console.log('[run-eval]', ...a);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a node script as a child process, passing through stdout/stderr. */
function runScript(scriptPath, extraArgs = []) {
  const argv = [scriptPath, ...extraArgs];
  log(`Running: node ${argv.join(' ')}`);
  const result = spawnSync('node', argv, {
    stdio:  'inherit',
    cwd:    resolve(__dirname, '..'),
    shell:  false,
  });
  if (result.status !== 0) {
    log(`ERROR: ${scriptPath} exited with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

/** Build the common flag array for sub-scripts. */
function commonFlags() {
  const flags = [];
  if (DRY_RUN)   flags.push('--dry-run');
  if (CONFIRMED) flags.push('--confirm');
  if (args.verbose) flags.push('--verbose');
  flags.push('--corpus-dir', resolve(args['corpus-dir']));
  flags.push('--out-dir',    resolve(args['out-dir']));
  flags.push('--model',      args.model);
  return flags;
}

// ---------------------------------------------------------------------------
// Estimate-only mode: just print cost and exit
// ---------------------------------------------------------------------------

if (ESTIMATE_ONLY) {
  log('Estimate-only mode: extracting corpus and computing cost estimate …');

  // Extract corpus first if needed
  if (!existsSync(join(resolve(args['corpus-dir']), 'text-blocks.json'))) {
    runScript(join(__dirname, 'extract-corpus.mjs'), [
      '--max-blocks',   args['max-blocks'],
      '--max-sessions', args['max-sessions'],
      '--out-dir',      resolve(args['corpus-dir']),
    ]);
  }

  const { printCostEstimate } = await import('./lib/cost.mjs');
  const blocksPath   = join(resolve(args['corpus-dir']), 'text-blocks.json');
  const sessionsPath = join(resolve(args['corpus-dir']), 'sessions.json');

  const l1Blocks   = existsSync(blocksPath)   ? JSON.parse(readFileSync(blocksPath,   'utf8')) : [];
  const l2Sessions = existsSync(sessionsPath) ? JSON.parse(readFileSync(sessionsPath, 'utf8')) : [];

  printCostEstimate({ l1Blocks, l2Sessions }, args.model);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Step 1: Corpus extraction
// ---------------------------------------------------------------------------

if (!args['skip-extract']) {
  log('Step 1/3: Extracting corpus …');
  runScript(join(__dirname, 'extract-corpus.mjs'), [
    '--max-blocks',   args['max-blocks'],
    '--max-sessions', args['max-sessions'],
    '--out-dir',      resolve(args['corpus-dir']),
    ...(args.verbose ? ['--verbose'] : []),
  ]);
} else {
  log('Step 1/3: Skipping corpus extraction (--skip-extract)');
}

// ---------------------------------------------------------------------------
// Step 2: Run requested eval levels
// ---------------------------------------------------------------------------

const runL1 = LEVEL === '1' || LEVEL === 'all';
const runL2 = LEVEL === '2' || LEVEL === 'all';

if (runL1) {
  log('Step 2/3: Running L1 OCR fidelity eval …');
  runScript(join(__dirname, 'eval-l1-ocr.mjs'), [
    ...commonFlags(),
    '--max-blocks', args['max-blocks'],
  ]);
}

if (runL2) {
  log('Step 2/3: Running L2 session replay eval …');
  const judgeFlag = args['judge-model']
    ? ['--judge-model', args['judge-model']]
    : [];
  runScript(join(__dirname, 'eval-l2-session.mjs'), [
    ...commonFlags(),
    '--max-sessions', args['max-sessions'],
    ...judgeFlag,
  ]);
}

// ---------------------------------------------------------------------------
// Step 3: Write combined summary report
// ---------------------------------------------------------------------------

log('Step 3/3: Writing combined report …');

const OUT_DIR = resolve(args['out-dir']);
mkdirSync(OUT_DIR, { recursive: true });

const l1ReportPath = join(OUT_DIR, 'l1-report.md');
const l2ReportPath = join(OUT_DIR, 'l2-report.md');
const l1JsonPath   = join(OUT_DIR, 'l1-results.json');
const l2JsonPath   = join(OUT_DIR, 'l2-results.json');

const l1Results = existsSync(l1JsonPath) ? JSON.parse(readFileSync(l1JsonPath, 'utf8')) : null;
const l2Results = existsSync(l2JsonPath) ? JSON.parse(readFileSync(l2JsonPath, 'utf8')) : null;

const now     = new Date().toISOString();
const dryNote = DRY_RUN ? ' *(dry run — scores are simulated)*' : '';

const combinedLines = [
  `# Reflow Eval — Combined Summary Report`,
  ``,
  `**Generated:** ${now}${dryNote}  `,
  `**Model:** ${args.model}  `,
  `**Levels run:** ${[runL1 && 'L1', runL2 && 'L2'].filter(Boolean).join(', ')}`,
  ``,
  `## Overview`,
  ``,
  l1Results ? [
    `### L1: OCR Fidelity`,
    ``,
    `| | Baseline | Reflow | Δ |`,
    `|--|---------|--------|---|`,
    `| Mean char accuracy | ${(l1Results.baselineAgg.meanAccuracy * 100).toFixed(2)}% | ${(l1Results.reflowAgg.meanAccuracy * 100).toFixed(2)}% | ${((l1Results.reflowAgg.meanAccuracy - l1Results.baselineAgg.meanAccuracy) * 100).toFixed(2)}pp |`,
    `| Macro accuracy | ${(l1Results.baselineAgg.macroAccuracy * 100).toFixed(2)}% | ${(l1Results.reflowAgg.macroAccuracy * 100).toFixed(2)}% | ${((l1Results.reflowAgg.macroAccuracy - l1Results.baselineAgg.macroAccuracy) * 100).toFixed(2)}pp |`,
    `| Image savings | — | ${l1Results.imageSavingsPct.toFixed(1)}% | |`,
    ``,
    `Full L1 report: [l1-report.md](l1-report.md)`,
    ``,
  ].join('\n') : '*(L1 not run)*',

  ``,

  l2Results ? [
    `### L2: Session Replay`,
    ``,
    `| | Value |`,
    `|--|------|`,
    `| Mean judge score | ${(l2Results.meanScore * 100).toFixed(1)}% |`,
    `| Pass rate (≥ 0.75) | ${(l2Results.passRate * 100).toFixed(1)}% |`,
    `| Image savings | ${l2Results.imageSavingsPct.toFixed(1)}% |`,
    ``,
    `Full L2 report: [l2-report.md](l2-report.md)`,
    ``,
  ].join('\n') : '*(L2 not run)*',

  ``,
  `## Shipping Gate`,
  ``,
  `Reflow is **safe to ship** if ALL of the following hold:`,
  ``,
  `- [ ] L1 mean accuracy delta ≥ −2pp  (reflow OCR not materially worse)`,
  `- [ ] L1 macro accuracy ≥ 95%         (overall character fidelity high)`,
  `- [ ] L2 mean judge score ≥ 0.80      (task comprehension preserved)`,
  `- [ ] L2 pass rate ≥ 80%              (failures are rare outliers)`,
  ``,
  `If any gate fails, investigate the failing sessions/blocks before shipping.`,
  ``,
  `## How to Interpret`,
  ``,
  `See [README.md](README.md) for full guidance on running and interpreting each level.`,
  ``,
  DRY_RUN ? `> ⚠️  **Dry-run mode**: all scores are simulated. Re-run with \`--confirm\` to get real scores.` : '',
];

const combinedPath = join(OUT_DIR, 'summary.md');
writeFileSync(combinedPath, combinedLines.join('\n'), 'utf8');

log(`Combined summary written to ${combinedPath}`);
log('Done.');
