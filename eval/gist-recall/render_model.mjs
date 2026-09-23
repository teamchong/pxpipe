// Re-render the gist-recall corpus (work, work2, work3) at a specific model's
// production profile and write render.meta.json so run*.py's preflight guard
// can verify the corpus matches the model under test.
//
// Usage: MODEL=claude-opus-5-5 node render_model.mjs [work work2 work3]
//
// Uses renderForModel() from eval/lib/render-bridge.mjs, so the geometry is
// exactly what pxpipe ships for MODEL (resolveClaudeProfile -> stripCols,
// style, maxHeightPx). Old s*_p*.png pages are removed first so a shorter
// render cannot leave stale trailing pages behind.
import { renderForModel } from '../lib/render-bridge.mjs';
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.MODEL;
if (!MODEL) {
  console.error('usage: MODEL=<model> node render_model.mjs [workdir ...]');
  process.exit(2);
}
const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ['work', 'work2', 'work3'];

for (const d of dirs) {
  const dir = join(HERE, d);
  for (const f of readdirSync(dir)) {
    if (/^s\d+_p\d+\.png$/.test(f)) unlinkSync(join(dir, f));
  }
  const sessions = readdirSync(dir).filter((f) => /^s\d+\.txt$/.test(f)).sort();
  let pages = 0, tok = 0, profile = null, width = null;
  for (const f of sessions) {
    const sid = f.replace(/\.txt$/, '');
    const text = readFileSync(join(dir, f), 'utf8');
    const { pages: imgs, profile: prof, stats } = await renderForModel(text, MODEL);
    profile ??= prof;
    width ??= stats[0]?.width ?? null;
    imgs.forEach((im, i) => writeFileSync(join(dir, `${sid}_p${i}.png`), im.png));
    pages += imgs.length;
    tok += stats.reduce((a, s) => a + s.visualTokens, 0);
  }
  const meta = {
    model: MODEL,
    font: profile.style?.font ?? null,
    stripCols: profile.stripCols,
    maxHeightPx: profile.maxHeightPx,
    pageWidthPx: width,
    pages,
    reflow: true,
    renderedAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, 'render.meta.json'), JSON.stringify(meta, null, 2) + '\n');
  console.log(`${d}: ${sessions.length} sessions -> ${pages} pages, ~${tok} visual tokens, ` +
    `font=${meta.font} cols=${meta.stripCols} width=${meta.pageWidthPx}px`);
}
