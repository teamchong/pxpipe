import { renderTextToPngsWithCharLimit, DENSE_CONTENT_COLS, DENSE_CONTENT_CHARS_PER_IMAGE, DENSE_RENDER_STYLE } from '../../dist/core/render.js';
import { readFileSync, writeFileSync } from 'node:fs';
let pages=0;
for (let s=0; s<6; s++){
  const t=readFileSync(`work3/s${s}.txt`,'utf8');
  const imgs=await renderTextToPngsWithCharLimit(t, DENSE_CONTENT_COLS, DENSE_CONTENT_CHARS_PER_IMAGE, DENSE_RENDER_STYLE);
  imgs.forEach((im,i)=>writeFileSync(`work3/s${s}_p${i}.png`, im.png)); pages+=imgs.length;
}
console.log('pages', pages);
