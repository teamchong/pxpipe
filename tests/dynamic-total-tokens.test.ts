/**
 * `<total_tokens>` is a per-turn counter, so it must not sit in the static slab.
 *
 * The slab is the cacheable prefix: it is rendered to a PNG whose bytes have to
 * repeat across turns for the provider to serve a cache read. A block whose value
 * changes every turn re-keys that image every turn, which turns the prefix into a
 * permanent cache create - the most expensive possible shape, and one that looks
 * like "compression is not saving anything" rather than like a bug.
 *
 * The two requests below differ in one number and nothing else. The imaged slab
 * must be byte-identical between them; only the dynamic tail may move.
 *
 * Run just this file:  pnpm vitest run tests/dynamic-total-tokens.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { transformRequest } from '../src/core/transform.js';
import { resetSessionState } from '../src/core/session-state.js';

const big = (n: number) => 'x'.repeat(n);
const enc = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));

/** Claude-Code-shaped system content carrying a running token counter. */
function systemWithTotalTokens(totalTokens: number): string {
  return [
    'You are a helpful assistant.',
    big(40_000),
    `<total_tokens>${totalTokens}</total_tokens>`,
  ].join('\n');
}

function bodyWithTotalTokens(totalTokens: number) {
  return enc({
    model: 'claude-3-5-sonnet',
    system: [{ type: 'text', text: systemWithTotalTokens(totalTokens) }],
    messages: [{ role: 'user', content: 'go' }],
  });
}

describe('total_tokens is classified as dynamic', () => {
  beforeEach(() => resetSessionState());

  it('keeps the static slab byte-identical when only the counter moves', async () => {
    const first = await transformRequest(bodyWithTotalTokens(1_234));
    resetSessionState();
    const second = await transformRequest(bodyWithTotalTokens(9_876_543));

    // Precondition: this request really did produce an imaged slab.
    expect(first.info.imageCount).toBeGreaterThan(0);
    expect(first.info.systemSha8).toBeDefined();

    // The headline: the cacheable image is unchanged across the two turns.
    expect(second.info.systemSha8).toBe(first.info.systemSha8);
  });

  it('does not report the tag as an unknown static block', async () => {
    const { info } = await transformRequest(bodyWithTotalTokens(4_242));
    expect(info.unknownStaticTags ?? []).not.toContain('total_tokens');
  });

  it('routes the counter into the dynamic text, where per-turn churn is free', async () => {
    const first = await transformRequest(bodyWithTotalTokens(1_234));
    resetSessionState();
    const second = await transformRequest(bodyWithTotalTokens(9_876_543));

    // Both turns carry a dynamic section, and it is the part that differs.
    expect(first.info.dynamicChars ?? 0).toBeGreaterThan(0);
    expect(second.info.dynamicChars).not.toBe(first.info.dynamicChars);
  });
});
