#!/usr/bin/env node
/**
 * eval/ab/gates.mjs — Shipping gates for A/B results
 *
 * Reads combined result JSON (ab-combined.json or per-variant results)
 * and applies gates:
 *
 * 1. exact-ID / negations: must be 100% match (identity matrix or negation)
 * 2. OCR fidelity: reflow score >= A1 baseline (or > -2pp)
 * 3. e2e / tool-call schema: native correctness
 *
 * Outputs gate verdict JSON per variant to eval/ab/results/<variant>-gates.json
 *
 * Usage:
 *   node eval/ab/gates.mjs [--results-file FILE]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const resultsDir = resolve(__dirname, 'results');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    'results-file': { type: 'string', default: '' },
    'verbose':      { type: 'boolean', default: false },
    'self-test':    { type: 'boolean', default: false },
    'help':         { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (args.help) {
  console.log(`
Usage: node eval/ab/gates.mjs [options]

Options:
  --results-file FILE  Path to ab-combined.json (default: eval/ab/results/ab-combined.json)
  --verbose            Verbose logging
  --self-test          Run self-tests using fixtures (default: off)
  --help               Show this help
`);
  process.exit(0);
}

const VERBOSE = args.verbose;
const SELF_TEST = args['self-test'];
const RESULTS_FILE = args['results-file'] || join(resultsDir, 'ab-combined.json');

const log = (...a) => console.log('[ab-gates]', ...a);

// ---------------------------------------------------------------------------
// Load results (skip in self-test mode)
// ---------------------------------------------------------------------------

let combined;

if (SELF_TEST) {
  if (VERBOSE) log('Self-test mode: fixtures will be loaded internally');
} else {
  try {
    const content = readFileSync(RESULTS_FILE, 'utf8');
    combined = JSON.parse(content);
  } catch (err) {
    console.error(`[ab-gates] Failed to load results: ${err.message}`);
    process.exit(1);
  }

  if (VERBOSE) log(`Loaded ${combined.numVariants} variant results from ${RESULTS_FILE}`);
}

// ---------------------------------------------------------------------------
// Gate logic
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} GateResult
 * @property {string} variantName
 * @property {boolean} pass — true if all gates pass
 * @property {Object} gates — per-gate results
 *   - exactId: { pass, reason }
 *   - ocrFidelity: { pass, reason }
 *   - toolCallSchema: { pass, reason }
 */

/**
 * Find baseline aggregate scores from results array.
 * Returns { meanAccuracy, macroAccuracy } or null if not found.
 */
function getBaselineAgg(allResults) {
  const baseline = allResults.find(r => r.variant === 'A1-baseline');
  if (!baseline || !baseline.baselineAgg) return null;
  return baseline.baselineAgg;
}

/**
 * Gate 0: Data presence
 * A live (non-dry) result must contain non-empty scored data. Guards against
 * vacuous passes: 2026-07-10 a run where every API call failed silently
 * (`spawn python3 ENOENT`) produced all-zero aggregates and 42/42 "PASS".
 */
function evaluateDataPresence(result) {
  if (result.dryRun === true || result.l1DryRun === true) {
    return { pass: true, reason: 'Dry run — presence gate not applicable' };
  }
  const agg = result.baselineAgg ?? {};
  if (typeof agg.totalChars === 'number') {
    return agg.totalChars > 0
      ? { pass: true, reason: `Data present (${agg.totalChars} scored chars)` }
      : { pass: false, reason: 'No scored data (baselineAgg.totalChars == 0) — live run produced empty results' };
  }
  const mean = agg.meanAccuracy ?? 0;
  return mean > 0
    ? { pass: true, reason: `Data present (meanAccuracy=${mean})` }
    : { pass: false, reason: 'No scored data (empty baselineAgg) — live run produced empty results' };
}

/**
 * Gate 1: Exact-ID / Negations
 * Checks if exactId field matches 100% (identity matrix or negation pattern).
 * If field is missing, gate is NON-BLOCKING (pass with reason).
 */
