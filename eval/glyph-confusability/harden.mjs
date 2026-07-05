/**
 * Lever C3 prototype: apply minimal, hand-designed pixel patches to the 5
 * highest-risk digit/letter glyphs (identified by analyze.mjs) and re-run the
 * SAME offline confusability screen against the FULL ASCII alphabet — not just
 * the target pairs — to check for (a) improved separation on the fixed pairs
 * and (b) no NEW collisions introduced elsewhere.
 *
 * Design rule: patch only ONE member of each confusable pair, leaving its
 * counterpart (O, S, Z, 6, 8) byte-identical to production, so nothing else
 * in the alphabet that already reads correctly can regress.
 *
 * This is a proxy screen (pixel/cosine distance after a blur), not ground
 * truth — it exists to decide whether a real bitmap-font edit + scored eval is
 * worth doing at all, and to focus that eval on the pairs that matter.
 */
import {
  ATLAS_PIXELS, ATLAS_OFFSETS, ATLAS_WIDE_FLAGS, ATLAS_CELL_W, ATLAS_CELL_H, atlasRank,
} from '../../src/core/atlas.js';

const W = ATLAS_CELL_W, H = ATLAS_CELL_H; // 5, 8 — production cell, unchanged

function decode(cp) {
  const rank = atlasRank(cp);
  if (rank < 0 || ATLAS_WIDE_FLAGS[rank] === 1) return null;
  const off = ATLAS_OFFSETS[rank];
  const px = new Float32Array(W * H);
  for (let gy = 0; gy < H; gy++)
    for (let gx = 0; gx < W; gx++) {
      const bit = off + gy * W + gx;
      px[gy * W + gx] = (ATLAS_PIXELS[bit >>> 3] >>> (7 - (bit & 7))) & 1;
    }
  return { w: W, h: H, px };
}

/**
 * row,col ink edits: 1 = force filled, 0 = force empty. Only these glyphs are
 * touched; every other codepoint in the alphabet is byte-identical to the
 * shipping atlas.
 *
 * VALIDATED (kept) — '2' and '5': each broke an ACCIDENTAL pixel-for-pixel
 * overlap with its confusable partner (2/Z were bit-identical at row 5; 5/S
 * at row 2) by adding a single new pixel at a position the partner does not
 * share. Full-alphabet rescan: target pair improved, zero new worst-24 entrants.
 *
 * REVERTED (do not ship) — '0', 'B', 'G': the initial attempt "bolded" the
 * glyph (wider bars, bigger center dot) to differentiate it from its partner.
 * That is the WRONG technique at 5x8 + blur + cosine-distance: adding ink
 * pushes a glyph toward a generic dense-blob shape that OTHER bold capitals
 * also blur into, so it drifts closer to unrelated letters even as the one
 * targeted pair moves. Measured: 'B' (wider bars) made 8~B worse (-0.0026)
 * and crashed B~O to 0.0196 (deep new worst-24 entrant) while drifting
 * closer to ~20 unrelated letters (H, K, N, M, O, G, ...). '0' (bigger dot)
 * improved 0~O only slightly (+0.0043) while creating two new worst-24
 * collisions (0~8, 0~9) — net negative. 'G' (bigger dot) barely moved 6~G
 * and caused the same broad convergence as B.
 *
 * Lesson for any future glyph-hardening attempt: de-collide by RELOCATING or
 * REMOVING a pixel the partner shares (see '2'/'5'), never by adding mass.
 */
const PATCHES = {
  0x35: { name: '5', edits: [[2, 1, 1]] },                 // #.... -> ##...  (flag serif vs S)
  0x32: { name: '2', edits: [[5, 1, 1]] },                 // #.... -> ##...  (breaks shared px w/ Z)
};

function applyPatch(glyph, edits) {
  const px = new Float32Array(glyph.px); // copy — never mutate the decoded original
  for (const [row, col, val] of edits) px[row * W + col] = val;
  return { w: W, h: H, px };
}

function blur({ w, h, px }) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
          s += px[yy * w + xx]; n++;
        }
      out[y * w + x] = s / n;
    }
  return out;
}
function cosDist(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return null;
  return 1 - dot / Math.sqrt(na * nb);
}
const disp = (cp) => (cp === 0x20 ? '␠' : String.fromCodePoint(cp));

/** Build the blurred set for the FULL printable-ASCII alphabet, with the 5
 *  patches applied where relevant — every other glyph is the real atlas bitmap. */
function buildAlphabet(patched) {
  const m = new Map();
  for (let cp = 0x21; cp <= 0x7e; cp++) {
    const raw = decode(cp);
    if (!raw) continue;
    const g = patched && PATCHES[cp] ? applyPatch(raw, PATCHES[cp].edits) : raw;
    let ink = 0; for (const v of g.px) ink += v;
    if (ink < 1e-6) continue;
    m.set(cp, blur(g));
  }
  return m;
}
function allPairs(blurred) {
  const cps = [...blurred.keys()], pairs = [];
  for (let i = 0; i < cps.length; i++)
    for (let j = i + 1; j < cps.length; j++) {
      const d = cosDist(blurred.get(cps[i]), blurred.get(cps[j]));
      if (d != null) pairs.push([cps[i], cps[j], d]);
    }
  pairs.sort((a, b) => a[2] - b[2]);
  return pairs;
}

