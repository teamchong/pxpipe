import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  aggregateSessions,
  filterSessions,
  type SessionsPaths,
} from '../src/sessions.js';
import type { TrackEvent } from '../src/core/tracker.js';

// ---- Test scaffolding ------------------------------------------------------

/** Build a tmpdir with a fresh events.jsonl and 4xx-bodies/ for each test. */
function makeTmp(): SessionsPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-sessions-'));
  const eventsFile = path.join(dir, 'events.jsonl');
  const sidecarDir = path.join(dir, '4xx-bodies');
  return { eventsFile, sidecarDir };
}

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

function writeEvents(paths: SessionsPaths, events: TrackEvent[]): void {
  fs.mkdirSync(path.dirname(paths.eventsFile), { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(paths.eventsFile, lines);
}

function writeSidecar(
  paths: SessionsPaths,
  name: string,
  bytes = 256,
): string {
  fs.mkdirSync(paths.sidecarDir, { recursive: true });
  const full = path.join(paths.sidecarDir, name);
  fs.writeFileSync(full, Buffer.alloc(bytes, 'x'));
  return full;
}


let tmp: SessionsPaths;
beforeEach(() => {
  tmp = makeTmp();
});
afterEach(() => {
  // Best-effort cleanup; on failure the tmpdir leaks but the OS handles it.
  try {
    fs.rmSync(path.dirname(tmp.eventsFile), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---- Aggregation -----------------------------------------------------------

describe('aggregateSessions', () => {
  it('groups events by first_user_sha8', async () => {
    writeEvents(tmp, [
      ev({ ts: '2026-05-18T00:00:00Z', first_user_sha8: 'aaaaaaaa', cwd: '/a' }),
      ev({ ts: '2026-05-18T00:00:01Z', first_user_sha8: 'aaaaaaaa', cwd: '/a' }),
      ev({ ts: '2026-05-18T00:00:02Z', first_user_sha8: 'bbbbbbbb', cwd: '/b' }),
    ]);
    const { sessions } = await aggregateSessions(tmp);
    expect(sessions.size).toBe(2);
    expect(sessions.get('aaaaaaaa')?.requestCount).toBe(2);
    expect(sessions.get('bbbbbbbb')?.requestCount).toBe(1);
  });

  it('uses earliest ts for firstSeen and latest for lastSeen even when input is unordered', async () => {
    writeEvents(tmp, [
      ev({ ts: '2026-05-18T00:00:05Z', first_user_sha8: 'aaaaaaaa' }),
      ev({ ts: '2026-05-18T00:00:01Z', first_user_sha8: 'aaaaaaaa' }),
      ev({ ts: '2026-05-18T00:00:09Z', first_user_sha8: 'aaaaaaaa' }),
    ]);
    const { sessions } = await aggregateSessions(tmp);
    const s = sessions.get('aaaaaaaa')!;
    expect(s.firstSeen).toBe('2026-05-18T00:00:01Z');
    expect(s.lastSeen).toBe('2026-05-18T00:00:09Z');
  });

  it('puts events with no first_user_sha8 into <unknown>', async () => {
    writeEvents(tmp, [ev({ first_user_sha8: undefined })]);
    const { sessions } = await aggregateSessions(tmp);
    expect(sessions.has('<unknown>')).toBe(true);
  });

  it('credits sidecar bytes to the right session', async () => {
    const sidecar = writeSidecar(tmp, 'sample.json.gz', 1024);
    writeEvents(tmp, [
      ev({ first_user_sha8: 'aaaaaaaa', req_body_sample_path: sidecar }),
      ev({ first_user_sha8: 'bbbbbbbb' }),
    ]);
    const { sessions, sidecarsBySession } = await aggregateSessions(tmp);
    expect(sessions.get('aaaaaaaa')?.sidecarBytes).toBe(1024);
    expect(sessions.get('bbbbbbbb')?.sidecarBytes).toBe(0);
    expect(sidecarsBySession.get('aaaaaaaa')?.has(sidecar)).toBe(true);
  });

  it('returns empty when events.jsonl is missing', async () => {
    const missing: SessionsPaths = {
      eventsFile: path.join(path.dirname(tmp.eventsFile), 'nope.jsonl'),
      sidecarDir: tmp.sidecarDir,
    };
    const { sessions } = await aggregateSessions(missing);
    expect(sessions.size).toBe(0);
  });

  it('drops malformed JSONL lines silently', async () => {
    fs.mkdirSync(path.dirname(tmp.eventsFile), { recursive: true });
    fs.writeFileSync(
      tmp.eventsFile,
      [
        JSON.stringify(ev({ first_user_sha8: 'aaaaaaaa' })),
        'this is not json',
        JSON.stringify(ev({ first_user_sha8: 'aaaaaaaa' })),
      ].join('\n') + '\n',
    );
    const { sessions } = await aggregateSessions(tmp);
    expect(sessions.get('aaaaaaaa')?.requestCount).toBe(2);
  });

  it('accumulates tokens saved from baseline_tokens vs upstream usage (allows negative)', async () => {
    writeEvents(tmp, [
      // baseline 20000, actual_input_eff = 1000 + 800*1.25 + 100*0.10 = 2010
      //   saved = 20000 − 2010 = 17990
      ev({
        first_user_sha8: 'aaaaaaaa',
        compressed: true,
        baseline_tokens: 20_000,
        input_tokens: 1_000,
        cache_create_tokens: 800,
        cache_read_tokens: 100,
      }),
      // baseline 2000, actual_input_eff = 3000 + 0 + 0 = 3000 → NET LOSS −1000
      // (must NOT be clamped to zero)
      ev({
        first_user_sha8: 'aaaaaaaa',
        compressed: true,
        baseline_tokens: 2_000,
        input_tokens: 3_000,
        cache_create_tokens: 0,
        cache_read_tokens: 0,
      }),
      // Missing baseline — skipped from savings rollup, still counts toward requests.
      ev({
        first_user_sha8: 'aaaaaaaa',
        compressed: false,
        input_tokens: 500,
      }),
      // Has baseline but no usage block — also skipped (apples-to-apples).
      ev({
        first_user_sha8: 'aaaaaaaa',
        compressed: true,
        baseline_tokens: 9_999,
      }),
    ]);
    const { sessions } = await aggregateSessions(tmp);
    const s = sessions.get('aaaaaaaa')!;
    // 17990 + (−1000) = 16990
    expect(s.tokensSavedEst).toBe(16_990);
    expect(s.charsSaved).toBe(16_990 * 4);
    expect(s.requestCount).toBe(4);
  });

  it('reports negative tokensSavedEst when all events net-lose', async () => {
    writeEvents(tmp, [
      // Each event: baseline=1000, actual=2000 → −1000
      ev({
        first_user_sha8: 'bbbbbbbb',
        compressed: true,
        baseline_tokens: 1_000,
        input_tokens: 2_000,
      }),
      ev({
        first_user_sha8: 'bbbbbbbb',
        compressed: true,
        baseline_tokens: 1_000,
        input_tokens: 2_000,
      }),
      ev({
        first_user_sha8: 'bbbbbbbb',
        compressed: true,
        baseline_tokens: 1_000,
        input_tokens: 2_000,
      }),
    ]);
    const { sessions } = await aggregateSessions(tmp);
    const s = sessions.get('bbbbbbbb')!;
    // 3 × −1000 = −3000
    expect(s.tokensSavedEst).toBe(-3_000);
    expect(s.charsSaved).toBe(-12_000);
  });
});

// ---- filter + list ---------------------------------------------------------

describe('filterSessions', () => {
  it('filters by project (substring match)', async () => {
    writeEvents(tmp, [
      ev({ first_user_sha8: 'aaaaaaaa', cwd: '/Users/me/code/pxpipe' }),
      ev({ first_user_sha8: 'bbbbbbbb', cwd: '/Users/me/code/other' }),
    ]);
    const { sessions } = await aggregateSessions(tmp);
    expect(filterSessions(sessions, { project: 'pxpipe' }).map((s) => s.id)).toEqual([
      'aaaaaaaa',
    ]);
    expect(filterSessions(sessions, { project: 'other' }).map((s) => s.id)).toEqual([
      'bbbbbbbb',
    ]);
  });

  it('filters by since (ISO date)', async () => {
    writeEvents(tmp, [
      ev({ ts: '2026-04-01T00:00:00Z', first_user_sha8: 'old1' }),
      ev({ ts: '2026-05-01T00:00:00Z', first_user_sha8: 'new1' }),
    ]);
    const { sessions } = await aggregateSessions(tmp);
    const filtered = filterSessions(sessions, { since: '2026-04-15T00:00:00Z' });
    expect(filtered.map((s) => s.id)).toEqual(['new1']);
  });

  it('sorts results most-recent-first', async () => {
    writeEvents(tmp, [
      ev({ ts: '2026-04-01T00:00:00Z', first_user_sha8: 'old1' }),
      ev({ ts: '2026-05-01T00:00:00Z', first_user_sha8: 'mid1' }),
      ev({ ts: '2026-06-01T00:00:00Z', first_user_sha8: 'new1' }),
    ]);
    const { sessions } = await aggregateSessions(tmp);
    const ids = filterSessions(sessions, {}).map((s) => s.id);
    expect(ids).toEqual(['new1', 'mid1', 'old1']);
  });
});

// ---- Claude Code session fingerprint map ----------------------------------

import {
  claudeCodeMap,
  decodeClaudeProjectDir,
  fingerprintFirstUser,
  readFirstUserFromClaudeSession,
} from '../src/sessions.js';

describe('Claude Code session map', () => {
  /** Build a synthetic `~/.claude/projects/<proj>/<session>.jsonl` tree under
   *  a tmpdir and return the root path. */
  function makeCCRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-ccmap-'));
  }

  it('returns an empty map when the directory does not exist', async () => {
    const m = await claudeCodeMap(path.join(os.tmpdir(), 'definitely-missing-xyz'));
    expect(m.size).toBe(0);
  });

  it('fingerprints the first user message and maps to the session id', async () => {
    const root = makeCCRoot();
    const proj = path.join(root, '-Users-me-code-pxpipe');
    fs.mkdirSync(proj, { recursive: true });
    const firstUser = 'hello, this is the start of a conversation';
    const sessionFile = path.join(proj, 'abc-123.jsonl');
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: 'permission-mode' }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: firstUser } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hi' } }),
      ].join('\n') + '\n',
    );

    const m = await claudeCodeMap(root);
    const expectedSha = fingerprintFirstUser(firstUser);
    const ref = m.get(expectedSha);
    expect(ref).toBeDefined();
    expect(ref!.sessionId).toBe('abc-123');
    expect(ref!.projectPath).toBe('/Users/me/code/pxpipe');
    expect(ref!.firstUserPreview).toContain('hello');
  });

  it('parses content-array blocks (the modern Claude Code shape)', async () => {
    const root = makeCCRoot();
    const proj = path.join(root, '-Users-me-foo');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(
      path.join(proj, 'sess.jsonl'),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'first user prompt with text block shape' },
          ],
        },
      }) + '\n',
    );
    const m = await claudeCodeMap(root);
    expect(m.size).toBe(1);
    const ref = [...m.values()][0]!;
    expect(ref.firstUserPreview).toContain('first user prompt');
  });

  it('decodes project directory names back to a slash-path', () => {
    expect(decodeClaudeProjectDir('-Users-me-code-foo')).toBe('/Users/me/code/foo');
    expect(decodeClaudeProjectDir('foo-bar')).toBe('foo/bar');
  });

  it('matches the proxy fingerprint: 4 KiB cap and 8-hex prefix', () => {
    // Two strings that differ only past the 4 KiB cap must produce the same
    // sha8 — otherwise the mapping silently misses every cross-pass-the-cap
    // conversation.
    const base = 'x'.repeat(4096);
    expect(fingerprintFirstUser(base + 'A')).toBe(fingerprintFirstUser(base + 'B'));
    expect(fingerprintFirstUser('hello')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('skips sessions whose first user row is unreadable', async () => {
    const root = makeCCRoot();
    const proj = path.join(root, '-tmp-x');
    fs.mkdirSync(proj, { recursive: true });
    // First user row has neither string content nor an array of text blocks
    // → readFirstUserFromClaudeSession returns undefined and we don't add a
    //   bogus mapping by hashing some later assistant turn.
    fs.writeFileSync(
      path.join(proj, 'sess.jsonl'),
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: { weird: true } } }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'later user message' } }),
      ].join('\n') + '\n',
    );
    const m = await claudeCodeMap(root);
    expect(m.size).toBe(0);
  });

  it('readFirstUserFromClaudeSession handles missing file gracefully', async () => {
    const got = await readFirstUserFromClaudeSession('/nope/does/not/exist.jsonl');
    expect(got).toBeUndefined();
  });
});
