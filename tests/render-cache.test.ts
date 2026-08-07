import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRenderCache,
  renderCacheStats,
  renderTextToPngsWithCharLimit,
  type RenderStyle,
} from '../src/core/render.js';

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const TEXT = 'const x = 1;\nfunction f(a, b) { return a + b; }\n// comment line\n';

describe('rendered-page cache', () => {
  beforeEach(() => {
    clearRenderCache();
  });

  it('returns byte-identical pages on a repeat render', async () => {
    const first = await renderTextToPngsWithCharLimit(TEXT, 64);
    const second = await renderTextToPngsWithCharLimit(TEXT, 64);

    expect(renderCacheStats()).toMatchObject({ hits: 1, misses: 1 });
    expect(second).toHaveLength(first.length);
    for (let i = 0; i < first.length; i++) {
      expect(bytesEqual(first[i]!.png, second[i]!.png)).toBe(true);
      expect([second[i]!.width, second[i]!.height]).toEqual([first[i]!.width, first[i]!.height]);
    }
  });

  // Each of these must MISS. A key that ignored any of them would serve a stale
  // image that silently misrepresents the text — worse than no cache at all.
  it('keys on every input that changes the output', async () => {
    await renderTextToPngsWithCharLimit(TEXT, 64);
    const base = renderCacheStats().misses;

    await renderTextToPngsWithCharLimit(`${TEXT}extra`, 64); // text
    await renderTextToPngsWithCharLimit(TEXT, 48); // cols
    await renderTextToPngsWithCharLimit(TEXT, 64, 500); // maxCharsPerImage
    await renderTextToPngsWithCharLimit(TEXT, 64, undefined, { aa: true }); // style
    await renderTextToPngsWithCharLimit(TEXT, 64, undefined, undefined, 512); // maxHeightPx

    expect(renderCacheStats().misses).toBe(base + 5);
    expect(renderCacheStats().hits).toBe(0);
  });

  it('distinguishes an absent slotText from an empty one', async () => {
    const style: RenderStyle = { colorByRole: true };
    await renderTextToPngsWithCharLimit(TEXT, 64, undefined, style, undefined, undefined);
    await renderTextToPngsWithCharLimit(TEXT, 64, undefined, style, undefined, '');

    // undefined disables the slot pass entirely; '' does not. Same entry would be wrong.
    expect(renderCacheStats()).toMatchObject({ hits: 0, misses: 2 });
  });

  it('is not fooled by a slotText/text split ambiguity', async () => {
    // Naive concatenation gives ("a b", "c") and ("a", "b c") the same key.
    const style: RenderStyle = { colorByRole: true };
    await renderTextToPngsWithCharLimit('c', 64, undefined, style, undefined, 'a b');
    await renderTextToPngsWithCharLimit('b c', 64, undefined, style, undefined, 'a');

    expect(renderCacheStats()).toMatchObject({ hits: 0, misses: 2 });
  });

  it('treats style key order and undefined fields as the same entry', async () => {
    await renderTextToPngsWithCharLimit(TEXT, 64, undefined, { aa: true, grid: false });
    await renderTextToPngsWithCharLimit(TEXT, 64, undefined, { grid: false, aa: true });
    await renderTextToPngsWithCharLimit(TEXT, 64, undefined, {
      grid: false,
      aa: true,
      inkDilate: undefined,
    });

    expect(renderCacheStats()).toMatchObject({ hits: 2, misses: 1 });
  });

  it('hands each caller its own droppedCodepoints map', async () => {
    // Callers merge this map into their own totals; a shared instance would let one
    // request's mutation leak into every later cache hit.
    const first = await renderTextToPngsWithCharLimit(TEXT, 64);
    first[0]!.droppedCodepoints.set(0x41, 999);

    const second = await renderTextToPngsWithCharLimit(TEXT, 64);
    expect(second[0]!.droppedCodepoints.get(0x41)).toBeUndefined();
  });

  it('accounts bytes and clears them', async () => {
    await renderTextToPngsWithCharLimit(TEXT, 64);
    const stats = renderCacheStats();
    expect(stats.entries).toBe(1);
    expect(stats.bytes).toBeGreaterThan(0);

    clearRenderCache();
    expect(renderCacheStats()).toEqual({ entries: 0, bytes: 0, hits: 0, misses: 0 });
  });
});

