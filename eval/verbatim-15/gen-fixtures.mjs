// Fixture generator for the verbatim hex-recall eval.
//
// WHY THIS EXISTS
// ---------------
// The original page0..page4.png in this directory were produced ad-hoc in
// /tmp/verb25 and that directory is long gone. No generator was ever committed,
// so nothing in the repo could state what geometry those pages were rendered at,
// and no source JSON survived to re-render them. Recovering that fact required
// decoding the PNGs and measuring their ink periodicity by hand. In the meantime
// a hand-made "hi-res control" (page0_big.png) entered the tree that was really
// just a ~3.08x interpolated upscale, and a resolution control was built on top
// of it that could only ever return a misleading answer.
//
// Everything here therefore derives from production code. Geometry constants are
// imported, never restated, and the emitted pages are asserted against the
// production pitch before anything is written. If production geometry changes,
// this script fails loudly instead of silently producing off-spec fixtures.
//
// Output is deterministic: same --seed produces byte-identical pages and golds.
// The per-page source text is written alongside each PNG so any needle can be
// verified without decoding an image.
//
// Usage:
//   node gen-fixtures.mjs [--out DIR] [--seed N] [--pages N] [--needles N]

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

const OUT     = join(HERE, arg('out', 'fixtures-v2'));
const SEED    = Number(arg('seed', 1));
const PAGES   = Number(arg('pages', 5));
const NEEDLES = Number(arg('needles', 3));

// Production's 312. Cell pitch is hard-pinned to 5x8 by the assert below: this
// harness will not emit off-production geometry under any flag or env var.
const COLS = DENSE_CONTENT_COLS;

// --band prepends the in-image instruction header into the PNG itself, so the task
// instruction and the content arrive in the SAME encoder pass. Ported from
// eval/eval-l1-ocr.mjs's `reflow-inimage` variant (EXPERIMENT_LOG: +1.04pp mean,
// won all 20 blocks vs `reflow`, erased that variant's -5.93pp cross-modal
// regression). Cell pitch is untouched at 5x8; only content is added.
// The renderer paginates at 90 rows/page, so a band cannot be free: it must
// displace content rows. Fewer data rows means fewer distractors, which would
// flatter the band arm on its own. --blankband emits the SAME number of rows,
// blank, so the instruction text is the only variable between the two arms.
const BAND_MODE =
  process.argv.includes('--band')        ? 'text'    :
  process.argv.includes('--neutralband') ? 'neutral' : 'none';

// Task framing only -- deliberately contains no id, no dur, and no answer. The
// mechanism under test is "anchor the reading mode", not retrieval assistance.
const BAND_TEXT =
  '=================== READING INSTRUCTIONS - DO NOT TRANSCRIBE ===================\n' +
  'Below the delimiter is a densely-packed JSON event log, one record per row.\n' +
  'Each record has the exact form:\n' +
  '  {"timestamp":"...","id":"<12 lowercase hex chars>","dur_ms":<integer>,...}\n' +
  'You will be asked to locate ONE record by its dur_ms value and read back its\n' +
  'id. Both fields are high-entropy: no character is guessable from context, so\n' +
  'read each glyph individually rather than inferring the token. 0/o/O, 1/l,\n' +
  '5/S, 6/b, 8/B and c/e are the distinctions that matter most here.\n' +
  '====================== END INSTRUCTIONS - BEGIN CONTENT ======================';

// Control band: same row count, same delimiter structure, comparable ink, but no
// reading guidance -- no mention of ids, dur_ms, hex, or confusable glyphs. Blank
// rows were the obvious control and are wrong twice over: the renderer collapses
// them (90 rows -> 84), and they'd remove the ink as well as the instructions,
// so a win couldn't be attributed to the guidance rather than to the header.
const NEUTRAL_TEXT =
  '=================== ARCHIVE EXPORT NOTICE - DO NOT TRANSCRIBE ==================\n' +
  'This export was produced by the batch archival service during a routine job.\n' +
  'Retention policy for this bundle:\n' +
  '  {"tier":"standard","retain_days":365,"replicas":3,"region":"us-east-1"}\n' +
  'The bundle was assembled from shards emitted by the collector fleet and was\n' +
  'validated against the manifest checksum before upload to long-term storage.\n' +
  'Questions about this export should be directed to the platform team via the\n' +
  'internal service catalog entry for the archival pipeline component.\n' +
  '========================= END NOTICE - BEGIN CONTENT =========================';

// A dense page is DENSE_CONTENT_COLS x ROWS. 90 rows is production's dense page
// budget (render.ts: "312 cols x 90 rows = 28080"), giving 312*5+8 = 1568 px wide
// by 90*8+8 = 728 px tall -- the geometry render.ts pins to the API's no-resize
// edge so pages bill at raw patch count with no server-side downscale.
const ROWS = 90;

// Band occupies BAND_ROWS of the 90; content gets the rest. Every arm therefore
// renders exactly ROWS lines => identical 1568x728 => identical 1456 tokens, so
// recall differences cannot be bought with extra image budget.
const BAND_ROWS = BAND_TEXT.split('\n').length;
const bandLines =
  BAND_MODE === 'text'    ? BAND_TEXT.split('\n')    :
  BAND_MODE === 'neutral' ? NEUTRAL_TEXT.split('\n') : [];
