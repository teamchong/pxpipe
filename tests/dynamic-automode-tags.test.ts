/**
 * Claude Code automode blocks (`cc_automode_session_rules`,
 * `cc_automode_permissions`) are per-turn state: permissions/grants land
 * mid-session, so their content evolves across turns. They must not sit in the
 * static slab, or the imaged cache prefix re-keys every turn (permanent cache
 * create — the most expensive shape).
 *
 * The two requests below differ in one automode payload and nothing else. The
 * imaged slab must be byte-identical between them; only the dynamic tail may
 * move. Nested <severity>/<category> tags ride inside these blocks.
 *
 * Run just this file:  pnpm vitest run tests/dynamic-automode-tags.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { transformRequest } from '../src/core/transform.js';
import { resetSessionState } from '../src/core/session-state.js';

const big = (n: number) => 'x'.repeat(n);
const enc = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));

/** Claude-Code-shaped system content carrying automode state blocks. */
function systemWithAutomode(permission: string): string {
  return [
    'You are a helpful assistant.',
    big(40_000),
    '<cc_automode_session_rules>You may ask before acting.</cc_automode_session_rules>',
    `<cc_automode_permissions>${permission}</cc_automode_permissions>`,
    '<severity>high</severity>',
    '<category>filesystem</category>',
  ].join('\n');
}

function bodyWithAutomode(permission: string) {
  return enc({
    model: 'claude-3-5-sonnet',
    system: [{ type: 'text', text: systemWithAutomode(permission) }],
    messages: [{ role: 'user', content: 'go' }],
  });
}

describe('automode blocks are classified as dynamic', () => {
  beforeEach(() => resetSessionState());

  it('keeps the static slab byte-identical when automode state moves', async () => {
    const first = await transformRequest(bodyWithAutomode('read'));
    resetSessionState();
    const second = await transformRequest(bodyWithAutomode('read,write,admin'));

    // Precondition: this request really did produce an imaged slab.
    expect(first.info.imageCount).toBeGreaterThan(0);
    expect(first.info.systemSha8).toBeDefined();

    // The headline: the cacheable image is unchanged across the two turns.
    expect(second.info.systemSha8).toBe(first.info.systemSha8);
  });

  it('does not report the automode tags as unknown static blocks', async () => {
    const { info } = await transformRequest(bodyWithAutomode('read'));
    expect(info.unknownStaticTags ?? []).not.toContain('cc_automode_session_rules');
    expect(info.unknownStaticTags ?? []).not.toContain('cc_automode_permissions');
  });

  it('routes the automode blocks into the dynamic text', async () => {
    const first = await transformRequest(bodyWithAutomode('read'));
    resetSessionState();
    const second = await transformRequest(bodyWithAutomode('read,write,admin'));

    // Both turns carry a dynamic section, and it is the part that differs.
    expect(first.info.dynamicChars ?? 0).toBeGreaterThan(0);
    expect(second.info.dynamicChars).not.toBe(first.info.dynamicChars);
  });
});
