/**
 * D12 render cache + E13 session guard + 1h-TTL breakpoint upgrade.
 *
 * Run just this file:  pnpm vitest run tests/render-cache.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cachedRender, clearRenderCache, renderCacheStats } from '../src/core/render-cache.js';
import { textToImageBlocks, transformRequest } from '../src/core/transform.js';
import { countCacheControlMarkers } from '../src/core/measurement.js';
import type { Message } from '../src/core/types.js';

const big = (n: number) => 'x'.repeat(n);

function enc(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}
function dec(b: Uint8Array): any {
  return JSON.parse(new TextDecoder().decode(b));
}

/** N closed plain turns, each `chars` long. */
function convo(n: number, chars = 3500): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i++) {
    const body = `turn ${i}: ` + big(chars);
    out.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: body });
  }
  return out;
}

function slabRequest(): Uint8Array {
  return enc({
    model: 'claude-3-5-sonnet',
    system: [{ type: 'text', text: big(80_000), cache_control: { type: 'ephemeral' } }],
    messages: convo(15),
  });
}

function imagesOf(msgs: Message[]): any[] {
  const out: any[] = [];
  for (const m of msgs) {
    if (Array.isArray(m.content)) {
      for (const b of m.content as any[]) if (b?.type === 'image') out.push(b);
    }
  }
  return out;
}

beforeEach(() => clearRenderCache());

describe('render-cache: content-addressed PNG memoization', () => {
  it('same key → renderer runs once, identical value returned', async () => {
    let calls = 0;
    const fake = async () => {
      calls++;
      return [
        {
          png: new Uint8Array([1, 2, 3]),
          width: 1,
          height: 3,
          charsRendered: 3,
          droppedChars: 0,
          droppedCodepoints: new Map<number, number>(),
        },
      ];
    };
    const a = await cachedRender(['t', 1, 'abc'], fake);
    const b = await cachedRender(['t', 1, 'abc'], fake);
    expect(calls).toBe(1);
    expect(a.hit).toBe(false);
    expect(b.hit).toBe(true);
    expect(b.imgs).toBe(a.imgs); // same immutable value, not a re-render
    const s = renderCacheStats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
    expect(s.entries).toBe(1);
  });

  it('different key parts never collide (order + content)', async () => {
    let calls = 0;
    const fake = async () => {
      calls++;
      return [] as any[];
    };
    await cachedRender(['a', 'bc'], fake);
    await cachedRender(['ab', 'c'], fake); // same concat, different parts
    await cachedRender(['a', 'bc', 1], fake);
    expect(calls).toBe(3);
  });

  it('textToImageBlocks: repeat call is a cache hit with byte-identical PNGs', async () => {
    const text = 'history chunk: ' + big(9_000);
    const first = await textToImageBlocks(text, 313, 1);
    const second = await textToImageBlocks(text, 313, 1);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.pngs.length).toBe(first.pngs.length);
    for (let i = 0; i < first.pngs.length; i++) {
      expect(Buffer.from(second.pngs[i]!).equals(Buffer.from(first.pngs[i]!))).toBe(true);
    }
    // Block objects must be fresh per call (callers may attach cache_control).
    expect(second.blocks[0]).not.toBe(first.blocks[0]);
  });

  it('transformRequest: second identical request reports renderCacheHits > 0', async () => {
    const { info: cold } = await transformRequest(slabRequest());
    expect(cold.compressed).toBe(true);
    expect(cold.renderCacheHits ?? 0).toBe(0);
    const { body: out2, info: warm } = await transformRequest(slabRequest());
    expect(warm.compressed).toBe(true);
    expect(warm.renderCacheHits ?? 0).toBeGreaterThan(0);
    // Cache must not change what goes upstream: marker conservation still holds.
    expect(countCacheControlMarkers(out2)).toBe(1);
  });
});

describe('E13 session guard (passthroughGuard)', () => {
  it('guard=true → byte-identical passthrough with reason session_guard', async () => {
    const body = slabRequest();
    const { body: out, info } = await transformRequest(body, {
      passthroughGuard: () => true,
    });
    expect(info.reason).toBe('session_guard');
    expect(info.compressed).toBe(false);
    expect(out).toBe(body); // original buffer, zero mutation
  });

  it('guard receives the session fingerprints the transform computed', async () => {
    let seen: { firstUserSha8?: string; claudeMdSha8?: string } | undefined;
    const { info } = await transformRequest(slabRequest(), {
      passthroughGuard: (ids) => {
        seen = ids;
        return false;
      },
    });
    expect(seen).toBeDefined();
    expect(seen!.firstUserSha8).toBe(info.firstUserSha8);
    expect(seen!.firstUserSha8).toMatch(/^[0-9a-f]{8}$/);
  });

  it('throwing guard fails open (compresses as usual)', async () => {
    const { info } = await transformRequest(slabRequest(), {
      passthroughGuard: () => {
        throw new Error('boom');
      },
    });
    expect(info.compressed).toBe(true);
  });
});

describe('cacheTtl1h: relocated breakpoints upgraded to 1h', () => {
  it('off (default): relocated marker keeps its original shape (no ttl added)', async () => {
    const { body: out } = await transformRequest(slabRequest());
    const req = dec(out);
    const marked = imagesOf(req.messages).filter((b) => b.cache_control !== undefined);
    const sysImgs = ((req.system ?? []) as any[]).filter?.((b) => b?.cache_control) ?? [];
    const all = [...marked, ...sysImgs];
    expect(all.length).toBeGreaterThan(0);
    for (const b of all) expect(b.cache_control.ttl).toBeUndefined();
  });

  it('on: every relocated ephemeral marker carries ttl 1h, count still conserved', async () => {
    const body = slabRequest();
    const { body: out } = await transformRequest(body, { cacheTtl1h: true });
    expect(countCacheControlMarkers(out)).toBe(1);
    const req = dec(out);
    const marked = imagesOf(req.messages).filter((b) => b.cache_control !== undefined);
    expect(marked.length).toBe(1);
    expect(marked[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('on: non-ephemeral / exotic marker shapes pass through untouched', async () => {
    // Guard the withCacheTtl narrowing: unknown shapes must survive verbatim.
    const body = enc({
      model: 'claude-3-5-sonnet',
      system: [{ type: 'text', text: big(80_000), cache_control: { type: 'weird_future' } }],
      messages: convo(15),
    });
    const { body: out } = await transformRequest(body, { cacheTtl1h: true });
    const req = dec(out);
    const marked = imagesOf(req.messages).filter((b) => b.cache_control !== undefined);
    for (const b of marked) expect(b.cache_control.ttl).toBeUndefined();
  });
});
