// Render the blind Grok native-size ladder (JB Mono 8..16px + spleen-5x8 control).
// Geometry: short-side ≤768px, maxH=512 (production Grok height).
// Swaps src/core/atlas*.ts, rebuilds, spawns render-one.mjs, restores on exit.
// Run: node eval/grok-density/native-sweep/render-ladder.mjs
import { copyFileSync, existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const atlasDir = join(here, 'atlases');
const cells = JSON.parse(readFileSync(join(here, 'atlas-cells.json'), 'utf8'));
const PX = [8, 9, 10, 11, 12, 13, 14, 15, 16];
const MAX_W = 768;
const MAX_H = 512;
const PAD_X = 4;

const srcAtlas = join(root, 'src/core/atlas.ts');
const srcGray = join(root, 'src/core/atlas-gray.ts');
const bakAtlas = join(here, '.bak-atlas.ts');
const bakGray = join(here, '.bak-atlas-gray.ts');

function restore() {
  if (existsSync(bakAtlas)) copyFileSync(bakAtlas, srcAtlas);
  if (existsSync(bakGray)) copyFileSync(bakGray, srcGray);
}
process.on('exit', restore);
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('SIGTERM', () => { restore(); process.exit(143); });

if (!existsSync(join(here, 'fixture.txt'))) {
  console.error('missing fixture.txt — run gen-fixture.mjs first');
  process.exit(1);
}

copyFileSync(srcAtlas, bakAtlas);
copyFileSync(srcGray, bakGray);

function build() {
  const r = spawnSync('pnpm', ['run', 'build'], {
    cwd: root, encoding: 'utf8', env: process.env, shell: process.platform === 'darwin',
  });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error('build failed');
  }
}

function renderOne(label, cols) {
  // wipe prior pages for this label so stale page counts don't linger
  for (const f of readdirSync(here)) {
    if (f.startsWith(`${label}-p`) && f.endsWith('.png')) unlinkSync(join(here, f));
  }
  const r = spawnSync(process.execPath, [join(here, 'render-one.mjs'), label, String(cols), String(MAX_H)], {
    cwd: root, encoding: 'utf8', env: process.env,
  });
  process.stdout.write(r.stdout || '');
  if (r.status !== 0) {
    console.error(r.stderr);
    throw new Error(`render-one ${label} failed`);
  }
  return JSON.parse(readFileSync(join(here, `cost-${label}.json`), 'utf8'));
}

const table = [];

// production control
{
  restore();
  build();
  table.push(renderOne('spleen5x8', 152));
}

for (const px of PX) {
  const mono = join(atlasDir, `atlas-jbmono${px}.ts`);
  const gray = join(atlasDir, `atlas-gray-jbmono${px}.ts`);
  if (!existsSync(mono) || !existsSync(gray)) {
    console.error(`missing atlases for ${px}px — run build-atlases.mjs`);
    continue;
  }
  const [cw] = String(cells[px] || '0x0').split('x').map(Number);
  const cols = Math.max(1, Math.floor((MAX_W - 2 * PAD_X) / cw));
  copyFileSync(mono, srcAtlas);
  copyFileSync(gray, srcGray);
  build();
  const row = renderOne(`jbmono${px}`, cols);
  if (cells[px] && row.cell !== cells[px]) {
    console.warn(`WARN jbmono${px}: measured ${row.cell} != expected ${cells[px]}`);
  }
  table.push(row);
}

restore();
build();
writeFileSync(join(here, 'render-table.json'), JSON.stringify(table, null, 2));
console.log('\nrender-table.json written,', table.length, 'rungs');
