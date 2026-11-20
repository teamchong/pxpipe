import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/worker.js';
import { setAllowedModelBases } from '../src/core/applicability.js';

afterEach(() => setAllowedModelBases(null));

describe('Cloudflare Worker model profiles', () => {
  it('uses PXPIPE_MODELS and the built-in Opus profile', async () => {
    const originalFetch = globalThis.fetch;
    let forwarded = '';
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      if (new URL(request.url).pathname.endsWith('/count_tokens')) {
        return new Response(JSON.stringify({ input_tokens: 20_000 }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      forwarded = await request.text();
      return new Response(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', content: [],
        model: 'claude-opus-5', stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const body = JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 16,
        system: Array.from({ length: 1800 }, (_, i) => `setting_${i}=value_${i * 7919}`).join('\n'),
        messages: [{ role: 'user', content: 'continue' }],
      });
      const response = await worker.fetch(
        new Request('https://pxpipe.test/v1/messages', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body,
        }),
        {
          ANTHROPIC_UPSTREAM: 'https://anthropic.test',
          PXPIPE_MODELS: 'claude-fable-5,claude-opus-5',
          COMPRESS: '1',
          MIN_COMPRESS_CHARS: '1',
        } satisfies Env,
        {} as ExecutionContext,
      );
      expect(response.status).toBe(200);
      const outgoing = JSON.parse(forwarded) as { messages: Array<{ content: unknown }> };
      const serialized = JSON.stringify(outgoing.messages);
      expect(serialized).toContain('image/png');
      const data = serialized.match(/"data":"([^"]+)"/)?.[1];
      expect(data).toBeDefined();
      const png = Uint8Array.from(atob(data!), (char) => char.charCodeAt(0));
      const width = new DataView(png.buffer).getUint32(16);
      expect(width).toBeLessThanOrEqual(1568);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('matches Node model-scope semantics for empty and off values', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', content: [],
      model: 'claude-fable-5', stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const body = JSON.stringify({
      model: 'claude-fable-5', max_tokens: 16,
      system: 'instruction '.repeat(2000), messages: [{ role: 'user', content: 'continue' }],
    });
    try {
      for (const [configured, shouldImage] of [['', true], ['off', false]] as const) {
        let forwarded = '';
        globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(String(input), init);
          forwarded = await request.text();
          return new Response(JSON.stringify({
            id: 'msg_test', type: 'message', role: 'assistant', content: [],
            model: 'claude-fable-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
          }), { headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        await worker.fetch(
          new Request('https://pxpipe.test/v1/messages', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body,
          }),
          { ANTHROPIC_UPSTREAM: 'https://anthropic.test', PXPIPE_MODELS: configured, MIN_COMPRESS_CHARS: '1' },
          {} as ExecutionContext,
        );
        expect(forwarded.includes('image/png')).toBe(shouldImage);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Cloudflare Worker PXPIPE_TRUST_ADJACENT_TOOL_ROUNDS', () => {
  /** A Claude Code subagent shape: one anchor prompt, then only tool_use /
   *  tool_result rounds. Without adjacent-pair splitting it never collapses. */
  function pureToolLoopBody(anchor: string, turns: number): string {
    const messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: anchor }];
    for (let i = 0; i < turns; i++) {
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { n: i } }] });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: `file ${i}: ` + 'x'.repeat(3500) }] });
    }
    return JSON.stringify({ model: 'claude-opus-5', max_tokens: 16, messages });
  }

  async function forwardedMessageCount(env: Env, anchor: string): Promise<number> {
    const originalFetch = globalThis.fetch;
    let forwarded = '';
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      if (new URL(request.url).pathname.endsWith('/count_tokens')) {
        return new Response(JSON.stringify({ input_tokens: 200_000 }), { headers: { 'content-type': 'application/json' } });
      }
      forwarded = await request.text();
      return new Response(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', content: [],
        model: 'claude-opus-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const response = await worker.fetch(
        new Request('https://pxpipe.test/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'claude-cli/2.1.316 (external, cli)', 'x-app': 'cli' },
          body: pureToolLoopBody(anchor, 60),
        }),
        env,
        {} as ExecutionContext,
      );
      expect(response.status).toBe(200);
      return (JSON.parse(forwarded) as { messages: unknown[] }).messages.length;
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  const baseEnv = {
    ANTHROPIC_UPSTREAM: 'https://anthropic.test',
    PXPIPE_MODELS: 'claude-opus-5',
    COMPRESS: '1',
    MIN_COMPRESS_CHARS: '1',
  } satisfies Env;

  it('"0" keeps Claude Code pure tool loops uncollapsed, overriding client-header detection', async () => {
    // Anchor text differs per case so session state from one run can't leak.
    const off = await forwardedMessageCount({ ...baseEnv, PXPIPE_TRUST_ADJACENT_TOOL_ROUNDS: '0' }, 'SESSION A: off');
    expect(off).toBe(121);
    const auto = await forwardedMessageCount(baseEnv, 'SESSION B: auto');
    expect(auto).toBeLessThan(121);
  });

  it('warns about an unrecognized value once per isolate, not per request', async () => {
    // env is only readable per request; a warning per request would flood
    // Workers Logs, which expects one JSON line per event.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const env = { ...baseEnv, PXPIPE_TRUST_ADJACENT_TOOL_ROUNDS: 'maybe-once' };
      await forwardedMessageCount(env, 'SESSION C: warn 1');
      await forwardedMessageCount(env, 'SESSION D: warn 2');
      const hits = warn.mock.calls.filter((args) => String(args[0]).includes('"maybe-once" not recognized'));
      expect(hits).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
