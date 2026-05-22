#!/usr/bin/env node
/**
 * eval/extract-corpus.mjs
 *
 * Corpus extraction for the reflow eval harness.
 *
 * Produces two artefacts in eval/corpus/:
 *   text-blocks.json  – array of plain-text strings suitable for L1 OCR eval
 *   sessions.json     – array of conversation session objects for L2 A/B eval
 *
 * Memory-safe: processes files one at a time with readline, never loading the
 * entire projects directory into memory at once. Stops scanning once targets
 * are reached.
 *
 * Usage:
 *   node eval/extract-corpus.mjs [--max-blocks N] [--max-sessions N] [--out-dir DIR]
 */

import {
  createReadStream,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
  options: {
    'max-blocks':   { type: 'string',  default: '20'  },
    'max-sessions': { type: 'string',  default: '10'  },
    'out-dir':      { type: 'string',  default: 'eval/corpus' },
    'projects-dir': { type: 'string',  default: join(homedir(), '.claude', 'projects') },
    'verbose':      { type: 'boolean', default: false },
    'help':         { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (args.help) {
  console.log(`
Usage: node eval/extract-corpus.mjs [options]

Options:
  --max-blocks N      Max text blocks to extract for L1 (default: 20)
  --max-sessions N    Max sessions to extract for L2 (default: 10)
  --out-dir DIR       Output directory (default: eval/corpus)
  --projects-dir DIR  Claude projects dir (default: ~/.claude/projects)
  --verbose           Print verbose progress
  --help              Show this help
`);
  process.exit(0);
}

const MAX_BLOCKS   = parseInt(args['max-blocks'],   10);
const MAX_SESSIONS = parseInt(args['max-sessions'], 10);
const OUT_DIR      = resolve(args['out-dir']);
const PROJECTS_DIR = args['projects-dir'];
const VERBOSE      = args['verbose'];

/** How many files to scan before giving up (avoid scanning 13k+ files). */
const MAX_FILES_SCANNED = 500;
/** Minimum file size (bytes) to bother reading. */
const MIN_FILE_BYTES = 2048;

const log  = (...a) => console.log('[extract-corpus]', ...a);
const vlog = (...a) => { if (VERBOSE) log(...a); };

// ---------------------------------------------------------------------------
// File discovery — returns files lazily, sorted by size desc
// so we get rich sessions first.
// ---------------------------------------------------------------------------

function* walkJsonl(dir, limit) {
  let count = 0;
  if (!existsSync(dir)) return;

  // Collect one level of subdirs + files (projects dir is flat-ish: one subdir per project)
  let entries;
  try { entries = readdirSync(dir); } catch { return; }

  // Shuffle-ish: sort by name to get variety across projects
  entries.sort();

  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }

    if (st.isDirectory()) {
      // Walk one level into project subdirectories
      let subEntries;
      try { subEntries = readdirSync(full); } catch { continue; }
      // Sort by size desc so we get large (interesting) files first
      const withSize = [];
      for (const sub of subEntries) {
        if (!sub.endsWith('.jsonl')) continue;
        const subFull = join(full, sub);
        try {
          const subSt = statSync(subFull);
          if (subSt.size >= MIN_FILE_BYTES) withSize.push({ path: subFull, size: subSt.size });
        } catch { continue; }
      }
      withSize.sort((a, b) => b.size - a.size);
      for (const { path } of withSize) {
        if (count++ >= limit) return;
        yield path;
      }
    } else if (entry.endsWith('.jsonl') && st.size >= MIN_FILE_BYTES) {
      if (count++ >= limit) return;
      yield full;
    }
  }
}

// ---------------------------------------------------------------------------
// Stream-parse a single JSONL file line by line
// ---------------------------------------------------------------------------

/** @returns {Promise<object[]>} conversation turns from this file */
async function parseTurnsFromFile(filePath) {
  const turns = [];
  return new Promise((resolve) => {
    const rl = createInterface({
      input:     createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let rec;
      try { rec = JSON.parse(line); } catch { return; }
      // Only keep user/assistant turns with content
      if (
        (rec.type === 'user' || rec.type === 'assistant') &&
        rec.message?.role &&
        rec.message?.content
      ) {
        turns.push(rec);
      }
    });
    rl.on('close', () => resolve(turns));
    rl.on('error', () => resolve(turns));
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n\n');
}

function isGoodBlock(text) {
  if (!text || text.trim().length < 200) return false;
  if (/^warmup$/i.test(text.trim())) return false;
  if (text.trim().split('\n').length < 3) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Main extraction loop — streams through files one at a time
// ---------------------------------------------------------------------------

log(`Scanning ${PROJECTS_DIR} …`);
if (!existsSync(PROJECTS_DIR)) {
  log(`WARNING: projects dir not found at ${PROJECTS_DIR} — using synthetic corpus`);
}

const l1Blocks   = [];
const l2Sessions = [];
const seenTexts  = new Set();
let filesScanned = 0;

const TARGET_BLOCKS   = MAX_BLOCKS;
const TARGET_SESSIONS = MAX_SESSIONS;
// Over-sample slightly so we can dedup and still hit target
const BLOCK_OVERSAMPLE   = Math.min(TARGET_BLOCKS   * 3, TARGET_BLOCKS   + 20);
const SESSION_OVERSAMPLE = Math.min(TARGET_SESSIONS * 2, TARGET_SESSIONS + 10);

for (const filePath of walkJsonl(PROJECTS_DIR, MAX_FILES_SCANNED)) {
  const done = l1Blocks.length >= BLOCK_OVERSAMPLE && l2Sessions.length >= SESSION_OVERSAMPLE;
  if (done) break;

  filesScanned++;
  vlog(`Scanning file ${filesScanned}: ${filePath.split('/').slice(-2).join('/')}`);

  const turns = await parseTurnsFromFile(filePath);
  if (turns.length < 2) continue;

  // Extract text blocks for L1
  if (l1Blocks.length < BLOCK_OVERSAMPLE) {
    for (const turn of turns) {
      if (l1Blocks.length >= BLOCK_OVERSAMPLE) break;
      const text = extractText(turn.message.content);
      if (!isGoodBlock(text)) continue;
      const key = text.slice(0, 80);
      if (seenTexts.has(key)) continue;
      seenTexts.add(key);
      l1Blocks.push({
        sessionId: turn.sessionId ?? 'unknown',
        role:      turn.message.role,
        charCount: text.length,
        text:      text.slice(0, 4000),
      });
    }
  }

  // Extract sessions for L2
  if (l2Sessions.length < SESSION_OVERSAMPLE && turns.length >= 6) {
    const sorted = turns.slice().sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return ta - tb;
    });

    const usable = sorted.filter(t => extractText(t.message.content).trim().length > 50);
    if (usable.length < 6) continue;

    const historyText = usable
      .slice(0, -2)
      .map(t => `[${t.message.role.toUpperCase()}]\n${extractText(t.message.content).slice(0, 1000)}`)
      .join('\n\n---\n\n');

    const questionTurn = usable[usable.length - 2];
    const expectedTurn = usable[usable.length - 1];
    if (!questionTurn || !expectedTurn) continue;

    l2Sessions.push({
      sessionId:        turns[0]?.sessionId ?? filePath,
      totalTurns:       usable.length,
      historyCharCount: historyText.length,
      historyText:      historyText.slice(0, 8000),
      questionText:     extractText(questionTurn.message.content).slice(0, 2000),
      expectedAnswer:   extractText(expectedTurn.message.content).slice(0, 2000),
    });
  }
}

log(`Scanned ${filesScanned} files`);

// ---------------------------------------------------------------------------
// Trim to target sizes
// ---------------------------------------------------------------------------

// For blocks: sort by length for diversity, then stride-sample
l1Blocks.sort((a, b) => a.charCount - b.charCount);
const stride = Math.max(1, Math.floor(l1Blocks.length / TARGET_BLOCKS));
const finalBlocks = [];
for (let i = 0; i < l1Blocks.length && finalBlocks.length < TARGET_BLOCKS; i += stride) {
  finalBlocks.push(l1Blocks[i]);
}
// Top up if needed
for (const b of l1Blocks) {
  if (finalBlocks.length >= TARGET_BLOCKS) break;
  if (!finalBlocks.includes(b)) finalBlocks.push(b);
}

// For sessions: prefer longer histories
l2Sessions.sort((a, b) => b.historyCharCount - a.historyCharCount);
const finalSessions = l2Sessions.slice(0, TARGET_SESSIONS);

// Fallback to synthetic if still empty
if (finalBlocks.length === 0) {
  log('WARNING: no text blocks found — using synthetic fallback corpus');
  finalBlocks.push(...syntheticBlocks());
}
if (finalSessions.length === 0) {
  log('WARNING: no sessions found — using synthetic fallback sessions');
  finalSessions.push(...syntheticSessions());
}

log(`Selected ${finalBlocks.length}/${TARGET_BLOCKS} text blocks for L1`);
log(`Selected ${finalSessions.length}/${TARGET_SESSIONS} sessions for L2`);

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });

