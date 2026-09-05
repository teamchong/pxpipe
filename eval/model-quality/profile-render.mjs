import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGptProfile } from '../../dist/core/gpt-model-profiles.js';
import { renderTextToPngs, neutralizeSentinel, reflow } from '../../dist/core/render.js';
import { factSheetText } from '../../dist/core/factsheet.js';
import { visionTokensForModel, openAIImageDetail, historyFactSheet, prepareImagedRenderText } from '../../dist/core/openai.js';

export const sha256 = x => createHash('sha256').update(x).digest('hex');
export { resolveGptProfile };
export const textPart = text => ({ type: 'input_text', text });
export const imagePart = (png, detail) => ({ type: 'input_image', image_url: `data:image/png;base64,${Buffer.from(png).toString('base64')}`, detail });

// Do not let stale dist silently restore an older font/profile during a paid run.
export function assertBuildFresh() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
  for (const name of readdirSync(join(root, 'src/core')).filter(n => n.endsWith('.ts'))) {
    const source = join(root, 'src/core', name);
    const output = join(root, 'dist/core', name.replace(/\.ts$/, '.js'));
    if (statSync(source).mtimeMs > statSync(output).mtimeMs) throw new Error(`Stale build: ${name}; run node scripts/build.mjs first`);
  }
}

// Same registry as normal requests, INCLUDING env overrides and unknown fallback.
// No eval font/cols/height/AA/factsheet override arguments are accepted.
export function profileRecipe(model, purpose = 'content') {
  if (!model) throw new Error('An explicit model is required for a quality eval');
  if (!['content', 'history'].includes(purpose)) throw new Error('Unknown rendering purpose');
  const profile = resolveGptProfile(model);
  const history = purpose === 'history';
  return {
    profile,
    cols: history ? profile.historyStripCols ?? profile.stripCols : profile.stripCols,
    style: history ? profile.historyStyle ?? profile.style : profile.style,
    maxHeightPx: profile.maxHeightPx,
    // Runtime default is true; a profile may explicitly turn history reflow off.
    reflow: history ? profile.history.reflow ?? true : true,
    factSheetFormat: profile.factSheetFormat ?? 'full',
    purpose,
  };
}

export async function renderProfileFixture(source, model, purpose = 'content') {
  const recipe = profileRecipe(model, purpose);
  const safe = neutralizeSentinel(source);
  const renderedSource = purpose === 'content' ? prepareImagedRenderText(source, recipe.reflow)
    : recipe.reflow ? reflow(safe) ?? safe : safe;
  const images = await renderTextToPngs(renderedSource, recipe.cols, recipe.style, recipe.maxHeightPx);
  // Exact same image-detail decision as OpenAI's normal outbound image blocks.
  const detail = openAIImageDetail(model);
  const sheet = purpose === 'history' ? historyFactSheet(source, recipe.profile)
    : factSheetText(source, recipe.factSheetFormat);
  return {
    parts: [...images.map(im => imagePart(im.png, detail)), ...(sheet ? [textPart(sheet)] : [])],
    imageTokens: images.reduce((n, im) => n + visionTokensForModel(model, im.width, im.height), 0),
    provenance: {
      recipe, profileHash: sha256(JSON.stringify(recipe.profile)), sourceHash: sha256(source),
      renderedSourceHash: sha256(renderedSource), factsheetHash: sha256(sheet),
      factsheetChars: sheet.length, detail,
      images: images.map(im => ({ width: im.width, height: im.height, sha256: sha256(im.png) })),
    },
  };
}
