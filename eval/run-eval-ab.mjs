#!/usr/bin/env node
/**
 * eval/run-eval-ab.mjs — A/B test orchestrator
 *
 * Orchestrates the full A/B harness:
 * 1. Extract corpus (or use frozen corpus if --corpus-frozen)
 * 2. Run A/B variants via runner.mjs (≥3 runs each)
 * 3. Apply gates.mjs
 * 4. Write combined report
 *
 * Usage:
 *   node eval/run-eval-ab.mjs [--dry-run] [--confirm] [--corpus-frozen] [options]
 *
 * Flags:
 *   --dry-run        Stub the eval harness (no real LLM calls, mock results)
 *   --confirm        Confirm real API spend (required without --dry-run)
 *   --corpus-frozen  Use frozen corpus (eval/corpus-frozen/) instead of extracting
 *   --variants V1,V2 Run only specific variants (default: all)
 *   --runs N         Repetitions per variant (default: 3)
 *   --max-blocks N   Limit blocks (default: 0 = all)
 *   --model NAME     Anthropic model (default: claude-sonnet-4-5)
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const evalDir = __dirname; // run-eval-ab.mjs is in eval/

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    'dry-run':       { type: 'boolean', default: false },
    'confirm':       { type: 'boolean', default: false },
    'corpus-frozen': { type: 'boolean', default: false },
    'variants':      { type: 'string', default: '' },
    'runs':          { type: 'string', default: '3' },
    'max-blocks':    { type: 'string', default: '0' },
    'model':         { type: 'string', default: 'claude-sonnet-4-5' },
    'verbose':       { type: 'boolean', default: false },
    'help':          { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (args.help) {
  console.log(`
Usage: node eval/run-eval-ab.mjs [options]

Options:
  --dry-run        Stub the harness (mock results, no API calls)
  --confirm        Confirm real API spend (required without --dry-run)
  --corpus-frozen  Use frozen corpus (default: extract corpus)
  --variants NAMES Comma-separated variant names (default: all)
  --runs N         Repetitions per variant (default: 3)
  --max-blocks N   Limit blocks (default: 0 = all)
  --model NAME     Anthropic model (default: claude-sonnet-4-5)
  --verbose        Verbose logging
  --help           Show this help

Examples:
  # Dry run (no cost):
  node eval/run-eval-ab.mjs --dry-run --corpus-frozen

  # Real A/B test (requires --confirm):
  node eval/run-eval-ab.mjs --confirm --corpus-frozen --runs 3

  # Test specific variants:
  node eval/run-eval-ab.mjs --dry-run --variants A1-baseline,B01-qw01
`);
  process.exit(0);
}

const DRY_RUN = args['dry-run'];
const CONFIRMED = args['confirm'];
const FROZEN = args['corpus-frozen'];
const VERBOSE = args.verbose;

const log = (...a) => console.log('[run-eval-ab]', ...a);

// ---------------------------------------------------------------------------
// Step 1: Corpus extraction (unless using frozen)
// ---------------------------------------------------------------------------

if (!FROZEN && !existsSync(join(resolve(args['corpus-dir'] || join(evalDir, 'corpus')), 'text-blocks.json'))) {
  log('Step 1/3: Extracting corpus …');
  const extractResult = spawnSync('node', [
    join(evalDir, 'extract-corpus.mjs'),
    '--max-blocks', args['max-blocks'] || '20',
    '--max-sessions', '10',
    '--out-dir', resolve(join(evalDir, 'corpus')),
    ...(VERBOSE ? ['--verbose'] : []),
  ], {
    stdio: 'inherit',
    cwd: resolve(evalDir, '..'),
  });
  if (extractResult.status !== 0) {
    console.error('[run-eval-ab] Corpus extraction failed');
    process.exit(1);
  }
} else if (FROZEN) {
  log('Step 1/3: Using frozen corpus (--corpus-frozen)');
} else {
  log('Step 1/3: Corpus already exists, skipping extraction');
}

// ---------------------------------------------------------------------------
// Step 2: Run A/B variants
// ---------------------------------------------------------------------------

log('Step 2/3: Running A/B variants …');

const runnerArgs = [
  join(evalDir, 'ab', 'runner.mjs'),
  ...(DRY_RUN ? ['--dry-run'] : []),
  ...(FROZEN ? ['--corpus-frozen'] : []),
  '--runs', args.runs || '3',
  '--model', args.model || 'claude-sonnet-4-5',
  '--max-blocks', args['max-blocks'] || '0',
];

if (args.variants) {
  runnerArgs.push('--variants', args.variants);
}

if (VERBOSE) {
  runnerArgs.push('--verbose');
}

if (!DRY_RUN && !CONFIRMED) {
  console.error(
    `[run-eval-ab] Real API calls require --confirm flag.\n` +
    `     Re-run with: node eval/run-eval-ab.mjs --confirm [other flags]\n` +
    `     Or dry-run: node eval/run-eval-ab.mjs --dry-run`
  );
  process.exit(1);
}

const runnerResult = spawnSync('node', runnerArgs, {
  stdio: 'inherit',
  cwd: resolve(evalDir, '..'),
});

if (runnerResult.status !== 0) {
  console.error('[run-eval-ab] A/B runner failed');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 3: Apply gates
// ---------------------------------------------------------------------------

log('Step 3/3: Applying shipping gates …');

const gatesResult = spawnSync('node', [
  join(evalDir, 'ab', 'gates.mjs'),
  ...(VERBOSE ? ['--verbose'] : []),
], {
  stdio: 'inherit',
  cwd: resolve(evalDir, '..'),
});

if (gatesResult.status !== 0) {
  console.error('[run-eval-ab] Gates evaluation failed');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Final report
// ---------------------------------------------------------------------------

log('\n=== A/B Test Complete ===');
const resultsDir = resolve(evalDir, 'ab', 'results');
const verdictFile = join(resultsDir, 'ab-gates-verdict.json');

if (existsSync(verdictFile)) {
  const verdict = JSON.parse(readFileSync(verdictFile, 'utf8'));
  log(`  Passing variants: ${verdict.summary.passCount}/${verdict.summary.totalVariants}`);
  log(`  Verdict: ${verdictFile}`);
}

log('Done.');
