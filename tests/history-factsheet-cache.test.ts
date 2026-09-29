import { describe, expect, it } from 'vitest';
import { factSheetText, prepareFactSheet } from '../src/core/factsheet.js';
import { createHistoryFactSheetRenderer, historyFactSheet } from '../src/core/openai.js';
import { resolveGptProfile } from '../src/core/gpt-model-profiles.js';

const path = 'src/feature/shared-cache-method.ts';
const fresh = 'src/feature/uncached-method.ts';
const text = `Read ${path} and ${fresh}. Call validateCacheState().`;

describe('request-local prepared factsheets', () => {
  it.each(['full', 'compact'] as const)('prepares %s once without caching coverage decisions', format => {
    const render = prepareFactSheet(text, format);
    for (const coverage of [undefined, '', path, new Set([path]), new Set([fresh]), new Set<string>()]) {
      expect(render(coverage)).toBe(factSheetText(text, format, coverage));
    }
    expect(render(new Set([path]))).not.toContain(path);
    expect(render()).toContain(path);
    expect(render(new Set([fresh]))).toContain(path);
  });

  it('reuses preparation between the profitability gate and final emission', () => {
    const p = resolveGptProfile('gpt-6-astra');
    const cache = createHistoryFactSheetRenderer(p);
    expect(cache.render(text)).toBe(historyFactSheet(text, p));
    expect(cache.render(text, new Set([path]))).toBe(historyFactSheet(text, p, new Set([path])));
    expect(cache.render(text)).toContain(path);
    expect(cache.stats()).toMatchObject({ entries: 1, chars: text.length, misses: 1, hits: 2 });
    // A new request must not inherit either cached preparation or prior coverage.
    const nextRequest = createHistoryFactSheetRenderer(p);
    expect(nextRequest.stats()).toMatchObject({ entries: 0, hits: 0, misses: 0 });
    expect(nextRequest.render(text)).toContain(path);
  });

  it('bounds retained entries and characters and safely bypasses oversized text', () => {
    const cache = createHistoryFactSheetRenderer(resolveGptProfile('gpt-6-astra'), { maxEntries: 2, maxChars: 100 });
    const a = 'Read src/cache/alpha.ts', b = 'Read src/cache/beta.ts', c = 'Read src/cache/gamma.ts';
    cache.render(a); cache.render(b); cache.render(a); cache.render(c);
    expect(cache.stats()).toMatchObject({ entries: 2, hits: 1, misses: 3 });
    cache.render(b); // b was least recently used.
    expect(cache.stats().misses).toBe(4);
    cache.render('x'.repeat(101));
    expect(cache.stats().entries).toBeLessThanOrEqual(2);
    expect(cache.stats().chars).toBeLessThanOrEqual(100);
    const disabled = createHistoryFactSheetRenderer(resolveGptProfile('gpt-6-astra'), { maxEntries: 0, maxChars: 0 });
    expect(disabled.render(text)).toBe(historyFactSheet(text, resolveGptProfile('gpt-6-astra')));
    expect(disabled.stats()).toMatchObject({ entries: 0, chars: 0 });
  });

  it.each(['gpt-6-astra', 'gpt-5.6-sol', 'gemini-3.6-flash'])('preserves all bytes of opaque/frequent/long data for %s', model => {
    const p = resolveGptProfile(model), cache = createHistoryFactSheetRenderer(p);
    const opaque = Array.from({ length: 180 }, (_, i) => `id=${(65536 + i).toString(16).padStart(12, '0')} amount=${i}`).join('\n');
    for (const source of ['', text, `${path}\n${path}`, `[tool_use fixture]\nsynthetic input\n${opaque}`, text.repeat(800)]) {
      for (const coverage of [undefined, new Set([path, fresh])]) {
        expect(cache.render(source, coverage)).toBe(historyFactSheet(source, p, coverage));
      }
    }
  });
});

it('keeps retained gate entries when emission has earlier uncached segments', () => {
  const profile = resolveGptProfile('gpt-6-astra');
  const cache = createHistoryFactSheetRenderer(profile, { maxEntries: 2, maxChars: 1024 });
  const a = 'Read src/cache/alpha.ts', b = 'Read src/cache/beta.ts', c = 'Read src/cache/gamma.ts';
  cache.render(a); cache.render(b); cache.beginEmission();
  cache.render(c); cache.render(a); cache.render(b);
  expect(cache.stats()).toMatchObject({ entries: 2, hits: 2, misses: 3 });
  expect(cache.render(c)).toBe(historyFactSheet(c, profile));
  expect(cache.stats().entries).toBe(2);
});
