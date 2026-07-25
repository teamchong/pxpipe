// gen-packed.mjs -- packed-layout fixture generator.
//
// WHY THIS EXISTS
// Measured: log records are <=110 cols but the dense canvas is 312 cols, so
// ~65% of every page's width is blank (task #14). Cell pitch is pinned at 5x8
// by the goal constraint and by gen-fixtures.mjs's guard, so the dead width
// CANNOT be spent on bigger/looser glyphs. The only constraint-respecting way
// to use it is to pack more records per row.
//
// This is simultaneously a cost fix and a diagnostic:
//   - cost:       PACK=2 puts 2 records per row => same corpus in 3 pages
//                 instead of 5 => ~40% fewer image tokens, identical per-image
//                 dimensions (the expectW/expectH guards below prove it).
//   - diagnostic: packing makes records ABUT horizontally, maximising crowding.
//                 The control's failures are dominated by WRONG_VALUE (model
//                 finds a record, misreads its digits). If those misreads are
//                 crowding-driven, packing makes recall worse. If they are
//                 confabulation, packing is free. Either result is decisive.
//
// Geometry is deliberately UNCHANGED from production (5x8 pitch, 1568x728),
// so this variant differs from the control in layout only.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  renderTextToPngs,
  renderCellWidth,
  renderCellHeight,
  DENSE_RENDER_STYLE,
  DENSE_CONTENT_COLS,
} from '../../dist/core/render.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const OUT     = join(HERE, arg('out', 'variants/pack2'));
const SEED    = Number(arg('seed', 1));
const PAGES   = Number(arg('pages', 5));     // baseline page count -> corpus size
const NEEDLES = Number(arg('needles', 3));   // baseline needles/page -> total needles
const PACK    = Number(arg('pack', 2));      // records per row
const GUTTER  = Number(arg('gutter', 3));    // blank cols between packed records

const ROWS = 90;

// Corpus and needle count are held EQUAL to the control so the arms are
// comparable: same records, same 15 probes, only the layout differs.
const TOTAL_RECORDS = PAGES * (ROWS - 1);
const TOTAL_NEEDLES = PAGES * NEEDLES;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = rng(SEED);
const hex12 = () => Array.from({ length: 12 }, () => '0123456789abcdef'[(rand() * 16) | 0]).join('');

const usedIds = new Set();
const usedDurs = new Set();

function uniqueId() {
  for (;;) {
    const h = hex12();
    if (!usedIds.has(h)) { usedIds.add(h); return h; }
  }
}
function uniqueDur() {
  for (;;) {
    const d = 100 + ((rand() * 9900) | 0);
    if (!usedDurs.has(d)) { usedDurs.add(d); return d; }
  }
}

const style = { ...DENSE_RENDER_STYLE };
const cellW = renderCellWidth(style);
const cellH = renderCellHeight(style);
const expectW = DENSE_CONTENT_COLS * cellW + 8;
const expectH = ROWS * cellH + 8;

// Needles are chosen over the FLAT record list, never adjacent, so no needle is
// locatable by position and no two land side-by-side in the same packed row.
const needleIdx = new Set();
while (needleIdx.size < TOTAL_NEEDLES) {
  const i = (rand() * TOTAL_RECORDS) | 0;
  if (![...needleIdx].some(x => Math.abs(x - i) < 3)) needleIdx.add(i);
}

// Build every record first, then lay them out. Records are padded to a common
// width so packed columns align; ragged columns would be a legibility
// confound rather than a pure density change.
const records = [];
for (let i = 0; i < TOTAL_RECORDS; i++) {
  const id = uniqueId();
  const dur = uniqueDur();
  const isNeedle = needleIdx.has(i);
  const mm = ((i / 60) | 0) % 60;
  const ss = i % 60;
  const path = isNeedle ? '/api/v1/sync' : `/api/v1/filler_${i}`;
  records.push({
    isNeedle, id, dur,
    text:
      `{"timestamp":"2026-07-21T12:${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}Z",` +
      `"id":"${id}","dur_ms":${dur},"status":200,"path":"${path}"}`,
  });
}

const RECW = Math.max(...records.map(r => r.text.length));
const rowWidth = RECW * PACK + GUTTER * (PACK - 1);
if (rowWidth > DENSE_CONTENT_COLS) {
  throw new Error(`packed row is ${rowWidth} cols, exceeds ${DENSE_CONTENT_COLS} -- lower --pack`);
}

// Chunk records into rows of PACK, then rows into pages.
const rows = [];
for (let i = 0; i < records.length; i += PACK) {
  const group = records.slice(i, i + PACK);
  rows.push({
    text: group.map(r => r.text.padEnd(RECW, ' ')).join(' '.repeat(GUTTER)).trimEnd(),
    members: group,
  });
}

