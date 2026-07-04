/**
 * End-to-end: the context router wired through the REAL transform via `keepSharp`.
 *
 * Proves the one production gap the router closes — pxpipe silently images secrets —
 * and that turning the router on fixes it without killing the savings on safe blocks.
 * No transform.ts fork: everything rides the existing `keepSharp` hook, exactly as
 * node.ts wires it from PXPIPE_CONTEXT_ROUTER.
 */

import { describe, expect, it } from 'vitest';
import { transformRequest } from '../src/core/transform.js';
import { makeKeepSharp, contextRouterPolicyFromEnv } from '../src/core/context-router.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeReq(content: unknown[], model = 'claude-fable-5') {
  return enc.encode(
    JSON.stringify({
      model,
      system: 'x'.repeat(80_000), // large slab → compression path is active
      messages: [{ role: 'user', content }],
    }),
  );
}
function userBlocks(body: Uint8Array): any[] {
  const req = JSON.parse(dec.decode(body));
  const user = (req.messages ?? []).find((m: any) => m.role === 'user');
  return Array.isArray(user?.content) ? user.content : [];
}
function bodyText(body: Uint8Array): string {
  return dec.decode(body);
}

const SECRET = 'sk-ant-api03-DEADBEEFdeadbeef1234567890SECRETvalue';
// A big tool_result that carries a secret in an otherwise imageable payload.
const SECRET_PAYLOAD =
  'log output line describing what happened during the run\n'.repeat(400) +
  `resolved credential ANTHROPIC_API_KEY=${SECRET}\n`;
// Big low-risk prose with no exact anchors — should still image with the router on.
const SAFE_PAYLOAD = 'the pipeline processed the batch and moved on to the next stage. '.repeat(400);

describe('context router e2e via keepSharp', () => {
  it('GAP: without the router, a secret-bearing tool_result gets imaged', async () => {
    const { body, info } = await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'toolu_s', content: SECRET_PAYLOAD }]),
      { multiCol: 1, charsPerToken: 2 },
    );
    expect(info.toolResultImgs ?? 0).toBeGreaterThan(0); // imaged
    // The secret is no longer present as text — it now lives only in the PNG pixels,
    // where a capable model can read it back. That's the silent-imaging failure.
    expect(bodyText(body)).not.toContain(SECRET);
  });

  it('FIX: with the router, the secret block stays text and the value survives verbatim', async () => {
    const { body, info } = await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'toolu_s', content: SECRET_PAYLOAD }]),
      { multiCol: 1, charsPerToken: 2, keepSharp: makeKeepSharp('coding-agent') },
    );
    expect(info.keptSharpBlocks ?? 0).toBeGreaterThan(0);
    expect(info.toolResultImgs ?? 0).toBe(0); // NOT imaged
    // Secret preserved exactly as sent — never rendered into pixels.
    const tr = userBlocks(body).find((b) => b.tool_use_id === 'toolu_s');
    const text = typeof tr?.content === 'string' ? tr.content : (tr?.content ?? []).find((b: any) => b.type === 'text')?.text;
    expect(text).toContain(SECRET);
  });

  it('SAVINGS PRESERVED: large low-risk prose still images with the router on', async () => {
    const { info } = await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'toolu_p', content: SAFE_PAYLOAD }]),
      { multiCol: 1, charsPerToken: 2, keepSharp: makeKeepSharp('coding-agent') },
    );
    expect(info.toolResultImgs ?? 0).toBeGreaterThan(0); // still compressed
    expect(info.keptSharpBlocks ?? 0).toBe(0);
  });

  it('mixed request: secret pinned to text while safe sibling images', async () => {
    const { body, info } = await transformRequest(
      makeReq([
        { type: 'tool_result', tool_use_id: 'secret', content: SECRET_PAYLOAD },
        { type: 'tool_result', tool_use_id: 'safe', content: SAFE_PAYLOAD },
      ]),
      { multiCol: 1, charsPerToken: 2, keepSharp: makeKeepSharp('coding-agent') },
    );
    expect(info.keptSharpBlocks ?? 0).toBe(1);
    expect(info.toolResultImgs ?? 0).toBeGreaterThan(0);
    const blocks = userBlocks(body);
    const secret = blocks.find((b) => b.tool_use_id === 'secret');
    const secretText = typeof secret?.content === 'string' ? secret.content : (secret?.content ?? []).find((b: any) => b.type === 'text')?.text;
    expect(secretText).toContain(SECRET);
    const safe = blocks.find((b) => b.tool_use_id === 'safe');
    const safeImaged = Array.isArray(safe?.content) && safe.content.some((b: any) => b.type === 'image');
    expect(safeImaged).toBe(true);
  });
});

