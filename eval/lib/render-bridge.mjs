/**
 * eval/lib/render-bridge.mjs
 *
 * Thin bridge that imports the compiled pxpipe render functions from
 * dist/core/render.js and exposes them to the eval scripts.
 *
 * Why dist/ and not src/?
 *   The vitest-based unit tests import from src/ via tsx (TypeScript → JS
 *   on-the-fly). The eval scripts are plain .mjs files run with `node` and
 *   don't go through tsx, so they need the already-compiled dist/ output.
 *   Run `npm run build` (or `pnpm run build`) first if dist/ is stale.
 *
 * The bridge re-exports exactly what the eval harness needs and nothing else.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const RENDER_PATH = resolve(ROOT, 'dist', 'core', 'render.js');
const PNG_PATH    = resolve(ROOT, 'dist', 'core', 'png.js');

if (!existsSync(RENDER_PATH)) {
  throw new Error(
    `[render-bridge] dist/core/render.js not found.\n` +
    `Run \`pnpm run build\` from the repo root first.\n` +
    `Expected: ${RENDER_PATH}`,
  );
}

// pathToFileURL: on Windows a bare absolute path ("D:\...") is rejected by
// the ESM loader (ERR_UNSUPPORTED_ESM_URL_SCHEME) — dynamic import() needs
// a proper file:// URL on every platform.
const renderModule = await import(pathToFileURL(RENDER_PATH).href);
const pngModule    = await import(pathToFileURL(PNG_PATH).href);

export const {
  renderTextToPngs,
  renderTextToPngsReflow,
  renderTextToPngsReflowMultiCol,
  renderTextToPngsMultiCol,
  minifyForRender,
  reflow,
  dereflow,
  NL_SENTINEL,
} = renderModule;

export const {
  bytesToBase64,
} = pngModule;