// The byte budget is read once at module init, so these load a fresh copy of the
// module under a different env instead of mutating a live cache.
async function freshRender(maxBytes: string) {
  vi.resetModules();
  vi.stubEnv('PXPIPE_RENDER_CACHE_BYTES', maxBytes);
  const mod = await import('../src/core/render.js');
  mod.clearRenderCache();
  return mod;
}

describe('rendered-page cache budget', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('evicts least-recently-used entries once the budget is exceeded', async () => {
    const A = 'alpha alpha alpha\n'.repeat(40);
    const B = 'beta beta beta\n'.repeat(40);
    const C = 'gamma gamma gamma\n'.repeat(40);

    // Derive the budget from a real entry instead of guessing a constant: room for
    // roughly two of these, so the third must evict the first.
    const probe = await freshRender(String(64 * 1024 * 1024));
    await probe.renderTextToPngsWithCharLimit(A, 64);
    const oneEntry = probe.renderCacheStats().bytes;

    const mod = await freshRender(String(Math.floor(oneEntry * 2.5)));
    const render = (t: string) => mod.renderTextToPngsWithCharLimit(t, 64);

    await render(A);
    await render(B);
    await render(C);

    const stats = mod.renderCacheStats();
    expect(stats.bytes).toBeLessThanOrEqual(Math.floor(oneEntry * 2.5));
    expect(stats.entries).toBe(2); // A was evicted to make room for C

    // The survivors still hit; the evicted entry must miss and be re-rendered.
    const before = mod.renderCacheStats();
    await render(C);
    expect(mod.renderCacheStats().hits).toBe(before.hits + 1);
    await render(A);
    expect(mod.renderCacheStats().misses).toBe(before.misses + 1);
  });

  it('keeps the byte counter exact rather than drifting', async () => {
    const big = String(64 * 1024 * 1024);
    const a = 'alpha alpha\n'.repeat(40);
    const b = 'beta beta beta\n'.repeat(40);

    // Measure each entry's cost in isolation, then together: the counter is only
    // correct if the combined total is exactly the sum, with no double-count on
    // the LRU re-insert path and no leftover from an eviction.
    const m1 = await freshRender(big);
    await m1.renderTextToPngsWithCharLimit(a, 64);
    const bytesA = m1.renderCacheStats().bytes;

    const m2 = await freshRender(big);
    await m2.renderTextToPngsWithCharLimit(b, 64);
    const bytesB = m2.renderCacheStats().bytes;

    const m3 = await freshRender(big);
    await m3.renderTextToPngsWithCharLimit(a, 64);
    await m3.renderTextToPngsWithCharLimit(b, 64);
    await m3.renderTextToPngsWithCharLimit(a, 64); // hit: must not re-add bytes
    expect(m3.renderCacheStats()).toMatchObject({ entries: 2, hits: 1, bytes: bytesA + bytesB });
  });

  it('never stores an entry larger than the whole budget', async () => {
    const mod = await freshRender('2000'); // smaller than a single page
    await mod.renderTextToPngsWithCharLimit('x '.repeat(2000), 64);

    const stats = mod.renderCacheStats();
    expect(stats.entries).toBe(0);
    expect(stats.bytes).toBe(0);
  });

  it('PXPIPE_RENDER_CACHE_BYTES=0 disables caching entirely', async () => {
    const mod = await freshRender('0');
    await mod.renderTextToPngsWithCharLimit('hello world', 64);
    await mod.renderTextToPngsWithCharLimit('hello world', 64);

    expect(mod.renderCacheStats()).toEqual({ entries: 0, bytes: 0, hits: 0, misses: 0 });
  });
});