const blocksPath   = join(OUT_DIR, 'text-blocks.json');
const sessionsPath = join(OUT_DIR, 'sessions.json');

writeFileSync(blocksPath,   JSON.stringify(finalBlocks,   null, 2), 'utf8');
writeFileSync(sessionsPath, JSON.stringify(finalSessions, null, 2), 'utf8');

log(`Wrote ${finalBlocks.length} blocks   → ${blocksPath}`);
log(`Wrote ${finalSessions.length} sessions → ${sessionsPath}`);

// ---------------------------------------------------------------------------
// Synthetic fallback corpus
// ---------------------------------------------------------------------------

function syntheticBlocks() {
  const SAMPLE_CODE = `
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Parses a JSONL file and returns all records that match the predicate.
 * Silently skips malformed lines.
 */
export function filterJsonl(path, predicate) {
  return readFileSync(path, 'utf8')
    .split('\\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    })
    .filter(r => r !== null && predicate(r));
}

// Example usage:
const records = filterJsonl(join(__dirname, 'data.jsonl'), r => r.type === 'user');
console.log('Found', records.length, 'user records');
`.trim();

  const SAMPLE_LOG = `
[2026-05-21 10:01:23] INFO  Server started on port 3000
[2026-05-21 10:01:24] DEBUG Atlas loaded: 7429 glyphs, 14858 bytes
[2026-05-21 10:01:25] INFO  Proxy listening at http://localhost:3000
[2026-05-21 10:02:01] DEBUG Incoming request: POST /v1/messages
[2026-05-21 10:02:01] DEBUG Transform applied: 4 images, 2847 chars -> 892 tokens
[2026-05-21 10:02:03] INFO  Response: 200 OK (1842ms)
[2026-05-21 10:03:17] DEBUG Incoming request: POST /v1/messages
[2026-05-21 10:03:17] INFO  Transform skipped: below min chars (240 < 500)
[2026-05-21 10:03:18] INFO  Response: 200 OK (289ms)
[2026-05-21 10:04:55] WARN  Dropped chars spike: 42 in last request (top: U+0009 TAB x38)
[2026-05-21 10:05:00] ERROR Render failed: atlas missing U+3000 IDEOGRAPHIC SPACE
[2026-05-21 10:05:00] INFO  Falling back to non-reflow render
`.trim();

  const SAMPLE_DOC = `
# Reflow Mode - Technical Notes

The reflow renderer re-packs source text into a dense continuous stream,
using the sentinel glyph to mark every original hard newline.
This eliminates the "dead right margin" that wastes ~71% of each rendered
image in typical Claude Code conversations.

## Why it works

Real Claude Code history wraps at ~60-80 chars, but our render canvas is
100 cols wide. Every short line leaves 20-40 cells of blank space that
still costs the same image-token budget as filled cells.

## Losslessness guarantee

For any text T that does not contain the sentinel glyph literally:
  dereflow(reflow(T)) === minifyForRender(T)

minifyForRender is the already-accepted lossy step (strips trailing
whitespace, collapses 4+ blank lines). Reflow adds zero additional loss.

## Sentinel collision

When T already contains the sentinel glyph, reflow() returns null and the
caller falls back to the standard non-reflow renderer. This is vanishingly
rare in real conversation text (measured: 0 collisions in 1M tokens).
`.trim();

  const SAMPLE_CONVO = `
I need to debug why the pixelpipe proxy is adding extra blank lines to the
rendered output. Here is the test case that reproduces it:

  const text = "line one\\n\\nline two\\n\\n\\nline three";
  const rendered = await renderTextToPngs(text);

The expected output should have at most 2 consecutive blank lines between
"line two" and "line three", but instead I'm seeing 3 blank lines.

Looking at the minifyForRender function in src/core/render.ts, it should
collapse runs of 4+ newlines (3+ blank lines) down to 3 newlines. But the
regex is matching \\n{4,} which means 4 or more newline characters - that
would be 3 blank lines, not 3+ blank lines.

Wait, let me re-read: 3 consecutive newlines = 2 blank lines. So \\n{4,}
collapses runs where you'd have 3 or more blank lines. That seems right.

Let me check whether the issue is in the test expectation rather than the
implementation. With text = "a\\n\\n\\nline three", that's:
  a + newline + newline + newline + "line three"
  = 3 newlines = 2 blank lines

And \\n{4,} requires 4 or more. So 3 newlines should NOT be collapsed.
The function seems correct. Let me look at the test more carefully.
`.trim();

  return [
    { sessionId: 'synthetic', role: 'assistant', charCount: SAMPLE_CODE.length,  text: SAMPLE_CODE  },
    { sessionId: 'synthetic', role: 'assistant', charCount: SAMPLE_LOG.length,   text: SAMPLE_LOG   },
    { sessionId: 'synthetic', role: 'assistant', charCount: SAMPLE_DOC.length,   text: SAMPLE_DOC   },
    { sessionId: 'synthetic', role: 'user',      charCount: SAMPLE_CONVO.length, text: SAMPLE_CONVO },
  ];
}

