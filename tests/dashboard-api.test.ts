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
import { getAllowedModelBases, setAllowedModelBases } from '../src/core/applicability.js';
import type { SessionsPaths } from '../src/sessions.js';
import type { TrackEvent } from '../src/core/tracker.js';
import type { StatsPayload, RecentPayload } from '../src/dashboard/types.js';
import { renderHeaderFragment, renderPage } from '../src/dashboard/fragments.js';

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
  setAllowedModelBases(null);
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

  it('renders opt-in GPT 5.5/5.6 chips and mutates the single model scope', async () => {
    const prev = process.env.PXPIPE_MODELS;
    try {
      delete process.env.PXPIPE_MODELS;
      setAllowedModelBases(null); // reset to built-in Fable-only default
      const off = await (await dash.serveFragment('models', url, 1234)).text();
      expect(off).toContain('Image OpenAI Responses models');
      expect(off).not.toContain('<div class="models" style="display:none">');
      // PXPIPE_MODELS textbox mirrors the live scope as CSV.
      expect(off).toContain('name="list"');
      expect(off).toContain('value="claude-fable-5"');
      expect(off).toContain('GPT 5.6 Sol</button>');
      expect(off).toContain('GPT 5.5</button>');
      // Sol remains available and ordered before GPT 5.5.
      expect(off.indexOf('GPT 5.6 Sol')).toBeLessThan(off.indexOf('GPT 5.5'));
      expect(getAllowedModelBases()).toContain('claude-fable-5');
      expect(getAllowedModelBases()).not.toContain('grok-4.5');
      expect(getAllowedModelBases()).not.toContain('gpt-5.6-sol');
      expect(getAllowedModelBases()).not.toContain('gpt-5.5');

      dash.handleModelsToggle('gpt-5.6-sol', true);
      dash.handleModelsToggle('gpt-5.5', true);
      const onBoth = await (await dash.serveFragment('models', url, 1234)).text();
      expect(onBoth).toContain('GPT 5.5 ✓');
      expect(onBoth).toContain('GPT 5.6 Sol ✓');
      expect(getAllowedModelBases()).toContain('gpt-5.5');
      expect(getAllowedModelBases()).toContain('gpt-5.6-sol');
      // Chip flips are reflected back into the textbox CSV.
      expect(onBoth).toContain('value="claude-fable-5,gpt-5.6-sol,gpt-5.5"');
    } finally {
      setAllowedModelBases(null);
      if (prev === undefined) delete process.env.PXPIPE_MODELS;
      else process.env.PXPIPE_MODELS = prev;
    }
  });

  it('replaces the whole scope from the PXPIPE_MODELS textbox CSV', async () => {
    const prev = process.env.PXPIPE_MODELS;
    try {
      delete process.env.PXPIPE_MODELS;
      dash.handleModelsSet(' claude-fable-5 , grok-4.5 ,');
      expect(getAllowedModelBases()).toEqual(['claude-fable-5', 'grok-4.5']);
      const html = await (await dash.serveFragment('models', url, 1234)).text();
      expect(html).toContain('value="claude-fable-5,grok-4.5"');
      expect(html).toContain('Grok 4.5 ✓');
      // Same falsey vocabulary as the env var: off/false/0 → compress nothing.
      dash.handleModelsSet('off');
      expect(getAllowedModelBases()).toEqual([]);
      dash.handleModelsSet('');
      expect(getAllowedModelBases()).toEqual([]);
    } finally {
      setAllowedModelBases(null);
      if (prev === undefined) delete process.env.PXPIPE_MODELS;
      else process.env.PXPIPE_MODELS = prev;
    }
  });

  it('renders header + recent + stats fragments from the same payloads as JSON', async () => {
    writeEvents(tmp, [
      ev({ status: 200, model: 'gpt-5.5', compressed: true, orig_chars: 1000, image_bytes: 200 }),
    ]);
    const header = await (await dash.serveFragment('header', url, 4711)).text();
    expect(header).toContain('4711');
    await dash.replay(tmp.eventsFile);
    const recent = await (await dash.serveFragment('recent', url, 4711)).text();
    expect(recent).toContain('<table');
    expect(recent).toContain('gpt-5.5');
    const stats = await (await dash.serveFragment('stats', url, 4711)).text();
    expect(stats).toContain('requests');
  });

  it('shows the OpenAI Responses composition in request Details', async () => {
    dash.update({
      method: 'POST', path: '/v1/responses', model: 'gpt-5.6-sol', status: 200,
      durationMs: 1,
      usage: { input_tokens: 500000, output_tokens: 10, cached_tokens: 490000 },
      info: {
        compressed: true, imageCount: 1, imagePngs: [new Uint8Array([1])],
        imageDims: [{ width: 10, height: 10 }], imageTokens: 15000,
        baselineImagedTokens: 56000, bucketChars: { history: 200000 },
        responsesComposition: {
          instructions: 1000, systemDeveloper: 2000, userAssistant: 450000,
          functionCalls: 1000, functionOutputs: 20000, reasoningEncrypted: 5000,
          compactionOpaque: 3000, toolsJson: 12000, other: 1000,
          totalLocal: 495000, imageParts: 0,
          completedFunctionPairs: 25, recentNativeFunctionPairs: 6,
          oldFunctionPairs: 19, openFunctionCalls: 1,
          imageableFunctionCalls: 900, imageableFunctionOutputs: 19000,
          collapsedFunctionPairs: 10, collapsedFunctionCalls: 500,
          collapsedFunctionOutputs: 12000,
        },
      } as never,
    });
    const html = await (await dash.serveFragment('context-map', new URL('http://localhost/fragments/context-map'), 1)).text();
    expect(html).toContain('Original Responses composition');
    expect(html).toContain('Reasoning / encrypted items');
    expect(html).toContain('Native tool JSON');
    expect(html).toContain('Function outputs eligible in old closed pairs');
    expect(html).toContain('Function outputs actually imaged this request');
    expect(html).toContain('Adjacent completed pairs');
    expect(html).toContain('Open calls kept native');
    expect(html).toContain('56.0k tok');
    expect(html).toContain('sent to gpt-5.6-sol');
    expect(html).toContain('Model reply (output)');
    expect(html).toContain('never calls Anthropic /count_tokens');
  });

  it('renders keyboard-accessible hover help for stat question marks', async () => {
    const header = await (await dash.serveFragment('header', url, 4711)).text();
    expect(header).toContain('class="q" tabindex="0"');
    expect(header).toContain('data-tip=');
    expect(header).toContain('aria-label=');
  });

  it('uses source text parallel to each captured PNG', async () => {
    const ids = dash.captureImage({
      imagePngs: [new Uint8Array([1]), new Uint8Array([2])],
      imageDims: [{ width: 10, height: 10 }, { width: 20, height: 20 }],
      imageSourceText: 'legacy shared',
      imageSourceTexts: ['slab source', 'history section source'],
    } as never);
    const html = await (await dash.serveFragment(
      'latest',
      new URL(`http://localhost/fragments/latest?source=1&pin=${ids[1]}`),
      1,
    )).text();
    expect(html).toContain('history section source');
    expect(html).not.toContain('slab source');
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

describe('dashboard page help UI', () => {
  it('ships visible hover/focus tooltip CSS for question-mark controls', () => {
    const html = renderPage(47821);
    expect(html).toContain('.q:hover::after, .q:focus-visible::after');
    expect(html).toContain('content: attr(data-tip)');
  });

  it('compares imaged requests with their own without-pxpipe counterfactual', () => {
    const html = renderHeaderFragment({
      compressed_paid_requests: 600,
      compressed_actual_usd: 96.42,
      compressed_avg_usd_per_request: 0.1607,
      passthrough_paid_requests: 36,
      passthrough_actual_usd: 2.5992,
      passthrough_avg_usd_per_request: 0.0722,
      saved_usd: 194.83,
      pricing_assumptions: { input_per_mtok: 10, output_multiplier: 5 },
    } as StatsPayload, 47821);

    expect(html).toContain('$0.1607');
    expect(html).toContain('vs $0.4854 without pxpipe');
    expect(html).not.toContain('vs $0.0722 without pxpipe');
    expect(html).toContain('same paid imaged requests');
  });
});

// ---- GPT (OpenAI) savings split ------------------------------------------
// The dashboard math was built entirely around the Anthropic cache-aware
// baseline, so GPT rows used to surface all-zero columns. These lock the
// GPT branch in update()/replay(): vision-token actual vs o200k text-token
// baseline, 0.1× automatic prefix cache, no count_tokens probe.
describe('GPT savings split', () => {
  beforeEach(() => {
    setAllowedModelBases(['gpt-5.5']);
  });

  // Imaged 50k o200k text tokens down to 8k vision tokens, with a 2k cached
  // prefix served at 0.1×:
  //   actual   = (10000 - 2000) + 2000×0.1               = 8200
  //   baseline = actual + (50000 - 8000)×0.1             = 12400
  //   saved    = baseline - actual                       = 4200
  const gptUpdate = {
    method: 'POST',
    path: '/openai/responses',
    model: 'gpt-5.5',
    status: 200,
    durationMs: 100,
    usage: { input_tokens: 10000, output_tokens: 200, cached_tokens: 2000 },
    info: {
      compressed: true,
      imageTokens: 8000,
      baselineImagedTokens: 50000,
      imageCount: 1,
      firstUserSha8: 'gptsess1',
    },
  };

  it('credits GPT savings on a compressed Responses request (live update + stats)', async () => {
    dash.update(structuredClone(gptUpdate) as never);
    const stats = (await dash.serveStats().json()) as StatsPayload;
    expect(stats.requests).toBe(1);
    expect(stats.actual_input_weighted).toBe(8200);
    expect(stats.baseline_input_weighted).toBe(12400);
    expect(stats.saved_input_tokens).toBe(4200);
    expect(stats.saved_pct_input_only).toBeGreaterThan(0);
  });

  it('includes only currently enabled models in overall stats', async () => {
    dash.update(structuredClone(gptUpdate) as never);
    dash.update({
      ...structuredClone(gptUpdate),
      model: 'gpt-5.6-sol',
      info: { ...structuredClone(gptUpdate.info), firstUserSha8: 'gptsol' },
    } as never);

    let stats = (await dash.serveStats().json()) as StatsPayload;
    expect(stats.requests).toBe(1);
    expect(stats.saved_input_tokens).toBe(4200);

    dash.handleModelsToggle('gpt-5.6-sol', true);
    stats = (await dash.serveStats().json()) as StatsPayload;
    expect(stats.requests).toBe(2);
    expect(stats.saved_input_tokens).toBe(8400);

    dash.handleModelsToggle('gpt-5.5', false);
    stats = (await dash.serveStats().json()) as StatsPayload;
    expect(stats.requests).toBe(1);
    expect(stats.saved_input_tokens).toBe(4200);
  });

  it('populates As-text / Sent / Cache-hits / Saved recent columns for GPT', async () => {
    dash.update(structuredClone(gptUpdate) as never);
    const recent = (await dash.serveRecent().json()) as RecentPayload;
    const row = recent.recent.at(-1)!;
    expect(row.path).toContain('responses');
    expect(row.cc_added).toBe(1); // "Sent as" → imaged
    expect(row.cache_read).toBe(2000); // cached_tokens, NOT Anthropic cache_read
    expect(row.baseline_input).toBe(12400); // "As text"
    expect(row.actual_input).toBe(8200); // "Sent"
    expect(row.session_saved_so_far_delta).toBe(4200); // "Saved"
  });

  it('prices a GPT cold turn (cached_tokens=0) at the FULL text delta, not the 0.1× warm rate', async () => {
    // Parity with the Anthropic cold-miss test: when OpenAI reports no cached
    // tokens, the text counterfactual was cold too, so the whole text↔image
    // delta is credited at 1.0× (not 0.1×). Under-pricing it here would HIDE a
    // real win; over-pricing it on a warm turn would FABRICATE one — both wrong.
    //   actual   = 10000 (no cache discount)
    //   baseline = 10000 + (50000 - 8000)×1.0 = 52000
    //   saved    = 42000
    dash.update({
      ...structuredClone(gptUpdate),
      usage: { input_tokens: 10000, output_tokens: 200, cached_tokens: 0 },
      info: { ...structuredClone(gptUpdate.info), firstUserSha8: 'gptcold' },
    } as never);
    const stats = (await dash.serveStats().json()) as StatsPayload;
    expect(stats.actual_input_weighted).toBe(10000);
    expect(stats.baseline_input_weighted).toBe(52000);
    expect(stats.saved_input_tokens).toBe(42000);
    const recent = (await dash.serveRecent().json()) as RecentPayload;
    const row = recent.recent.at(-1)!;
    expect(row.cache_read).toBe(0);
    expect(row.baseline_input).toBe(52000);
    expect(row.actual_input).toBe(10000);
  });

  it('does not credit savings on an uncompressed GPT passthrough row', async () => {
    dash.update({
      ...structuredClone(gptUpdate),
      info: {
        compressed: false,
        imageTokens: 0,
        baselineImagedTokens: 0,
        firstUserSha8: 'gptsess2',
      },
    } as never);
    const stats = (await dash.serveStats().json()) as StatsPayload;
    expect(stats.saved_input_tokens).toBe(0);
    const recent = (await dash.serveRecent().json()) as RecentPayload;
    expect(recent.recent.at(-1)!.session_saved_so_far_delta ?? 0).toBe(0);
  });

  it('uses the Anthropic 1-hour cache-write split in dashboard savings', async () => {
    setAllowedModelBases(['claude-fable-5']);
    dash.update({
      method: 'POST', path: '/v1/messages', model: 'claude-fable-5-20260609', status: 200,
      durationMs: 1,
      usage: {
        input_tokens: 1000,
        output_tokens: 0,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 0,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 2000,
        },
      },
      info: {
        compressed: true,
        baselineTokens: 10000,
        baselineCacheableTokens: 9000,
        baselineProbeStatus: 'ok',
        firstUserSha8: 'onehour',
      },
    } as never);

    const stats = (await dash.serveStats().json()) as StatsPayload;
    expect(stats.actual_input_weighted).toBe(5000);
    expect(stats.baseline_input_weighted).toBe(19000);
    expect(stats.saved_input_tokens).toBe(14000);
    expect(stats.saved_usd).toBe(0.14);
  });

  it('replay() preserves Anthropic 1-hour cache-write accounting', async () => {
    writeEvents(tmp, [
      ev({
        model: 'claude-fable-5-20260609',
        compressed: true,
        input_tokens: 1000,
        cache_create_tokens: 2000,
        cache_create_5m_tokens: 0,
        cache_create_1h_tokens: 2000,
        baseline_tokens: 10000,
        baseline_cacheable_tokens: 9000,
        baseline_probe_status: 'ok',
        first_user_sha8: 'onehour-replay',
      }),
    ]);
    await dash.replay(tmp.eventsFile);

    const recent = (await dash.serveRecent().json()) as RecentPayload;
    const row = recent.recent.at(-1)!;
    expect(row.actual_input).toBe(5000);
    expect(row.baseline_input).toBe(19000);
    expect(row.session_saved_so_far_delta).toBe(14000);
  });

  it('replay() reconstructs GPT recent rows byte-identically to the live path', async () => {
    writeEvents(tmp, [
      ev({
        path: '/openai/responses',
        model: 'gpt-5.5',
        compressed: true,
        input_tokens: 10000,
        output_tokens: 200,
        cached_tokens: 2000,
        image_tokens: 8000,
        baseline_imaged_tokens: 50000,
        image_count: 1,
        first_user_sha8: 'gptsess1',
      }),
    ]);
    await dash.replay(tmp.eventsFile);
    const recent = (await dash.serveRecent().json()) as RecentPayload;
    const row = recent.recent.at(-1)!;
    expect(row.cache_read).toBe(2000);
    expect(row.baseline_input).toBe(12400);
    expect(row.actual_input).toBe(8200);
    expect(row.session_saved_so_far_delta).toBe(4200);
  });

  it('uses OpenAI accounting for a bridged Sol Messages event and subtracts proxy overhead', async () => {
    setAllowedModelBases(['gpt-5.6-sol']);
    dash.update({
      ...structuredClone(gptUpdate),
      path: '/v1/messages',
      accountingProvider: 'openai',
      model: 'gpt-5.6-sol',
      usage: { input_tokens: 10000, output_tokens: 200, cached_tokens: 2000 },
      info: {
        ...structuredClone(gptUpdate.info),
        nativeInjectedTokens: 1000,
        firstUserSha8: 'bridgedsol',
      },
    } as never);
    const recent = (await dash.serveRecent().json()) as RecentPayload;
    const row = recent.recent.at(-1)!;
    // actual=8200; baseline=8200+(50000-8000-1000)*0.1=12300
    expect(row.actual_input).toBe(8200);
    expect(row.baseline_input).toBe(12300);
    expect(row.session_saved_so_far_delta).toBe(4100);
  });

  it('replays bridged Sol Messages with the same provider and overhead semantics', async () => {
    setAllowedModelBases(['gpt-5.6-sol']);
    writeEvents(tmp, [ev({
      path: '/v1/messages',
      accounting_provider: 'openai',
      model: 'gpt-5.6-sol',
      compressed: true,
      input_tokens: 10000,
      output_tokens: 200,
      cached_tokens: 2000,
      image_tokens: 8000,
      baseline_imaged_tokens: 50000,
      native_injected_tokens: 1000,
      image_count: 1,
      first_user_sha8: 'bridgedsol',
    })]);
    await dash.replay(tmp.eventsFile);
    const recent = (await dash.serveRecent().json()) as RecentPayload;
    const row = recent.recent.at(-1)!;
    expect(row.actual_input).toBe(8200);
    expect(row.baseline_input).toBe(12300);
    expect(row.session_saved_so_far_delta).toBe(4100);
  });
});

describe('server-observed warmth: text follows actual cache_read', () => {
  // The text counterfactual is hypothetical, so its cache state follows the only
  // server-observed signal we have: cr>0 means warm for both paths, cr===0 means
  // cold for both paths. A prior row only refines reused/grown split after cr>0.
  function antEvt(
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    },
    cacheable: number,
    sid = 'warmsess',
    systemSha8 = 'stable-system',
  ): unknown {
    return {
      ts: '2026-05-19T00:00:00Z',
      method: 'POST',
      path: '/v1/messages',
      model: 'claude-opus-4',
      status: 200,
      duration_ms: 100,
      usage,
      info: {
        compressed: true,
        firstUserSha8: sid,
        systemSha8,
        baselineProbeStatus: 'ok',
        baselineTokens: 30000, // text counterfactual: full prefix + tail
        baselineCacheableTokens: cacheable, // prefix up to the cache_control marker
      },
    };
  }

  it('prices text cold when the actual image request has cache_read=0', async () => {
    // Turn 1 records a prior prefix size, but it must not make a later cr=0 row
    // warm by wall-clock inference alone.
    dash.update(
      antEvt(
        {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 20000, // warm read
        },
        20000,
      ) as never,
    );

    // Turn 2: actual request has cache_read === 0 and pays a full re-create.
    // The imagined text path gets the same cold cache state.
    dash.update(
      antEvt(
        {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 20000, // re-created the whole prefix
          cache_read_input_tokens: 0, // ← the image-cache miss
        },
        20000,
      ) as never,
    );

    const recent = (await dash.serveRecent().json()) as RecentPayload;
    const miss = recent.recent.at(-1)!;

    // pxpipe's image really did miss — it paid the cold create this turn.
    expect(miss.cache_read).toBe(0);

    // actual = 100 + 20000×1.25 = 25100 (what pxpipe actually paid this turn).
    expect(miss.actual_input).toBe(25100);

    // Cold text baseline: 20000×1.25 + 10000 tail = 35000.
    expect(miss.baseline_input).toBe(35000);
    expect(miss.session_saved_so_far_delta).toBe(9900);
  });

  it('does not let an overlapping request warm the text counterfactual before it completed', async () => {
    writeEvents(tmp, [
      ev({
        ts: '2026-05-19T00:00:20.000Z',
        duration_ms: 20_000,
        compressed: true,
        first_user_sha8: 'overlap',
        system_sha8: 'stable-system',
        baseline_probe_status: 'ok',
        baseline_tokens: 30_000,
        baseline_cacheable_tokens: 20_000,
        input_tokens: 100,
        output_tokens: 50,
        cache_create_tokens: 20_000,
        cache_read_tokens: 0,
      }),
      ev({
        // Starts at 00:00:15, five seconds BEFORE the prior request completed.
        // cr>0 proves warmth, but that prior could not refine the text baseline's
        // reused/grown split for this in-flight request.
        ts: '2026-05-19T00:00:25.000Z',
        duration_ms: 10_000,
        compressed: true,
        first_user_sha8: 'overlap',
        system_sha8: 'stable-system',
        baseline_probe_status: 'ok',
        baseline_tokens: 32_000,
        baseline_cacheable_tokens: 22_000,
        input_tokens: 100,
        output_tokens: 50,
        cache_create_tokens: 2_000,
        cache_read_tokens: 20_000,
      }),
    ]);
    await dash.replay(tmp.eventsFile);

    const recent = (await dash.serveRecent().json()) as RecentPayload;
    const overlap = recent.recent.at(-1)!;
    expect(overlap.cache_read).toBe(20000);
    expect(overlap.actual_input).toBe(4600);
    // Warm via cr>0, but no completed prior was available at send time, so the
    // text baseline assumes full reuse instead of using the overlapping prior:
    // 22000×0.1 + 10000 tail = 12200.
    expect(overlap.baseline_input).toBe(12200);
    expect(overlap.session_saved_so_far_delta).toBe(7600);
  });

  it('prices text cold when cache_read=0 even if the static prefix hash changed inside the old TTL window', async () => {
    dash.update(
      antEvt(
        {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 20000,
        },
        20000,
        'hashsess',
        'old-system',
      ) as never,
    );

    dash.update(
      antEvt(
        {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 20000,
          cache_read_input_tokens: 0,
        },
        20000,
        'hashsess',
        'new-system',
      ) as never,
    );

    const recent = (await dash.serveRecent().json()) as RecentPayload;
    const changed = recent.recent.at(-1)!;
    // cache_read=0, so the text path is cold too:
    // baseline = 20000*1.25 + 10000 tail = 35000, not warm 12000.
    expect(changed.baseline_input).toBe(35000);
    expect(changed.session_saved_so_far_delta).toBe(9900);
  });

  it('still prices a genuine warm turn warm (cr>0 reads the prefix cheaply)', async () => {
    // Prime, then a real warm turn: cache_read > 0, small growth.
    dash.update(
      antEvt(
        {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 20000,
          cache_read_input_tokens: 0,
        },
        20000,
      ) as never,
    );
    dash.update(
      antEvt(
        {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 2000, // grew the prefix by 2000
          cache_read_input_tokens: 20000, // warm read of the rest
        },
        22000,
      ) as never,
    );

    const recent = (await dash.serveRecent().json()) as RecentPayload;
    const warm = recent.recent.at(-1)!;
    expect(warm.cache_read).toBe(20000);
    // actual = 100 + 2000×1.25 + 20000×0.1 = 4600.
    expect(warm.actual_input).toBe(4600);
    // warm baseline: 20000×0.1 (reused) + 2000×1.25 (grown) + 8000 tail = 12500.
    expect(warm.baseline_input).toBe(12500);
    expect(warm.session_saved_so_far_delta).toBe(7900);
  });

  it('prices a warm read warm even with NO prior warmth state (post-restart)', async () => {
    // The cache is already warm on Anthropic's side (cr>0), but this process has
    // never seen the session — exactly the first turn after a pxpipe restart or a
    // SESSION_CAP eviction. The OLD code required
    // an in-memory warmthPrev entry, so it fell through to the COLD branch and
    // billed the known-cached prefix the 1.25× CREATE rate — fabricating the
    // inflated "99% saved" row the operator reported. cr>0 is direct proof the
    // prefix was cached, so it must be priced as a warm READ.
    dash.update(
      antEvt(
        {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 20000, // warm read on the FIRST turn we see
        },
        20000,
        'restartsess', // never primed in this process
      ) as never,
    );

    const recent = (await dash.serveRecent().json()) as RecentPayload;
    const row = recent.recent.at(-1)!;
    expect(row.cache_read).toBe(20000);

    // actual = 100 + 20000×0.1 = 2100 (we paid the warm read rate).
    expect(row.actual_input).toBe(2100);

    // Warm baseline with full prefix reuse (no prior ⇒ prevCacheable = cacheable):
    // 20000×0.1 (reused) + 0 (grown) + 10000 tail = 12000. NOT the cold
    // 20000×1.25 + 10000 = 35000 the old code produced (which would have shown a
    // 32900-token / ~94% "saved" against a 2100-token actual — the inflated row).
    expect(row.baseline_input).toBe(12000);
    expect(row.baseline_input).not.toBe(35000); // the inflated cold-priced bug value
    expect(row.session_saved_so_far_delta).toBe(9900);
  });
});
