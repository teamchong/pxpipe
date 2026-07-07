// Build library ESM + declarations with tsc, then overwrite the Node CLI
// entry with a bundled executable. The Worker target can still be built by
// wrangler directly from src/worker.ts, but dist/worker.js is also emitted for
// package consumers via tsc.
import { build } from 'esbuild';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Single source of truth for the CLI version: read it here, inline it into the
// bundle via esbuild `define`. Reading npm_package_version at CLI *runtime* is
// unreliable (unset for global bins / npx, or the consumer's version), so the
// value is fixed at build time instead.
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const OUT = 'dist';
if (existsSync(OUT)) await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// Run tsc's JS entry directly with the current Node binary rather than via
// `pnpm exec`. On Windows the pnpm launcher is `pnpm.cmd`, which spawnSync
// refuses to run without shell:true (EINVAL since the CVE-2024-27980 fix), and
// with shell:true trips the DEP0190 arg-escaping warning. Resolving the tsc bin
// and invoking `node <tsc>` sidesteps both — same pattern as the smoke check
// below, and drops the build's dependency on pnpm being the caller.
const tscBin = require.resolve('typescript/bin/tsc');
const tsc = spawnSync(process.execPath, [tscBin, '-p', 'tsconfig.json'], {
  stdio: 'inherit',
});
if (tsc.error) {
  console.error(`✗ failed to run tsc: ${tsc.error.message}`);
  process.exit(1);
}
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
console.log('✓ emitted dist/ library modules + declarations');

await build({
  entryPoints: ['src/node.ts'],
  outfile: 'dist/node.js',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  sourcemap: true,
  // Inline the package version so `pxpipe --version` is correct for global/npx
  // installs (see the note where `pkg` is read). esbuild replaces the bare
  // identifier with the string literal at every reference.
  define: { __PXPIPE_VERSION__: JSON.stringify(pkg.version) },
  // Atlas is inlined as a base64 string in src/core/atlas.ts, so no external assets.
  external: [],
  banner: { js: '#!/usr/bin/env node' },
});

console.log('✓ built dist/node.js');

// Smoke check: the bundled CLI must report the real package version, not a
// stale fallback. Runs the shipped artifact end-to-end and fails the build on
// mismatch, so a broken version injection can never reach a release.
const smoke = spawnSync(process.execPath, ['dist/node.js', '--version'], { encoding: 'utf8' });
const printedVersion = (smoke.stdout ?? '').trim();
if (smoke.status !== 0 || printedVersion !== pkg.version) {
  console.error(
    `✗ version smoke check failed: 'node dist/node.js --version' printed ` +
      `${JSON.stringify(printedVersion)} (exit ${smoke.status}), expected ${JSON.stringify(pkg.version)}`,
  );
  process.exit(1);
}
console.log(`✓ version smoke check: --version prints ${pkg.version}`);
