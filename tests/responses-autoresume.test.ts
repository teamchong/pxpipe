import { describe, expect, it } from 'vitest';
import { resumableResponse } from '../src/core/proxy.js';

const enc = new TextEncoder();

function broken(parts: string[], fail = true): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(c) {
      for (const part of parts) c.enqueue(enc.encode(part));
      if (fail) queueMicrotask(() => c.error(new Error('socket reset'))); else c.close();
    },
  }), { headers: { 'content-type': 'text/event-stream', 'content-length': '999' } });
}

describe('Responses autoresume', () => {
  it('replays an identical prefix and emits every byte exactly once', async () => {
    const first = broken(['event: response.created\n\n', 'data: one\n\n']);
    const resumed = resumableResponse(first, async () => broken([
      'event: response.created\n\n', 'data: one\n\n', 'event: response.completed\n\n',
    ], false));
    expect(await resumed.text()).toBe(
      'event: response.created\n\ndata: one\n\nevent: response.completed\n\n',
    );
    expect(resumed.headers.has('content-length')).toBe(false);
  });

  it('fails closed when a replay belongs to a different model run', async () => {
    const resumed = resumableResponse(
      broken(['data: run-a\n\n']),
      async () => broken(['data: run-b\n\n'], false),
    );
    await expect(resumed.text()).rejects.toThrow('prefix mismatch');
  });
});
