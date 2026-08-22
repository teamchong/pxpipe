// 300k Effective Context Window Benchmark — Reasoning & Causal State Tracking in the Middle
// Evaluates Raw Text vs pxpipe Visual Context across relative context depths (10%, 30%, 50%, 70%, 90%).

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformGoogleGenerateContent } from '../../dist/core/google.js';
import { resolveGeminiProfile } from '../../dist/core/gemini-model-profiles.js';
import { callGeminiRequest, resultFilename } from './gemini-client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.MODEL || 'gemini-3.6-flash';
const TARGET_CHARS = Math.max(10000, Number(process.env.CHARS || 300000));
const SCALE_LABEL = TARGET_CHARS >= 1000000 ? '1m' : `${Math.round(TARGET_CHARS / 1000)}k`;
const RESULT = join(HERE, resultFilename(`lost-in-middle-${SCALE_LABEL}`, MODEL));
const DEPTHS = [0.10, 0.30, 0.50, 0.70, 0.90];
const REPEATS = Math.max(1, Number(process.env.REPEATS || 2));
const TIMEOUT = Number(process.env.TIMEOUT_MS || 300000);
const RUN_ARM = (process.env.ARM || 'all').toLowerCase();
const profile = resolveGeminiProfile();

const CLUSTERS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'theta', 'omega', 'sigma'];
const STATUSES = ['nominal', 'degraded', 'maintenance', 'recovering', 'active', 'standby'];
const ACTIONS = ['rebalance', 'drain', 'isolate', 'failover', 'scale_up', 'scale_down'];
const POLICIES = [
  {
    name: 'cascade_failover',
    rule: 'If primary cluster is in maintenance and secondary is active, route to secondary. If secondary is also disabled or maintenance, route to blackhole_sink with code 503.',
  },
  {
    name: 'quarantine_drain',
    rule: 'If cluster security audit fails, quarantine cluster immediately and reject all queued transactions with code 423 (Locked).',
  },
];

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

function generateLogLine(rand, id) {
  const c = CLUSTERS[rand() % CLUSTERS.length];
  const a = ACTIONS[rand() % ACTIONS.length];
  const duration = (rand() % 450) + 10;
  const mem = (rand() % 64) + 16;
  const cpu = ((rand() % 900) / 10).toFixed(1);
  return `[LOG ${id.toString().padStart(6, '0')}] cluster=${c} action=${a} duration=${duration}ms mem_used=${mem}GB cpu_load=${cpu}% status=nominal`;
}

