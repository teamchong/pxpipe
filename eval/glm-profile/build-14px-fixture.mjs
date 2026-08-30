// Build the 14px pilot fixture from the recovered 5x8 source text.
// Geometry is the measured native profile: JetBrains Mono 14px in a 9x16 cell,
// 84 cols (764px wide), maxH 512. Records are 93-96 chars, so each wraps to two
// lines at 84 cols; pagination keeps a record's lines together (15 records x 2
// lines = 30 rows = 488px per page). Fields are rendered verbatim, no rewrite.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderTextToPngs } from '../../dist/core/render.js';

const SRC = 'eval/glm-profile/14px-fixture/src';
const OUT = 'eval/glm-profile/14px-fixture';
const COLS = 84;
const ROWS_PER_PAGE = 30;

const style = {
  font: 'jetbrains-mono-14',
  cellWBonus: 0,
  cellHBonus: 0,
  aa: true,
  grid: false,
  gridCols: 0,
  colorCycle: false,
  markerScale: 1,
  markerRed: false,
  inkDilate: 0,
};

const golds = JSON.parse(readFileSync('eval/verbatim-15/golds.json', 'utf8'));

const pages = [];
let pageLines = [];
let pageRecords = [];
const needlePage = new Map();

function flush() {
  if (pageLines.length) pages.push([...pageLines]);
  pageLines = [];
  pageRecords = [];
}

for (let p = 0; p < 5; p++) {
  const src = readFileSync(join(SRC, `page${p}.txt`), 'utf8').split('\n').filter((l) => l.length > 0);
  for (const line of src) {
    const chunks = [];
    for (let i = 0; i < line.length; i += COLS) chunks.push(line.slice(i, i + COLS));
    if (pageRecords.length + 1 > ROWS_PER_PAGE / 2) flush();
    for (const ch of chunks) pageLines.push(ch);
    pageRecords.push(chunks.length);
    for (const g of golds) {
      if (g.page === p && line.includes(`"dur_ms":${g.dur}`) && line.includes(g.gold)) {
        if (needlePage.has(g.dur)) throw new Error(`needle dur ${g.dur} matched twice`);
        needlePage.set(g.dur, pages.length);
      }
    }
  }
}
flush();

if (needlePage.size !== golds.length) throw new Error(`needles placed ${needlePage.size}/${golds.length}`);

mkdirSync(OUT, { recursive: true });
const manifest = [];
for (let p = 0; p < pages.length; p++) {
  const imgs = await renderTextToPngs(pages[p].join('\n'), COLS, style, 512);
  if (imgs.length !== 1) throw new Error(`page ${p}: expected 1 image, got ${imgs.length}`);
  const { png, width, height } = imgs[0];
  writeFileSync(join(OUT, `page${p}.png`), png);
  writeFileSync(join(OUT, `page${p}.txt`), pages[p].join('\n') + '\n');
  manifest.push({ page: p, width, height, lines: pages[p].length });
  console.log(`page${p}: ${width}x${height}, ${pages[p].length} lines`);
}

const outGolds = golds.map((g) => ({ page: needlePage.get(g.dur), dur: g.dur, gold: g.gold }));
writeFileSync(join(OUT, 'golds.json'), JSON.stringify(outGolds, null, 2) + '\n');
writeFileSync(join(OUT, 'provenance.json'), JSON.stringify({
  generatedBy: 'eval/glm-profile/14px fixture builder',
  source: 'committed eval/verbatim-15 pages decoded back to text (decode-verbatim-pages.mjs), verified 15/15 against golds.json',
  font: 'jetbrains-mono-14', cols: COLS, maxH: 512,
  recordsWrap: 2, rowsPerPage: ROWS_PER_PAGE,
  pages: manifest,
}, null, 2) + '\n');
console.log(`pages: ${pages.length}, trials: ${outGolds.length}`);
