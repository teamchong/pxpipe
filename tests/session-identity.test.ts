import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';
import { sha8, transformRequest } from '../src/core/transform.js';
import { toTrackEvent } from '../src/core/tracker.js';
import {
  isBoilerplateText, markCacheDead, peekSessionState,
  recordFreezeStep, resetSessionState, serializeSessionState, sessionAnchorText,
} from '../src/core/session-state.js';

const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const command = '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args></command-args>';
const boilerplate = [
  '<local-command-caveat>local only</local-command-caveat>', command,
  '<local-command-stdout>high</local-command-stdout>',
];
const request = (anchor = 'audit the request') => enc({
  model: 'claude-fable-5',
  messages: [
    ...boilerplate.map((text) => ({ role: 'user', content: [{ type: 'text', text }] })),
    { role: 'user', content: anchor },
  ],
});

describe('session identity', () => {
  beforeEach(() => resetSessionState());

  it('skips complete boilerplate sequences, keeping mixed prose and the fallback/cap', () => {
    for (const tag of ['system-notice', 'system-reminder', 'local-command-caveat',
      'local-command-stdout', 'local-command-stderr', 'command-name', 'command-message', 'command-args']) {
      expect(isBoilerplateText(` \n<${tag}>body\n</${tag}>\t${command} `)).toBe(true);
    }
    expect(sessionAnchorText([...boilerplate, 'real request'])).toBe('real request');
    for (const text of [`${command}\nreal request`, '<command-name>unclosed',
      '<command-name>wrong close</command-message>', '<unknown>body</unknown>',
      '<system-reminder>one</system-reminder> prose <system-reminder>two</system-reminder>']) {
      expect(isBoilerplateText(text)).toBe(false);
      expect(sessionAnchorText([text, 'later'])).toBe(text);
    }
    expect(sessionAnchorText(boilerplate)).toBe(boilerplate[0]);
    expect(sessionAnchorText(['x'.repeat(5000)])).toBe('x'.repeat(4096));
  });

  it('hashes client id plus anchor, keeping telemetry identity and wire bytes unchanged', async () => {
    const body = request();
    const plain = await transformRequest(body);
    const a = await transformRequest(body, { claudeCodeSessionId: 'session_A' });
    const b = await transformRequest(body, { claudeCodeSessionId: 'session_B' });
    const side = await transformRequest(request('side request'), { claudeCodeSessionId: 'session_A' });
    expect(plain.info.firstUserSha8).toBe(await sha8('audit the request'));
    expect(plain.info.sessionKey).toBe(plain.info.firstUserSha8);
    expect(plain.info.sessionKeySource).toBe('anchor');
    expect(a.info.firstUserSha8).toBe(plain.info.firstUserSha8);
    expect(a.info.sessionKey).toBe(await sha8('cc-session:session_A\naudit the request'));
    expect(a.info.sessionKeySource).toBe('client');
    expect(new Set([a.info.sessionKey, b.info.sessionKey, side.info.sessionKey]).size).toBe(3);
    expect(a.body).toEqual(body);
    expect(b.body).toEqual(plain.body);
    for (const id of ['short', 'x'.repeat(129), 'invalid.id', 'session_A\n', 'session A']) {
      const invalid = await transformRequest(body, { claudeCodeSessionId: id });
      expect(invalid.info.sessionKey).toBe(plain.info.sessionKey);
      expect(invalid.info.sessionKeySource).toBe('anchor');
      expect(invalid.body).toEqual(plain.body);
    }
    for (const id of ['a'.repeat(8), 'Z_-'.repeat(42) + 'ab']) {
      expect((await transformRequest(body, { claudeCodeSessionId: id })).info.sessionKeySource).toBe('client');
    }
  });

  it('isolates history freeze and dead-cache feedback by client key', async () => {
    const body = enc({ model: 'claude-3-5-sonnet', messages: [
      { role: 'user', content: 'shared opening prompt' },
      ...Array.from({ length: 45 }, (_, i) => ({
        role: i % 2 === 0 ? 'assistant' : 'user', content: `turn ${i}: ` + 'x'.repeat(3500),
      })),
    ] });
    const a = await transformRequest(body, { claudeCodeSessionId: 'session_A' });
    expect(a.info.collapsedTurns).toBeGreaterThan(0);
    expect(peekSessionState(a.info.sessionKey!)?.freezeStep).toBe(a.info.historyFreezeStep);
    expect(peekSessionState(a.info.firstUserSha8!)).toBeUndefined();
    recordFreezeStep(a.info.sessionKey, 1280);
    markCacheDead(a.info.sessionKey);
    const b = await transformRequest(body, { claudeCodeSessionId: 'session_B' });
    expect(b.info.historyPackFill).toBeUndefined();
    expect(b.info.historyFreezeStep).toBeLessThan(1280);
    expect(peekSessionState(a.info.sessionKey!)?.cacheDead).toBe(true);
    const again = await transformRequest(body, { claudeCodeSessionId: 'session_A' });
    expect(again.info.historyPackFill).toBe(true);
    expect(serializeSessionState()).not.toContain('session_A');
    expect(serializeSessionState()).not.toContain('session_B');
  });

  it('changes only metadata for requests with an unchanged rendered prefix', async () => {
    const body = enc({ model: 'claude', system: 'static rules\n'.repeat(3000),
      messages: [{ role: 'user', content: 'same task' }] });
    const plain = await transformRequest(body);
    const client = await transformRequest(body, { claudeCodeSessionId: 'session_A' });
    expect(plain.info.compressed).toBe(true);
    expect(client.body).toEqual(plain.body);
  });
});

