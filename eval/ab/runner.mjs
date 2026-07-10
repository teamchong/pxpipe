#!/usr/bin/env node
/**
 * eval/ab/runner.mjs — A/B test runner
 *
 * For each variant, spawns ≥3 child processes (eval-l1-ocr.mjs or mock)
 * with the variant's environment variables set, collects results into
 * eval/ab/results/<variant>-<run_N>.json.
 *
 * Usage:
 *   node eval/ab/runner.mjs [--dry-run] [--runs 3] [--variants V1,V2,...] \
 *     [--corpus-frozen] [--max-blocks N]
 *
 * Flags:
 *   --dry-run        Stub the eval (no real LLM calls, mock results)
 *   --runs N         Number of repetitions per variant (default: 3)
 *   --variants NAMES Comma-separated variant names to run
 *   --corpus-frozen  Use frozen corpus (eval/corpus-frozen/) instead of eval/corpus/
 *   --max-blocks N   Limit blocks per variant run (default: 0 = all)
 *   --model NAME     Model for L1 (default: claude-sonnet-4-5)
 */

import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import VARIANTS from './variants.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const evalDir = resolve(__dirname, '..');
const abDir = resolve(evalDir, 'ab');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    'dry-run':      { type: 'boolean', default: false },
    'runs':         { type: 'string',  default: '3' },
    'variants':     { type: 'string',  default: '' },
    'corpus-frozen':{ type: 'boolean', default: false },
    'max-blocks':   { type: 'string',  default: '0' },
    'model':        { type: 'string',  default: 'claude-sonnet-4-5' },
    // Spawn the real L1 child WITHOUT --confirm: full pipeline (render,
    // corpus, result plumbing) but simulated scores, zero API cost.
    'l1-dry-run':   { type: 'boolean', default: false },
    'verbose':      { type: 'boolean', default: false },
    'help':         { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (args.help) {
  console.log(`
Usage: node eval/ab/runner.mjs [options]

Options:
  --dry-run        Stub the eval (mock results, no API calls)
  --runs N         Repetitions per variant (default: 3)
  --variants NAMES Comma-separated names (default: all)
  --corpus-frozen  Use frozen corpus (default: eval/corpus/)
  --max-blocks N   Limit blocks (default: 0 = all)
  --model NAME     Anthropic model (default: claude-sonnet-4-5)
  --verbose        Verbose logging
  --help           Show this help
`);
  process.exit(0);
}

const DRY_RUN = args['dry-run'];
const NUM_RUNS = Math.max(1, parseInt(args.runs, 10));
const VARIANTS_FILTER = args.variants;
const USE_FROZEN = args['corpus-frozen'];
const MAX_BLOCKS = args['max-blocks'];
const MODEL = args.model;
const L1_DRY_RUN = args['l1-dry-run'];
const VERBOSE = args.verbose;

const log = (...a) => console.log('[ab-runner]', ...a);

// ---------------------------------------------------------------------------
// Filter variants if requested
// ---------------------------------------------------------------------------

let variantsToRun = VARIANTS;
if (VARIANTS_FILTER) {
  const requested = VARIANTS_FILTER.split(',').map(s => s.trim()).filter(Boolean);
  variantsToRun = VARIANTS.filter(v => requested.includes(v.name));
  if (variantsToRun.length !== requested.length) {
    const unknown = requested.filter(
      n => !VARIANTS.map(v => v.name).includes(n)
    );
    console.error(`[ab-runner] Unknown variant(s): ${unknown.join(', ')}`);
    process.exit(1);
  }
}

log(`Will run ${variantsToRun.length} variant(s) × ${NUM_RUNS} run(s) each`);

// ---------------------------------------------------------------------------
// Setup result directory
// ---------------------------------------------------------------------------

const resultsDir = resolve(abDir, 'results');
mkdirSync(resultsDir, { recursive: true });

// ---------------------------------------------------------------------------
// QW07 cache management
// ---------------------------------------------------------------------------

const CACHE_DIR = resolve(abDir, '.cache');

function cleanCache() {
  if (existsSync(CACHE_DIR)) {
    rmSync(CACHE_DIR, { recursive: true, force: true });
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  if (VERBOSE) log('Cache cleaned');
}

// ---------------------------------------------------------------------------
// Run L1 for a variant
// ---------------------------------------------------------------------------

/**
 * Spawn eval-l1-ocr.mjs (or mock) with variant env vars.
 * Returns { ok, result } where result = { score, imageCount, ... }
 *
 * On --dry-run, returns fake scores.
 * On real run, calls eval-l1-ocr.mjs as child process.
 */
async function runVariantOnce(variant, runIndex) {
  if (VERBOSE) log(`Running ${variant.name} iteration ${runIndex + 1}/${NUM_RUNS} ...`);

  // Handle QW07 cache modes
  if (variant.env._CACHE_MODE === 'cold') {
    cleanCache();
  }
  // 'warm' mode reuses cache across runs (implicit, no action)

  if (DRY_RUN) {
    // Mock result
    return {
      ok: true,
      result: {
        variant: variant.name,
        runIndex,
        dryRun: true,
        baselineAgg: { meanAccuracy: 0.95, macroAccuracy: 0.96 },
        reflowAgg: { meanAccuracy: 0.945, macroAccuracy: 0.955 },
        imageSavingsPct: 35.2,
      },
    };
  }

  // Real run: spawn eval-l1-ocr.mjs as child process
  const corpusDir = USE_FROZEN
    ? resolve(evalDir, 'corpus-frozen')
    : resolve(evalDir, 'corpus');

  const argv = [
    resolve(evalDir, 'eval-l1-ocr.mjs'),
    '--model', MODEL,
    '--corpus-dir', corpusDir,
    '--out-dir', resultsDir,
  ];
  // With --l1-dry-run the child gets an explicit --dry-run (simulated
  // scores, no API spend) while still exercising render + plumbing;
  // otherwise --confirm authorizes real API calls.
  argv.splice(1, 0, L1_DRY_RUN ? '--dry-run' : '--confirm');
  if (MAX_BLOCKS !== '0') {
    argv.push('--max-blocks', MAX_BLOCKS);
  }
  if (VERBOSE) {
    argv.push('--verbose');
  }

  const env = {
    ...process.env,
    ...variant.env,
  };
  // Remove internal markers
  delete env._CACHE_MODE;

  if (VERBOSE) {
    log(`  env: PXPIPE_QW01=${env.PXPIPE_QW01} ... PXPIPE_QW10=${env.PXPIPE_QW10}`);
  }

  return new Promise(resolve => {
    const child = spawn('node', argv, { env, stdio: VERBOSE ? 'inherit' : 'pipe' });
    let stdout = '';
    let stderr = '';

    if (!VERBOSE) {
      child.stdout?.on('data', d => (stdout += d.toString()));
      child.stderr?.on('data', d => (stderr += d.toString()));
    }

    child.on('close', code => {
      if (code !== 0) {
        console.error(`[ab-runner] ${variant.name} run ${runIndex + 1} exited with code ${code}`);
        if (stderr) console.error(stderr);
        resolve({ ok: false, error: `Exit code ${code}` });
        return;
      }

      // Surface L1 aggregates into the per-run result so shipping gates
      // (b) OCR fidelity and (c) tool-call schema can evaluate real data
      // (closes W2b known-limitation #1). Raw L1 outputs are archived per
      // variant×run so successive runs do not overwrite each other.
      let l1 = null;
      const l1Json = join(resultsDir, 'l1-results.json');
      const l1Report = join(resultsDir, 'l1-report.md');
      try {
        l1 = JSON.parse(readFileSync(l1Json, 'utf8'));
        copyFileSync(l1Json, join(resultsDir, `${variant.name}-run${runIndex}-l1.json`));
        if (existsSync(l1Report)) {
          copyFileSync(l1Report, join(resultsDir, `${variant.name}-run${runIndex}-l1-report.md`));
        }
      } catch (err) {
        console.error(
          `[ab-runner] WARN: no parsable L1 results for ${variant.name} run ${runIndex + 1}: ${err.message}`,
        );
      }

      const pv = l1?.perVariant ?? {};
      // Production-flow proxy: prefer reflow-inimage (matches pxpipe's
      // instruction-in-image flow, see EXPERIMENT_LOG) else plain reflow.
      const reflowKey = pv['reflow-inimage'] ? 'reflow-inimage' : 'reflow';
      const baselineAgg = pv.baseline?.agg ?? null;
      const reflowAgg = pv[reflowKey]?.agg ?? null;
      const baseImgs = pv.baseline?.imageCount;
      const reflowImgs = pv[reflowKey]?.imageCount;
      const imageSavingsPct =
        typeof baseImgs === 'number' && baseImgs > 0 && typeof reflowImgs === 'number'
          ? (1 - reflowImgs / baseImgs) * 100
          : null;

      // Anomaly guard: a child that scored zero blocks is a failure even if
      // it exited 0 (defence-in-depth vs silently swallowed API errors).
      if (!baselineAgg || (baselineAgg.totalChars ?? 0) === 0) {
        const tail = stderr.split('\n').filter(Boolean).slice(-8).join('\n');
        console.error(
          `[ab-runner] ${variant.name} run ${runIndex + 1}: empty L1 results (0 blocks scored) — treating as FAILURE.`,
        );
        if (tail) console.error(tail);
        resolve({ ok: false, error: 'Empty L1 results (0 blocks scored)' });
        return;
      }

      resolve({
        ok: true,
        result: {
          variant: variant.name,
          runIndex,
          dryRun: false,
          l1DryRun: L1_DRY_RUN,
          timestamp: new Date().toISOString(),
          ...(baselineAgg ? { baselineAgg } : {}),
          ...(reflowAgg ? { reflowAgg, l1ReflowVariant: reflowKey } : {}),
          ...(imageSavingsPct !== null ? { imageSavingsPct } : {}),
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Main run loop
// ---------------------------------------------------------------------------

async function main() {
  const allResults = [];

  for (const variant of variantsToRun) {
    log(`\n=== Variant: ${variant.name} ===`);

    const variantResults = [];

    for (let runIdx = 0; runIdx < NUM_RUNS; runIdx++) {
      const res = await runVariantOnce(variant, runIdx);

      if (!res.ok) {
        log(`  FAILED: ${res.error}`);
        variantResults.push({ ...res.result, status: 'failed' });
        continue;
      }

      log(`  OK (run ${runIdx + 1}/${NUM_RUNS})`);
      variantResults.push({ ...res.result, status: 'ok' });
    }

    // Write variant result file
    const resultFile = resolve(resultsDir, `${variant.name}-run.json`);
    writeFileSync(
      resultFile,
      JSON.stringify({
        variant: variant.name,
        numRuns: NUM_RUNS,
        dryRun: DRY_RUN,
        timestamp: new Date().toISOString(),
        runs: variantResults,
      }, null, 2),
      'utf8'
    );

    log(`  Results written to ${resultFile}`);
    allResults.push(...variantResults);
  }

  // Write combined result file
  const combinedFile = resolve(resultsDir, 'ab-combined.json');
  writeFileSync(
    combinedFile,
    JSON.stringify({
      numVariants: variantsToRun.length,
      numRuns: NUM_RUNS,
      dryRun: DRY_RUN,
      timestamp: new Date().toISOString(),
      allResults,
    }, null, 2),
    'utf8'
  );

  log(`\n=== Summary ===`);
  log(`  Variants run: ${variantsToRun.length}`);
  log(`  Runs per variant: ${NUM_RUNS}`);
  log(`  Combined results: ${combinedFile}`);
}

await main();
