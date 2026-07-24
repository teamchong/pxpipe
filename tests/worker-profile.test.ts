import { afterEach, describe, expect, it } from 'vitest';
import worker, { type Env } from '../src/worker.js';
import { setAllowedModelBases } from '../src/core/applicability.js';

afterEach(() => setAllowedModelBases(null));

describe('Cloudflare Worker model profiles', () => {
  it('uses PXPIPE_MODELS and the built-in Opus 14px profile', async () => {
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
        model: 'claude-opus-4-8', stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const body = JSON.stringify({
        model: 'claude-opus-4-8',
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
          PXPIPE_MODELS: 'claude-fable-5,claude-opus-4-8',
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
      expect(width).toBeLessThanOrEqual(782);
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