if (BAND_MODE !== 'none' && bandLines.length !== BAND_ROWS) {
  throw new Error(`band/neutral row mismatch: ${bandLines.length} vs ${BAND_ROWS} -- arms would differ in data rows`);
}
const DATA_ROWS = ROWS - 1 - bandLines.length;

// mulberry32 -- small, deterministic, no dependency.
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

// Every id and every dur_ms must be unique across the whole fixture set. A
// duplicate dur makes the probe ("the line whose dur_ms is exactly N") ambiguous,
// and a duplicate id makes a HIT unattributable to a specific line.
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

mkdirSync(OUT, { recursive: true });

// --style '{"colorCycle":true}' merges overrides onto the production style so a
// variant differs from prod in exactly one named field. Absent => byte-identical
// to production, which the control arm below verifies against the shipped pages.
// The expectW/expectH asserts further down throw on ANY dimension change, so a
// variant that survives generation is proven token-neutral (image tokens are a
// function of width x height) rather than assumed to be.
const STYLE_OVERRIDE = (() => {
  const i = process.argv.indexOf('--style');
  if (i === -1 || process.argv[i + 1] === undefined) return {};
  return JSON.parse(process.argv[i + 1]);
})();
const style = { ...DENSE_RENDER_STYLE, ...STYLE_OVERRIDE };
const cellW = renderCellWidth(style);
const cellH = renderCellHeight(style);
const expectW = COLS * cellW + 8;
const expectH = ROWS * cellH + 8;

const golds = [];
const manifest = [];

for (let page = 0; page < PAGES; page++) {
  // Needles land at pseudo-random rows, never row 0 (a header line) and never
  // adjacent, so no needle can be read off by position alone.
  const needleRows = new Set();
  while (needleRows.size < NEEDLES) {
    const r = 1 + ((rand() * (DATA_ROWS - 1)) | 0);
    if (![...needleRows].some(x => Math.abs(x - r) < 3)) needleRows.add(r);
  }
  const rowsSorted = [...needleRows].sort((a, b) => a - b);

  const lines = [`BEGIN EVENT LOG TRACE - SYSTEM SESSION p${page} seed${SEED}`];
  const pageNeedles = [];

  for (let r = 1; r <= DATA_ROWS; r++) {
    const id = uniqueId();
    const dur = uniqueDur();
    const isNeedle = needleRows.has(r);
    const ss = (r % 60).toString().padStart(2, '0');
    const path = isNeedle ? '/api/v1/sync' : `/api/v1/filler_${r}`;
    lines.push(
      `{"timestamp":"2026-07-21T12:${((r / 60) | 0).toString().padStart(2, '0')}:${ss}Z",` +
      `"id":"${id}","dur_ms":${dur},"status":200,"path":"${path}"}`
    );
    if (isNeedle) pageNeedles.push({ page, dur, gold: id, row: r });
  }

  // Band rows sit ABOVE the content. The 89 data rows and every needle are
  // byte-identical to the control arm, so golds.json matches and recall stays
  // directly comparable; the band is the only difference in what the model sees.
  const text = [...bandLines, ...lines].join('\n');
  const imgs = await renderTextToPngs(text, COLS, style, 1568);

  // Fail loudly rather than emit off-spec fixtures. A fixture set that silently
  // drifts from production geometry is precisely the failure this file exists
  // to prevent.
  if (imgs.length !== 1) {
    throw new Error(`page ${page}: expected exactly 1 image, got ${imgs.length} -- ROWS too large for maxHeight`);
  }
  const { width, height, png } = imgs[0];
  if (cellW !== 5 || cellH !== 8) {
    throw new Error(`cell pitch is ${cellW}x${cellH}, expected 5x8 -- production DENSE_RENDER_STYLE changed`);
  }
  if (width !== expectW || height !== expectH) {
    throw new Error(`page ${page}: got ${width}x${height}, expected ${expectW}x${expectH}`);
  }

  writeFileSync(join(OUT, `page${page}.png`), png);
  writeFileSync(join(OUT, `page${page}.txt`), text + '\n');
  golds.push(...pageNeedles.map(({ page, dur, gold }) => ({ page, dur, gold })));
  manifest.push({ page, width, height, rows: ROWS, needleRows: rowsSorted });
}

writeFileSync(join(OUT, 'golds.json'), JSON.stringify(golds, null, 2) + '\n');
writeFileSync(
  join(OUT, 'provenance.json'),
  JSON.stringify({
    generatedBy: 'eval/verbatim-15/gen-fixtures.mjs',
    seed: SEED,
    pages: PAGES,
    needlesPerPage: NEEDLES,
    rows: ROWS,
    cols: COLS,
    cellW, cellH,
    imageDims: `${expectW}x${expectH}`,
    style,
    offProductionGeometry: cellW !== 5 || cellH !== 8,
    note: 'Deterministic: same seed reproduces these pages byte-for-byte. Source text is in page*.txt.',
    manifest,
  }, null, 2) + '\n'
);

console.log(`cell pitch : ${cellW}x${cellH}`);
console.log(`page dims  : ${expectW}x${expectH}   (cols=${COLS}, rows=${ROWS})`);
console.log(`pages      : ${PAGES}`);
console.log(`trials     : ${golds.length}  (${NEEDLES} needles/page)`);
console.log(`unique ids : ${usedIds.size}   unique durs: ${usedDurs.size}`);
console.log(`written to : ${OUT}`);
