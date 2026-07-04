/**
 * Runnable demo of the context risk router. No install needed:
 *
 *     npx tsx scripts/context-router-demo.ts
 *
 * Prints each handoff case → risk, decision, and the exact tokens preserved.
 * Doubles as the "Routing Examples" evidence and a smoke check the modules load.
 */

import { routeBlock, type ContextPolicy } from '../src/core/context-router.js';

interface Case {
  name: string;
  policy?: ContextPolicy;
  text: string;
}

const bigProse =
  'Context compression trades exactness for size, block by block. '.repeat(160);
const bigLog = 'processed record ok, retry scheduled, cache warm\n'.repeat(400);

const CASES: Case[] = [
  { name: '1. low-risk prose', text: bigProse },
  {
    name: '2. stack trace',
    text:
      "Error: Cannot find module './foo'\n" +
      '    at src/core/index.ts:42:13\n' +
      '    at tests/core.test.ts:7:5\n',
  },
  {
    name: '3. secret block',
    text: 'ANTHROPIC_API_KEY=sk-ant-abc123456789xyz\nPXPIPE_WORKER_SECRET=hunter2hunter2hunter2',
  },
  {
    name: '4. command block',
    text:
      'npx pxpipe-proxy\n' +
      'ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude\n' +
      'pnpm install && pnpm test\n',
  },
  {
    name: '5. large mixed tool output',
    text: bigLog + '\nartifact at dist/out.js built from commit a1b2c3d\n',
  },
  {
    name: '6. density fallback (anchor-dense, large)',
    policy: 'coding-agent',
    text: 'src/core/module-number-XX/file-name-here.ts\n'.repeat(300),
  },
];

for (const c of CASES) {
  const { assessment: a, keepAsText, rescueStrip } = routeBlock(c.text, c.policy ?? 'default');
  const preview = a.exactTokens
    .slice(0, 6)
    .map((t) => `${t.kind}:${t.value}`)
    .join(', ');
  console.log(`\n=== ${c.name}${c.policy ? ` [${c.policy}]` : ''} (${c.text.length} chars) ===`);
  console.log(`  risk=${a.risk}  decision=${a.decision}  keepAsText=${keepAsText}`);
  console.log(`  reasons: ${a.reasons.join('; ')}`);
  console.log(`  exactTokens(${a.exactTokens.length}): ${preview || '—'}`);
  if (rescueStrip) console.log(`  rescueStrip:\n${rescueStrip.split('\n').map((l) => '    ' + l).join('\n')}`);
}
console.log('\nDEMO_OK');
