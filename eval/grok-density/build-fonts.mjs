// Build eval-only atlases. Never overwrites production src/core/atlas*.ts.
// Fonts available in assets/: Spleen-5x8.otb, Unifont-16.0.04.otf, JetBrainsMono-Regular.ttf
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const outDir = resolve(here, 'atlases');
mkdirSync(outDir, { recursive: true });

const jobs = [
  // production-equivalent (sanity)
  {
    name: 'spleen5x8',
    env: {
      ATLAS_PRIMARY_FONT: 'assets/Spleen-5x8.otb',
      ATLAS_FALLBACK_FONT: 'assets/Unifont-16.0.04.otf',
      ATLAS_PRIMARY_FAMILY: 'Spleen',
      ATLAS_FALLBACK_FAMILY: 'Unifont',
      ATLAS_PRIMARY_PX: '8',
      ATLAS_FALLBACK_PX: '8',
      ATLAS_PROFILE: 'ascii',
      ATLAS_LABEL: 'Spleen 5x8 + Unifont 8px',
      ATLAS_OUT: `eval/grok-density/atlases/atlas-spleen5x8.ts`,
      ATLAS_OUT_GRAY: `eval/grok-density/atlases/atlas-gray-spleen5x8.ts`,
    },
  },
  // JetBrains Mono at small sizes — real font change (not cell padding)
  {
    name: 'jbmono8',
    env: {
      ATLAS_PRIMARY_FONT: 'assets/JetBrainsMono-Regular.ttf',
      ATLAS_FALLBACK_FONT: 'assets/Unifont-16.0.04.otf',
      ATLAS_PRIMARY_FAMILY: 'JetBrainsMono',
      ATLAS_FALLBACK_FAMILY: 'Unifont',
      ATLAS_PRIMARY_PX: '8',
      ATLAS_FALLBACK_PX: '8',
      ATLAS_PRIMARY_ONLY: '0',
      ATLAS_ALLOW_ANY_CELL: '1',
      ATLAS_PROFILE: 'ascii',
      ATLAS_LABEL: 'JetBrains Mono 8px + Unifont 8px',
      ATLAS_OUT: `eval/grok-density/atlases/atlas-jbmono8.ts`,
      ATLAS_OUT_GRAY: `eval/grok-density/atlases/atlas-gray-jbmono8.ts`,
    },
  },
  {
    name: 'jbmono10',
    env: {
      ATLAS_PRIMARY_FONT: 'assets/JetBrainsMono-Regular.ttf',
      ATLAS_FALLBACK_FONT: 'assets/Unifont-16.0.04.otf',
      ATLAS_PRIMARY_FAMILY: 'JetBrainsMono',
      ATLAS_FALLBACK_FAMILY: 'Unifont',
      ATLAS_PRIMARY_PX: '10',
      ATLAS_FALLBACK_PX: '10',
      ATLAS_ALLOW_ANY_CELL: '1',
      ATLAS_PROFILE: 'ascii',
      ATLAS_LABEL: 'JetBrains Mono 10px + Unifont 10px',
      ATLAS_OUT: `eval/grok-density/atlases/atlas-jbmono10.ts`,
      ATLAS_OUT_GRAY: `eval/grok-density/atlases/atlas-gray-jbmono10.ts`,
    },
  },
  {
    name: 'jbmono12',
    env: {
      ATLAS_PRIMARY_FONT: 'assets/JetBrainsMono-Regular.ttf',
      ATLAS_FALLBACK_FONT: 'assets/Unifont-16.0.04.otf',
      ATLAS_PRIMARY_FAMILY: 'JetBrainsMono',
      ATLAS_FALLBACK_FAMILY: 'Unifont',
      ATLAS_PRIMARY_PX: '12',
      ATLAS_FALLBACK_PX: '12',
      ATLAS_ALLOW_ANY_CELL: '1',
      ATLAS_PROFILE: 'ascii',
      ATLAS_LABEL: 'JetBrains Mono 12px + Unifont 12px',
      ATLAS_OUT: `eval/grok-density/atlases/atlas-jbmono12.ts`,
      ATLAS_OUT_GRAY: `eval/grok-density/atlases/atlas-gray-jbmono12.ts`,
    },
  },
  // Unifont-only at 8/10/12
  {
    name: 'unifont8',
    env: {
      ATLAS_PRIMARY_FONT: 'assets/Unifont-16.0.04.otf',
      ATLAS_FALLBACK_FONT: 'assets/Unifont-16.0.04.otf',
      ATLAS_PRIMARY_FAMILY: 'Unifont',
      ATLAS_FALLBACK_FAMILY: 'Unifont',
      ATLAS_PRIMARY_PX: '8',
      ATLAS_FALLBACK_PX: '8',
      ATLAS_PRIMARY_ONLY: '1',
      ATLAS_ALLOW_ANY_CELL: '1',
      ATLAS_PROFILE: 'ascii',
      ATLAS_LABEL: 'Unifont 8px only',
      ATLAS_OUT: `eval/grok-density/atlases/atlas-unifont8.ts`,
      ATLAS_OUT_GRAY: `eval/grok-density/atlases/atlas-gray-unifont8.ts`,
    },
  },
  {
    name: 'unifont10',
    env: {
      ATLAS_PRIMARY_FONT: 'assets/Unifont-16.0.04.otf',
      ATLAS_FALLBACK_FONT: 'assets/Unifont-16.0.04.otf',
      ATLAS_PRIMARY_FAMILY: 'Unifont',
      ATLAS_FALLBACK_FAMILY: 'Unifont',
      ATLAS_PRIMARY_PX: '10',
      ATLAS_FALLBACK_PX: '10',
      ATLAS_PRIMARY_ONLY: '1',
      ATLAS_ALLOW_ANY_CELL: '1',
      ATLAS_PROFILE: 'ascii',
      ATLAS_LABEL: 'Unifont 10px only',
      ATLAS_OUT: `eval/grok-density/atlases/atlas-unifont10.ts`,
      ATLAS_OUT_GRAY: `eval/grok-density/atlases/atlas-gray-unifont10.ts`,
    },
  },
];

for (const job of jobs) {
  console.log(`\n=== build ${job.name} (1-bit) ===`);
  let r = spawnSync('pnpm', ['exec', 'tsx', 'scripts/gen-atlas.ts'], {
    cwd: root,
    env: { ...process.env, ...job.env, ATLAS_GRAY: '0' },
    encoding: 'utf8',
  });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  if (r.status !== 0) {
    console.error(`FAILED ${job.name} 1-bit status=${r.status}`);
    continue;
  }
  console.log(`=== build ${job.name} (gray) ===`);
  r = spawnSync('pnpm', ['exec', 'tsx', 'scripts/gen-atlas.ts'], {
    cwd: root,
    env: { ...process.env, ...job.env, ATLAS_GRAY: '1' },
    encoding: 'utf8',
  });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  if (r.status !== 0) console.error(`FAILED ${job.name} gray status=${r.status}`);
}
console.log('\nDone. Files in', outDir);
