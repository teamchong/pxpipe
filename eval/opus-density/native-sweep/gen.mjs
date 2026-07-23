// Native-only density sweep for Opus, "like Sol": genuine JB Mono atlas glyphs,
// NO cell padding (Sol's native rule). Only two shippable native rungs exist:
//   jetbrains-mono-10  -> 6x11 cell  (denser, cheaper, harder)
//   jetbrains-mono-12  -> 8x13 cell  (bigger, costlier, clearer)
//
// Blind protocol: fresh crypto-random targets are written to truth.json and the
// prose lives in fixture.txt. This script prints ONLY the token/savings table +
// the questions + PNG paths -- never the targets or the session text. The reader
// (Opus) opens ONLY the PNGs, locks answers.json, THEN score.mjs reveals truth.
//
// Run: pnpm exec tsx eval/opus-density/native-sweep/gen.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { renderTextToImages } from '../../../src/core/library.js';
import { renderCellWidth, renderCellHeight } from '../../../src/core/render.js';

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(here, { recursive: true });

// Anthropic bills 28px patches; pages are un-downscaled so raw patch count = cost.
const patchTokens = (w, h) => Math.ceil(w / 28) * Math.ceil(h / 28);

// ---- fresh random target generators (I never choose the values) -------------
const R = (n) => randomBytes(n).toString('hex').slice(0, n);
const WORDS = ['ledger', 'shard', 'queue', 'render', 'atlas', 'token', 'commit',
  'stripe', 'glyph', 'patch', 'vision', 'cursor', 'buffer', 'stream', 'digest',
  'anchor', 'cache', 'probe', 'sweep', 'retune', 'baseline', 'profile'];
const w = () => WORDS[randomBytes(1)[0] % WORDS.length];
const d = (n) => Array.from({ length: n }, () => randomBytes(1)[0] % 10).join('');
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const B64 = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const b64 = (n) => Array.from({ length: n }, () => B64[randomBytes(1)[0] % B64.length]).join('');

const targets = [
  { key: 'hex12',  anchor: `trace=`,               value: R(12),
    q: `The 12-char hex id immediately after "trace=".` },
  { key: 'camel',  anchor: `export function `,      value: w() + cap(w()) + cap(w()),
    q: `The camelCase symbol name right after "export function " (before the "(").` },
  { key: 'path',   anchor: `wrote `,                value: `/Users/${w()}/repos/${w()}/src/core/${w()}${d(2)}.ts`,
    q: `The full file path right after "wrote " (ends in .ts).` },
  { key: 'semver', anchor: `pxpipe-proxy@`,         value: `${1 + randomBytes(1)[0] % 9}.${randomBytes(1)[0] % 40}.${randomBytes(1)[0] % 99}`,
    q: `The version string right after "pxpipe-proxy@".` },
  { key: 'bytes',  anchor: `flushed `,              value: d(11),
    q: `The integer immediately after "flushed " (before " bytes").` },
  { key: 'reqid',  anchor: `req_`,                  value: `${R(8)}-${R(4)}`,
    q: `The request id right after "req_" (form 8hex-4hex).` },
  { key: 'envvar', anchor: null,                    value: `${w().toUpperCase()}_${w().toUpperCase()}_${d(1)}`,
    q: `The UPPER_SNAKE_CASE env var name that appears just before "=1" on the export line.` },
  { key: 'sha',    anchor: `sha256:`,               value: b64(16),
    q: `The 16-char token right after "sha256:".` },
];

// ---- build a dense, realistic session log; scatter targets among filler -----
const filler = [
  `$ git log --oneline -12`,
  `  rebased onto origin/main, ${d(2)} files changed, no conflicts`,
  `  resolved ${w()} vs ${w()} drift, kept the ${w()} baseline`,
  `[render] paging ${d(2)} cols, cap 728px, no downscale on either tier`,
  `[tokens] est ${d(4)} text vs ${d(3)} image, gate holds at savings>0`,
  `$ pnpm exec tsx eval/${w()}/run.mjs   # dry-run, no key`,
  `  loaded ${d(2)} fixtures, ${d(1)} profiles, ${d(3)} probes`,
  `[warn] ${w()} cache miss, refetched ${w()} manifest from disk`,
  `  minifyForRender stripped ${d(3)} blank runs, reflow=true`,
  `$ node scripts/verify-${w()}.mjs --strict`,
  `  ok: ${w()} atlas checksum matches the committed ${w()} snapshot`,
  `[commit] ${w()}: retune ${w()} cell density, keep native glyphs`,
  `  reviewer asked for a paired old-profile arm before shipping`,
  `[note] confab guard: abstain beats a wrong verbatim read every time`,
];