function syntheticSessions() {
  const historyText = `[USER]
Can you explain how the reflow renderer works in pixelpipe?

---

[ASSISTANT]
The reflow renderer re-packs text into a dense stream using the sentinel glyph.
It eliminates dead right-margin whitespace and can reduce image count by 30-50%.

The pipeline is:
1. minifyForRender() - strips trailing whitespace, collapses blank lines
2. expandTabsInLine() - converts tabs to visible arrow + spaces
3. join lines with sentinel glyph instead of newline characters

The sentinel glyph (the return symbol) marks where original hard newlines were,
so the vision model can reconstruct the original structure when reading the image.

---

[USER]
How does it handle the case where the text already contains that sentinel glyph?

---

[ASSISTANT]
When reflow() detects the sentinel glyph in the source text it immediately
returns null. The caller then falls back to the standard renderTextToPngs() path.
This makes losslessness provable: no escape encoding needed, no ambiguity.

The probability of a real text block containing the U+21B5 return symbol is
extremely low in practice. In production telemetry across 1M tokens, zero
collisions were observed. The symbol only appears intentionally in documents
that are specifically discussing the reflow feature itself.`;

  return [{
    sessionId:        'synthetic',
    totalTurns:       6,
    historyCharCount: historyText.length,
    historyText,
    questionText:     'What is the token savings estimate for reflow mode compared to baseline rendering?',
    expectedAnswer:
      'Reflow mode is estimated to save 30-50% of image tokens by eliminating dead right-margin whitespace. ' +
      'At 29% glyph fill in typical Claude Code history, most of each rendered image row is blank cells. ' +
      'Reflow packs the text densely so each row reaches the full column width.',
  }];
}
