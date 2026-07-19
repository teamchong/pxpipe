#!/usr/bin/env node
// Read-only diagnostic: classifies WHY consecutive compressed requests in the
// same session miss Anthropic's prompt cache (cache_create instead of
// cache_read), using the fingerprints already recorded per-event by
// src/core/tracker.ts. No PNGs are re-rendered; this only reads events.jsonl.
//
// Usage: node scripts/diagnose-cache.mjs [path-to-events.jsonl] [--restart-window=300]
//
// Classification per consecutive pair of compressed events within a session
// (grouped by first_user_sha8, ordered by ts):
//   - cache_prefix_sha8 changed:
//       churning_static_tags present   -> "tag-churn"      (cause: dynamic tag baked into slab)
//       unknown_static_tags present    -> "unknown-tag"     (cause: new tag not yet classified)
//       history_image_sha8 changed     -> "boundary-drift"  (cause: slab/chunk boundary moved)
//       system_sha8/claude_md_sha8 chg -> "system-drift"    (cause: system text changed)
//       (none of the above)            -> "unexplained-bust"
//   - cache_prefix_sha8 stable but cache_create tokens > 0:
//       gap > restart window           -> "ttl-expiry"      (benign: Anthropic-side TTL, e.g. restart gap)
//       gap <= restart window          -> "upstream-evict"  (benign-ish: server evicted anyway)
//   - cache_read_tokens > 0 and no cache_create -> "hit" (not printed, just counted)

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const restartWindowArg = args.find((a) => a.startsWith('--restart-window='));
const RESTART_WINDOW_SEC = restartWindowArg ? Number(restartWindowArg.split('=')[1]) : 300;
const explicitPath = args.find((a) => !a.startsWith('--'));
const defaultPath = join(homedir(), '.pxpipe', 'events.jsonl');
const filePath = explicitPath || defaultPath;

if (!existsSync(filePath)) {
  console.error(`No events file at ${filePath}`);
  process.exit(1);
}

async function readEvents(path) {
  const events = [];
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip malformed line
    }
  }
  return events;
}

function sessionKeyOf(ev) {
  return ev.first_user_sha8 || 'UNKNOWN_SESSION';
}

function classifyBust(prev, cur) {
  if (cur.churning_static_tags && cur.churning_static_tags.length) {
    return { cause: 'tag-churn', detail: cur.churning_static_tags.join(', ') };
  }
  if (cur.unknown_static_tags && cur.unknown_static_tags.length) {
    return { cause: 'unknown-tag', detail: cur.unknown_static_tags.join(', ') };
  }
  if (prev.history_image_sha8 && cur.history_image_sha8 && prev.history_image_sha8 !== cur.history_image_sha8) {
    return { cause: 'boundary-drift', detail: `${prev.history_image_sha8} -> ${cur.history_image_sha8}` };
  }
  if ((prev.system_sha8 && cur.system_sha8 && prev.system_sha8 !== cur.system_sha8) ||
      (prev.claude_md_sha8 && cur.claude_md_sha8 && prev.claude_md_sha8 !== cur.claude_md_sha8)) {
    return { cause: 'system-drift', detail: 'system_sha8/claude_md_sha8 changed' };
  }
  return { cause: 'unexplained-bust', detail: '(no fingerprint explains it — needs code-level look)' };
}

function main() {
  readEvents(filePath).then((all) => {
    const compressed = all
      .filter((e) => e.path === '/v1/messages' && e.compressed === true && e.cache_prefix_sha8)
      .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

    const bySession = new Map();
    for (const ev of compressed) {
      const key = sessionKeyOf(ev);
      if (!bySession.has(key)) bySession.set(key, []);
      bySession.get(key).push(ev);
    }

    const totals = new Map();
    const bump = (cause) => totals.set(cause, (totals.get(cause) || 0) + 1);

    let hits = 0;
    let pairsExamined = 0;

    for (const [sessionKey, evs] of bySession) {
      if (evs.length < 2) continue;
      const rows = [];
      for (let i = 1; i < evs.length; i++) {
        const prev = evs[i - 1];
        const cur = evs[i];
        pairsExamined++;
        const create = (cur.cache_create_5m_tokens || 0) + (cur.cache_create_1h_tokens || 0);
        const read = cur.cache_read_tokens || 0;

        if (cur.cache_prefix_sha8 !== prev.cache_prefix_sha8) {
          const { cause, detail } = classifyBust(prev, cur);
          bump(cause);
          rows.push({ ts: cur.ts, cause, detail, create, read });
          continue;
        }
        if (create > 0) {
          const gapSec = (new Date(cur.ts).getTime() - new Date(prev.ts).getTime()) / 1000;
          const cause = gapSec > RESTART_WINDOW_SEC ? 'ttl-expiry' : 'upstream-evict';
          bump(cause);
          rows.push({ ts: cur.ts, cause, detail: `gap=${gapSec.toFixed(0)}s`, create, read });
          continue;
        }
        if (read > 0) {
          hits++;
        }
      }
      if (rows.length) {
        console.log(`\nSession ${sessionKey} (${evs.length} compressed requests):`);
        for (const r of rows) {
          console.log(`  ${r.ts}  ${r.cause.padEnd(18)} create=${r.create} read=${r.read}  ${r.detail}`);
        }
      }
    }

    console.log('\n=== Summary ===');
    console.log(`Compressed requests examined: ${compressed.length}`);
    console.log(`Consecutive pairs examined:    ${pairsExamined}`);
    console.log(`Clean cache hits:              ${hits}`);
    for (const [cause, count] of [...totals.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`${cause.padEnd(18)} ${count}`);
    }
    const unexplained = totals.get('unexplained-bust') || 0;
    if (pairsExamined > 0) {
      const explainedPct = (100 * (1 - unexplained / pairsExamined)).toFixed(1);
      console.log(`\nExplained-cause coverage: ${explainedPct}% (target >= 95%)`);
    }
  });
}

main();