function evaluateExactId(result) {
  if (!result.exactId) {
    return {
      pass: true,
      reason: 'No exact-ID data in result (field absent)',
    };
  }

  const { pass: isExactMatch, negationMatch } = result.exactId;
  // Fail-closed: malformed gate input (non-boolean flags) must never pass.
  // A truthy-but-non-boolean value (e.g. "true", 1) indicates a schema
  // drift upstream, not a verified match.
  if (
    (isExactMatch !== undefined && typeof isExactMatch !== 'boolean') ||
    (negationMatch !== undefined && typeof negationMatch !== 'boolean')
  ) {
    return {
      pass: false,
      reason: `Exact-ID: malformed data (pass=${JSON.stringify(isExactMatch)}, negation=${JSON.stringify(negationMatch)}) — expected booleans, failing closed`,
    };
  }
  if (isExactMatch === true || negationMatch === true) {
    return {
      pass: true,
      reason: isExactMatch ? 'Exact-ID: 100% match (identity)' : 'Exact-ID: deterministic negation',
    };
  }

  return {
    pass: false,
    reason: `Exact-ID: mismatch (not identity or negation); pass=${isExactMatch}, negation=${negationMatch}`,
  };
}

/**
 * Gate 2: OCR Fidelity
 * Variant must achieve >= (baseline.meanAccuracy - 0.02) for charAccuracy.
 * If baseline is absent, skip (non-blocking PASS).
 */
function evaluateOcrFidelity(result, baselineAgg) {
  if (!result.reflowAgg) {
    return {
      pass: true,
      reason: 'No OCR data in result (field absent)',
    };
  }

  if (!baselineAgg) {
    return {
      pass: true,
      reason: 'No A1-baseline reference found; OCR gate skipped',
    };
  }

  // Fail-closed: non-finite accuracies (NaN/Infinity/undefined) indicate a
  // broken scoring pipeline (cf. 2026-07-10 all-zero-aggregate incident) and
  // must fail the gate, not slip through a NaN comparison.
  if (
    !Number.isFinite(baselineAgg.meanAccuracy) ||
    !Number.isFinite(result.reflowAgg.meanAccuracy)
  ) {
    return {
      pass: false,
      reason: `OCR: non-finite meanAccuracy (baseline=${baselineAgg.meanAccuracy}, variant=${result.reflowAgg.meanAccuracy}) — failing closed`,
    };
  }

  const threshold = baselineAgg.meanAccuracy - 0.02; // -2pp tolerance
  const actual = result.reflowAgg.meanAccuracy;
  const delta = (actual - baselineAgg.meanAccuracy) * 100;

  if (actual >= threshold) {
    return {
      pass: true,
      reason: `OCR: ${(actual * 100).toFixed(2)}% vs baseline ${(baselineAgg.meanAccuracy * 100).toFixed(2)}% (delta ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}pp, threshold -2pp)`,
    };
  }

  return {
    pass: false,
    reason: `OCR: ${(actual * 100).toFixed(2)}% vs baseline ${(baselineAgg.meanAccuracy * 100).toFixed(2)}% (delta ${delta.toFixed(2)}pp, BELOW -2pp threshold)`,
  };
}

/**
 * Gate 3: Tool-call Schema
 * Checks if toolCallSchema field exists and has nativeCorrect === true.
 * If field is missing, gate is NON-BLOCKING (pass with reason).
 */
function evaluateToolCallSchema(result) {
  if (!result.toolCallSchema) {
    return {
      pass: true,
      reason: 'No tool-call schema data in result (field absent)',
    };
  }

  if (result.toolCallSchema.nativeCorrect === true) {
    return {
      pass: true,
      reason: 'Tool-call schema: native structure valid',
    };
  }

  return {
    pass: false,
    reason: `Tool-call schema: invalid (nativeCorrect=${result.toolCallSchema.nativeCorrect}); details: ${result.toolCallSchema.details || 'none'}`,
  };
}

