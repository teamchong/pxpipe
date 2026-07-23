// Reveal truth and score both native rungs. Run AFTER answers-*.json are locked.
// Run: pnpm exec tsx eval/opus-density/native-sweep/score.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, f), 'utf8'));

const truth = load('truth.json');
const table = load('render-table.json');
const RUNGS = [
  { file: 'answers-jbmono10_6x11.json', savings: table.find((t) => t.rung === 'jbmono10_6x11') },
  { file: 'answers-jbmono12_8x13.json', savings: table.find((t) => t.rung === 'jbmono12_8x13') },
];
const KEYS = Object.keys(truth);
const V = { exact: 'EXACT', confab: 'CONFAB', abstain: 'abstain' };

function classify(ans) { return Object.fromEntries(KEYS.map((k) => {
  const a = ans[k]?.answer ?? null;
  const t = truth[k];
  const v = a === null ? V.abstain : (a === t ? V.exact : V.confab);
  return [k, { a, t, v, conf: ans[k]?.conf }];
})); }

const scored = RUNGS.map((r) => {
  const ans = load(r.file);
  const cls = classify(ans);
  const tally = { exact: 0, confab: 0, abstain: 0 };
  for (const k of KEYS) tally[cls[k].v === V.exact ? 'exact' : cls[k].v === V.confab ? 'confab' : 'abstain']++;
  return { rung: ans._rung, savings: r.savings, cls, tally };
});

console.log('\n================ NATIVE SWEEP SCORE (blind, reader = Opus) ================\n');
for (const k of KEYS) {
  console.log(`  ${k.padEnd(7)} truth=${String(truth[k])}`);
  for (const s of scored) {
    const c = s.cls[k];
    const mark = c.v === V.exact ? '✓' : c.v === V.confab ? '✗ CONFAB' : '· abstain';
    console.log(`           ${s.rung.padEnd(15)} ${mark.padEnd(10)} read=${c.a === null ? '(abstain)' : c.a}${c.v === V.confab ? `   [conf=${c.conf}]` : ''}`);
  }
}
console.log('\n---------------------------------------------------------------------------');
console.log('rung            cell   savings  EXACT  CONFAB  abstain   verdict');
for (const s of scored) {
  const clean = s.tally.confab === 0;
  const full = clean && s.tally.abstain === 0 && s.tally.exact === KEYS.length;
  const verdict = full ? 'PASS (all exact, 0 confab)'
    : clean ? `partial (${s.tally.abstain} abstain, 0 confab — safe but lossy)`
    : `FAIL (${s.tally.confab} silent confab)`;
  console.log(`${s.rung.padEnd(15)} ${s.savings.cell.padEnd(6)} ${(s.savings.savingsPct + '%').padEnd(8)} ${String(s.tally.exact).padEnd(6)} ${String(s.tally.confab).padEnd(7)} ${String(s.tally.abstain).padEnd(9)} ${verdict}`);
}

// Sweet spot: cheapest rung that is PASS. Confab disqualifies (silent wrong reads
// are the dangerous mode). Densest-passing wins on savings.
const passing = scored.filter((s) => s.tally.confab === 0 && s.tally.abstain === 0 && s.tally.exact === KEYS.length);
const densestPass = passing.sort((a, b) => b.savings.savingsPct - a.savings.savingsPct)[0];
console.log('\nSWEET SPOT: ' + (densestPass
  ? `${densestPass.rung} (${densestPass.savings.cell}, ${densestPass.savings.savingsPct}% saved) — densest native rung that reads clean.`
  : 'no native rung is fully clean; densest 6x11 confabulates silently → recommend the larger native 8x13, or a padded retune (Sol\'s 9x12 lever) if 8x13 also drops tokens.'));
console.log('===========================================================================\n');
