// Source fixtures shared by EVERY model. No raster images or model geometry here.
// Version this corpus when changing it; do not mix old/new scores in one table.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
export const CORPUS_VERSION = 'profile-quality-v2';
export function arithmeticFixtures() {
  const { seed, rows } = JSON.parse(readFileSync(join(HERE, '../sol-profile/novel-arithmetic-results.json'), 'utf8'));
  return { seed, rows: rows.map(({ i, question, answer }) => ({ i, question, answer })) };
}
export function gistFixtures() {
  const result = [];
  for (const [tier, n] of [['work', 10], ['work2', 6], ['work3', 6]]) {
    const root = join(HERE, '../gist-recall', tier);
    const probes = JSON.parse(readFileSync(join(root, 'probes.json'), 'utf8'));
    for (let session = 0; session < n; session++) result.push({
      tier, session, probes: probes.filter(p => p.session === session),
      source: readFileSync(join(root, `s${session}.txt`), 'utf8'),
    });
  }
  return result;
}

// Five deterministic source logs, three randomly located targets per log.
// Unique ids/durations and indistinguishable target/filler record formatting.
// In particular, no "target line" label or always-first target (old Gemini arm).
export function hexFixtures(seed = 20260905) {
  let state = seed >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const ids = new Set(), durations = new Set(), pages = [], trials = [];
  for (let page = 0; page < 5; page++) {
    const targets = new Set();
    while (targets.size < 3) targets.add(Math.floor(rand() * 89));
    const records = [];
    for (let row = 0; row < 89; row++) {
      let id, dur;
      do { id = Array.from({ length: 12 }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join(''); } while (ids.has(id));
      do { dur = 100 + Math.floor(rand() * 9900); } while (durations.has(dur));
      ids.add(id); durations.add(dur);
      records.push({ timestamp: `2026-09-05T12:${String(Math.floor(row / 60)).padStart(2, '0')}:${String(row % 60).padStart(2, '0')}Z`,
        id, dur_ms: dur, status: 200, path: `/api/v1/worker_${row % 7}` });
      if (targets.has(row)) trials.push({ page, row, dur, gold: id });
    }
    pages.push(`BEGIN EVENT LOG TRACE - PAGE ${page}\n` + records.map(r => JSON.stringify(r)).join('\n'));
  }
  return { seed, pages, trials };
}
