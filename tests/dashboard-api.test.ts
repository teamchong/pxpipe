/**
 * Tests for the new /api/* dashboard endpoints. We instantiate a
 * DashboardState directly against a tmpdir SessionsPaths and call its
 * serve* methods, then assert on the JSON body. No real HTTP server — the
 * route dispatch lives in node.ts and would just be a thin re-export of the
 * same calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DashboardState, dashboardPath } from '../src/dashboard.js';
import type { SessionsPaths } from '../src/sessions.js';
import type { TrackEvent } from '../src/core/tracker.js';

function makeTmp(): SessionsPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-dashapi-'));
  return {
    eventsFile: path.join(dir, 'events.jsonl'),
    sidecarDir: path.join(dir, '4xx-bodies'),
  };
}

function ev(p: Partial<TrackEvent>): TrackEvent {
  return {
    ts: '2026-05-19T00:00:00Z',
    method: 'POST',
    path: '/v1/messages',
    status: 200,
    duration_ms: 100,
    ...p,
  };
}

function writeEvents(paths: SessionsPaths, events: TrackEvent[]): void {
  fs.mkdirSync(path.dirname(paths.eventsFile), { recursive: true });
  fs.writeFileSync(
    paths.eventsFile,
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

let tmp: SessionsPaths;
let dash: DashboardState;
beforeEach(() => {
  tmp = makeTmp();
  // Inject an empty Claude Code map so tests don't scan the developer's real
  // ~/.claude/projects/ directory (slow + flaky depending on which machine
  // the suite runs on). Tests that need a populated map can re-construct.
  dash = new DashboardState(tmp, async () => new Map());
});
afterEach(() => {
  try {
    fs.rmSync(path.dirname(tmp.eventsFile), { recursive: true, force: true });
  } catch {
    /* leak the tmpdir; OS will reap */
  }
});

// ---- dashboardPath route table -------------------------------------------

describe('dashboardPath()', () => {
  it('matches the main HTML routes', () => {
    expect(dashboardPath('/')?.kind).toBe('html');
    expect(dashboardPath('/dashboard')?.kind).toBe('html');
  });

  it('matches the legacy live-poll routes', () => {
    expect(dashboardPath('/proxy-stats')?.kind).toBe('stats');
    expect(dashboardPath('/proxy-recent')?.kind).toBe('recent');
    expect(dashboardPath('/proxy-latest-png')?.kind).toBe('png');
  });

  it('matches the new /api/* routes', () => {
    expect(dashboardPath('/api/sessions.json')?.kind).toBe('api-sessions');
    expect(dashboardPath('/api/stats.json')?.kind).toBe('api-stats');
  });

  it('returns null for unknown paths', () => {
    expect(dashboardPath('/v1/messages')).toBeNull();
    expect(dashboardPath('/api/whatever.json')).toBeNull();
    // The per-session detail routes were cut — these no longer match.
    expect(dashboardPath('/api/sessions/abc12345.json')).toBeNull();
    expect(dashboardPath('/sessions/abc12345')).toBeNull();
  });
});

// ---- /api/sessions.json --------------------------------------------------

describe('serveSessionsJson', () => {
  it('returns a list of grouped sessions with claudeCode null when no ~/.claude/projects/ match', async () => {
    writeEvents(tmp, [
      ev({ first_user_sha8: 'aaaaaaaa', cwd: '/x', ts: '2026-05-19T00:00:00Z' }),
      ev({ first_user_sha8: 'aaaaaaaa', cwd: '/x', ts: '2026-05-19T00:01:00Z' }),
      ev({ first_user_sha8: 'bbbbbbbb', cwd: '/y', ts: '2026-05-19T00:02:00Z' }),
    ]);
    const res = await dash.serveSessionsJson();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.sessions).toHaveLength(2);
    // Most-recent-first
    expect(body.sessions[0].id).toBe('bbbbbbbb');
    expect(body.sessions[1].id).toBe('aaaaaaaa');
    expect(body.sessions[0].claudeCode).toBeNull();
  });

  it('respects ?project filtering', async () => {
    writeEvents(tmp, [
      ev({ first_user_sha8: 'aaaaaaaa', cwd: '/Users/me/code/pxpipe' }),
      ev({ first_user_sha8: 'bbbbbbbb', cwd: '/Users/me/code/other' }),
    ]);
    const res = await dash.serveSessionsJson({ project: 'pxpipe' });
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.sessions[0].id).toBe('aaaaaaaa');
  });

  it('returns 503 when DashboardState was built without paths', async () => {
    const bare = new DashboardState();
    const res = await bare.serveSessionsJson();
    expect(res.status).toBe(503);
  });
});

