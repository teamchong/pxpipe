// Render fixture with whatever atlas is currently built into dist.
// Args: <label> <cols> <maxH>
// Run (by driver after rebuild): node eval/grok-density/native-sweep/render-one.mjs jbmono14 84 512
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderTextToImages } from '../../../dist/core/library.js';
import { ATLAS_CELL_W, ATLAS_CELL_H } from '../../../dist/core/atlas.js';

const here = dirname(fileURLToPath(import.meta.url));
const [label, colsArg, maxHArg] = process.argv.slice(2);
const cols = Number(colsArg);
const maxH = Number(maxHArg || 512);
const GROK_TOK_PER_MPIX = 1000;
const session = readFileSync(join(here, 'fixture.txt'), 'utf8');
const textTokens = Math.ceil(session.length / 3.5);
const grokTokens = (w, h) => Math.max(1, Math.ceil(((w * h) / 1_000_000) * GROK_TOK_PER_MPIX));

const { pages } = await renderTextToImages(session, {
  style: { aa: true, cellWBonus: 0, cellHBonus: 0 },
  cols,
  maxHeightPx: maxH,
  reflow: true,
});
const imageTokens = pages.reduce((n, p) => n + grokTokens(p.width, p.height), 0);
const savingsPct = Math.round((1 - imageTokens / textTokens) * 100);
const files = pages.map((p, i) => {
  const f = join(here, `${label}-p${i + 1}.png`);
  writeFileSync(f, Buffer.from(p.png));
  return f;
});
const row = {
  label,
  cell: `${ATLAS_CELL_W}x${ATLAS_CELL_H}`,
  cols,
  maxH,
  pages: pages.length,
  dims: pages.map((p) => `${p.width}x${p.height}`).join(','),
  imageTokens,
  textTokens,
  savingsPct,
  files,
};
writeFileSync(join(here, `cost-${label}.json`), JSON.stringify(row, null, 2));
console.log(`${label}  cell=${row.cell} cols=${row.cols} pages=${row.pages} dims=${row.dims} imgTok=${imageTokens} save=${savingsPct}%`);