function buildScenario(depth, repeat, targetChars) {
  const seed = Math.floor(depth * 1000000) + repeat * 7919;
  const rand = lcg(seed);

  // Define unique target cluster and state mutation for this test probe
  const targetCluster = CLUSTERS[(rand() % (CLUSTERS.length - 2)) + 1];
  const backupCluster = CLUSTERS[0];
  const targetToken = `MUTATION_${targetCluster.toUpperCase()}_${(rand() % 90000 + 10000)}`;

  // The critical state mutation injected at exact depth
  const criticalEvent = [
    `>>> CRITICAL STATE CHANGE [${targetToken}] <<<`,
    `CLUSTER: ${targetCluster}`,
    `STATUS: maintenance (active drain in progress)`,
    `BACKUP_TARGET: ${backupCluster}`,
    `BACKUP_STATUS: disabled (kernel panic in node pool)`,
    `ACTIVE_POLICY: cascade_failover`,
    `EXPECTED_ROUTE: blackhole_sink`,
    `EXPECTED_CODE: 503`,
    `>>> END STATE CHANGE [${targetToken}] <<<`,
  ].join('\n');

  // Fill ~300k chars with multi-turn log records
  const approxLineLen = 105;
  const totalLines = Math.floor(targetChars / approxLineLen);
  const targetLineIdx = Math.floor(totalLines * depth);

  const turns = 30;
  const linesPerTurn = Math.floor(totalLines / turns);
  const targetTurnIdx = Math.min(turns - 1, Math.floor(targetLineIdx / linesPerTurn));

  const contents = [];

  // Initial turn: System setup and policy declaration
  contents.push({
    role: 'user',
    parts: [{
      text: [
        '## SYSTEM ARCHITECTURE AND DISASTER RECOVERY POLICY SPECIFICATION',
        'You are the autonomous infrastructure auditor. Follow these exact multi-hop routing rules:',
        ...POLICIES.map((p) => `- Policy ${p.name}: ${p.rule}`),
        '',
        'Analyze the multi-turn telemetry stream below and track all cluster state transitions.',
      ].join('\n'),
    }],
  });
  contents.push({
    role: 'model',
    parts: [{ text: 'Telemetry ingest initialized. Disaster recovery policies active.' }],
  });

  const distClusters = CLUSTERS.filter((c) => c !== targetCluster && c !== backupCluster);

  let lineCount = 0;
  for (let t = 0; t < turns; t++) {
    const lines = [];
    for (let l = 0; l < linesPerTurn; l++) {
      if (t === targetTurnIdx && l === Math.floor(linesPerTurn / 2)) {
        lines.push(criticalEvent);
      } else if (l === 10 && t !== targetTurnIdx) {
        // Inject distractor state transitions ONLY for other clusters (never target/backup)
        const distCluster = distClusters[t % distClusters.length];
        const distStatus = STATUSES[t % STATUSES.length];
        lines.push(`>>> STATE UPDATE [EVENT_${t * 100 + l}] <<< CLUSTER: ${distCluster} | STATUS: ${distStatus} | ACTION: auto_remediate | ROUTE: internal_mesh | CODE: 200`);
      } else {
        lines.push(generateLogLine(rand, lineCount++));
      }
    }

    contents.push({
      role: 'user',
      parts: [{ text: `## TELEMETRY BATCH ${t + 1}\n` + lines.join('\n') }],
    });
    contents.push({
      role: 'model',
      parts: [{ text: `Telemetry batch ${t + 1} processed and indexed.` }],
    });
  }

  // Final query: Multi-hop reasoning combining Policy + Middle State Change
  const query = [
    `Incoming request target: cluster '${targetCluster}'.`,
    `Based on the disaster recovery policies and the state transitions in the telemetry stream, determine:`,
    `1. What is the current operational state of cluster '${targetCluster}' and its designated backup?`,
    `2. Under the active policy, where must incoming traffic for '${targetCluster}' be routed?`,
    `3. What HTTP response code must be returned to clients?`,
    '',
    'Return your answer ONLY as a JSON object with this exact schema:',
    '{"target_cluster":string,"primary_status":string,"backup_status":string,"final_route":string,"status_code":number,"mutation_token":string}',
  ].join('\n');

  contents.push({
    role: 'user',
    parts: [{ text: query }],
  });

  return {
    targetCluster,
    backupCluster,
    targetToken,
    expectedRoute: 'blackhole_sink',
    expectedCode: 503,
    request: {
      contents,
      generationConfig: { responseMimeType: 'application/json' },
    },
  };
}

function parseJson(text) {
  try {
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s >= 0 && e > s) return JSON.parse(text.slice(s, e + 1));
  } catch {}
  return null;
}

function score(ans, scenario) {
  const p = parseJson(ans);
  const tokenFound = p?.mutation_token === scenario.targetToken;
  const primaryStateOk = String(p?.primary_status ?? '').toLowerCase().includes('maintenance');
  const backupStateOk = String(p?.backup_status ?? '').toLowerCase().includes('disabled');
  const routeOk = String(p?.final_route ?? '').toLowerCase().includes('blackhole_sink');
  const codeOk = Number(p?.status_code) === scenario.expectedCode;

  const reasoningSuccess = routeOk && codeOk;
  const fullMultiHopSuccess = tokenFound && primaryStateOk && backupStateOk && routeOk && codeOk;

  return {
    parsed: p,
    tokenFound,
    primaryStateOk,
    backupStateOk,
    routeOk,
    codeOk,
    reasoningSuccess,
    fullMultiHopSuccess,
  };
}