// ---- /api/stats.json ------------------------------------

describe('serveApiStats', () => {
  it('aggregates the events file into a Summary-shaped JSON', async () => {
    writeEvents(tmp, [
      ev({ status: 200, compressed: true, orig_chars: 1000, image_bytes: 200 }),
      ev({ status: 200, compressed: true, orig_chars: 2000, image_bytes: 300 }),
      ev({ status: 400, compressed: false }),
    ]);
    const res = await dash.serveApiStats();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parsed).toBe(3);
    expect(body.summary.total).toBe(3);
    expect(body.summary.ok2xx).toBe(2);
    expect(body.summary.err4xx).toBe(1);
    expect(body.summary.compressed).toBe(2);
    expect(body.summary.passthrough).toBe(1);
    expect(body.summary.origCharsTotal).toBe(3000);
    expect(body.summary.imageBytesTotal).toBe(500);
  });

  it('404s when no events file exists', async () => {
    const res = await dash.serveApiStats();
    expect(res.status).toBe(404);
  });
});

// ---- /fragments/* (htmx server-rendered HTML) ------------------------

describe('serveFragment', () => {
  const url = new URL('http://localhost/fragments/x');

  it('routes /fragments/<name> via dashboardPath', () => {
    expect(dashboardPath('/fragments/header')).toEqual({ kind: 'fragment', name: 'header' });
    expect(dashboardPath('/fragments/latest')).toEqual({ kind: 'fragment', name: 'latest' });
  });

  it('renders the toggle fragment reflecting compression state', async () => {
    const on = await dash.serveFragment('toggle', url, 1234);
    expect(on.headers.get('content-type')).toContain('text/html');
    expect(await on.text()).toContain('Disable compression');
    dash.handleCompressionToggle({ enabled: false });
    const off = await dash.serveFragment('toggle', url, 1234);
    const offHtml = await off.text();
    expect(offHtml).toContain('PASSTHROUGH MODE');
    expect(offHtml).toContain('Enable compression');
    dash.handleCompressionToggle({ enabled: true });
  });

  it('renders header + recent + stats fragments from the same payloads as JSON', async () => {
    writeEvents(tmp, [
      ev({ status: 200, compressed: true, orig_chars: 1000, image_bytes: 200 }),
    ]);
    const header = await (await dash.serveFragment('header', url, 4711)).text();
    expect(header).toContain('4711');
    const recent = await (await dash.serveFragment('recent', url, 4711)).text();
    expect(recent).toContain('<table');
    const stats = await (await dash.serveFragment('stats', url, 4711)).text();
    expect(stats).toContain('requests');
  });

  it('escapes HTML in latest source text', async () => {
    dash.captureImage({
      imagePngs: [new Uint8Array([137, 80, 78, 71])],
      imageDims: [{ width: 100, height: 80 }],
      imageSourceText: '<script>alert(1)</script>',
    } as never);
    const srcUrl = new URL('http://localhost/fragments/latest?source=1');
    const html = await (await dash.serveFragment('latest', srcUrl, 1)).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('404s unknown fragments', async () => {
    const res = await dash.serveFragment('nope', url, 1);
    expect(res.status).toBe(404);
  });
});
