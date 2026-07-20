/**
 * Demo A — the K/H glyph fix, before vs after.
 * BEFORE = rasterized straight from the stock Spleen font file (unchanged in assets/).
 * AFTER  = decoded out of the shipped atlas.ts (which now carries the surgery).
 * Run:  npx tsx eval/glyph-matrix/demo-glyph.mts
 */
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { readFileSync } from 'node:fs';
import {
  atlasRank, ATLAS_CELL_W, ATLAS_CELL_H, ATLAS_OFFSETS, ATLAS_PIXELS, ATLAS_WIDE_FLAGS,
} from '../../src/core/atlas.js';

const W = ATLAS_CELL_W, H = ATLAS_CELL_H;

GlobalFonts.register(readFileSync('assets/Spleen-5x8.otb'), 'SpleenDemo');
function fromFont(ch: string): number[] {
  const c = createCanvas(W, H), ctx = c.getContext('2d');
  ctx.font = `8px SpleenDemo`; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#fff'; ctx.fillText(ch, 0, 7);
  const img = ctx.getImageData(0, 0, W, H);
  return Array.from({ length: W * H }, (_, p) => (img.data[p * 4]! >= 128 ? 1 : 0));
}
function fromAtlas(ch: string): number[] {
  const rank = atlasRank(ch.codePointAt(0)!);
  const base = ATLAS_OFFSETS[rank]!;
  const w = ATLAS_WIDE_FLAGS[rank] ? 2 * W : W;
  return Array.from({ length: w * H }, (_, p) => {
    const bit = base + p;
    return (ATLAS_PIXELS[bit >>> 3]! >>> (7 - (bit & 7))) & 1;
  });
}
const ham = (a: number[], b: number[]) => a.reduce((d, v, i) => d + (v !== b[i] ? 1 : 0), 0);
function render(bits: number[], w = W): string[] {
  return Array.from({ length: H }, (_, y) =>
    Array.from({ length: w }, (_, x) => (bits[y * w + x] ? '#' : '.')).join(''));
}
function sideBySide(title: string, pairs: Array<[string, number[]]>) {
  console.log(`\n${title}`);
  console.log(pairs.map(([n]) => n.padEnd(W + 3)).join(''));
  const rows = pairs.map(([, b]) => render(b));
  for (let y = 0; y < H; y++) console.log(rows.map((r) => r[y]!.padEnd(W + 3)).join(''));
}

const beforeK = fromFont('K'), beforeH = fromFont('H');
const afterK = fromAtlas('K'), afterH = fromAtlas('H');

sideBySide('BEFORE (stock Spleen font)', [['H', beforeH], ['K', beforeK]]);
console.log(`  → Hamming(H,K) = ${ham(beforeH, beforeK)}   ${ham(beforeH, beforeK) <= 1 ? '⚠️  indistinguishable after downscaling' : ''}`);

sideBySide('AFTER (shipped atlas.ts)', [['H', afterH], ['K', afterK]]);
console.log(`  → Hamming(H,K) = ${ham(afterH, afterK)}   ✅ unmistakable`);

// Nearest neighbour of the new K across all printable ASCII.
let worst = { ch: '', d: Infinity };
for (let cp = 0x21; cp <= 0x7e; cp++) {
  const ch = String.fromCharCode(cp);
  if (ch === 'K') continue;
  const d = ham(afterK, fromAtlas(ch));
  if (d < worst.d) worst = { ch, d };
}
console.log(`\nNew K's closest neighbour across ASCII: '${worst.ch}' at Hamming ${worst.d} (safe if ≥ 2)`);
