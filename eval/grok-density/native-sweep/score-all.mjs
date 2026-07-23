// Reveal truth and score every rung that has locked answers + cost.
// Sweet spot = densest (highest savings) clean rung: all exact, 0 confab.
// Run: node eval/grok-density/native-sweep/score-all.mjs
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, f), 'utf8'));
const truth = load('truth.json');
const KEYS = Object.keys(truth);
const LABELS = ['spleen5x8', ...[8, 9, 10, 11, 12, 13, 14, 15, 16].map((p) => `jbmono${p}`)];

const rows = [];
for (const label of LABELS) {
  const af = `answers-${label}.json`;
  const cf = `cost-${label}.json`;
  if (!existsSync(join(here, af)) || !existsSync(join(here, cf))) {
    rows.push({ label, unread: true });
    continue;
  }
  const ans = load(af);
  const cost = load(cf);
  const t = { exact: 0, confab: 0, abstain: 0 };
  const detail = {};
  for (const k of KEYS) {
    const a = ans[k]?.answer ?? null;
    const v = a === null ? 'abstain' : (String(a) === String(truth[k]) ? 'exact' : 'confab');
    t[v]++;
    detail[k] = { a, t: truth[k], v };
  }
  rows.push({
    label,
    cell: cost.cell,
    cols: cost.cols,
    savings: cost.savingsPct,
    imageTokens: cost.imageTokens,
    pages: cost.pages,
    ...t,
    detail,
    clean: t.confab === 0 && t.abstain === 0 && t.exact === KEYS.length,
  });
}

console.log('\n============== GROK 4.5 NATIVE PX SWEEP (blind) ==============');
console.log('truth:', JSON.stringify(truth));
console.log('\nlabel        cell   cols  save   EXACT CONFAB abst   per-token');
for (const r of rows) {
  if (r.unread) { console.log(`${r.label.padEnd(12)} (not read yet)`); continue; }
  const marks = KEYS.map((k) => `${k}:${r.detail[k].v === 'exact' ? '✓' : r.detail[k].v === 'confab' ? '✗' : '·'}`).join(' ');
  console.log(`${r.label.padEnd(12)} ${String(r.cell).padEnd(6)} ${String(r.cols).padEnd(5)} ${(r.savings + '%').padEnd(6)} ${String(r.exact).padEnd(5)} ${String(r.confab).padEnd(6)} ${String(r.abstain).padEnd(6)} ${marks}`);
}
const clean = rows.filter((r) => !r.unread && r.clean).sort((a, b) => b.savings - a.savings);
console.log('\nCLEAN rungs (all 8 exact, 0 confab):', clean.length ? clean.map((r) => `${r.label}(${r.savings}%)`).join(', ') : 'none');
console.log('SWEET SPOT: ' + (clean.length
  ? `${clean[0].label} (${clean[0].cell}, ${clean[0].savings}% saved) — densest clean rung.`
  : 'no rung fully clean.'));
console.log('==============================================================\n');

writeFileSync(join(here, 'score.json'), JSON.stringify({ truth, rows, sweetSpot: clean[0] || null }, null, 2) + '\n');
