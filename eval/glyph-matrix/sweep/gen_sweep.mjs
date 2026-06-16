// Root-cause sweep: SAME content rendered at increasing glyph-cell sizes.
// Isolates ONE variable — pixels-per-glyph (cell size) — from density/search.
// Short lines so every cell size fits one <=1568px page. Same content across
// sizes => only resolution changes. Reader accuracy vs cell size = the curve.
import { renderTextToPngs } from '/Users/steven_chong/Downloads/repos/pixelpipe/dist/core/render.js';
import { writeFileSync, mkdirSync } from 'node:fs';
const OUT = '/tmp/sweep'; mkdirSync(OUT, { recursive: true });

const PAGES = 4;
// (cellWBonus, cellHBonus) -> cell = (5+wb) x (8+hb). prod is (0,0)=5x8.
const SIZES = [
  ['s0', 0, 0],   // 5x8   prod
  ['s1', 2, 2],   // 7x10
  ['s2', 5, 8],   // 10x16  (2x linear)
  ['s3', 9, 14],  // 14x22  (~2.8x)
  ['s4', 15, 24], // 20x32  (4x)
];

function mulberry32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const rnd = mulberry32(20260616);
const hex = (n)=>Array.from({length:n},()=>'0123456789abcdef'[(rnd()*16)|0]).join('');
const ri = (lo,hi)=>lo+Math.floor(rnd()*(hi-lo+1));

// short line (~45 chars) so large cells still fit one page
function line(label){
  const id = hex(12);
  const rec = label ? {label, id, dur: ri(100,9999)} : {lvl:['info','warn','dbg'][ri(0,2)], id, dur: ri(100,9999)};
  return { text: JSON.stringify(rec), id };
}

const golds = {}; SIZES.forEach(([k])=>golds[k]=[]);
const pageTexts = [];
for (let p=0; p<PAGES; p++){
  const pos = new Set(); while(pos.size<5) pos.add(ri(0,7));
  const labelAt=[...pos]; const labels=['A','B','C','D','E']; const gold={}; const rows=[];
  for (let r=0; r<8; r++){
    const idx=labelAt.indexOf(r);
    if(idx>=0){ const {text,id}=line(labels[idx]); gold[labels[idx]]=id; rows.push(text);}
    else rows.push(line(null).text);
  }
  pageTexts.push(rows.join('\n'));
  SIZES.forEach(([k])=>golds[k].push(gold)); // identical content across sizes
}

for (const [k, wb, hb] of SIZES){
  for (let p=0; p<PAGES; p++){
    // cols=72: even the 20px cell -> 72*20=1440px < 1568, so NO downscale.
    // Lines are ~45 chars so they fit one row at every size. Glyph px now
    // genuinely varies at the encoder (the whole point).
    const pngs = await renderTextToPngs(pageTexts[p], 72, {aa:true, cellWBonus:wb, cellHBonus:hb});
    if (pngs.length!==1) console.error(`WARN ${k}_${p}: ${pngs.length} pages`);
    writeFileSync(`${OUT}/${k}_${p}.png`, pngs[0].png);
    if (p===0) console.log(`${k} cell=${5+wb}x${8+hb}px  page0=${pngs[0].width}x${pngs[0].height}px  img_tokens~${Math.round(pngs[0].width*pngs[0].height/750)}`);
  }
}
writeFileSync(`${OUT}/golds.json`, JSON.stringify(golds));
console.log(`done: ${SIZES.length} sizes x ${PAGES} pages`);
