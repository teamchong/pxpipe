// Fresh BLIND fixture only (no render). Writes fixture.txt / truth.json /
// questions.json with new crypto-random targets. Prints ONLY char count +
// questions -- never the targets. Reader opens PNGs, never these files.
// Run: pnpm exec tsx eval/opus-density/native-sweep/gen-fixture.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const R = (n) => randomBytes(n).toString('hex').slice(0, n);
const WORDS = ['ledger','shard','queue','render','atlas','token','commit','stripe',
  'glyph','patch','vision','cursor','buffer','stream','digest','anchor','cache',
  'probe','sweep','retune','baseline','profile'];
const w = () => WORDS[randomBytes(1)[0] % WORDS.length];
const d = (n) => Array.from({ length: n }, () => randomBytes(1)[0] % 10).join('');
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const B64 = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const b64 = (n) => Array.from({ length: n }, () => B64[randomBytes(1)[0] % B64.length]).join('');

const targets = [
  { key: 'hex12',  value: R(12),                q: `The 12-char hex id immediately after "trace=".` },
  { key: 'camel',  value: w()+cap(w())+cap(w()), q: `The camelCase symbol right after "export function " (before "(").` },
  { key: 'path',   value: `/Users/${w()}/repos/${w()}/src/core/${w()}${d(2)}.ts`, q: `The full file path right after "wrote " (ends .ts).` },
  { key: 'semver', value: `${1+randomBytes(1)[0]%9}.${randomBytes(1)[0]%40}.${randomBytes(1)[0]%99}`, q: `The version right after "pxpipe-proxy@".` },
  { key: 'bytes',  value: d(11),                q: `The integer right after "flushed " (before " bytes").` },
  { key: 'reqid',  value: `${R(8)}-${R(4)}`,     q: `The id right after "req_" (8hex-4hex).` },
  { key: 'envvar', value: `${w().toUpperCase()}_${w().toUpperCase()}_${d(1)}`, q: `The UPPER_SNAKE env var just before "=1" on the export line.` },
  { key: 'sha',    value: b64(16),               q: `The 16-char token right after "sha256:".` },
];

const filler = [
  `$ git log --oneline -12`,
  `  rebased onto origin/main, ${d(2)} files changed, no conflicts`,
  `  resolved ${w()} vs ${w()} drift, kept the ${w()} baseline`,
  `[render] paging 20 cols, cap 728px, no downscale on either tier`,
  `[tokens] est ${d(4)} text vs ${d(3)} image, gate holds at savings>0`,
  `$ pnpm exec tsx eval/${w()}/run.mjs   # dry-run, no key`,
  `  loaded ${d(2)} fixtures, ${d(1)} profiles, ${d(3)} probes`,
  `[warn] ${w()} cache miss, refetched ${w()} manifest from disk`,
  `  minifyForRender stripped ${d(3)} blank runs, reflow=true`,
  `$ node scripts/verify-${w()}.mjs --strict`,
  `  ok: cursor atlas checksum matches the committed snapshot`,
  `[commit] ${w()}: retune stripe cell density, keep native glyphs`,
  `  reviewer asked for a paired old-profile arm before shipping`,
  `[note] confab guard: abstain beats a wrong verbatim read every time`,
];
const anchorLine = {
  hex12:  (v) => `[net] upstream connect trace=${v} latency=${d(2)}ms status=200`,
  camel:  (v) => `  export function ${v}(input, opts) {   // hot path, do not inline`,
  path:   (v) => `[fs] wrote ${v}  (${d(4)} bytes, mode 0644)`,
  semver: (v) => `  installed pxpipe-proxy@${v} from the private registry`,
  bytes:  (v) => `[flush] flushed ${v} bytes to the ${w()} spool, fsync ok`,
  reqid:  (v) => `[api] retry req_${v} after 429, backoff ${d(3)}ms`,
  envvar: (v) => `  export ${v}=1   # enable the ${w()} path for this run`,
  sha:    (v) => `[verify] object sha256:${v} matches lockfile entry`,
};

const lines = [];
let fi = 0;
for (const t of targets) {
  for (let k = 0; k < 3; k++) lines.push(filler[(fi++) % filler.length]);
  lines.push(anchorLine[t.key](t.value));
}
while (lines.length < 150) lines.push(filler[(fi++) % filler.length]);

const SESSION = `=== SESSION LOG (dense native-read fixture) ===\n` + lines.join('\n') + '\n';
writeFileSync(join(here, 'fixture.txt'), SESSION);
writeFileSync(join(here, 'truth.json'), JSON.stringify(Object.fromEntries(targets.map((t) => [t.key, t.value])), null, 2));
writeFileSync(join(here, 'questions.json'), JSON.stringify(targets.map((t) => ({ key: t.key, q: t.q })), null, 2));
console.log(`fresh fixture: chars=${SESSION.length}  textTokens(≈/3.5)=${Math.ceil(SESSION.length/3.5)}  targets=${targets.length}`);
console.log('QUESTIONS:');
for (const t of targets) console.log(`  ${t.key.padEnd(7)} ${t.q}`);
