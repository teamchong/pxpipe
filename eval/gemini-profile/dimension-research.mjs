// Dimension and Geometry Research for Gemini 3.6 Flash
// Measures token cost and verbatim reading accuracy across image sizes and aspect ratios.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { callGemini } from './gemini-client.mjs';
import { renderTextToPngs } from '../../dist/core/render.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.MODEL || 'gemini-3.6-flash';
const LIVE = process.env.LIVE === '1';

// Probe 1: Image Token Pricing across dimensions
const DIMENSION_PROBES = [
  { name: 'tiny-square', w: 100, h: 100 },
  { name: 'small-square', w: 256, h: 256 },
  { name: 'medium-square', w: 512, h: 512 },
  { name: 'standard-square', w: 1024, h: 1024 },
  { name: 'large-square', w: 2048, h: 2048 },
  { name: 'claude-widescreen', w: 1568, h: 728 },
  { name: 'gpt-sol-portrait', w: 768, h: 1932 },
  { name: 'grok-short-portrait', w: 768, h: 512 },
  { name: 'hd-1080p', w: 1920, h: 1080 },
  { name: 'ultra-wide-4-1', w: 2048, h: 512 },
  { name: 'ultra-tall-1-4', w: 512, h: 2048 },
  { name: 'extreme-wide-8-1', w: 4096, h: 512 },
];

function renderCanvasImage(w, h) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  ctx.font = '12px sans-serif';
  ctx.fillText('Probe image for token count measurement', 10, 20);
  return canvas.toBuffer('image/png');
}

const VERBATIM_TRIALS = [
  { id: 'a1', gold: 'c9c947f680ec', dur: 4439 },
  { id: 'a2', gold: '851eb3af1bd1', dur: 812 },
  { id: 'a3', gold: 'ade34f70fd73', dur: 6150 },
  { id: 'a4', gold: 'c5d68855f46d', dur: 7978 },
  { id: 'a5', gold: '92abade01aad', dur: 8071 },
];

async function run() {
  console.log(`=== Gemini 3.6 Flash Dimension & Geometry Research ===\n`);
  
  const tokenResults = [];
  for (const dim of DIMENSION_PROBES) {
    const png = renderCanvasImage(dim.w, dim.h);
    let imgTokens = null;
    let totalTokens = null;
    let ms = null;
    
    if (LIVE) {
      const content = [
        { type: 'input_image', image_url: `data:image/png;base64,${png.toString('base64')}` },
        { type: 'input_text', text: 'A' }
      ];
      try {
        const res = await callGemini({ model: MODEL, content, maxOutputTokens: 10, timeoutMs: 30000 });
        imgTokens = res.usage?.promptTokensDetails?.find(d => d.modality === 'IMAGE')?.tokenCount ?? null;
        totalTokens = res.usage?.promptTokenCount ?? null;
        ms = res.ms;
      } catch (e) {
        console.error(`Error on ${dim.name}:`, e.message);
      }
    }
    
    const aspect = (dim.w / dim.h).toFixed(2);
    tokenResults.push({ ...dim, aspect, imgTokens, totalTokens, ms });
    console.log(`${dim.name.padEnd(22)} ${dim.w}x${dim.h} (aspect ${aspect}) -> image tokens: ${imgTokens ?? 'N/A'}`);
  }

  // Geometry legibility benchmark across 4 rendering profiles
  const GEOMETRIES = [
    { name: '312-col 1568x728 (Claude widescreen)', cols: 312, maxH: 728 },
    { name: '152-col 768x1932 (GPT/Sol tall portrait)', cols: 152, maxH: 1932 },
    { name: '152-col 768x512 (Grok short portrait)', cols: 152, maxH: 512 },
    { name: '200-col 1024x1024 (1:1 square)', cols: 200, maxH: 1024 },
  ];

  console.log(`\n=== Verbatim Recall across Rendering Geometries ===\n`);
  const legibilityResults = [];

  for (const geom of GEOMETRIES) {
    let hits = 0;
    for (const trial of VERBATIM_TRIALS) {
      const sourceText = [
        'LOG TRACE FILE - EVENT STREAM',
        `{"timestamp":"2026-07-21T12:00:00Z","id":"${trial.gold}","dur_ms":${trial.dur},"status":200,"path":"/api/v1/sync"}`,
        '{"timestamp":"2026-07-21T12:00:01Z","id":"112233445566","dur_ms":1234,"status":200,"path":"/api/v1/data"}',
      ].join('\n');

      const imgs = await renderTextToPngs(sourceText, geom.cols, { font: 'spleen-5x8', aa: true }, geom.maxH);
      const png = imgs[0].png;
      let ok = false;
      let got = '';
      
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
          console.error(`  Error in trial ${trial.id}:`, e.message);
        }
      }
    }
    legibilityResults.push({ geometry: geom.name, hits, total: VERBATIM_TRIALS.length, accuracy: `${hits}/${VERBATIM_TRIALS.length}` });
    console.log(`${geom.name.padEnd(42)}: ${hits}/${VERBATIM_TRIALS.length} correct`);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    live: LIVE,
    tokenResults,
    legibilityResults
  };

  writeFileSync(join(HERE, 'dimension-research-results.json'), JSON.stringify(output, null, 2));
  console.log(`\nResults written to eval/gemini-profile/dimension-research-results.json`);
}

run();