async function runEval() {
  console.log(`=== 300k Effective Context Window Eval (Reasoning in the Middle) ===`);
  console.log(`Model: ${MODEL} | Target Chars: ${TARGET_CHARS} | Depths: ${DEPTHS.join(', ')} | Repeats: ${REPEATS}\n`);

  const results = [];

  for (const depth of DEPTHS) {
    for (let r = 0; r < REPEATS; r++) {
      const scenario = buildScenario(depth, r, TARGET_CHARS);
      const depthPct = Math.round(depth * 100);
      console.log(`[Depth ${depthPct}% | Run ${r + 1}/${REPEATS}] Building 300k scenario...`);

      // 1. Raw Text Arm
      let rawAns = null;
      let rawScore = null;
      let rawMs = 0;
      let rawUsage = null;
      if (RUN_ARM === 'all' || RUN_ARM === 'raw' || RUN_ARM === 'text') {
        console.log(`  -> Running Raw Text Arm...`);
        try {
          const rawRes = await callGeminiRequest({
            model: MODEL,
            request: scenario.request,
            maxOutputTokens: 8192,
            timeoutMs: TIMEOUT,
          });
          rawAns = rawRes.text;
          rawMs = rawRes.ms;
          rawUsage = rawRes.usage;
          rawScore = score(rawAns, scenario);
        } catch (err) {
          console.error(`     Raw Text error: ${err.message}`);
          rawScore = { error: err.message };
        }
      }

      // 2. pxpipe Visual Context Arm
      let pxAns = null;
      let pxScore = null;
      let pxMs = 0;
      let pxUsage = null;
      if (RUN_ARM === 'all' || RUN_ARM === 'pxpipe' || RUN_ARM === 'visual') {
        console.log(`  -> Running pxpipe Visual Context Arm...`);
        try {
          const bodyBytes = new TextEncoder().encode(JSON.stringify(scenario.request));
          const transformed = await transformGoogleGenerateContent(bodyBytes, MODEL, {
            compress: true,
            collapseHistory: true,
            compressToolResults: false,
          });
          const transformedRequest = JSON.parse(new TextDecoder().decode(transformed.body));
          const pxRes = await callGeminiRequest({
            model: MODEL,
            request: transformedRequest,
            maxOutputTokens: 8192,
            timeoutMs: TIMEOUT,
          });
          pxAns = pxRes.text;
          pxMs = pxRes.ms;
          pxUsage = pxRes.usage;
          pxScore = score(pxAns, scenario);
        } catch (err) {
          console.error(`     pxpipe error: ${err.message}`);
          pxScore = { error: err.message };
        }
      }

      const rawStatus = rawScore ? (rawScore.reasoningSuccess ? '✓' : '✗') : 'skipped';
      const pxStatus = pxScore ? (pxScore.reasoningSuccess ? '✓' : '✗') : 'skipped';
      console.log(`  [Depth ${depthPct}%] Raw Reasoning: ${rawStatus} (${rawMs}ms) | pxpipe Reasoning: ${pxStatus} (${pxMs}ms)`);

      results.push({
        depth,
        repeat: r,
        targetCluster: scenario.targetCluster,
        raw: { score: rawScore, ms: rawMs, usage: rawUsage, text: rawAns },
        pxpipe: { score: pxScore, ms: pxMs, usage: pxUsage, text: pxAns },
      });
    }
  }

  // Summary aggregation
  const summary = {
    model: MODEL,
    targetChars: TARGET_CHARS,
    depths: DEPTHS,
    repeats: REPEATS,
    byDepth: {},
  };

  for (const d of DEPTHS) {
    const dRows = results.filter((r) => r.depth === d);
    const rawActive = dRows.filter((r) => r.raw.score !== null);
    const pxActive = dRows.filter((r) => r.pxpipe.score !== null);
    summary.byDepth[d] = {
      raw_reasoning_acc: rawActive.length > 0 ? (rawActive.filter((r) => r.raw.score?.reasoningSuccess).length / rawActive.length) : null,
      pxpipe_reasoning_acc: pxActive.length > 0 ? (pxActive.filter((r) => r.pxpipe.score?.reasoningSuccess).length / pxActive.length) : null,
      raw_multihop_acc: rawActive.length > 0 ? (rawActive.filter((r) => r.raw.score?.fullMultiHopSuccess).length / rawActive.length) : null,
      pxpipe_multihop_acc: pxActive.length > 0 ? (pxActive.filter((r) => r.pxpipe.score?.fullMultiHopSuccess).length / pxActive.length) : null,
      raw_avg_ms: rawActive.length > 0 ? Math.round(rawActive.reduce((a, b) => a + (b.raw.ms || 0), 0) / rawActive.length) : 0,
      pxpipe_avg_ms: pxActive.length > 0 ? Math.round(pxActive.reduce((a, b) => a + (b.pxpipe.ms || 0), 0) / pxActive.length) : 0,
    };
  }

  const out = {
    generatedAt: new Date().toISOString(),
    summary,
    results,
  };

  writeFileSync(RESULT, JSON.stringify(out, null, 2) + '\n');
  console.log(`\n=== Benchmark Results Saved to ${RESULT} ===`);
  console.table(summary.byDepth);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runEval().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
