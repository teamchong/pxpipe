// One-off: recover the source text of the committed eval/verbatim-15 pages.
// They were rendered by this repo's renderer (spleen 5x8, AA, 312 cols, 90 rows,
// 4px pad) but no page*.txt was committed. Glyph ink never overlaps between
// cells, so per-cell ink masks (pixel < 128) can be matched against reference
// masks rendered per char at the same style. Grid ink (230) and background (255)
// stay above threshold and cancel out.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { renderChunkToPng } from '../../dist/core/render.js';

const ROOT = 'eval/verbatim-15';
const OUT = 'eval/glm-profile/14px-fixture/src';
const COLS = 312;
const CELL_W = 5;
const CELL_H = 8;
const PAD = 4;
const ROWS = 90;

const CHARS = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));

async function grayscale(path) {
  const img = await loadImage(path);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  const w = img.width;
  const h = img.height;
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const v = (r + g + b) / 3;
    ink[i] = v < 128 ? 1 : 0;
  }
  return { ink, w, h };
}

function cellMask(page, row, col) {
  const m = new Uint8Array(CELL_W * CELL_H);
  for (let y = 0; y < CELL_H; y++) {
    for (let x = 0; x < CELL_W; x++) {
      const px = PAD + col * CELL_W + x;
      const py = PAD + row * CELL_H + y;
      m[y * CELL_W + x] = page.ink[py * page.w + px] || 0;
    }
  }
  return m;
}

// Reference masks: one render per char, read cell (row 0, col 0).
const refs = new Map();
for (const ch of CHARS) {
  const { png } = await renderChunkToPng(ch.repeat(COLS), COLS, { aa: true });
  const tmp = join('/var/folders/dw/yx3z2gxj7cj3_3ll_w9phf1r0000gn/T/opencode', 'ref.png');
  writeFileSync(tmp, png);
  const page = await grayscale(tmp);
  refs.set(ch, cellMask(page, 0, 0));
}
const blank = new Uint8Array(CELL_W * CELL_H);
refs.set(' ', blank);

function bestMatch(mask) {
  let inkCount = 0;
  for (const v of mask) inkCount += v;
  if (inkCount === 0) return ' ';
  let best = ' ';
  let bestDist = Infinity;
  for (const [ch, ref] of refs) {
    let d = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] !== ref[i]) d++;
    if (d < bestDist) { bestDist = d; best = ch; }
  }
  return best;
}

mkdirSync(OUT, { recursive: true });
const decodedAll = [];
for (let p = 0; p < 5; p++) {
  const page = await grayscale(join(ROOT, `page${p}.png`));
  const rows = Math.floor((page.h - 2 * PAD) / CELL_H);
  const cols = Math.floor((page.w - 2 * PAD) / CELL_W);
  const lines = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) line += bestMatch(cellMask(page, r, c));
    lines.push(line.replace(/\s+$/, ''));
  }
  const text = lines.join('\n');
  writeFileSync(join(OUT, `page${p}.txt`), text + '\n');
  decodedAll.push({ p, lines });
  console.log(`page${p}: ${rows}x${cols} decoded, line0=${JSON.stringify(lines[0].slice(0, 60))}, line1=${JSON.stringify(lines[1].slice(0, 80))}`);
}

// Verify: golds recovered from decoded text must equal golds.json exactly.
const golds = JSON.parse(readFileSync(join(ROOT, 'golds.json'), 'utf8'));
const byDur = new Map();
for (const { lines } of decodedAll) {
  for (const line of lines) {
    const m = line.match(/"id":"([0-9a-f]{12})".*?"dur_ms":(\d+)/);
    if (m) byDur.set(Number(m[2]), m[1]);
  }
}
let ok = 0;
for (const g of golds) {
  const got = byDur.get(g.dur);
  if (got === g.gold) ok++;
  else console.log(`MISMATCH dur=${g.dur} gold=${g.gold} decoded=${got}`);
}
console.log(`gold verification: ${ok}/${golds.length}`);