const ROWS_PER_PAGE = ROWS - 1;
const OUT_PAGES = Math.ceil(rows.length / ROWS_PER_PAGE);

const golds = [];
const manifest = [];

for (let page = 0; page < OUT_PAGES; page++) {
  const pageRows = rows.slice(page * ROWS_PER_PAGE, (page + 1) * ROWS_PER_PAGE);
  const lines = [`BEGIN EVENT LOG TRACE - SYSTEM SESSION p${page} seed${SEED}`];
  const needleRows = [];

  pageRows.forEach((row, r) => {
    lines.push(row.text);
    for (const m of row.members) {
      if (m.isNeedle) {
        golds.push({ page, dur: m.dur, gold: m.id });
        needleRows.push(r + 1);
      }
    }
  });

  const text = lines.join('\n');
  const imgs = await renderTextToPngs(text, DENSE_CONTENT_COLS, style, 1568);

  // Same loud guards as the production generator. These are what make the
  // "token-neutral per page" claim a proof rather than an assumption.
  if (imgs.length !== 1) {
    throw new Error(`page ${page}: expected exactly 1 image, got ${imgs.length}`);
  }
  const { width, height, png, droppedChars } = imgs[0];
  if (cellW !== 5 || cellH !== 8) {
    throw new Error(`cell pitch is ${cellW}x${cellH}, expected 5x8`);
  }
  // Width must always match production. Height must match this page's actual
  // row count exactly; only the final page may be short (a partially filled
  // tail), and a short tail bills FEWER tokens, so it is never a hidden cost.
  const expectPageH = (pageRows.length + 1) * cellH + 8;
  if (width !== expectW) {
    throw new Error(`page ${page}: width ${width}, expected ${expectW}`);
  }
  if (height !== expectPageH) {
    throw new Error(`page ${page}: height ${height}, expected ${expectPageH} for ${pageRows.length + 1} rows`);
  }
  if (page !== OUT_PAGES - 1 && height !== expectH) {
    throw new Error(`page ${page}: non-final page is ${height}px, expected full ${expectH}`);
  }
  if (droppedChars !== 0) {
    throw new Error(`page ${page}: ${droppedChars} chars dropped from atlas`);
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `page${page}.png`), png);
  writeFileSync(join(OUT, `page${page}.txt`), text + '\n');
  manifest.push({ page, width, height, rows: pageRows.length + 1, needleRows });
}

if (golds.length !== TOTAL_NEEDLES) {
  throw new Error(`gold count ${golds.length}, expected ${TOTAL_NEEDLES}`);
}

writeFileSync(join(OUT, 'golds.json'), JSON.stringify(golds, null, 2) + '\n');
writeFileSync(
  join(OUT, 'provenance.json'),
  JSON.stringify({
    generatedBy: 'eval/verbatim-15/gen-packed.mjs',
    seed: SEED, pack: PACK, gutter: GUTTER,
    recordWidth: RECW, rowWidth,
    corpusRecords: TOTAL_RECORDS,
    baselinePages: PAGES, packedPages: OUT_PAGES,
    rows: ROWS, cols: DENSE_CONTENT_COLS, cellW, cellH,
    imageDims: `${expectW}x${expectH}`,
    style,
    note: 'Layout-only variant of gen-fixtures.mjs. Same corpus size, same needle count, same page geometry; records packed PACK-per-row.',
    manifest,
  }, null, 2) + '\n'
);

const util = ((rowWidth / DENSE_CONTENT_COLS) * 100).toFixed(1);
console.log(`cell pitch  : ${cellW}x${cellH}`);
console.log(`page dims   : ${expectW}x${expectH}`);
console.log(`record width: ${RECW}  packed ${PACK}/row -> ${rowWidth} of ${DENSE_CONTENT_COLS} cols (${util}% used)`);
// Image tokens scale with pixel area, and every page here is the same width, so
// summed height is the honest cost unit -- a half-filled tail page must not be
// billed as a whole one.
const packedPx = manifest.reduce((s, m) => s + m.height, 0);
const basePx = PAGES * expectH;
console.log(`pages       : ${OUT_PAGES}  (baseline ${PAGES})`);
console.log(`image cost  : ${packedPx}px vs ${basePx}px tall -> ${(100 - (packedPx / basePx) * 100).toFixed(1)}% fewer image tokens`);
console.log(`trials      : ${golds.length}`);
console.log(`unique ids  : ${usedIds.size}   unique durs: ${usedDurs.size}`);
console.log(`written to  : ${OUT}`);
