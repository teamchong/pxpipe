/**
 * Adaptive CPT — the store (Node path).
 *
 * End-to-end for the learning loop: a real events.jsonl on disk → samples →
 * fit → the resolver the gate consults. Uses synthetic rows whose token counts
 * are generated from CPTs we choose, so "did it learn the right number?" has a
 * ground truth.
 */

import { describe, expect, it, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildCptState,
  resolverFor,
  sampleFromEvent,
  writeCptState,
  GLOBAL_KEY,
} from '../src/cpt-store.js';
import { ANTHROPIC_PATCH_PX } from '../src/core/anthropic-vision.js';
const PIXELS_PER_VISUAL_TOKEN = ANTHROPIC_PATCH_PX * ANTHROPIC_PATCH_PX;

const tmpDirs: string[] = [];
function tmpdir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-cpt-'));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * Write an events.jsonl whose rows encode the given per-bucket CPTs exactly:
 * baseline_tokens = Σ chars_b/cpt_b + image_pixels/750.
 */
function writeEvents(
  file: string,
  rows: Array<{ sha: string; chars: Record<string, number>; cpt: Record<string, number> }>,
): void {
  const r = rng(99);
  const lines = rows.map(({ sha, chars, cpt }) => {
    let textTokens = 0;
    for (const [b, c] of Object.entries(chars)) textTokens += c / cpt[b]!;
    const image_pixels = Math.floor(r() * 500_000);
    return JSON.stringify({
      ts: new Date().toISOString(),
      system_sha8: sha,
      bucket_chars: chars,
      image_pixels,
      baseline_tokens: textTokens + image_pixels / PIXELS_PER_VISUAL_TOKEN,
    });
  });
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

describe('sampleFromEvent', () => {
  it('subtracts the image cost on the 28px patch grid to isolate text tokens', () => {
    // One full pxpipe page: 1568×728. Both edges are whole multiples of 28, so
    // the patch count is exact — 56×26 = 1456 visual tokens — and the aggregate
    // pixels/784 form agrees with it exactly.
    const pagePixels = 1568 * 728;
    expect(pagePixels / (ANTHROPIC_PATCH_PX * ANTHROPIC_PATCH_PX)).toBe(1456);
    expect(Math.ceil(1568 / ANTHROPIC_PATCH_PX) * Math.ceil(728 / ANTHROPIC_PATCH_PX)).toBe(1456);

    const s = sampleFromEvent({
      bucket_chars: { static_slab: 30_000 },
      image_pixels: pagePixels,
      baseline_tokens: 20_000 + 1456,
    });
    expect(s).not.toBeNull();
    expect(s!.textTokens).toBeCloseTo(20_000, 6);
  });

  it('rejects rows missing the fields the fit needs', () => {
    expect(sampleFromEvent({})).toBeNull();
    expect(sampleFromEvent({ bucket_chars: { static_slab: 10 } })).toBeNull();
    expect(sampleFromEvent({ baseline_tokens: 100 })).toBeNull();
    // zero chars → no regressor
    expect(sampleFromEvent({ bucket_chars: { static_slab: 0 }, baseline_tokens: 100 })).toBeNull();
    // image cost exceeds the whole bill → broken row, not a negative text cost
    expect(
      sampleFromEvent({
        bucket_chars: { static_slab: 1000 },
        image_pixels: 7_500_000,
        baseline_tokens: 10,
      }),
    ).toBeNull();
  });
});

describe('buildCptState', () => {
  it('recovers the CPTs used to generate a real events file', async () => {
    const dir = tmpdir();
    const file = path.join(dir, 'events.jsonl');
    const cpt = { static_slab: 1.5, tool_result_json: 1.3 };
    const r = rng(5);
    writeEvents(
      file,
      Array.from({ length: 50 }, () => ({
        sha: 'aaaa1111',
        chars: {
          static_slab: Math.floor(20_000 + r() * 30_000),
          tool_result_json: Math.floor(5_000 + r() * 25_000),
        },
        cpt,
      })),
    );

    const state = await buildCptState(file);
    const fit = state.fits.get('aaaa1111');
    expect(fit, 'per-project fit missing').toBeDefined();
    expect(fit!.cpt.static_slab!).toBeCloseTo(1.5, 1);
    expect(fit!.cpt.tool_result_json!).toBeCloseTo(1.3, 1);
    // The pooled table is fitted too, so a fresh project has a prior.
    expect(state.fits.get(GLOBAL_KEY)).toBeDefined();
  });

  it('returns an empty state for a missing log instead of throwing', async () => {
    const state = await buildCptState(path.join(tmpdir(), 'nope.jsonl'));
    expect(state.fits.size).toBe(0);
    expect(resolverFor(state)('static_slab')).toBeUndefined();
  });

  it('prefers the project rate over the pooled one, and pools for unknown projects', async () => {
    const dir = tmpdir();
    const file = path.join(dir, 'events.jsonl');
    const r = rng(17);
    // Project A is dense (1.2); project B is loose (3.5). Both are well-sampled.
    const rows = [
      ...Array.from({ length: 40 }, () => ({
        sha: 'aaaaaaaa',
        chars: { static_slab: Math.floor(20_000 + r() * 20_000) },
        cpt: { static_slab: 1.2 },
      })),
      ...Array.from({ length: 40 }, () => ({
        sha: 'bbbbbbbb',
        chars: { static_slab: Math.floor(20_000 + r() * 20_000) },
        cpt: { static_slab: 3.5 },
      })),
    ];
    writeEvents(file, rows);

    const state = await buildCptState(file);
    const resolve = resolverFor(state);

    expect(resolve('static_slab', 'aaaaaaaa')!).toBeCloseTo(1.2, 1);
    expect(resolve('static_slab', 'bbbbbbbb')!).toBeCloseTo(3.5, 1);
    // An unseen project falls back to the pooled table — a real number, and
    // strictly better informed than a hand-picked constant.
    const pooled = resolve('static_slab', 'ffffffff');
    expect(pooled).toBeDefined();
    expect(pooled!).toBeGreaterThan(1.0);
    expect(pooled!).toBeLessThan(6.0);
  });

  it('persists a readable state file', async () => {
    const dir = tmpdir();
    const file = path.join(dir, 'events.jsonl');
    const r = rng(23);
    writeEvents(
      file,
      Array.from({ length: 40 }, () => ({
        sha: 'cccccccc',
        chars: { static_slab: Math.floor(20_000 + r() * 20_000) },
        cpt: { static_slab: 1.5 },
      })),
    );
    const state = await buildCptState(file);
    const out = path.join(dir, 'cpt-state.jsonl');
    writeCptState(state, out);

    const parsed = fs
      .readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { system_sha8: string; cpt: Record<string, number>; n_events: number });
    const proj = parsed.find((p) => p.system_sha8 === 'cccccccc');
    expect(proj).toBeDefined();
    expect(proj!.n_events).toBe(40);
    expect(proj!.cpt.static_slab!).toBeCloseTo(1.5, 1);
  });
});
