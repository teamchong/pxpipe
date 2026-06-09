// Render any {question} jsonl with pxpipe's real renderTextToPngs.
// Usage: node render_cfg.mjs <data.jsonl> <outdir> [N] [OFFSET]
import { renderTextToPngs } from '../../dist/core/render.js';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
const DATA = process.argv[2], OUT = process.argv[3];
const N = parseInt(process.argv[4] || '100'), OFF = parseInt(process.argv[5] || '0');
mkdirSync(OUT, { recursive: true });
const lines = readFileSync(DATA, 'utf8').trim().split('\n').slice(OFF, OFF + N);
let tok = 0;
for (let i = 0; i < lines.length; i++) {
  const q = JSON.parse(lines[i]).question;
  const p = await renderTextToPngs(q);
  writeFileSync(`${OUT}/q${i}.png`, p[0].png);
  tok += Math.round((p[0].width * p[0].height) / 750);
}
console.log(`rendered ${lines.length} | avg_img_tokens=${Math.round(tok / lines.length)}`);
