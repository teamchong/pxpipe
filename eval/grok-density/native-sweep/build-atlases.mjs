// Build GENUINE JB Mono atlases at every px in the native ladder (8..16), from
// assets/JetBrainsMono-Regular.ttf via scripts/gen-atlas.ts (ATLAS_ALLOW_ANY_CELL).
// Emits eval-only atlas-jbmono<px>.ts + atlas-gray-jbmono<px>.ts. Never touches
// production src/core/atlas*.ts. Prints the measured cell W x H for each px.
// Run: pnpm exec tsx eval/grok-density/native-sweep/build-atlases.mjs
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const outDir = join(here, 'atlases');
mkdirSync(outDir, { recursive: true });

const PX_LIST = [8, 9, 10, 11, 12, 13, 14, 15, 16];
const cells = {};

for (const px of PX_LIST) {
  const env = {
    ATLAS_PRIMARY_FONT: 'assets/JetBrainsMono-Regular.ttf',
    ATLAS_FALLBACK_FONT: 'assets/Unifont-16.0.04.otf',
    ATLAS_PRIMARY_FAMILY: 'JetBrainsMono',
    ATLAS_FALLBACK_FAMILY: 'Unifont',
    ATLAS_PRIMARY_PX: String(px),
    ATLAS_FALLBACK_PX: String(px),
    ATLAS_ALLOW_ANY_CELL: '1',
    ATLAS_PROFILE: 'ascii',
    ATLAS_LABEL: `JetBrains Mono ${px}px`,
    ATLAS_OUT: `eval/grok-density/native-sweep/atlases/atlas-jbmono${px}.ts`,
    ATLAS_OUT_GRAY: `eval/grok-density/native-sweep/atlases/atlas-gray-jbmono${px}.ts`,
  };
  for (const gray of ['0', '1']) {
    const r = spawnSync('pnpm', ['exec', 'tsx', 'scripts/gen-atlas.ts'], {
      cwd: root, env: { ...process.env, ...env, ATLAS_GRAY: gray }, encoding: 'utf8',
    });
    const out = (r.stdout || '') + (r.stderr || '');
    const m = out.match(/cell=(\d+)[x×](\d+)/);
    if (m) cells[px] = `${m[1]}x${m[2]}`;
    if (r.status !== 0) { console.error(`FAILED jbmono${px} gray=${gray} status=${r.status}\n${out}`); }
  }
  console.log(`jbmono${px}: cell=${cells[px] || '?'}`);
}
writeFileSync(join(here, 'atlas-cells.json'), JSON.stringify(cells, null, 2));
console.log('\ncells:', JSON.stringify(cells));
