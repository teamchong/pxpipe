import { describe, it, expect } from 'vitest';
import {
  extractFactSheetTokens,
  extractFactSheetEntries,
  extractFactSheetEntriesAllPages,
  factSheetText,
  factSheetTextWithDrop,
} from '../src/core/factsheet.js';

describe('factsheet extraction', () => {
  it('captures precision-critical, hard-to-OCR tokens', () => {
    const text = [
      'Edited src/lib/__tests__/livekit-egress.test.ts and agents/transcription/agent.ts',
      'opened https://github.com/Keplogic/atlas/pull/93 at commit 6d80bd6',
      'set LIVEKIT_API_SECRET and ran with --max-tokens 64000, coverage 97.82',
    ].join('\n');
    const toks = extractFactSheetTokens(text);
    expect(toks).toContain('src/lib/__tests__/livekit-egress.test.ts');
    expect(toks).toContain('https://github.com/Keplogic/atlas/pull/93');
    expect(toks).toContain('6d80bd6');
    expect(toks).toContain('LIVEKIT_API_SECRET');
    expect(toks).toContain('--max-tokens');
    expect(toks).toContain('97.82');
  });

  it('drops substrings of longer kept tokens', () => {
    const toks = extractFactSheetTokens('see https://github.com/o/r/pull/9 in repo');
    // The bare /github.com path must collapse into the full URL.
    expect(toks).toContain('https://github.com/o/r/pull/9');
    expect(toks).not.toContain('/github.com');
  });

  it('does not flag pure-letter hex words (decade, facade)', () => {
    const toks = extractFactSheetTokens('this decade the facade was added');
    expect(toks).not.toContain('decade');
    expect(toks).not.toContain('facade');
  });

  it('is deterministic — identical input yields byte-identical output (cache stability)', () => {
    const text = 'paths /a/b/c.ts /d/e/f.ts ids 1a2b3c4 9f8e7d6 nums 12345 6789.0 FLAG_X FLAG_Y';
    expect(factSheetText(text)).toBe(factSheetText(text));
  });

  it('returns empty string when nothing notable is present', () => {
    expect(factSheetText('the quick brown fox jumps over')).toBe('');
  });

  it('caps the token budget', () => {
    const many = Array.from({ length: 200 }, (_, i) => `/dir${i}/file${i}.ts`).join(' ');
    expect(extractFactSheetTokens(many).length).toBeLessThanOrEqual(64);
  });

  it('protects short high-consequence tokens from eviction by long URLs', () => {
    // 80 long doc-URLs (well over the 64-token budget) plus a short commit SHA and a port —
    // the exact shape that silently dropped the SHA a coding agent needed off the image.
    const urls = Array.from({ length: 80 }, (_, i) =>
      `https://platform.claude.com/docs/en/build-with-claude/page-${String(i).padStart(2, '0')}-guide.md`);
    const text = [...urls.slice(0, 40), 'fix in commit 9d121ac on port 47821', ...urls.slice(40)].join('\n');
    const toks = extractFactSheetTokens(text);
    expect(toks).toContain('9d121ac');
    expect(toks).toContain('47821');
    expect(toks.length).toBeLessThanOrEqual(64);
    expect(toks.filter((t) => t.startsWith('http')).length).toBeLessThanOrEqual(8);
  });
});

describe('ticket-style codes and occurrence counts', () => {
  it('captures uppercase hyphenated codes that contain a digit', () => {
    const toks = extractFactSheetTokens(
      'audit marker AUDIT-ZX9 tracked as PROJ-1482, see CVE-2024-30078 for details',
    );
    expect(toks).toContain('AUDIT-ZX9');
    expect(toks).toContain('PROJ-1482');
    expect(toks).toContain('CVE-2024-30078');
  });

  it('does not flag digit-free hyphenated prose (READ-ONLY, NON-NULL)', () => {
    const toks = extractFactSheetTokens('column is READ-ONLY and NON-NULL by default');
    expect(toks).not.toContain('READ-ONLY');
    expect(toks).not.toContain('NON-NULL');
  });

  it('annotates repeated tokens with ×N and explains the notation', () => {
    const text = 'retry DEPLOY-77 failed\nretry DEPLOY-77 ok\nfinal DEPLOY-77 done\nsha 9d121ac';
    const sheet = factSheetText(text);
    expect(sheet).toContain('DEPLOY-77 ×3');
    expect(sheet).toContain('×N marks a token that occurs N times');
    expect(sheet).not.toContain('9d121ac ×');
  });

  it('emits byte-identical sheets to the pre-count format when nothing repeats', () => {
    const text = 'commit 9d121ac on port 47821';
    expect(factSheetText(text)).toContain('from the image: ');
    expect(factSheetText(text)).not.toContain('×');
  });

  it('marks listed values as high-confidence and tells the model to abstain instead of guessing', () => {
    const sheet = factSheetText('commit 9d121ac on port 47821');
    expect(sheet).toContain('listed values are high-confidence text');
    expect(sheet).toContain('say it is not visible');
    expect(sheet).toContain('do not guess');
  });

  it('never double-counts one span matched by two patterns', () => {
    // 1.2.3 is hit by the version pattern; its 1.2 substring by decimal — offset dedup
    // plus substring-collapse must leave a single un-annotated v1.2.3-style entry.
    const sheet = factSheetText('release v1.2.3 shipped');
    expect(sheet).not.toMatch(/×\d/);
  });

  it('keeps a rare ticket code over a flood of per-line hex ids (log-file shape)', () => {
    const lines = Array.from({ length: 300 }, (_, i) =>
      `2026-07-26T09:40:41Z WARN svc=ingest req=${(0x10000000 + i * 7919).toString(16)} shard=12 msg=processed batch ${10000 + i} ok`,
    );
    lines[137] += ' AUDIT-ZX9';
    lines[201] += ' AUDIT-ZX9';
    const entries = extractFactSheetEntries(lines.join('\n'));
    const hit = entries.find((e) => e.token === 'AUDIT-ZX9');
    expect(hit).toBeDefined();
    expect(hit!.count).toBe(2);
  });

  it('sums counts across pages in the all-pages variant', () => {
    const page = 'x'.repeat(90) + ' TICK-42 ';
    const { kept } = extractFactSheetEntriesAllPages(page.repeat(5), 100);
    const hit = kept.find((e) => e.token === 'TICK-42');
    expect(hit).toBeDefined();
    expect(hit!.count).toBe(5);
  });
});

