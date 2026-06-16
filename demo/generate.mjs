/**
 * Smart-zone demo generator.
 *
 * Builds ONE large context that you feed to two Claude columns (plain vs pxpipe):
 *  - context/filler-*.txt : inert, token-dense logs sized to flood the window.
 *  - context/needle.txt   : a few state-tracking facts with a deterministic
 *                           integer answer (small -> stays TEXT even through
 *                           pxpipe, so the pxpipe column reads it perfectly).
 *
 * The point: at large context the PLAIN column drowns in the filler and gets the
 * answer wrong (the "dumb zone"); the pxpipe column images the filler, keeps a
 * small active context, and answers correctly.
 *
 * Prints the prompt to paste and the expected answer. Re-run to change SIZE.
 *   node demo/generate.mjs
 */
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CTX = join(HERE, "context");
rmSync(CTX, { recursive: true, force: true });
mkdirSync(CTX, { recursive: true });

const SIZE = 200_000;        // target filler tokens (bump to 400k+ if plain Claude still answers right)
const CPT = 1.91;            // chars per text token
const FILE_CHARS = 40_000;   // each file stays under Read's ~25k-token page

let _s = 0x2545f491 >>> 0;
const rnd = () => { let s = _s; s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; _s = s; return s / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pad = (n, w) => String(n).padStart(w, "0");

// --- needle: deterministic state-tracking reasoning --------------------------
const start = ri(1000, 9000), a = ri(100, 900), b = ri(100, 900), c = ri(100, 900);
const answer = ((start + a - b) * 2) - c;
writeFileSync(join(CTX, "needle.txt"),
`Operational note — ledger account ZX-9 (do not confuse with any other account).

The ledger balance of account ZX-9 began the quarter at ${start} units.
In week 3, an adjustment increased the ZX-9 balance by ${a} units.
In week 7, a correction reduced the ZX-9 balance by ${b} units.
In week 9, the ZX-9 balance was doubled following a stock split.
In week 11, ${c} units were withdrawn from ZX-9.
No other changes to ZX-9 occurred during the quarter.
`);

// --- filler: inert, token-dense, no answer-like content ----------------------
const LVL = ["INFO", "DEBUG", "WARN", "TRACE"], SVC = ["billing", "auth", "cache", "router", "queue", "ingest", "render", "index"];
const line = () => `2026-${pad(ri(1,12),2)}-${pad(ri(1,28),2)}T${pad(ri(0,23),2)}:${pad(ri(0,59),2)}:${pad(ri(0,59),2)}Z ${LVL[ri(0,3)]} svc=${SVC[ri(0,7)]} req=${Array.from({length:8},()=>"0123456789abcdef"[ri(0,15)]).join("")} shard=${ri(0,31)} lat=${ri(1,800)}ms msg=processed batch ${ri(1000,99999)} ok`;

let filler = "";
const targetChars = Math.round(SIZE * CPT);
while (filler.length < targetChars) filler += line() + "\n";
let n = 0;
for (let off = 0; off < filler.length; off += FILE_CHARS) writeFileSync(join(CTX, `filler-${pad(n++, 3)}.txt`), filler.slice(off, off + FILE_CHARS));

const prompt = "Read EVERY file in the context/ folder (all the filler-*.txt logs AND needle.txt), then answer using only their contents: What is the final ledger balance of account ZX-9? Reply with ONLY the integer.";

console.log(`generated context/: ${n} filler files (~${SIZE.toLocaleString()} tokens) + needle.txt`);
console.log(`\n--- paste this prompt in BOTH Claude columns ---\n${prompt}\n`);
console.log(`--- expected answer (ground truth): ${answer} ---`);
console.log(`plain column at this size may get it WRONG (context overload); pxpipe column should get ${answer}.`);
