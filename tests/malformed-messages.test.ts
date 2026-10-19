/**
 * A malformed message/input array must not turn into a 502, on any of the three
 * request-transform entry points.
 *
 * All three JSON.parse the client body and do no per-element shape validation —
 * deliberately, since the upstream API is the authority on what a valid request
 * is and pxpipe's contract is that anything it cannot improve is forwarded
 * byte-identical. But every stage after the parse reads `.role` / `.content` off
 * each element, so a non-object element threw a TypeError straight out of the
 * transform:
 *
 *   /v1/messages          transform.ts:1914  countNativeImages   m.content
 *   /v1/chat/completions  openai.ts:1005     findIndex           m.role
 *   /v1/responses         openai.ts:1223     findIndex           item.role
 *
 * All three transform calls sit inside one try/catch in proxy.ts (the calls at
 * proxy.ts:1776-1782, caught at :1880), so each threw TypeError became
 * `502 {"error":"pxpipe transform failed"}` — replacing the 400 the real API
 * would have returned with a gateway error that blames the proxy.
 *
 * `[null, ...]` is not a shape any client should send, but it is one a client
 * CAN send, and the surrounding code already tolerates malformed input at every
 * other level: `countNativeImages` guards the block
 * (`(blk as {...} | null)?.type`) and the array (`messages ?? []`), the chat
 * path already validates `Array.isArray(req.messages)`, the responses path
 * already validates the input container, and `isPinReply` /
 * `canAppendPinBlock` guard the message object. Only the per-element deref was
 * unguarded.
 *
 * Every request below carries a slab-sized system prompt / instructions block,
 * so each one is a body that genuinely WOULD compress. Without that the
 * requests bail at `below_min_chars` and the assertions would pass for the
 * wrong reason.
 *
 * Contract being verified:
 *   - A non-object element makes the transform return the ORIGINAL bytes with
 *     `reason: 'invalid_messages'` (`'invalid_input'` on the responses path),
 *     never throw.
 *   - The bail-out is byte-exact: the forwarded body is the input body.
 *   - The identical body minus the bad element still compresses, so the guard is
 *     not a blanket opt-out.
 */

import { describe, expect, it } from 'vitest';
import { transformOpenAIChatCompletions, transformOpenAIResponses } from '../src/core/openai.js';
import { transformRequest } from '../src/core/transform.js';

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** Slab-sized: clears minCompressChars (2000) so the body is really imageable. */
const SYSTEM = 'You are a careful assistant. Follow the project conventions. '.repeat(120);

/** The non-object elements a client can actually put in the array. */
const BAD = [
  ['null', null],
  ['a bare string', 'hello'],
  ['a number', 7],
  ['a boolean', false],
] as const;

describe('/v1/messages — malformed messages array', () => {
  for (const [label, element] of BAD) {
    it(`forwards untouched instead of throwing: ${label}`, async () => {
      const body = enc({
        model: 'claude-sonnet-5',
        system: SYSTEM,
        messages: [element, { role: 'user', content: 'summarize the repo' }],
      });
      const out = await transformRequest(body, { compress: true });
      expect(out.info.reason).toBe('invalid_messages');
      expect(out.info.compressed).toBe(false);
      // Byte-exact passthrough: the client's bytes are what goes upstream.
      expect(dec(out.body)).toBe(dec(body));
    });
  }

  it('catches a null element anywhere in the array, not just the first', async () => {
    const body = enc({
      model: 'claude-sonnet-5',
      system: SYSTEM,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        null,
        { role: 'user', content: 'summarize the repo' },
      ],
    });
    const out = await transformRequest(body, { compress: true });
    expect(out.info.reason).toBe('invalid_messages');
    expect(dec(out.body)).toBe(dec(body));
  });

  it('does not silently drop pins when a null element rides along', async () => {
    // The pin block sits behind its own try/catch, so this body degraded to
    // pins-dropped-and-commands-forwarded rather than a clean bail. Either way
    // the commands must survive in the forwarded bytes.
    const body = enc({
      model: 'claude-sonnet-5',
      system: SYSTEM,
      messages: [null, { role: 'user', content: '@pxpipe pin always use tabs' }],
    });
    const out = await transformRequest(body, { compress: true });
    expect(out.info.reason).toBe('invalid_messages');
    expect(dec(out.body)).toContain('@pxpipe pin always use tabs');
  });

  it('still compresses the same body once the bad element is removed', async () => {
    const body = enc({
      model: 'claude-sonnet-5',
      system: SYSTEM,
      messages: [{ role: 'user', content: 'summarize the repo' }],
    });
    const out = await transformRequest(body, { compress: true });
    expect(out.info.reason).toBeUndefined();
    expect(out.info.compressed).toBe(true);
  });
});

describe('/v1/chat/completions — malformed messages array', () => {
  for (const [label, element] of BAD) {
    it(`forwards untouched instead of throwing: ${label}`, async () => {
      const body = enc({
        model: 'gpt-5',
        messages: [
          element,
          { role: 'system', content: SYSTEM },
          { role: 'user', content: 'summarize the repo' },
        ],
      });
      const out = await transformOpenAIChatCompletions(body, { compress: true });
      expect(out.info.reason).toBe('invalid_messages');
      expect(out.info.compressed).toBe(false);
      expect(dec(out.body)).toBe(dec(body));
    });
  }

  it('still compresses the same body once the bad element is removed', async () => {
    const body = enc({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'summarize the repo' },
      ],
    });
    const out = await transformOpenAIChatCompletions(body, { compress: true });
    expect(out.info.reason).toBeUndefined();
    expect(out.info.compressed).toBe(true);
  });
});

describe('/v1/responses — malformed input array', () => {
  for (const [label, element] of BAD) {
    it(`forwards untouched instead of throwing: ${label}`, async () => {
      const body = enc({
        model: 'gpt-5',
        instructions: SYSTEM,
        input: [element, { role: 'user', content: 'summarize the repo' }],
      });
      const out = await transformOpenAIResponses(body, { compress: true });
      expect(out.info.reason).toBe('invalid_input');
      expect(out.info.compressed).toBe(false);
      expect(dec(out.body)).toBe(dec(body));
    });
  }

  it('still compresses the same body once the bad element is removed', async () => {
    const body = enc({
      model: 'gpt-5',
      instructions: SYSTEM,
      input: [{ role: 'user', content: 'summarize the repo' }],
    });
    const out = await transformOpenAIResponses(body, { compress: true });
    expect(out.info.reason).toBeUndefined();
    expect(out.info.compressed).toBe(true);
  });
});