function evaluateGates(result, baselineAgg) {
  const gates = {};

  gates.dataPresence = evaluateDataPresence(result);
  gates.exactId = evaluateExactId(result);
  gates.ocrFidelity = evaluateOcrFidelity(result, baselineAgg);
  gates.toolCallSchema = evaluateToolCallSchema(result);

  // Compute overall verdict
  const pass = gates.dataPresence.pass && gates.exactId.pass &&
    gates.ocrFidelity.pass && gates.toolCallSchema.pass;

  return {
    variantName: result.variant,
    pass,
    gates,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Self-test mode
// ---------------------------------------------------------------------------

async function runSelfTest() {
  if (VERBOSE) log('Running self-tests ...');

  // Load fixture files
  const fixturesDir = resolve(__dirname, 'fixtures');
  let fixtures;
  try {
    const fixtureFiles = [
      'pass-case.json',
      'fail-case-exact-id.json',
      'fail-case-ocr-regression.json',
    ];

    fixtures = [];
    for (const file of fixtureFiles) {
      const path = join(fixturesDir, file);
      const content = readFileSync(path, 'utf8');
      fixtures.push({
        file,
        data: JSON.parse(content),
      });
    }
  } catch (err) {
    console.error(`[ab-gates] Self-test fixture load failed: ${err.message}`);
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;

  for (const fixture of fixtures) {
    const baselineAgg = getBaselineAgg(fixture.data.allResults);
    let fixture_passed = true;
    let fixture_failed = false;

    for (const result of fixture.data.allResults) {
      const gateResult = evaluateGates(result, baselineAgg);
      const expected = fixture.data.expectedVerdicts[result.variant];

      if (gateResult.pass !== expected) {
        console.error(`[ab-gates] ${fixture.file}: ${result.variant} expected ${expected}, got ${gateResult.pass}`);
        fixture_failed = true;
      }
    }

    if (fixture_failed) {
      failed++;
      log(`  ${fixture.file}: FAIL`);
    } else {
      passed++;
      log(`  ${fixture.file}: PASS`);
    }
  }

  log(`\n=== Self-Test Summary ===`);
  log(`  Passed: ${passed}/${fixtures.length}`);
  log(`  Failed: ${failed}/${fixtures.length}`);

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

if (SELF_TEST) {
  await runSelfTest();
}

// ---------------------------------------------------------------------------
// Process all variants
// ---------------------------------------------------------------------------

mkdirSync(resultsDir, { recursive: true });

const gateResults = [];
const allPass = [];
const allFail = [];

const baselineAgg = getBaselineAgg(combined.allResults);

for (const result of combined.allResults) {
  const gates = evaluateGates(result, baselineAgg);
  gateResults.push(gates);

  if (gates.pass) {
    allPass.push(result.variant);
  } else {
    allFail.push(result.variant);
  }

  // Write per-variant gate file
  const gateFile = resolve(resultsDir, `${result.variant}-gates.json`);
  writeFileSync(gateFile, JSON.stringify(gates, null, 2), 'utf8');

  if (VERBOSE) {
    log(`  ${result.variant}: ${gates.pass ? 'PASS' : 'FAIL'}`);
  }
}

// Write combined gate verdict
const verdictFile = resolve(resultsDir, 'ab-gates-verdict.json');
writeFileSync(
  verdictFile,
  JSON.stringify({
    timestamp: new Date().toISOString(),
    dryRun: combined.dryRun,
    summary: {
      totalVariants: gateResults.length,
      passCount: allPass.length,
      failCount: allFail.length,
    },
    passing: allPass,
    failing: allFail,
    allGates: gateResults,
  }, null, 2),
  'utf8'
);

log(`\n=== Gate Summary ===`);
log(`  Passing: ${allPass.length}/${gateResults.length}`);
log(`  Failing: ${allFail.length}/${gateResults.length}`);
log(`  Verdict file: ${verdictFile}`);

// Fail-closed: a failing gate must fail the process, or CI treats a red
// verdict as green (fail-open #3 — found during the 2026-07-10 review).
if (allFail.length > 0) {
  process.exit(1);
}
