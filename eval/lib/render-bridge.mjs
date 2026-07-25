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
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const RENDER_PATH  = resolve(ROOT, 'dist', 'core', 'render.js');
const PNG_PATH     = resolve(ROOT, 'dist', 'core', 'png.js');
const PROFILE_PATH = resolve(ROOT, 'dist', 'core', 'gpt-model-profiles.js');
const VISION_PATH  = resolve(ROOT, 'dist', 'core', 'anthropic-vision.js');

if (!existsSync(RENDER_PATH)) {
  throw new Error(
    `[render-bridge] dist/core/render.js not found.\n` +
    `Run \`pnpm run build\` from the repo root first.\n` +
    `Expected: ${RENDER_PATH}`,
  );
}

const renderModule  = await import(RENDER_PATH);
const pngModule     = await import(PNG_PATH);
const profileModule = await import(PROFILE_PATH);
const visionModule  = await import(VISION_PATH);

export const {
  renderTextToPngs,
  renderTextToPngsReflow,
  minifyForRender,
  reflow,
  dereflow,
  NL_SENTINEL,
} = renderModule;

export const {
  bytesToBase64,
} = pngModule;

// ---------------------------------------------------------------------------
// Profile-aware rendering.
//
// Why this exists: `renderTextToPngs(text)` with no further arguments silently
// falls back to the module-level DEFAULT_COLS / MAX_HEIGHT_PX / {} style. That
// is *usually* right for Claude (DEFAULT_COLS and CLAUDE_*_PROFILE.stripCols
// are aliases of the same constant today) but it is right by coincidence, not
// by construction — and it is simply wrong for any model whose profile diverges.
//
// Every eval that scores a model must render through the same geometry the
// runtime would choose for that model. Use renderForModel(), not the raw
// renderer, so adding a new model means adding a profile and nothing else.
//
// Regression this guards: eval/gsm8k/novel_imgs was frozen on 2026-06-09 at
// 313 cols (1573 px). render.ts caps the slab at 312 cols (1568 px) because
// 1573 px trips a 0.997x resample that blurs every glyph. Those stale fixtures
// were scored against every model for weeks with no alarm.
// ---------------------------------------------------------------------------

export const { resolveGptProfile } = profileModule;
export const { anthropicVisionProfile, patchTokens } = visionModule;

/** Width/height from a PNG IHDR without pulling in a decoder. */
export function pngSize(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/**
 * Render `text` with the exact geometry the runtime uses for `model`.
 * Returns the pages plus the resolved profile and per-page cost stats.
 */
export async function renderForModel(text, model, { enforce = true } = {}) {
  const profile = resolveGptProfile(model);
  const pages = await renderModule.renderTextToPngs(
    text,
    profile.stripCols,
    profile.style,
    profile.maxHeightPx,
  );
  const stats = pages.map((p) => ({
    width: p.width,
    height: p.height,
    longEdge: Math.max(p.width, p.height),
    visualTokens: patchTokens(p.width, p.height),
  }));
  if (enforce) assertVisionBounds(stats, model);
  return { pages, profile, stats };
}

/** Fail loudly if a page exceeds the model's own declared vision caps. */
export function assertVisionBounds(stats, model) {
  const v = anthropicVisionProfile(model);
  stats.forEach((s, i) => {
    if (s.longEdge > v.maxLongEdge) {
      throw new Error(
        `[render-bridge] ${model} page ${i}: long edge ${s.longEdge}px exceeds ` +
        `profile maxLongEdge ${v.maxLongEdge}px (tier=${v.tier}) — would be resampled.`,
      );
    }
    if (s.visualTokens > v.maxVisualTokens) {
      throw new Error(
        `[render-bridge] ${model} page ${i}: ${s.visualTokens} visual tokens exceeds ` +
        `profile maxVisualTokens ${v.maxVisualTokens} (tier=${v.tier}).`,
      );
    }
  });
}

/**
 * Verify on-disk fixtures still match what `model`'s profile renders today.
 * `items` is [{ path, text }]. Throws listing every drifted fixture.
 *
 * Benches should call this before scoring; it is the check whose absence let
 * the 1573px fixtures survive a profile change.
 */
export async function assertFixturesFresh(items, model) {
  const { readFileSync, existsSync } = await import('node:fs');
  const drift = [];
  for (const { path, text } of items) {
    if (!existsSync(path)) { drift.push(`${path}: MISSING`); continue; }
    const onDisk = pngSize(readFileSync(path));
    const { pages } = await renderForModel(text, model, { enforce: false });
    const fresh = { width: pages[0].width, height: pages[0].height };
    if (onDisk.width !== fresh.width || onDisk.height !== fresh.height) {
      drift.push(
        `${path}: on-disk ${onDisk.width}x${onDisk.height} != profile ${fresh.width}x${fresh.height}`,
      );
    }
  }
  if (drift.length) {
    throw new Error(
      `[render-bridge] ${drift.length}/${items.length} fixtures are STALE for ${model}.\n` +
      drift.slice(0, 10).map((d) => '  ' + d).join('\n') +
      (drift.length > 10 ? `\n  ... ${drift.length - 10} more` : '') +
      `\nRegenerate them before scoring.`,
    );
  }
}
