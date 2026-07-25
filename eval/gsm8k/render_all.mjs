// Render GSM8K problems through a specific model's profile geometry,
// so the benchmark tests pxpipe as that model would actually see it.
//
// Usage: MODEL=claude-opus-5 [GSM_IMGS=./imgs] node render_all.mjs [N] [OFFSET]
//
// Was: renderTextToPngs(q) with "default settings". Defaults happen to equal
// every claude-*/gemini profile today (312 cols / 728 px) but are wrong for
// grok-4.5 (152/512) and gpt-5.6 (152/1932), and they silently decouple the
// fixtures from the profile — which is how eval/gsm8k/novel_imgs drifted to
// 313 cols / 1573 px and sat blurred through weeks of scoring.
//
// Cost was also reported via the deprecated (W*H)/750 slope, which understates
// the real patch cost by ~40% (a 1568x16 page is 56 tokens, not 34).
import { renderForModel } from '../lib/render-bridge.mjs';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';

const N = parseInt(process.argv[2] || '100');
const OFF = parseInt(process.argv[3] || '100');
const DATA = process.env.GSM_DATA || '/tmp/gsm8k_test.jsonl';
const OUT = process.env.GSM_IMGS || './imgs';
const MODEL = process.env.MODEL;

if (!MODEL) {
  console.error('[render_all] MODEL is required — fixtures are per-model geometry.');
  console.error('             e.g. MODEL=claude-opus-5 node render_all.mjs 100 100');
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });
const lines = readFileSync(DATA, 'utf8').trim().split('\n').slice(OFF, OFF + N);

let multipage = 0, visualTokens = 0, profile = null;
const dims = [];

for (let i = 0; i < lines.length; i++) {
  const q = JSON.parse(lines[i]).question;
  const { pages, profile: prof, stats } = await renderForModel(q, MODEL);
  profile ??= prof;
  if (pages.length > 1) multipage++;
  writeFileSync(`${OUT}/q${i}.png`, pages[0].png);
  visualTokens += stats[0].visualTokens;
  dims.push(`${stats[0].width}x${stats[0].height}`);
}

const avg = Math.round(visualTokens / lines.length);
const uniqueDims = [...new Set(dims)];

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
  `rendered ${lines.length} (offset ${OFF}) for ${MODEL} | cols=${profile.stripCols} ` +
  `maxH=${profile.maxHeightPx} | multipage=${multipage} | avg_visual_tokens=${avg}`,
);
