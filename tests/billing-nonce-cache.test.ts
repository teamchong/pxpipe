/**
 * The cache-prefix DIGEST must agree with what the endpoint actually caches
 * when a per-request billing nonce is in play.
 *
 * Claude Code's interactive CLI entrypoint sends
 *   `x-anthropic-billing-header: cc_version=...; cc_entrypoint=cli; cch=<rnd>; cc_prev_req=req_<id>;`
 * with `cch` and `cc_prev_req` changing on EVERY request. Upstream now drops
 * the billing block from the outgoing body entirely (stripBillingLine, covered
 * by tests/billing-line-cache.test.ts; verified here: 3 system blocks in, 2
 * out, nonce gone), so the request-side fix needs no fork test anymore. What stays fork-relevant is the
 * *diagnostic*: cachePrefixDigest must ignore the nonce exactly where the
 * endpoint ignores it (leading billing block) and must keep reporting a bust
 * where the endpoint does bust (billing text buried behind cached blocks).
 * Otherwise the dashboard chases phantom cache-bust culprits — that was the
 * failure mode behind the "wandering cache_prefix_sha8" false alarm.
 *
 * Fixture is a real captured Claude Code request body, so the shape (system
 * block order, cache_control placement) is the client's, not our guess.
 *
 * Run just this file:  pnpm vitest run tests/billing-nonce-cache.test.ts
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cachePrefixDigest, transformRequest } from '../src/core/transform.js';

const FIXTURE = new URL('./fixtures/claude-code-cli-request.json', import.meta.url);

function billingLine(cch: string, prevReq: string): string {
  return `x-anthropic-billing-header: cc_version=2.1.220.85f; cc_entrypoint=cli; cch=${cch}; cc_prev_req=req_${prevReq};`;
}

/** The captured body with a different billing nonce spliced in — nothing else. */
function bodyWithNonce(cch: string, prevReq: string): Uint8Array {
  const req = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const sys = req.system;
  if (!Array.isArray(sys)) throw new Error('fixture system is not a block array');
  const idx = sys.findIndex(
    (b: { type?: string; text?: string }) =>
      typeof b?.text === 'string' && b.text.startsWith('x-anthropic-billing-header:'),
  );
  if (idx < 0) throw new Error('fixture carries no billing header block');
  sys[idx] = { ...sys[idx], text: billingLine(cch, prevReq) };
  return new TextEncoder().encode(JSON.stringify(req));
}

describe('cache-prefix digest vs. per-request billing nonce', () => {
  it('fixture is a real CLI request: billing header leads, uncached, others cached', () => {
    const req = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    expect(req.system[0].text.startsWith('x-anthropic-billing-header:')).toBe(true);
    expect(req.system[0].cache_control ?? null).toBe(null);
    expect(req.system.slice(1).some((b: { cache_control?: unknown }) => b.cache_control)).toBe(true);
  });

  it('is one stable sha8 across billing nonces — via transformRequest', async () => {
    const a = await transformRequest(bodyWithNonce('aaaaaaaa', 'AAAAAAAAAAAAAAAA'));
    const b = await transformRequest(bodyWithNonce('bbbbbbbb', 'BBBBBBBBBBBBBBBB'));

    // Upstream semantics: the billing block is dropped from the outgoing body
    // entirely — neither nonce may survive anywhere in either output.
    const outA = JSON.parse(new TextDecoder().decode(a.body));
    const outB = JSON.parse(new TextDecoder().decode(b.body));
    const carries = (o: { system: unknown }) =>
      JSON.stringify(o.system).includes('x-anthropic-billing-header');
    expect(carries(outA)).toBe(false);
    expect(carries(outB)).toBe(false);

    // … yet the digest — the dashboard's cache identity — does not move.
    expect(b.info.cachePrefixSha8).toBe(a.info.cachePrefixSha8);
    expect(b.info.cachePrefixBytes).toBe(a.info.cachePrefixBytes);
  });

  // Positional, and it matters: only a *leading* billing block is lifted out of
  // the endpoint's cache key. Buried, it does bust the cache — the digest has to
  // keep saying so. Unreachable through transformRequest (liftBillingBlock always
  // re-leads it), hence the direct call.
  const cached = { type: 'text', text: 'static system prefix', cache_control: { type: 'ephemeral' } };
  const reqWith = (system: unknown[]) => ({
    tools: [],
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: '[End of rendered context.]' }] }],
  });
  const bill = (cch: string) => ({ type: 'text', text: billingLine(cch, 'AAAAAAAAAAAAAAAA') });

  it('ignores the nonce when the billing block leads', async () => {
    const a = await cachePrefixDigest(reqWith([bill('aaaaa'), cached]));
    const b = await cachePrefixDigest(reqWith([bill('bbbbb'), cached]));
    expect(a?.sha8).toBeDefined();
    expect(b?.sha8).toBe(a?.sha8);
  });

  it('still reports a bust when the billing block is buried', async () => {
    const a = await cachePrefixDigest(reqWith([cached, bill('aaaaa')]));
    const b = await cachePrefixDigest(reqWith([cached, bill('bbbbb')]));
    expect(a?.sha8).toBeDefined();
    expect(b?.sha8).not.toBe(a?.sha8);
  });
});