describe('proxy client session header', () => {
  const originalFetch = globalThis.fetch;
  const originalModels = process.env.PXPIPE_MODELS;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalModels === undefined) delete process.env.PXPIPE_MODELS;
    else process.env.PXPIPE_MODELS = originalModels;
    resetSessionState();
  });

  it('passes valid ids, falls back for invalid/missing ids, and attributes cache outcomes', async () => {
    process.env.PXPIPE_MODELS = 'claude-fable-5';
    let status = 200;
    globalThis.fetch = (async () => new Response(JSON.stringify(status === 200
      ? { usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 123 } }
      : { error: { message: 'prompt too long' } }), {
      status, headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const events: ProxyEvent[] = [];
    const proxy = createProxy({ onRequest: (e) => { events.push(e); } });
    const body = enc({ model: 'claude-fable-5', messages: [
      { role: 'user', content: 'shared prompt' },
      ...Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: 'x'.repeat(2500) })),
    ] });
    for (const id of ['session_A', 'session_B', 'bad.id', undefined]) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (id) headers['x-claude-code-session-id'] = id;
      const res = await proxy(new Request('http://localhost/v1/messages', { method: 'POST', headers, body }));
      await res.text();
      await expect.poll(() => events.length).toBe(id === 'session_A' ? 1 : id === 'session_B' ? 2 : id === 'bad.id' ? 3 : 4);
      if (id === 'session_A') status = 400;
    }
    const [a, b, invalid, missing] = events.map((e) => e.info!);
    expect(a!.sessionKeySource).toBe('client');
    expect(a!.sessionKey).not.toBe(b!.sessionKey);
    expect(peekSessionState(a!.sessionKey!)?.cacheDead).toBe(false);
    expect(peekSessionState(a!.sessionKey!)).toMatchObject({ lastCacheAlive: true, everCacheAlive: true });
    expect(peekSessionState(b!.sessionKey!)?.cacheDead).toBe(true);
    expect(invalid!.sessionKey).toBe(missing!.firstUserSha8);
    expect(missing!.sessionKeySource).toBe('anchor');
    expect(toTrackEvent(events[0]!).session_key_source).toBe('client');
    expect(toTrackEvent(events[3]!).session_key_source).toBe('anchor');
    expect(JSON.stringify(events)).not.toContain('session_A');
    expect(serializeSessionState()).not.toContain('session_A');
  });
});
