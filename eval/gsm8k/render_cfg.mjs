// Render any {question} jsonl through the geometry of a specific model's profile.
//
// Usage: MODEL=claude-opus-5 node render_cfg.mjs <data.jsonl> <outdir> [N] [OFFSET]
//
// Fixtures are PER-MODEL and disposable. Do not commit them and do not reuse a
// directory across models: the profile decides cols/style/maxHeightPx, so two
// models can legitimately need different pixels for the same question.
//
// History: this script used to call renderTextToPngs(q) with no geometry, which
// pinned every model to the renderer's defaults. The committed fixtures then
// drifted to 313 cols / 1573 px — into the 0.997x resample that blurs glyphs —
// and were scored against every model for weeks. renderForModel() + the
// manifest below exist so that cannot recur silently.
import { renderForModel } from '../lib/render-bridge.mjs';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';

const DATA = process.argv[2], OUT = process.argv[3];
const N = parseInt(process.argv[4] || '100'), OFF = parseInt(process.argv[5] || '0');
const MODEL = process.env.MODEL;

if (!DATA || !OUT) {
  console.error('usage: MODEL=<model> node render_cfg.mjs <data.jsonl> <outdir> [N] [OFFSET]');
  process.exit(2);
}
if (!MODEL) {
  console.error('[render_cfg] MODEL is required — fixtures are per-model geometry.');
  console.error('             e.g. MODEL=claude-opus-5 node render_cfg.mjs ...');
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });
const lines = readFileSync(DATA, 'utf8').trim().split('\n').slice(OFF, OFF + N);

let visualTokens = 0, multipage = 0, profile = null;
const dims = [];

for (let i = 0; i < lines.length; i++) {
  const q = JSON.parse(lines[i]).question;
  // enforce:true -> throws if this model's own profile caps are exceeded.
  const { pages, profile: prof, stats } = await renderForModel(q, MODEL);
  profile ??= prof;
  if (pages.length > 1) multipage++;
  writeFileSync(`${OUT}/q${i}.png`, pages[0].png);
  visualTokens += stats[0].visualTokens;
  dims.push(`${stats[0].width}x${stats[0].height}`);
}

const avg = Math.round(visualTokens / lines.length);
const uniqueDims = [...new Set(dims)];

// Manifest makes staleness detectable: bench.py / assertFixturesFresh compare
// against it instead of trusting whatever PNGs happen to be on disk.
writeFileSync(`${OUT}/manifest.json`, JSON.stringify({
  model: MODEL,
  generated: new Date().toISOString(),
  source: DATA,
  count: lines.length,
  offset: OFF,
  geometry: {
    stripCols: profile.stripCols,
    maxHeightPx: profile.maxHeightPx,
    style: profile.style,
  },
  avgVisualTokens: avg,
  dims: uniqueDims,
}, null, 2) + '\n');

console.log(
  `rendered ${lines.length} for ${MODEL} | cols=${profile.stripCols} ` +
  `maxH=${profile.maxHeightPx} | avg_visual_tokens=${avg} | multipage=${multipage}`,
);
console.log(`dims: ${uniqueDims.slice(0, 5).join(', ')}${uniqueDims.length > 5 ? ` (+${uniqueDims.length - 5})` : ''}`);
