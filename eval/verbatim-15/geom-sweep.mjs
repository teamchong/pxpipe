// Fixed-pitch 5x8 legibility sweep. Cell pitch NEVER changes: cols=312, wb=0, hb=0
// -> 1568px, exactly the API long-edge bound (render.ts:162). Full density preserved.
import { writeFileSync } from 'node:fs';
import { renderTextToPngs, renderCellWidth, renderCellHeight } from '../../dist/core/render.js';

const TRIALS = [
  { id: 't1', gold: 'c9c947f680ec', dur: 4439 },
  { id: 't2', gold: '851eb3af1bd1', dur: 812  },
  { id: 't3', gold: 'ade34f70fd73', dur: 6150 },
];

function denseLog(trial, totalLines = 80) {
  const lines = [
    `BEGIN EVENT LOG TRACE - SYSTEM SESSION ${trial.id}`,
    `{"timestamp":"2026-07-21T12:00:00Z","id":"${trial.gold}","dur_ms":${trial.dur},"status":200,"path":"/api/v1/sync","msg":"target line"}`,
  ];
  for (let i = 0; i < totalLines - 2; i++) {
    const fakeHex = (i * 12345678911 + 987654321).toString(16).padEnd(12,'0').slice(0,12);
    lines.push(`{"timestamp":"2026-07-21T12:01:${(i%60).toString().padStart(2,'0')}Z","id":"${fakeHex}","dur_ms":${1000+i*17},"status":200,"path":"/api/v1/filler_${i}"}`);
  }
  return lines.join('\n');
}

const COLS = 312, MAXH = 1568;
const manifest = [];
let n = 0;
for (const aa of [false, true])
for (const inkDilate of [0, 1])
for (const classTick of [false, true])
for (const colorByClass of [false, true]) {
  const style = { font:'spleen-5x8', cellWBonus:0, cellHBonus:0,
                  aa, inkDilate, inkDilateAxis:'y', classTick, colorByClass };
  const cw = renderCellWidth(style), ch = renderCellHeight(style);
  const name = `aa${aa?1:0}_dil${inkDilate}_tick${classTick?1:0}_cls${colorByClass?1:0}`;
  for (const t of TRIALS) {
    const imgs = await renderTextToPngs(denseLog(t), COLS, style, MAXH);
    if (imgs.length !== 1) throw new Error(`${name}/${t.id}: ${imgs.length} pages`);
    const p = `/tmp/geomsweep/${name}__${t.id}.png`;
    writeFileSync(p, imgs[0].png);
    manifest.push({ variant:name, trial:t.id, gold:t.gold, dur:t.dur, path:p,
                    w:imgs[0].width, h:imgs[0].height, cellW:cw, cellH:ch,
                    aa, inkDilate, classTick, colorByClass });
  }
  n++;
}
writeFileSync('/tmp/geomsweep/manifest.json', JSON.stringify(manifest, null, 2));

const pitches = [...new Set(manifest.map(m => `${m.cellW}x${m.cellH}`))];
const dims    = [...new Set(manifest.map(m => `${m.w}x${m.h}`))];
console.log(`variants        : ${n}   (x${TRIALS.length} trials = ${manifest.length} images)`);
console.log(`cell pitch      : ${pitches.join(', ')}   <- must be exactly 5x8`);
console.log(`image dims      : ${dims.join(', ')}      <- must be exactly 1568x648`);
console.log(pitches.length===1 && pitches[0]==='5x8' ? '\nPASS: 5x8 pitch identical across every variant. Full density held.'
                                                     : '\nFAIL: pitch drifted!');
