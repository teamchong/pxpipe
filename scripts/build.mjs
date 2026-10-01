// Build library ESM + declarations with tsc, then overwrite the Node CLI
// entry with a bundled executable. The Worker target can still be built by
// wrangler directly from src/worker.ts, but dist/worker.js is also emitted for
// package consumers via tsc.
import { build } from 'esbuild';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';

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
//
// TS 7 no longer exports './bin/tsc', so resolve it via the bin field of the
// (still-exported) package.json instead of a direct subpath require. Resolve
// the relative bin path with node:path so Windows drive-qualified paths remain
// native filesystem paths and never acquire URL pathname semantics (/C:/...).
const tsPkgJsonPath = require.resolve('typescript/package.json');
const tsPkgDir = path.dirname(tsPkgJsonPath);
const tscBin = path.resolve(tsPkgDir, require('typescript/package.json').bin.tsc);
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
  target: 'node20',
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

const nodeJsContent = await readFile('dist/node.js');
const entrySha256 = createHash('sha256').update(nodeJsContent).digest('hex');

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr ?? '').trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
  return (result.stdout ?? '').trim();
}

function tryGit(args) {
  try {
    return runGit(args);
  } catch {
    return '';
  }
}

function repositoryFromRemoteUrl(remoteUrl) {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return '';
  const match = trimmed.match(/[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  return match?.[1] ?? trimmed;
}

function detectRepository() {
  let remoteName = '';

  const upstreamRef = tryGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstreamRef.includes('/')) {
    remoteName = upstreamRef.split('/')[0] ?? '';
  }

  const gitRef = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!remoteName && gitRef && gitRef !== 'HEAD') {
    remoteName = tryGit(['config', '--get', `branch.${gitRef}.remote`]);
  }

  let remoteUrl = '';
  if (remoteName) {
    remoteUrl = tryGit(['config', '--get', `remote.${remoteName}.url`]);
  }
  if (!remoteUrl) remoteUrl = tryGit(['config', '--get', 'remote.origin.url']);
  if (!remoteUrl) remoteUrl = tryGit(['config', '--get', 'remote.fork.url']);

  return repositoryFromRemoteUrl(remoteUrl) || 'Jouron93/pxpipe';
}

let gitCommit;
let gitRef;
let gitStatus;
let repository;
try {
  gitCommit = runGit(['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40}$/i.test(gitCommit)) {
    throw new Error(`invalid 40-character git HEAD SHA: ${JSON.stringify(gitCommit)}`);
  }
  gitRef = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  gitStatus = runGit(['status', '--porcelain']);
  repository = detectRepository();
} catch (error) {
  console.error(`✗ build provenance error: ${error instanceof Error ? error.message : String(error)}`);
  console.error('  builds must run inside a valid git checkout with git available');
  process.exit(1);
}

const provenance = {
  schema_version: 1,
  repository,
  source_sha: gitCommit,
  source_ref: gitRef || 'HEAD',
  dirty: gitStatus.length > 0,
  package_version: pkg.version,
  node_executable: process.execPath,
  node_version: process.version,
  built_at_utc: new Date().toISOString(),
  entry_sha256: entrySha256,
};

await writeFile(
  'dist/build-provenance.json',
  `${JSON.stringify(provenance, null, 2)}\n`,
  'utf8',
);
console.log(
  `✓ wrote dist/build-provenance.json ` +
    `(source: ${provenance.source_sha}, dirty: ${provenance.dirty}, entry: ${entrySha256})`,
);

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

// Smoke check 2: the bundled CLI must load the manifest it was just built with,
// verify the on-disk bundle hash, and report the same immutable source identity.
const provSmoke = spawnSync(process.execPath, ['dist/node.js', '--build-info'], { encoding: 'utf8' });
const printedProv = (provSmoke.stdout ?? '').trim();
if (provSmoke.status !== 0) {
  console.error(`✗ build-info smoke check failed: exit ${provSmoke.status}\n${provSmoke.stderr ?? ''}`);
  process.exit(1);
}

let parsedProv;
try {
  parsedProv = JSON.parse(printedProv);
} catch {
  console.error(`✗ build-info smoke check failed to parse JSON: ${printedProv}`);
  process.exit(1);
}

if (
  parsedProv.schema_version !== 1 ||
  parsedProv.source_sha !== gitCommit ||
  parsedProv.source_ref !== (gitRef || 'HEAD') ||
  parsedProv.dirty !== (gitStatus.length > 0) ||
  parsedProv.package_version !== pkg.version ||
  parsedProv.entry_sha256 !== entrySha256 ||
  parsedProv.runtime_entry_sha256 !== entrySha256 ||
  parsedProv.bundle_verified !== true
) {
  console.error(
    '✗ build-info verification failed: bundled runtime did not reproduce the build provenance contract',
  );
  console.error(JSON.stringify(parsedProv, null, 2));
  process.exit(1);
}
console.log('✓ build-info smoke check: provenance schema v1 and bundle SHA-256 verified');