function makeReqWithSystem(system: string, content: unknown[], model = 'claude-fable-5') {
  return enc.encode(JSON.stringify({ model, system, messages: [{ role: 'user', content }] }));
}

describe('slab secret guard', () => {
  // A large static slab (images by default) that hides a secret in it.
  const SLAB_SECRET = 'sk-ant-api03-SLABsecretDEADBEEF1234567890abcdef';
  const SECRET_SLAB =
    'You are a helpful assistant. '.repeat(3000) + `\nDEPLOY_KEY=${SLAB_SECRET}\n`;
  // Large slab rich in paths/versions but NO secret — must still image with guard on.
  const SAFE_SLAB =
    ('Use the module at src/core/handler.ts, pinned to v2.4.1, see docs/guide.md. ').repeat(2000);
  const trivial = [{ type: 'text', text: 'hi' }];

  it('GAP: without the guard, a secret in the system slab gets imaged', async () => {
    const { body, info } = await transformRequest(
      makeReqWithSystem(SECRET_SLAB, trivial),
      { charsPerToken: 2 },
    );
    expect(info.compressed).toBe(true); // slab imaged
    expect(bodyText(body)).not.toContain(SLAB_SECRET); // secret now only in pixels
  });

  it('FIX: with guardSlabSecrets, the slab stays text and the secret survives', async () => {
    const { body, info } = await transformRequest(
      makeReqWithSystem(SECRET_SLAB, trivial),
      { charsPerToken: 2, guardSlabSecrets: true },
    );
    expect(info.compressed).toBe(false);
    expect(info.reason).toBe('slab_secret_guard');
    expect(bodyText(body)).toContain(SLAB_SECRET); // preserved verbatim, never imaged
  });

  it('NO FALSE TRIGGER: a path/version-rich slab with no secret still images', async () => {
    const { info } = await transformRequest(
      makeReqWithSystem(SAFE_SLAB, trivial),
      { charsPerToken: 2, guardSlabSecrets: true },
    );
    expect(info.compressed).toBe(true); // compression untouched in the common case
    expect(info.reason).not.toBe('slab_secret_guard');
  });
});

describe('PXPIPE_CONTEXT_ROUTER env resolution', () => {
  const prev = process.env.PXPIPE_CONTEXT_ROUTER;
  const set = (v: string | undefined) => {
    if (v === undefined) delete process.env.PXPIPE_CONTEXT_ROUTER;
    else process.env.PXPIPE_CONTEXT_ROUTER = v;
  };
  const restore = () => set(prev);

  it('off / unset / falsey → null (default, no behavior change)', () => {
    set(undefined);
    expect(contextRouterPolicyFromEnv()).toBeNull();
    set('off');
    expect(contextRouterPolicyFromEnv()).toBeNull();
    set('0');
    expect(contextRouterPolicyFromEnv()).toBeNull();
    restore();
  });

  it('on / strict / named policies resolve', () => {
    set('on');
    expect(contextRouterPolicyFromEnv()).toBe('coding-agent');
    set('strict');
    expect(contextRouterPolicyFromEnv()).toBe('strict');
    set('research');
    expect(contextRouterPolicyFromEnv()).toBe('research');
    set('garbage');
    expect(contextRouterPolicyFromEnv()).toBe('coding-agent'); // fail safe, not off
    restore();
  });
});
