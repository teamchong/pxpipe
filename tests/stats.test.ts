import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { newSummary, fold, renderTextReport, runStats } from '../src/stats.js';
import type { TrackEvent } from '../src/core/tracker.js';

function ev(partial: Partial<TrackEvent>): TrackEvent {
  return {
    ts: '2026-05-18T00:00:00Z',
    method: 'POST',
    path: '/v1/messages',
    status: 200,
    duration_ms: 100,
    ...partial,
  };
}

describe('stats aggregator', () => {
  it('counts status buckets', () => {
    const s = newSummary();
    fold(s, ev({ status: 200 }));
    fold(s, ev({ status: 201 }));
    fold(s, ev({ status: 404 }));
    fold(s, ev({ status: 503 }));
    fold(s, ev({ status: 500 }));
    expect(s.total).toBe(5);
    expect(s.ok2xx).toBe(2);
    expect(s.err4xx).toBe(1);
    expect(s.err5xx).toBe(2);
  });

  it('separates compressed vs passthrough and collects skip reasons', () => {
    const s = newSummary();
    fold(s, ev({ compressed: true, orig_chars: 1000, image_bytes: 200 }));
    fold(s, ev({ compressed: true, orig_chars: 2000, image_bytes: 300 }));
    fold(s, ev({ compressed: false, reason: 'below_min_chars (50 < 2000)' }));
    fold(s, ev({ compressed: false, reason: 'below_min_chars (60 < 2000)' }));
    fold(s, ev({ compressed: false, reason: 'compress=false' }));
    expect(s.compressed).toBe(2);
    expect(s.passthrough).toBe(3);
    expect(s.origCharsTotal).toBe(3000);
    expect(s.imageBytesTotal).toBe(500);
    // Reasons keep their exact string form (parenthetical char counts and
    // all) — useful for spotting outliers without collapsing detail.
    expect(s.skipReasons.size).toBe(3);
    expect(s.skipReasons.get('below_min_chars (50 < 2000)')).toBe(1);
    expect(s.skipReasons.get('below_min_chars (60 < 2000)')).toBe(1);
    expect(s.skipReasons.get('compress=false')).toBe(1);
  });

  it('aggregates Anthropic token usage and computes cache hit metrics', () => {
    const s = newSummary();
    fold(
      s,
      ev({
        input_tokens: 100,
        output_tokens: 10,
        cache_read_tokens: 0,
        cache_create_tokens: 5000,
      }),
    );
    fold(
      s,
      ev({
        input_tokens: 50,
        output_tokens: 5,
        cache_read_tokens: 5000,
        cache_create_tokens: 0,
      }),
    );
    fold(
      s,
      ev({
        input_tokens: 60,
        output_tokens: 6,
        cache_read_tokens: 5000,
        cache_create_tokens: 0,
      }),
    );
    // 3 events all carried usage; 2 had cache_read > 0.
    expect(s.eventsWithUsage).toBe(3);
    expect(s.cacheHitEvents).toBe(2);
    expect(s.inputTokensTotal).toBe(210);
    expect(s.outputTokensTotal).toBe(21);
    expect(s.cacheReadTokensTotal).toBe(10000);
    expect(s.cacheCreateTokensTotal).toBe(5000);
  });

  it('buckets by cwd and tracks system_sha8 reuse', () => {
    const s = newSummary();
    fold(s, ev({ cwd: '/a', system_sha8: 'aaa', orig_chars: 100, image_bytes: 20 }));
    fold(s, ev({ cwd: '/a', system_sha8: 'aaa', orig_chars: 100, image_bytes: 20 }));
    fold(s, ev({ cwd: '/b', system_sha8: 'bbb', orig_chars: 200, image_bytes: 40 }));
    expect(s.byCwd.size).toBe(2);
    expect(s.byCwd.get('/a')!.count).toBe(2);
    expect(s.byCwd.get('/a')!.origChars).toBe(200);
    expect(s.systemShaHist.get('aaa')).toBe(2);
    expect(s.systemShaHist.get('bbb')).toBe(1);
  });

  it('collects unknown_static_tags across events', () => {
    const s = newSummary();
    fold(s, ev({ unknown_static_tags: ['recent_files', 'todo_list'] }));
    fold(s, ev({ unknown_static_tags: ['recent_files'] }));
    fold(s, ev({}));
    expect(s.unknownTags.get('recent_files')).toBe(2);
    expect(s.unknownTags.get('todo_list')).toBe(1);
  });

  it('renders a non-empty text report for a populated summary', () => {
    const s = newSummary();
    for (let i = 0; i < 100; i++) {
      fold(
        s,
        ev({
          compressed: true,
          orig_chars: 5000,
          image_bytes: 1000,
          input_tokens: 50,
          cache_read_tokens: i % 2 === 0 ? 4000 : 0,
          cache_create_tokens: i % 2 === 0 ? 0 : 4000,
          duration_ms: 100 + i,
          first_byte_ms: 30 + i,
          cwd: '/Users/x/code/pp',
          system_sha8: 'stable',
        }),
      );
    }
    const out = renderTextReport(s);
    expect(out).toContain('pxpipe stats');
    expect(out).toContain('compressed');
    expect(out).toContain('cache hit rate');
    expect(out).toContain('/Users/x/code/pp');
    expect(out).toContain('stable');
    // 50% cache hit rate by event.
    expect(out).toMatch(/cache hit rate \(by events\):\s+50.0%/);
  });

  it('measures savings only on probe-OK rows and shows the headline', () => {
    const s = newSummary();
    // Probe OK: 1000 baseline vs 300 actual (200 input + 100 cache create).
    fold(
      s,
      ev({
        baseline_tokens: 1000,
        baseline_probe_status: 'ok',
        input_tokens: 200,
        cache_create_tokens: 100,
        cache_read_tokens: 0,
      }),
    );
    // Failed probe: must NOT pollute the ratio even with a huge baseline.
    fold(
      s,
      ev({
        baseline_tokens: 9999,
        baseline_probe_status: 'failed',
        input_tokens: 10,
      }),
    );
    // No baseline at all: excluded from both totals.
    fold(s, ev({ input_tokens: 500 }));

    expect(s.baselineMeasuredEvents).toBe(1);
    expect(s.baselineTokensTotal).toBe(1000);
    expect(s.measuredActualTokensTotal).toBe(300);

    const out = renderTextReport(s);
    expect(out).toContain('measured savings');
    // saved = 1000 − 300 = 700 → 70.0% of baseline.
    expect(out).toMatch(/saved:\s+700\s+\(\s*70.0%\)/);
  });

  it('runStats reads a log offline and reports savings; errors when absent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-stats-'));
    const file = path.join(dir, 'events.jsonl');
    try {
      const rows = [
        { ts: 't', method: 'POST', path: '/v1/messages', status: 200, baseline_tokens: 1000, baseline_probe_status: 'ok', input_tokens: 200, cache_create_tokens: 100 },
        'not json',
      ];
      fs.writeFileSync(file, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');

      const ok = await runStats([], file);
      expect(ok.code).toBe(0);
      expect(ok.out).toContain('measured savings');
      expect(ok.out).toMatch(/saved:\s+700\s+\(\s*70.0%\)/);
      expect(ok.err).toContain('1 unparseable');

      const asJson = await runStats(['--json'], file);
      expect(JSON.parse(asJson.out).savedTokensTotal).toBe(700);

      const missing = await runStats([], path.join(dir, 'nope.jsonl'));
      expect(missing.code).toBe(1);

      // --help short-circuits before any file read (usage, exit 0).
      const help = await runStats(['--help'], path.join(dir, 'nope.jsonl'));
      expect(help.code).toBe(0);
      expect(help.out).toContain('Usage:');
      expect(help.out).toContain('Exit codes:');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
