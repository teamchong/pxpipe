/**
 * Savings replay for the context risk router. Answers the question PR #39 leaves
 * open: does turning the router on materially hurt the token savings?
 *
 *     npx tsx scripts/context-router-bench.ts
 *
 * Reuses pxpipe's OWN cost model (`evalCompressionProfitability`, same constants
 * the live gate uses) — no separate token oracle. For a realistic coding-agent turn
 * it prints three totals:
 *   - ALL-TEXT      : no pxpipe (the bill Anthropic would send).
 *   - IMAGE-EVERY   : pxpipe with no router — images every profitable block,
 *                     INCLUDING the secret (max savings, but unsafe).
 *   - ROUTER-ON     : router keeps secrets + dense/high-risk blocks as text,
 *                     images the rest (safe).
 * The gap between IMAGE-EVERY and ROUTER-ON is the measured "cost of safety".
 */

import { evalCompressionProfitability } from '../src/core/transform.js';
import { DENSE_CONTENT_COLS } from '../src/core/render.js';
import { routeBlock } from '../src/core/context-router.js';

const CPT = 4; // chars/token for tool_result/reminder text (the live gate's default)
const COLS = DENSE_CONTENT_COLS;

interface Block {
  name: string;
  text: string;
  /** True if this block carries a secret — used only to report the safety verdict. */
  hasSecret?: boolean;
}

const SECRET = 'sk-ant-api03-BENCHsecretDEADBEEF1234567890abcd';

// Scenario A — a RISKY turn (worst case for the router): a path-dense listing plus a
// secret in a large image-profitable log. Maximizes the router's "cost of safety".
const RISKY: Block[] = [
  { name: 'system prose doc', text: 'This assistant follows the project conventions described here. '.repeat(360) },
  { name: 'log (sparse anchors)', text: 'INFO worker processed batch, moving on\n'.repeat(500) + 'built dist/app.js at commit a1b2c3d\n' },
  { name: 'file listing (path-dense)', text: 'src/core/module/handler-file-name.ts\n'.repeat(360) },
  { name: 'stack trace', text: "Error: boom\n    at src/core/index.ts:42:13\n    at tests/x.test.ts:7:5\n" },
  { name: 'command block', text: 'pnpm install && pnpm test\nANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude\n' },
  { name: 'log w/ SECRET (profitable)', text: '2026-05-19T10:00:00Z INFO request handled ok in 42ms, cache warm, upstream 200 rows=17\n'.repeat(300) + `resolved ANTHROPIC_API_KEY=${SECRET} for upstream call\n`, hasSecret: true },
];

// Scenario B — a TYPICAL turn: prose + long-line logs with only sparse anchors, no
// secret, no path-dense block. The common case: router ≈ image-every.
const TYPICAL: Block[] = [
  { name: 'system prose doc', text: 'This assistant follows the project conventions described here. '.repeat(360) },
  { name: 'long doc / readme', text: 'The pipeline reads the config, validates inputs, and streams results downstream. '.repeat(300) },
  { name: 'log (sparse anchors)', text: '2026-05-19T10:00:00Z INFO handled request ok in 42ms cache warm upstream 200 rows=17\n'.repeat(300) + 'output at dist/bundle.js\n' },
  { name: 'test output (sparse)', text: 'PASS suite ran green in 12ms, all assertions held, nothing to report here\n'.repeat(240) + 'see coverage/report.html\n' },
];

const tok = (text: string) => {
  const e = evalCompressionProfitability(text, COLS, undefined, 1, CPT);
  return e ? { text: e.textTokens, image: e.imageTokens, profitable: e.profitable } : { text: text.length / CPT, image: Infinity, profitable: false };
};
const pct = (from: number, to: number) => `${(((from - to) / from) * 100).toFixed(1)}%`;

function run(label: string, blocks: Block[]): void {
  let allText = 0, imageEvery = 0, routerOn = 0;
  let secretImagedEvery = false, secretImagedRouter = false;
  const rows: string[] = [];
  for (const b of blocks) {
    const t = tok(b.text);
    const keptText = routeBlock(b.text, 'coding-agent').keepAsText;
    const decision = routeBlock(b.text, 'coding-agent').assessment.decision;
    const textCost = Math.round(t.text);
    const imageCost = Number.isFinite(t.image) ? Math.round(t.image) : textCost;
    allText += textCost;
    const everyCost = t.profitable ? imageCost : textCost;
    imageEvery += everyCost;
    if (t.profitable && b.hasSecret) secretImagedEvery = true;
    const routerCost = keptText ? textCost : (t.profitable ? imageCost : textCost);
    routerOn += routerCost;
    if (!keptText && t.profitable && b.hasSecret) secretImagedRouter = true;
    rows.push(
      `  ${b.name.padEnd(28)} text=${String(textCost).padStart(6)} img=${String(imageCost).padStart(6)}` +
      `  every:${(t.profitable ? 'IMG' : 'txt').padEnd(3)} router:${decision}`,
    );
  }
  console.log(`\n=== ${label} ===`);
  console.log(rows.join('\n'));
  console.log(`  ALL-TEXT      ${String(allText).padStart(7)}`);
  console.log(`  IMAGE-EVERY   ${String(imageEvery).padStart(7)}  saves ${pct(allText, imageEvery)}  secret imaged: ${secretImagedEvery ? 'YES ⚠ UNSAFE' : 'no'}`);
  console.log(`  ROUTER-ON     ${String(routerOn).padStart(7)}  saves ${pct(allText, routerOn)}  secret imaged: ${secretImagedRouter ? 'YES ⚠' : 'no ✓'}`);
  console.log(`  cost of safety: ${(((routerOn - imageEvery) / allText) * 100).toFixed(1)}pp of baseline`);
}

run('Scenario A — RISKY turn (secret + path-dense; worst case)', RISKY);
run('Scenario B — TYPICAL turn (no secret, sparse anchors; common case)', TYPICAL);
console.log('\nBENCH_OK');