const before = buildAlphabet(false);
const after = buildAlphabet(true);
const pairsBefore = allPairs(before);
const pairsAfter = allPairs(after);

console.log(`\n=== LEVER C3 — hardened-glyph rescan (${Object.keys(PATCHES).length} glyphs patched, full ${before.size}-glyph alphabet) ===\n`);

// 1. Target pairs: did they actually improve? Only the validated de-collision
// patches ('2','5') are applied above; '0'/'B'/'G' are listed for reference —
// they are UNPATCHED (reverted), so their delta should read ~0 here.
const TARGETS = [['5', 'S'], ['2', 'Z'], ['0', 'O'], ['8', 'B'], ['6', 'G']];
console.log('--- target pairs: before -> after (only 5/S, 2/Z are patched; 0/O, 8/B, 6/G are reference/reverted) ---');
for (const [a, b] of TARGETS) {
  const cpa = a.codePointAt(0), cpb = b.codePointAt(0);
  const d0 = cosDist(before.get(cpa), before.get(cpb));
  const d1 = cosDist(after.get(cpa), after.get(cpb));
  const delta = d1 - d0;
  console.log(
    `  '${a}'~'${b}'  ${d0.toFixed(4)} -> ${d1.toFixed(4)}   Δ=${delta >= 0 ? '+' : ''}${delta.toFixed(4)}  ${delta > 0 ? 'IMPROVED' : delta < 0 ? 'WORSE' : '='}`,
  );
}

// 2. Global regression check: for each patched glyph, did its distance to any
//    OTHER (unrelated) glyph get worse enough to create a NEW top-24 collision?
const top24Before = new Set(pairsBefore.slice(0, 24).map(([a, b]) => `${a},${b}`));
const top24After = pairsAfter.slice(0, 24);
console.log('\n--- full-alphabet worst-24 pairs AFTER patch (flag any NOT in the original worst-24) ---');
let newEntrants = 0;
for (const [a, b, d] of top24After) {
  const key = `${a},${b}`;
  const isNew = !top24Before.has(key);
  const patchedHere = PATCHES[a] || PATCHES[b] ? ' (involves a patched glyph)' : '';
  if (isNew) newEntrants++;
  console.log(`  '${disp(a)}'~'${disp(b)}'  dist=${d.toFixed(4)}${patchedHere}${isNew ? '  <-- NEW to worst-24' : ''}`);
}
console.log(`\nNew entrants into the global worst-24 after patching: ${newEntrants}`);

// 3. Did any patched glyph get CLOSER to some third, previously-unrelated glyph?
console.log('\n--- did a patched glyph move closer to any OTHER (non-target) glyph? ---');
let regressions = 0;
for (const cpStr of Object.keys(PATCHES)) {
  const cp = Number(cpStr);
  const name = PATCHES[cp].name;
  for (const otherCp of before.keys()) {
    if (otherCp === cp) continue;
    // skip the intended target partner — that's the pair we WANT to change
    const targetPartner = TARGETS.find(([a, b]) => a === name || b === name);
    const partnerCp = targetPartner ? (targetPartner[0] === name ? targetPartner[1] : targetPartner[0]).codePointAt(0) : -1;
    if (otherCp === partnerCp) continue;
    const d0 = cosDist(before.get(cp), before.get(otherCp));
    const d1 = cosDist(after.get(cp), after.get(otherCp));
    if (d0 == null || d1 == null) continue;
    if (d1 < d0 - 0.01) { // more than trivial drift
      regressions++;
      console.log(`  '${name}' moved closer to '${disp(otherCp)}': ${d0.toFixed(4)} -> ${d1.toFixed(4)}`);
    }
  }
}
if (regressions === 0) console.log('  none — no patched glyph became more confusable with any unrelated glyph.');

console.log('\nNote: still a pixel-distance proxy, not model ground truth. Decides whether a');
console.log('real font edit + scored run is worth doing; does not replace the scored run.\n');

// Sanity check: '*'~'m' is unpatched — confirm its pairwise distance is
// EXACTLY unchanged (any "new to worst-24" flag on it is a rank-boundary
// artifact from 2/5 vacating higher slots, not a real regression).
const dStar0 = cosDist(before.get(0x2a), before.get(0x6d));
const dStar1 = cosDist(after.get(0x2a), after.get(0x6d));
console.log(`\nsanity: '*'~'m' distance before=${dStar0.toFixed(6)} after=${dStar1.toFixed(6)} (must be identical)`);
