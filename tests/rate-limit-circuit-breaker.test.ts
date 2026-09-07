/**
 * A session stuck behind a provider rate limit must stop re-imaging the same
 * doomed bytes.
 *
 * Observed in production (#234): a session retrying an unchanged imaged
 * request got 429 on every attempt, same image_count/image_bytes each time —
 * imaging never got it past the rate limit, because a 429 never populates a
 * fresh prefix cache for the retry to build on. Three 429s in a row is past
 * "unlucky timing"; falling back to plain text gives the session a chance to
 * complete a request, which is also the only way its own cache comes back.
 *
 * Run just this file:  pnpm vitest run tests/rate-limit-circuit-breaker.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { transformRequest } from '../src/core/transform.js';
import {
  isRateLimitCircuitOpen,
  noteRateLimitOutcome,
  peekSessionState,
  resetSessionState,
} from '../src/core/session-state.js';

const big = (n: number) => 'x'.repeat(n);
const enc = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));

function bodyFor(userText: string) {
  return enc({
    model: 'claude-sonnet-5',
    system: [{ type: 'text', text: ['You are a helpful assistant.', big(40_000)].join('\n') }],
    messages: [{ role: 'user', content: userText }],
  });
}

describe('isRateLimitCircuitOpen — unit', () => {
  beforeEach(() => resetSessionState());

  it('stays closed under the threshold', () => {
    noteRateLimitOutcome('sess-a', 429);
    noteRateLimitOutcome('sess-a', 429);
    expect(isRateLimitCircuitOpen('sess-a')).toBe(false);
  });

  it('opens at the third consecutive 429', () => {
    noteRateLimitOutcome('sess-a', 429);
    noteRateLimitOutcome('sess-a', 429);
    noteRateLimitOutcome('sess-a', 429);
    expect(isRateLimitCircuitOpen('sess-a')).toBe(true);
  });

  it('resets on any non-429 response', () => {
    noteRateLimitOutcome('sess-a', 429);
    noteRateLimitOutcome('sess-a', 429);
    noteRateLimitOutcome('sess-a', 200);
    expect(isRateLimitCircuitOpen('sess-a')).toBe(false);
    expect(peekSessionState('sess-a')?.consecutive429).toBe(0);
  });

  it('keeps sessions independent', () => {
    noteRateLimitOutcome('sess-a', 429);
    noteRateLimitOutcome('sess-a', 429);
    noteRateLimitOutcome('sess-a', 429);
    expect(isRateLimitCircuitOpen('sess-a')).toBe(true);
    expect(isRateLimitCircuitOpen('sess-b')).toBe(false);
  });

  it('is closed for a session never seen', () => {
    expect(isRateLimitCircuitOpen('never-seen')).toBe(false);
  });
});

describe('transformRequest — falls back to text once the circuit is open', () => {
  beforeEach(() => resetSessionState());

  it('images normally while the circuit is closed', async () => {
    const { info } = await transformRequest(bodyFor('turn 1'));
    expect(info.imageCount).toBeGreaterThan(0);
    expect(info.compressed).toBe(true);
  });

  it('stops imaging the same session after 3 consecutive 429s', async () => {
    // First request: establishes the session and its firstUserSha8.
    const first = await transformRequest(bodyFor('turn 1'));
    expect(first.info.imageCount).toBeGreaterThan(0);
    const sessionKey = first.info.firstUserSha8;
    expect(sessionKey).toBeDefined();

    // Three consecutive 429s on that session, exactly what proxy.ts records
    // from real upstream responses.
    noteRateLimitOutcome(sessionKey, 429);
    noteRateLimitOutcome(sessionKey, 429);
    noteRateLimitOutcome(sessionKey, 429);

    const after = await transformRequest(bodyFor('turn 1'));
    expect(after.info.compressed).toBe(false);
    expect(after.info.imageCount ?? 0).toBe(0);
    expect(after.info.reason).toContain('rate_limit_circuit_open');
  });

  it('resumes imaging once a request gets through', async () => {
    const first = await transformRequest(bodyFor('turn 1'));
    const sessionKey = first.info.firstUserSha8;

    noteRateLimitOutcome(sessionKey, 429);
    noteRateLimitOutcome(sessionKey, 429);
    noteRateLimitOutcome(sessionKey, 429);
    expect((await transformRequest(bodyFor('turn 1'))).info.compressed).toBe(false);

    // A 200 gets through (e.g. the plain-text fallback request above
    // succeeded) and clears the counter.
    noteRateLimitOutcome(sessionKey, 200);

    const resumed = await transformRequest(bodyFor('turn 1'));
    expect(resumed.info.compressed).toBe(true);
    expect(resumed.info.imageCount).toBeGreaterThan(0);
  });
});
