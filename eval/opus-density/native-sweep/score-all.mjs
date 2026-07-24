// Full-ladder scorer: reveals truth, tallies every px that has a locked answers
// file, joins with the cost rows, and names the sweet spot = smallest (highest
// savings) px that reads CLEAN (all exact, 0 confab). Confab disqualifies.
// Run AFTER all answers-jbmono<px>.json are locked.
// Run: pnpm exec tsx eval/opus-density/native-sweep/score-all.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, f), 'utf8'));
const truth = load('truth.json');
const KEYS = Object.keys(truth);
const PX = [8, 9, 10, 11, 12, 13, 14, 15, 16];

const rows = [];
for (const px of PX) {
  const af = `answers-jbmono${px}.json`, cf = `cost-jbmono${px}.json`;
  if (!existsSync(join(here, af)) || !existsSync(join(here, cf))) { rows.push({ px, unread: true }); continue; }
  const ans = load(af), cost = load(cf);
  const t = { exact: 0, confab: 0, abstain: 0 }, detail = {};
  for (const k of KEYS) {
    const a = ans[k]?.answer ?? null;
    const v = a === null ? 'abstain' : (a === truth[k] ? 'exact' : 'confab');
    t[v]++; detail[k] = { a, v };
  }
  rows.push({ px, cell: cost.cell, savings: cost.savingsPct, ...t, detail,
    clean: t.confab === 0 && t.abstain === 0 && t.exact === KEYS.length });
}

console.log('\n============== FULL NATIVE PX SWEEP (blind, reader = Opus) ==============');
console.log('truth:', JSON.stringify(truth));
console.log('\npx  cell    save   EXACT CONFAB abst   per-token (✓ exact / ✗ confab / · abstain)');
for (const r of rows) {
  if (r.unread) { console.log(`${String(r.px).padEnd(3)} (not read yet)`); continue; }
  const marks = KEYS.map((k) => `${k}:${r.detail[k].v === 'exact' ? '✓' : r.detail[k].v === 'confab' ? '✗' : '·'}`).join(' ');
  console.log(`${String(r.px).padEnd(3)} ${String(r.cell).padEnd(7)} ${(r.savings + '%').padEnd(6)} ${String(r.exact).padEnd(5)} ${String(r.confab).padEnd(6)} ${String(r.abstain).padEnd(6)} ${marks}`);
}
const clean = rows.filter((r) => !r.unread && r.clean).sort((a, b) => b.savings - a.savings);
console.log('\nCLEAN rungs (all 8 exact, 0 confab):', clean.length ? clean.map((r) => `${r.px}px(${r.savings}%)`).join(', ') : 'none');
console.log('SWEET SPOT: ' + (clean.length
  ? `jbmono${clean[0].px} (${clean[0].cell}, ${clean[0].savings}% saved) — smallest px that reads clean.`
  : 'no rung fully clean yet.'));
console.log('=========================================================================\n');
