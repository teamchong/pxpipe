/**
 * `<cc_automode_session_rules>`, `<cc_automode_permissions>`, `<severity>`, and
 * `<category>` are per-turn blocks emitted by newer Claude Code builds. Left
 * out of DYNAMIC_BLOCK_TAGS they fall into the static slab and get imaged
 * along with the rest of the identity block (see #234).
 *
 * Same shape as dynamic-total-tokens.test.ts: an unrecognized per-turn tag
 * re-keys (or, per #234, corrupts the provider's read of) the cacheable
 * image every turn instead of being routed to the dynamic tail.
 *
 * Run just this file:  pnpm vitest run tests/dynamic-cc-automode-tags.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { transformRequest } from '../src/core/transform.js';
import { resetSessionState } from '../src/core/session-state.js';

const big = (n: number) => 'x'.repeat(n);
const enc = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));

/** Claude-Code-shaped system content carrying the newer automode block. */
function systemWithAutomodeBlock(rulesId: string, severity: string): string {
  return [
    'You are a helpful assistant.',
    big(40_000),
    `<cc_automode_session_rules>${rulesId}</cc_automode_session_rules>`,
    '<cc_automode_permissions>allow-all</cc_automode_permissions>',
    `<severity>${severity}</severity>`,
    '<category>automode</category>',
  ].join('\n');
}

function bodyWithAutomodeBlock(rulesId: string, severity: string) {
  return enc({
    model: 'claude-sonnet-5',
    system: [{ type: 'text', text: systemWithAutomodeBlock(rulesId, severity) }],
    messages: [{ role: 'user', content: 'go' }],
  });
}

describe('cc_automode_* / severity / category are classified as dynamic', () => {
  beforeEach(() => resetSessionState());

  it('does not report any of the four tags as unknown static blocks', async () => {
    const { info } = await transformRequest(bodyWithAutomodeBlock('turn-1', 'info'));
    const unknown = info.unknownStaticTags ?? [];
    expect(unknown).not.toContain('cc_automode_session_rules');
    expect(unknown).not.toContain('cc_automode_permissions');
    expect(unknown).not.toContain('severity');
    expect(unknown).not.toContain('category');
  });

  it('keeps the static slab byte-identical when only the block content moves', async () => {
    const first = await transformRequest(bodyWithAutomodeBlock('turn-1', 'info'));
    resetSessionState();
    const second = await transformRequest(bodyWithAutomodeBlock('turn-2', 'warning'));

    // Precondition: this request really did produce an imaged slab.
    expect(first.info.imageCount).toBeGreaterThan(0);
    expect(first.info.systemSha8).toBeDefined();

    // The headline: the cacheable image is unchanged across the two turns.
    expect(second.info.systemSha8).toBe(first.info.systemSha8);
  });

  it('routes the block into the dynamic text, not the imaged slab', async () => {
    const first = await transformRequest(bodyWithAutomodeBlock('turn-1', 'info'));
    resetSessionState();
    const second = await transformRequest(bodyWithAutomodeBlock('turn-2', 'warning'));

    expect(first.info.dynamicChars ?? 0).toBeGreaterThan(0);
    expect(second.info.dynamicChars).not.toBe(first.info.dynamicChars);
  });
});
