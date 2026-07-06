import { describe, expect, it, vi } from 'vitest';
import { cachedRender } from '../src/core/render-cache.js';
import type { RenderedImage } from '../src/core/render.js';

function fakeImage(tag: string): RenderedImage[] {
  return [
    {
      png: new Uint8Array([tag.charCodeAt(0)]),
      width: 1,
      height: 1,
      charsRendered: 1,
      droppedChars: 0,
      droppedCodepoints: new Map(),
    },
  ];
}

describe('cachedRender', () => {
  it('returns the cached array without re-invoking render on a repeated key', async () => {
    const render = vi.fn(async () => fakeImage('a'));
    const key = `render-cache-test:${Math.random()}`;

    const first = await cachedRender(key, render);
    const second = await cachedRender(key, render);

    expect(render).toHaveBeenCalledTimes(1);
    expect(second).toBe(first); // same array instance, not just equal content
  });

  it('invokes render for a distinct key', async () => {
    const renderA = vi.fn(async () => fakeImage('a'));
    const renderB = vi.fn(async () => fakeImage('b'));
    const base = `render-cache-test:${Math.random()}`;

    await cachedRender(`${base}:a`, renderA);
    await cachedRender(`${base}:b`, renderB);

    expect(renderA).toHaveBeenCalledTimes(1);
    expect(renderB).toHaveBeenCalledTimes(1);
  });

  it('evicts the oldest entry once the cache exceeds its cap', async () => {
    const base = `render-cache-test-evict:${Math.random()}`;
    // Cap is 128; fill past it so the very first key falls off the LRU.
    for (let i = 0; i < 129; i++) {
      await cachedRender(`${base}:${i}`, async () => fakeImage(String(i)));
    }
    const render0 = vi.fn(async () => fakeImage('0-again'));
    await cachedRender(`${base}:0`, render0);
    expect(render0).toHaveBeenCalledTimes(1); // evicted, so this must be a fresh render

    const render128 = vi.fn(async () => fakeImage('128-again'));
    await cachedRender(`${base}:128`, render128);
    expect(render128).toHaveBeenCalledTimes(0); // still warm, no re-render
  });
});
