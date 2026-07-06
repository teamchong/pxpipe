/**
 * Content-addressed memoization for rendered PNG pages. The two call sites that use
 * this (transform.ts's static slab, history.ts's frozen collapse chunks) are already
 * designed to produce byte-identical render output across turns — see the
 * "byte-stable"/"cache-friendly" comments at those call sites, written for Anthropic's
 * prompt cache. That same guarantee means a cache hit here can skip the real work
 * (glyph blit + PNG deflate) entirely and return the prior bytes untouched.
 *
 * Bounded LRU, same eviction pattern as transform.ts's tagObservations.
 */

import type { RenderedImage } from './render.js';

const RENDER_CACHE_MAX = 128;
const cache = new Map<string, RenderedImage[]>();

export async function cachedRender(
  key: string,
  render: () => Promise<RenderedImage[]>,
): Promise<RenderedImage[]> {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // refresh LRU position
    cache.set(key, hit);
    return hit;
  }
  const images = await render();
  cache.set(key, images);
  while (cache.size > RENDER_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return images;
}
