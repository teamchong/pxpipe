#!/usr/bin/env node
/**
 * eval/eval-l2-session.mjs  —  Level 2: Task-level A/B Session Replay
 *
 * For each session in eval/corpus/sessions.json:
 *   1. Render the conversation history both ways:
 *        baseline  → renderTextToPngs()
 *        reflow    → renderTextToPngsReflow()
 *   2. Ask the model to produce the next turn in the conversation,
 *      using each rendered history as context
 *   3. Use a model-judge to score whether the reflow-history answer is
 *      as good as the baseline-history answer (0–1 scale)
 *   4. Aggregate and write eval/results/l2-report.md
 *
 * Flags: same pattern as eval-l1-ocr.mjs
 *   --dry-run     Skip API calls; print what would be sent + use fake scores
 *   --confirm     Required for real API calls (cost confirmation gate)
 *   --max-sessions Override session count (default: all in corpus)
 *   --model       Anthropic model (default: claude-sonnet-4-5)
 *   --judge-model Anthropic model for judge (default: same as --model)
 *   --corpus-dir  Directory with sessions.json (default: eval/corpus)
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
    'dry-run':      { type: 'boolean', default: false },
    'confirm':      { type: 'boolean', default: false },
    'max-sessions': { type: 'string',  default: '0'   }, // 0 = all
    'model':        { type: 'string',  default: 'claude-sonnet-4-5' },
    'judge-model':  { type: 'string',  default: '' },
    'corpus-dir':   { type: 'string',  default: join(__dirname, 'corpus') },
    'out-dir':      { type: 'string',  default: join(__dirname, 'results') },
    'verbose':      { type: 'boolean', default: false },
    'help':         { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (args.help) {
  console.log(`
Usage: node eval/eval-l2-session.mjs [options]

Options:
  --dry-run          Run without API calls (fake scores)
  --confirm          Confirm real API spend (required without --dry-run)
  --max-sessions N   Evaluate at most N sessions (default: all)
  --model NAME       Anthropic model for replay (default: claude-sonnet-4-5)
  --judge-model NAME Anthropic model for judge (default: same as --model)
  --corpus-dir       Path to corpus directory (default: eval/corpus)
  --out-dir          Output directory for results (default: eval/results)
  --verbose          Print per-session progress
  --help             Show this help
`);
  process.exit(0);
}

const DRY_RUN     = args['dry-run'];
const CONFIRMED   = args['confirm'];
const MAX_SESS    = parseInt(args['max-sessions'], 10);
const MODEL       = args['model'];
const JUDGE_MODEL = args['judge-model'] || MODEL;
const CORPUS_DIR  = resolve(args['corpus-dir']);
const OUT_DIR     = resolve(args['out-dir']);
const VERBOSE     = args['verbose'];

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const { renderTextToPngs, renderTextToPngsReflow, bytesToBase64 } =
  await import('./lib/render-bridge.mjs');

const { createClient } = await import('./lib/anthropic-client.mjs');
const { printCostEstimate, estimateImageCount, estimateL2SessionCost } =
  await import('./lib/cost.mjs');

// ---------------------------------------------------------------------------
// Load corpus
// ---------------------------------------------------------------------------

const sessionsPath = join(CORPUS_DIR, 'sessions.json');
if (!existsSync(sessionsPath)) {
  console.error(`[L2] Corpus not found at ${sessionsPath}`);
  console.error(`     Run: node eval/extract-corpus.mjs`);
  process.exit(1);
}

let sessions = JSON.parse(readFileSync(sessionsPath, 'utf8'));
if (MAX_SESS > 0) sessions = sessions.slice(0, MAX_SESS);
console.log(`[L2] Loaded ${sessions.length} sessions from corpus`);

// ---------------------------------------------------------------------------
// Cost estimate gate
// ---------------------------------------------------------------------------

const corpus = { l1Blocks: [], l2Sessions: sessions };
const totalUsd = printCostEstimate(corpus, MODEL);

if (!DRY_RUN && !CONFIRMED) {
  console.error(
    `[L2] Real API calls require --confirm flag.\n` +
    `     Estimated cost: $${totalUsd.toFixed(4)}\n` +
    `     Re-run with: node eval/eval-l2-session.mjs --confirm\n` +
    `     Or test without spend: node eval/eval-l2-session.mjs --dry-run`,
  );
  process.exit(1);
}

if (DRY_RUN) {
  console.log('[L2] DRY RUN — no API calls will be made\n');
} else {
  console.log(`[L2] CONFIRMED — will spend ~$${totalUsd.toFixed(4)} USD\n`);
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const replayClient = createClient({ model: MODEL,       dryRun: DRY_RUN });
const judgeClient  = createClient({ model: JUDGE_MODEL, dryRun: DRY_RUN });

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const REPLAY_SYSTEM = `You are an AI assistant continuing a conversation.
The conversation history has been rendered as images for context efficiency.
Read the history carefully and produce the next assistant response.
Be concise and directly address the user's question.`;

const JUDGE_SYSTEM = `You are an expert evaluator judging the quality of AI assistant responses.
You will be given:
  - A REFERENCE answer (produced using the standard history rendering)
  - A CANDIDATE answer (produced using a compressed "reflow" history rendering)
  - The QUESTION that was asked

Score the CANDIDATE answer from 0.0 to 1.0:
  1.0 = semantically equivalent to reference, addresses the question equally well
  0.8 = mostly equivalent, minor information loss
  0.6 = partially equivalent, some relevant content missing
  0.4 = substantially worse, significant information missing
  0.2 = poor, mostly unrelated
  0.0 = completely wrong or missing

Respond with ONLY a JSON object in this exact format (no markdown, no explanation outside JSON):
{"score": <number>, "verdict": "<pass|borderline|fail>", "reasoning": "<one sentence>"}

"pass" if score >= 0.75, "borderline" if 0.5 <= score < 0.75, "fail" if score < 0.5.`;

// ---------------------------------------------------------------------------
// Per-session evaluation
// ---------------------------------------------------------------------------

/** @type {Array<object>} */
const results = [];

