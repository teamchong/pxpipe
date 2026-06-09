// Render GSM8K problems with pxpipe's REAL renderTextToPngs (default settings),
// so the benchmark tests pxpipe itself, not an approximation.
// Usage: node render_all.mjs [N] [OFFSET]   → writes ./imgs/q*.png
import { renderTextToPngs } from '../../dist/core/render.js';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';

const N = parseInt(process.argv[2] || '100');
const OFF = parseInt(process.argv[3] || '100');
const DATA = process.env.GSM_DATA || '/tmp/gsm8k_test.jsonl';

mkdirSync('./imgs', { recursive: true });
const lines = readFileSync(DATA, 'utf8').trim().split('\n').slice(OFF, OFF + N);
let multipage = 0, toks = 0;
for (let i = 0; i < lines.length; i++) {
  const q = JSON.parse(lines[i]).question;
  const pngs = await renderTextToPngs(q);
  if (pngs.length > 1) multipage++;
  writeFileSync(`./imgs/q${i}.png`, pngs[0].png);
  toks += Math.round((pngs[0].width * pngs[0].height) / 750);
}
console.log(`rendered ${lines.length} (offset ${OFF}) | multipage=${multipage} | avg_img_tokens=${Math.round(toks / lines.length)}`);
