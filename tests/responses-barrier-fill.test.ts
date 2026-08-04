/**
 * Responses planner PAGE-FILL contract.
 *
 * Every run the mixed planner emits renders at least one image, so any item
 * that ends a run costs a page break. Live Codex traffic showed 174.6 `message`
 * barriers per request and images filled to ~10% of the 28,080 chars a page
 * holds. Two message shapes were responsible, and both are losslessly
 * renderable or inert — neither is a reason to split a run.
 *
 * These pin the fix and, critically, the ordering invariant that makes it safe:
 * an item the planner skips must still be re-emitted at its original position.
 */
import { describe, expect, it } from 'vitest';
import { planResponsesPairCollapse } from '../src/core/openai-history.js';

const yes = () => true;
const PAGE_CHARS = 28080;

function transcript(rounds: number, between: unknown): unknown[] {
  const items: unknown[] = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
  ];
  for (let i = 0; i < rounds; i++) {
    items.push(JSON.parse(JSON.stringify(between)));
    items.push({ type: 'function_call', call_id: 'c' + i, name: 'sh', arguments: '{}' });
    items.push({ type: 'function_call_output', call_id: 'c' + i, output: 'x'.repeat(3000) });
  }
  items.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'now' }] });
  return items;
}

const opts = {
  cols: 312, maxHeightPx: 728, maxImages: 96, keepTail: 6,
  keepRecentPairs: 6, minCollapseTokens: 2000, responsesMode: 'mixed' as const,
};

async function fill(between: unknown): Promise<number> {
  const plan = await planResponsesPairCollapse(transcript(40, between), yes, opts);
  const images = plan.segments.reduce((n, s) => n + s.images.length, 0);
  return images ? plan.collapsedChars / images : 0;
}

describe('interleaved messages must not fragment collapse runs', () => {
  it('packs pages when rounds are separated by a refusal part', async () => {
    // Model-authored prose in its own part type — renderable, so groupable.
    const f = await fill({ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] });
    expect(f).toBeGreaterThan(PAGE_CHARS * 0.5);
  });

  it('packs pages when rounds are separated by a contentless message', async () => {
    // Nothing to image and nothing to reorder — must not end a run.
    const f = await fill({ type: 'message', role: 'assistant', content: [] });
    expect(f).toBeGreaterThan(PAGE_CHARS * 0.5);
  });

  it('packs pages when rounds are separated by whitespace-only text', async () => {
    const f = await fill({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '   ' }] });
    expect(f).toBeGreaterThan(PAGE_CHARS * 0.5);
  });

  it('still treats a message carrying a non-text part as a hard barrier', async () => {
    // An image part is real payload the planner cannot render. Fragmenting is
    // the correct, conservative outcome — this is the guard that keeps the
    // relaxation above from swallowing content.
    const withImage = {
      type: 'message', role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }],
    };
    const plan = await planResponsesPairCollapse(transcript(40, withImage), yes, opts);
    const barriers = plan.barrierTypes?.get('message') ?? 0;
    expect(barriers).toBeGreaterThan(0);
  });

  it('never selects a skipped contentless item, so order is preserved', async () => {
    // The splice in openai.ts re-emits every index absent from selectedIndices.
    // If a skipped item were ever selected it would be silently deleted.
    const items = transcript(40, { type: 'message', role: 'assistant', content: [] });
    const plan = await planResponsesPairCollapse(items, yes, opts);
    const contentless = items
      .map((it, i) => [it, i] as const)
      .filter(([it]) => {
        const o = it as Record<string, unknown>;
        return o.type === 'message' && Array.isArray(o.content) && o.content.length === 0;
      })
      .map(([, i]) => i);
    expect(contentless.length).toBeGreaterThan(0);
    for (const i of contentless) expect(plan.selectedIndices).not.toContain(i);
  });
});