// Honesty fix (multi-specialist debate 2026-07-07): the caption OPEN string reads
// as a CLOSED, authoritative identifier index ("quote these verbatim"), but the
// MAX_TOKENS=64 budget silently evicts the excess on dense blocks — the exact
// condition that manufactures confident wrong-precision answers (the model treats
// the list as complete and confabulates the missing token). The caption must admit
// when it is truncated.
describe('factsheet caption honesty (omission marker)', () => {
  it('marks omission when the budget evicts tokens on a very dense block', () => {
    // 260 distinct tier-0 hex ids > MAX_TIER0 (192), so >=68 are evicted.
    const text = Array.from({ length: 260 }, (_, i) =>
      `cache key ${(0xe8d4a51000 + i).toString(16)} ok`,
    ).join('\n');
    const sheet = factSheetText(text);
    expect(sheet).not.toBe('');
    // Must carry an explicit omission signal with a count, not present a closed list.
    expect(sheet).toMatch(/\+\d+ more/);
    expect(sheet).toContain('it is NOT complete');
    expect(sheet).toContain('unlisted exact values are unknown');
    // The count must be honest: at least (260 - 192) = 68 omitted.
    const m = sheet.match(/\+(\d+) more/);
    expect(Number(m![1])).toBeGreaterThanOrEqual(68);
  });

  it('is byte-identical to the old caption when nothing is evicted (cache-stable common case)', () => {
    // Few tokens, well under budget -> no marker, so existing dense-prefix caches never bust.
    const sheet = factSheetText('commit 9d121ac on port 47821 in src/net/pool.ts');
    expect(sheet).not.toMatch(/\+\d+ more/);
    expect(sheet.endsWith(']')).toBe(true);
  });
});

// tier-0 budget raise (multi-specialist debate 2026-07-07): the high-consequence,
// zero-redundancy tokens (SHAs, ports, flags, uuids, const-ids, ticket codes) are
// exactly the ones a model can't reconstruct and most needs verbatim. Giving them a
// higher keep-cap than the reconstructable tier-1/2 tail closes most of the gap that
// motivated the (dead-on-arrival) recover feature — deterministically, cache-stably,
// with no round-trips.
describe('factsheet tier-0 budget', () => {
  it('keeps far more than the old 64-token cap of zero-redundancy tier-0 ids', () => {
    // 150 distinct hex ids: above the old flat 64 cap, below the tier-0 cap (192).
    const hexes = Array.from({ length: 150 }, (_, i) => (0xa100000000 + i).toString(16));
    const text = hexes.map((h) => `id ${h}`).join('\n');
    const sheet = factSheetText(text);
    // All 150 tier-0 ids present, and NO omission marker (nothing evicted).
    expect(sheet).not.toMatch(/\+\d+ more/);
    for (const h of hexes) expect(sheet).toContain(h);
  });
});

// Passive instrumentation (multi-specialist debate 2026-07-07): callers (transform.ts)
// need the per-block tier0Dropped count alongside the caption text, to accumulate into
// TransformInfo without a model call — the panel's load-bearing, near-free measurement
// of how often the >MAX_TIER0 case actually occurs on real traffic.
describe('factSheetTextWithDrop', () => {
  it('returns the same text as factSheetText, plus tier0Dropped', () => {
    const text = 'commit 9d121ac on port 47821';
    const { text: sheet, tier0Dropped } = factSheetTextWithDrop(text);
    expect(sheet).toBe(factSheetText(text));
    expect(tier0Dropped).toBe(0);
  });

  it('reports tier0Dropped > 0 when tier-0 tokens exceed MAX_TIER0', () => {
    const hexes = Array.from({ length: 260 }, (_, i) => (0xe8d4a51000 + i).toString(16));
    const text = hexes.map((h) => `id ${h}`).join('\n');
    const { tier0Dropped } = factSheetTextWithDrop(text);
    expect(tier0Dropped).toBeGreaterThanOrEqual(68); // 260 - 192
  });
});
