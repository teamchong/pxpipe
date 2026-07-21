// Empirical Long Side & Resolution Sweep for Gemini 3.6 Flash
// Sweeps width (cols), height (long side px), and font scaling to find exact breakdown threshold.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callGemini } from './gemini-client.mjs';
import { renderTextToPngs } from '../../dist/core/render.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.MODEL || 'gemini-3.6-flash';
const LIVE = process.env.LIVE === '1';

// Dense test fixtures containing exact hex IDs and dur_ms targets
const SWEEP_TRIALS = [
  { id: 't1', gold: 'c9c947f680ec', dur: 4439 },
  { id: 't2', gold: '851eb3af1bd1', dur: 812 },
  { id: 't3', gold: 'ade34f70fd73', dur: 6150 },
  { id: 't4', gold: 'c5d68855f46d', dur: 7978 },
  { id: 't5', gold: '92abade01aad', dur: 8071 },
];

function generateDenseLog(trial, totalLines = 60) {
  const lines = [
    `BEGIN EVENT LOG TRACE - SYSTEM SESSION ${trial.id}`,
    `{"timestamp":"2026-07-21T12:00:00Z","id":"${trial.gold}","dur_ms":${trial.dur},"status":200,"path":"/api/v1/sync","msg":"target line"}`,
  ];
  for (let i = 0; i < totalLines - 2; i++) {
    const fakeHex = (i * 12345678911 + 987654321).toString(16).padEnd(12, '0').slice(0, 12);
    lines.push(`{"timestamp":"2026-07-21T12:01:${(i % 60).toString().padStart(2, '0')}Z","id":"${fakeHex}","dur_ms":${1000 + i * 17},"status":200,"path":"/api/v1/filler_${i}"}`);
  }
  return lines.join('\n');
}

// Sweep configurations
const CONFIGS = [
  { name: '152-col x 728px (768x728)', cols: 152, maxH: 728 },
  { name: '152-col x 1932px (768x1932 Sol tall)', cols: 152, maxH: 1932 },
  { name: '312-col x 728px (1568x728 Claude wide)', cols: 312, maxH: 728 },
  { name: '312-col x 1568px (1568x1568 Square 1.5M)', cols: 312, maxH: 1568 },
  { name: '312-col x 2048px (1568x2048 Tall wide)', cols: 312, maxH: 2048 },
  { name: '400-col x 1024px (2000x1024 Ultra wide)', cols: 400, maxH: 1024 },
  { name: '500-col x 1200px (2500x1200 Extreme wide)', cols: 500, maxH: 1200 },
];

async function run() {
  console.log(`=== Gemini 3.6 Flash Resolution & Long Side Sweep ===\n`);

  const results = [];
  for (const cfg of CONFIGS) {
    let hits = 0;
    let sampleImgDetails = null;

    console.log(`Testing config: ${cfg.name}...`);
    for (const trial of SWEEP_TRIALS) {
      const sourceText = generateDenseLog(trial, 80);
      const imgs = await renderTextToPngs(sourceText, cfg.cols, { font: 'spleen-5x8', aa: true }, cfg.maxH);
      const png = imgs[0].png;
      if (!sampleImgDetails) {
        sampleImgDetails = { width: imgs[0].width, height: imgs[0].height, pages: imgs.length };
      }

      let got = '';
      let ok = false;
      if (LIVE) {
        const content = [
          { type: 'input_image', image_url: `data:image/png;base64,${Buffer.from(png).toString('base64')}` },
          { type: 'input_text', text: `Read the image visually. Find the JSON line whose dur_ms is exactly ${trial.dur}. Return only its id field, exactly 12 lowercase hex characters.` }
        ];
        try {
          const res = await callGemini({ model: MODEL, content, maxOutputTokens: 50, timeoutMs: 30000 });
          got = res.text.match(/[0-9a-f]{12}/i)?.[0]?.toLowerCase() || '';
          ok = got === trial.gold;
          if (ok) hits++;
        } catch (e) {
          console.error(`  Error on ${trial.id}:`, e.message);
        }
      }
    }

    const accuracy = `${hits}/${SWEEP_TRIALS.length}`;
    results.push({ name: cfg.name, cols: cfg.cols, maxH: cfg.maxH, dimensions: sampleImgDetails, hits, total: SWEEP_TRIALS.length, accuracy });
    console.log(`  -> Dimensions: ${sampleImgDetails?.width}x${sampleImgDetails?.height} | Accuracy: ${accuracy}\n`);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    live: LIVE,
    results
  };

  writeFileSync(join(HERE, 'resolution-sweep-results.json'), JSON.stringify(output, null, 2));
  console.log(`Results saved to eval/gemini-profile/resolution-sweep-results.json`);
}

run();
