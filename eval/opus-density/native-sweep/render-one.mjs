// Render the blind fixture with whatever atlas is CURRENTLY built into dist
// (the driver swaps src/core/atlas*.ts + rebuilds before calling this). Fixed
// cols=86 for a controlled px comparison. Emits PNGs + a cost row per px.
// Run (by driver, after rebuild): node eval/opus-density/native-sweep/render-one.mjs <px>
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderTextToImages } from '../../../dist/core/library.js';
import { ATLAS_CELL_W, ATLAS_CELL_H } from '../../../dist/core/atlas.js';

const here = dirname(fileURLToPath(import.meta.url));
const px = Number(process.argv[2]);
const COLS = 86;
const SESSION = readFileSync(join(here, 'fixture.txt'), 'utf8');
const TEXT_TOKENS = Math.ceil(SESSION.length / 3.5);
const patchTokens = (w, h) => Math.ceil(w / 28) * Math.ceil(h / 28);

const { pages } = await renderTextToImages(SESSION, { style: { aa: true, cellWBonus: 0, cellHBonus: 0 }, cols: COLS, reflow: true });
const imageTokens = pages.reduce((n, p) => n + patchTokens(p.width, p.height), 0);
const savingsPct = Math.round((1 - imageTokens / TEXT_TOKENS) * 100);
const files = pages.map((p, i) => {
  const f = join(here, `jbmono${px}-p${i + 1}.png`);
  writeFileSync(f, Buffer.from(p.png));
  return f;
});
const row = {
  px, cell: `${ATLAS_CELL_W}x${ATLAS_CELL_H}`, cols: COLS, pages: pages.length,
  dims: pages.map((p) => `${p.width}x${p.height}`).join(','),
  imageTokens, textTokens: TEXT_TOKENS, savingsPct, files,
};
writeFileSync(join(here, `cost-jbmono${px}.json`), JSON.stringify(row, null, 2));
console.log(`jbmono${px}  cell=${row.cell}  pages=${row.pages}  dims=${row.dims}  imgTok=${imageTokens}  save=${savingsPct}%`);
