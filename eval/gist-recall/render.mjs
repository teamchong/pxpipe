// Render each session txt to PNGs at the proxy's production density.
import { renderTextToPngsWithCharLimit, DENSE_CONTENT_COLS, DENSE_CONTENT_CHARS_PER_IMAGE, DENSE_RENDER_STYLE } from '../../dist/core/render.js';
import { readFileSync, writeFileSync } from 'node:fs';
let tok = 0, pages = 0;
for (let s = 0; s < 10; s++) {
  const text = readFileSync(`work2/s${s}.txt`, 'utf8');
  const imgs = await renderTextToPngsWithCharLimit(text, DENSE_CONTENT_COLS, DENSE_CONTENT_CHARS_PER_IMAGE, DENSE_RENDER_STYLE);
  imgs.forEach((im, i) => writeFileSync(`work2/s${s}_p${i}.png`, im.png));
  pages += imgs.length;
  tok += imgs.reduce((a, im) => a + Math.round(im.width * im.height / 750), 0);
}
console.log(`rendered ${pages} pages, ~${tok} img tokens total (vs ~${Math.round(10*15900/4)} text tokens)`);
