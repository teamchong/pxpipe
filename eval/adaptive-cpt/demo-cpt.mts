/**
 * Demo B — adaptive CPT: the gate learns, and the learned rate changes decisions.
 * Self-contained: seeds a synthetic events log, fits it, and A/Bs the real gate.
 * Run:  npx tsx eval/adaptive-cpt/demo-cpt.mts
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildCptState, resolverFor, writeCptState } from '../../src/cpt-store.js';
import { transformRequest } from '../../src/core/transform.js';
import { ANTHROPIC_PATCH_PX } from '../../src/core/anthropic-vision.js';
const PIXELS_PER_VISUAL_TOKEN = ANTHROPIC_PATCH_PX * ANTHROPIC_PATCH_PX;

const TRUE_CPT = 1.5;                       // the density we secretly encode
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-demo-'));
const log = path.join(dir, 'events.jsonl');

// ── 1. Seed a log that behaves as if this project's slab text is 1.5 chars/token
let s = 7; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
const rows = Array.from({ length: 60 }, () => {
  const chars = Math.floor(20000 + rnd() * 30000);
  const px = Math.floor(rnd() * 400000);
  return JSON.stringify({
    ts: new Date().toISOString(), system_sha8: 'demo1234',
    bucket_chars: { static_slab: chars }, image_pixels: px,
    baseline_tokens: chars / TRUE_CPT + px / PIXELS_PER_VISUAL_TOKEN,
  });
});
fs.writeFileSync(log, rows.join('\n') + '\n');
console.log(`1. Seeded ${rows.length} events encoding a TRUE slab CPT of ${TRUE_CPT}`);
console.log(`   ${log}`);

// ── 2. Learn from it
const state = await buildCptState(log);
writeCptState(state, path.join(dir, 'cpt-state.jsonl'));
const fit = state.fits.get('demo1234')!;
console.log(`\n2. Learned from the log:`);
console.log(`   static_slab CPT = ${fit.cpt.static_slab?.toFixed(4)}   (truth ${TRUE_CPT}) ` +
  `${Math.abs((fit.cpt.static_slab ?? 0) - TRUE_CPT) < 0.05 ? '✅ recovered' : '❌'}`);
console.log(`   n_events = ${fit.nSamples}`);
console.log(`   buckets with no data were rejected, with reasons:`);
for (const [b, why] of Object.entries(fit.rejected)) console.log(`     - ${b}: ${why}`);

// ── 3. Show the learned rate changing a real gate decision
const enc = new TextEncoder();
const slabReq = (lines: number, width: number) => enc.encode(JSON.stringify({
  model: 'claude-3-5-sonnet',
  system: Array.from({ length: lines }, () => 'a'.repeat(width)).join('\n'),
  messages: [{ role: 'user', content: 'hi' }],
}));

console.log(`\n3. The same request, priced three ways (sparse slab: 900 lines × 32 chars):`);
for (const [label, opts] of [
  ['baked constant (2.0)', { reflow: false as const }],
  ['learned dense (1.0)',  { reflow: false as const, cptFor: () => 1.0 }],
  ['learned sparse (6.0)', { reflow: false as const, cptFor: () => 6.0 }],
] as const) {
  const { info } = await transformRequest(slabReq(900, 32), opts as any);
  console.log(`   ${label.padEnd(22)} → imaged=${String(info.compressed).padEnd(5)} ` +
    `cpt=${info.cptUsed?.static_slab} (${info.cptSource?.static_slab})` +
    `${info.compressed ? '' : `  reason=${info.reason}`}`);
}
console.log(`\n   ↑ The decision FLIPS purely from the price of text — that is the feature.`);

// ── 4. Per-project beats pooled
const resolve = resolverFor(state);
console.log(`\n4. Resolver: known project → ${resolve('static_slab', 'demo1234')?.toFixed(4)}` +
  `, unknown project → ${resolve('static_slab', 'ffffffff')?.toFixed(4)} (pooled fallback)`);
console.log(`   history bucket (no data) → ${resolve('history', 'demo1234') ?? 'undefined → baked constant 2.0'}`);

fs.rmSync(dir, { recursive: true, force: true });