const lines = [];
const anchorLine = {
  hex12:  (t) => `[net] upstream connect ${t.anchor}${t.value} latency=${d(2)}ms status=200`,
  camel:  (t) => `  ${t.anchor}${t.value}(input, opts) {   // hot path, do not inline`,
  path:   (t) => `[fs] wrote ${t.value}  (${d(4)} bytes, mode 0644)`,
  semver: (t) => `  installed pxpipe-proxy@${t.value} from the private registry`,
  bytes:  (t) => `[flush] flushed ${t.value} bytes to the ${w()} spool, fsync ok`,
  reqid:  (t) => `[api] retry req_${t.value} after 429, backoff ${d(3)}ms`,
  envvar: (t) => `  export ${t.value}=1   # enable the ${w()} path for this run`,
  sha:    (t) => `[verify] object sha256:${t.value} matches lockfile entry`,
};
// interleave: a few filler, then a target line, repeat, then pad to multi-page
let fi = 0;
for (const t of targets) {
  for (let k = 0; k < 3; k++) lines.push(filler[(fi++) % filler.length]);
  lines.push(anchorLine[t.key](t));
}
while (lines.length < 150) lines.push(filler[(fi++) % filler.length]);

const SESSION = `=== SESSION LOG (dense native-read fixture) ===\n` + lines.join('\n') + '\n';
const TEXT_TOKENS = Math.ceil(SESSION.length / 3.5); // Claude-dense proxy (matches prior harness)

writeFileSync(join(here, 'fixture.txt'), SESSION);
writeFileSync(join(here, 'truth.json'), JSON.stringify(
  Object.fromEntries(targets.map((t) => [t.key, t.value])), null, 2));
writeFileSync(join(here, 'questions.json'), JSON.stringify(
  targets.map((t) => ({ key: t.key, q: t.q })), null, 2));

// ---- native rungs: real atlases, NO padding (Sol's native discipline) -------
const RUNGS = [
  { name: 'jbmono10_6x11', font: 'jetbrains-mono-10', cellW: 6, cellH: 11 },
  { name: 'jbmono12_8x13', font: 'jetbrains-mono-12', cellW: 8, cellH: 13 },
];
const COLS = 86;

const table = [];
for (const r of RUNGS) {
  const style = { font: r.font, cellWBonus: 0, cellHBonus: 0, aa: true };
  const cw = renderCellWidth(style), ch = renderCellHeight(style);
  if (cw !== r.cellW || ch !== r.cellH)
    throw new Error(`${r.name}: native cell ${cw}x${ch} != expected ${r.cellW}x${r.cellH} (padding leaked?)`);
  const { pages } = await renderTextToImages(SESSION, { style, cols: COLS, reflow: true });
  const imageTokens = pages.reduce((n, p) => n + patchTokens(p.width, p.height), 0);
  const savingsPct = Math.round((1 - imageTokens / TEXT_TOKENS) * 100);
  const files = pages.map((p, i) => {
    const f = join(here, `${r.name}-p${i + 1}.png`);
    writeFileSync(f, Buffer.from(p.png));
    return { f, dim: `${p.width}x${p.height}` };
  });
  table.push({ rung: r.name, cell: `${cw}x${ch}`, cols: COLS, pages: pages.length,
    dims: files.map((x) => x.dim).join(','), imageTokens, textTokens: TEXT_TOKENS, savingsPct, files: files.map((x) => x.f) });
}

// ---- print ONLY non-sensitive summary + questions (no targets, no session) --
console.log(`\nSESSION chars=${SESSION.length}  textTokens(≈chars/3.5)=${TEXT_TOKENS}  targets=${targets.length}\n`);
console.log('rung            cell   cols  pages  dims                 imgTok  savings');
for (const t of table)
  console.log(`${t.rung.padEnd(15)} ${t.cell.padEnd(6)} ${String(t.cols).padEnd(5)} ${String(t.pages).padEnd(6)} ${t.dims.padEnd(20)} ${String(t.imageTokens).padEnd(7)} ${t.savingsPct}%`);
console.log('\nPNGs to read (open ONLY these, in order):');
for (const t of table) for (const f of t.files) console.log('  ' + f);
console.log('\nQUESTIONS (answer each by reading the PNGs; write eval/opus-density/native-sweep/answers.json):');
for (const q of JSON.parse(JSON.stringify(targets.map((t) => ({ key: t.key, q: t.q })))))
  console.log(`  ${q.key.padEnd(7)} ${q.q}`);
writeFileSync(join(here, 'render-table.json'), JSON.stringify(table, null, 2));