for (let idx = 0; idx < sessions.length; idx++) {
  const session = sessions[idx];
  console.log(`[L2] Session ${idx + 1}/${sessions.length}  ` +
    `(${session.totalTurns} turns, ${session.historyCharCount} history chars)`);

  const historyText = session.historyText;
  const questionText = session.questionText;
  const expectedAnswer = session.expectedAnswer;

  // --- Render history both ways ---
  let baselineImages, reflowImages;
  try {
    [baselineImages, reflowImages] = await Promise.all([
      renderTextToPngs(historyText),
      renderTextToPngsReflow(historyText),
    ]);
  } catch (err) {
    console.error(`  ERROR rendering session ${idx}: ${err.message}`);
    continue;
  }

  if (VERBOSE) {
    console.log(`  baseline: ${baselineImages.length} PNG(s), reflow: ${reflowImages.length} PNG(s)`);
    console.log(`  question: ${questionText.slice(0, 80)}…`);
  }

  // Build image content blocks helper
  const toImageBlocks = (images) => images.map(img => ({
    type:   'image',
    source: { type: 'base64', media_type: 'image/png', data: bytesToBase64(img.png) },
  }));

  // --- Baseline replay call ---
  const baselineMessages = [
    {
      role: 'user',
      content: [
        ...toImageBlocks(baselineImages),
        { type: 'text', text: `The above images contain the conversation history.\n\nUser question: ${questionText}` },
      ],
    },
  ];

  // --- Reflow replay call ---
  const reflowMessages = [
    {
      role: 'user',
      content: [
        ...toImageBlocks(reflowImages),
        {
          type: 'text',
          text: `The above images contain the conversation history in reflowed format.\n` +
                `Note: the ↵ glyph (U+21B5) in the images denotes a hard line break.\n\n` +
                `User question: ${questionText}`,
        },
      ],
    },
  ];

  let baselineResp, reflowResp;
  try {
    [baselineResp, reflowResp] = await Promise.all([
      replayClient.messages({ system: REPLAY_SYSTEM, messages: baselineMessages, max_tokens: 512 }),
      replayClient.messages({ system: REPLAY_SYSTEM, messages: reflowMessages,   max_tokens: 512 }),
    ]);
  } catch (err) {
    console.error(`  ERROR in replay calls for session ${idx}: ${err.message}`);
    continue;
  }

  const baselineAnswer = baselineResp.content?.[0]?.text ?? '';
  const reflowAnswer   = reflowResp.content?.[0]?.text ?? '';

  // --- Judge call ---
  const judgeMessages = [
    {
      role: 'user',
      content: `QUESTION:\n${questionText}\n\n` +
               `REFERENCE ANSWER (baseline rendering):\n${baselineAnswer}\n\n` +
               `CANDIDATE ANSWER (reflow rendering):\n${reflowAnswer}`,
    },
  ];

  let judgeResp;
  try {
    judgeResp = await judgeClient.messages({ system: JUDGE_SYSTEM, messages: judgeMessages, max_tokens: 256 });
  } catch (err) {
    console.error(`  ERROR in judge call for session ${idx}: ${err.message}`);
    continue;
  }

  // Parse judge response
  let judgeResult = { score: 0.5, verdict: 'borderline', reasoning: 'parse error' };
  try {
    const text = judgeResp.content?.[0]?.text ?? '{}';
    // Strip any accidental markdown fencing
    const cleaned = text.replace(/^```[^\n]*\n?/m, '').replace(/```$/m, '').trim();
    judgeResult = JSON.parse(cleaned);
  } catch (e) {
    console.error(`  WARNING: Could not parse judge JSON: ${judgeResp.content?.[0]?.text?.slice(0, 100)}`);
  }

  if (VERBOSE) {
    console.log(`  Judge score: ${judgeResult.score}  verdict: ${judgeResult.verdict}`);
    console.log(`  Reasoning:   ${judgeResult.reasoning}`);
  }

  results.push({
    sessionIdx:         idx,
    sessionId:          session.sessionId,
    totalTurns:         session.totalTurns,
    historyCharCount:   session.historyCharCount,
    baselineImageCount: baselineImages.length,
    reflowImageCount:   reflowImages.length,
    baselineAnswer:     baselineAnswer.slice(0, 300),
    reflowAnswer:       reflowAnswer.slice(0, 300),
    judgeScore:         judgeResult.score,
    judgeVerdict:       judgeResult.verdict,
    judgeReasoning:     judgeResult.reasoning,
    dryRun:             DRY_RUN,
  });
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

const scores   = results.map(r => r.judgeScore);
const verdicts = results.map(r => r.judgeVerdict);

const meanScore   = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : 0;
const passCount   = verdicts.filter(v => v === 'pass').length;
const borderCount = verdicts.filter(v => v === 'borderline').length;
const failCount   = verdicts.filter(v => v === 'fail').length;
const passRate    = results.length > 0 ? passCount / results.length : 0;

const imageSavingsPct = results.length > 0
  ? (1 - results.reduce((s, r) => s + r.reflowImageCount, 0) /
         Math.max(1, results.reduce((s, r) => s + r.baselineImageCount, 0))) * 100
  : 0;

// ---------------------------------------------------------------------------
// Write report
// ---------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });

const reportLines = [
  `# L2 Session Replay Report`,
  ``,
  `**Generated:** ${new Date().toISOString()}  `,
  `**Replay model:** ${MODEL}  `,
  `**Judge model:** ${JUDGE_MODEL}  `,
  `**Dry run:** ${DRY_RUN}  `,
  `**Sessions evaluated:** ${results.length}`,
  ``,
  `## Summary`,
  ``,
  `| Metric | Value |`,
  `|--------|-------|`,
  `| Mean judge score | ${(meanScore * 100).toFixed(1)}% |`,
  `| Pass rate (score ≥ 0.75) | ${(passRate * 100).toFixed(1)}% (${passCount}/${results.length}) |`,
  `| Borderline (0.5–0.75) | ${borderCount} |`,
  `| Fail (< 0.5) | ${failCount} |`,
  `| Image count savings | ${imageSavingsPct.toFixed(1)}% fewer images |`,
  ``,
  `## Interpretation`,
  ``,
  `- **Mean score ≥ 0.80 + pass rate ≥ 80%** → reflow history is production-safe`,
  `- **Mean score 0.65–0.79 or pass rate 60–79%** → borderline; investigate failing sessions`,
  `- **Mean score < 0.65 or pass rate < 60%** → reflow causes material comprehension loss; do not ship`,
  ``,
  `## Per-Session Results`,
  ``,
  `| # | Session | Turns | Hist Chars | Base PNGs | Reflow PNGs | Judge Score | Verdict |`,
  `|---|---------|-------|------------|-----------|-------------|-------------|---------|`,
  ...results.map(r =>
    `| ${r.sessionIdx + 1} | ${r.sessionId.slice(0, 12)}… | ${r.totalTurns} | ${r.historyCharCount} | ${r.baselineImageCount} | ${r.reflowImageCount} | ${(r.judgeScore * 100).toFixed(0)}% | ${r.judgeVerdict} |`
  ),
  ``,
  `## Session Details`,
  ``,
  ...results.flatMap(r => [
    `### Session ${r.sessionIdx + 1}: ${r.sessionId.slice(0, 20)}`,
    ``,
    `**Judge score:** ${(r.judgeScore * 100).toFixed(0)}%  **Verdict:** ${r.judgeVerdict}`,
    ``,
    `**Reasoning:** ${r.judgeReasoning}`,
    ``,
    `**Baseline answer (excerpt):**`,
    `> ${r.baselineAnswer.slice(0, 200).replace(/\n/g, '\n> ')}`,
    ``,
    `**Reflow answer (excerpt):**`,
    `> ${r.reflowAnswer.slice(0, 200).replace(/\n/g, '\n> ')}`,
    ``,
    `---`,
    ``,
  ]),
  DRY_RUN ? `> ⚠️  **Dry-run mode**: all scores are simulated. Real evaluation requires \`--confirm\`.` : '',
];

const reportPath = join(OUT_DIR, 'l2-report.md');
writeFileSync(reportPath, reportLines.join('\n'), 'utf8');

const jsonPath = join(OUT_DIR, 'l2-results.json');
writeFileSync(jsonPath, JSON.stringify({ results, meanScore, passRate, imageSavingsPct, dryRun: DRY_RUN }, null, 2), 'utf8');

// ---------------------------------------------------------------------------
// Console summary
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(60)}`);
console.log(`  L2 SESSION REPLAY SUMMARY  (${DRY_RUN ? 'DRY RUN' : 'REAL'})`);
console.log(`${'─'.repeat(60)}`);
console.log(`  Sessions evaluated:  ${results.length}`);
console.log(`  Mean judge score:    ${(meanScore * 100).toFixed(1)}%`);
console.log(`  Pass / borderline / fail: ${passCount} / ${borderCount} / ${failCount}`);
console.log(`  Pass rate:           ${(passRate * 100).toFixed(1)}%`);
console.log(`  Image savings:       ${imageSavingsPct.toFixed(1)}%`);
console.log(`  Report:              ${reportPath}`);
console.log(`${'─'.repeat(60)}\n`);
