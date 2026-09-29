import { describe, expect, it } from 'vitest';
import { planResponsesPairCollapse } from '../src/core/openai-history.js';
import { transformOpenAIResponses } from '../src/core/openai.js';
import { computeOpenAIBaselineRawTokens } from '../src/core/openai-savings.js';

type Item = Record<string, unknown>;
const yes = () => true;
const output = 'The synthetic build completed successfully. All module checks passed without warnings. '.repeat(160);
const sharedPath = 'src/feature/shared-build-hook.ts';
const customPair = (id: string): Item[] => [
  { type: 'custom_tool_call', id: `item_${id}`, call_id: id, name: 'run_fixture', namespace: 'tools', input: 'inspect build\n--synthetic', status: 'completed' },
  { type: 'custom_tool_call_output', id: `output_${id}`, call_id: id, output: `Fixture ${id}\n${output}\n${sharedPath}` },
];
const fnPair = (id: string): Item[] => [
  { type: 'function_call', id: `item_${id}`, call_id: id, name: 'inspect', arguments: '{}' },
  { type: 'function_call_output', id: `output_${id}`, call_id: id, output },
];
const opts = { keepRecentPairs: 0, minCollapseTokens: 1, maxImages: 100, reflow: true };

function rounds(n: number): Item[] {
  const items: Item[] = [{ role: 'user', content: 'Review the synthetic build results.' }];
  for (let i = 0; i < n; i++) items.push(
    { type: 'reasoning', id: `reasoning_${i}`, encrypted_content: `opaque-fixture-${i}` },
    ...customPair(`round_${i}`),
  );
  return items;
}

describe('Responses custom tool history', () => {
  it('renders raw input and its namespace, not missing JSON arguments', async () => {
    const items = customPair('raw');
    const plan = await planResponsesPairCollapse(items, yes, opts);
    expect(plan.selectedIndices).toEqual([0, 1]);
    expect(plan.text).toContain('[tool_use tools.run_fixture]\ninspect build\n--synthetic');
    expect(plan.text).toContain(output);
    expect(plan.text).not.toContain('undefined');
    expect(plan.pairState.completedPairs).toBe(1);
    expect(plan.pairState.collapsedPairs).toBe(1);
  });

  it('accepts textual output parts without dropping their text', async () => {
    const items = customPair('parts');
    items[1]!.output = [{ type: 'input_text', text: output }, { type: 'input_text', text: 'last line' }];
    const plan = await planResponsesPairCollapse(items, yes, opts);
    expect(plan.selectedIndices).toEqual([0, 1]);
    expect(plan.text).toContain('last line');
  });

  it('selects a mixed function/custom parallel round atomically', async () => {
    const [a, ao] = fnPair('fn');
    const [b, bo] = customPair('custom');
    const items = [a!, b!, bo!, ao!];
    const plan = await planResponsesPairCollapse(items, yes, opts);
    expect(plan.selectedIndices).toEqual([0, 1, 2, 3]);
    expect(plan.pairState.completedPairs).toBe(2);
    const recent = await planResponsesPairCollapse(items, yes, { ...opts, keepRecentPairs: 1 });
    expect(recent.selectedIndices).toEqual([]);
    expect(recent.pairState.recentCompletedPairs).toBe(2);
  });

  const invalid: Array<[string, (items: Item[]) => void]> = [
    ['non-string custom input', a => { a[0]!.input = { not: 'raw text' }; }],
    ['missing name', a => { delete a[0]!.name; }],
    ['unknown namespace shape', a => { a[0]!.namespace = {}; }],
    ['partial call', a => { a[0]!.status = 'in_progress'; }],
    ['partial output', a => { a[1]!.status = 'incomplete'; }],
    ['mismatched output kind', a => { a[1]!.type = 'function_call_output'; }],
    ['image output', a => { a[1]!.output = [{ type: 'input_image', image_url: 'data:image/png;base64,fixture' }]; }],
    ['file output', a => { a[1]!.output = [{ type: 'input_file', file_id: 'file_fixture' }]; }],
    ['mixed image/text output', a => { a[1]!.output = [{ type: 'input_text', text: output }, { type: 'input_image', image_url: 'fixture' }]; }],
    ['unknown output', a => { a[1]!.output = { future_type: 'opaque' }; }],
    ['missing call id', a => { delete a[0]!.call_id; }],
    ['reversed pair', a => { a.reverse(); }],
    ['duplicate call', a => { a.unshift({ ...a[0] }); }],
    ['duplicate output', a => { a.push({ ...a[1] }); }],
    ['intervening reasoning', a => { a.splice(1, 0, { type: 'reasoning', encrypted_content: 'opaque' }); }],
  ];
  it.each(invalid)('keeps %s completely native', async (_, mutate) => {
    const items = customPair('unsafe');
    mutate(items);
    const original = JSON.stringify(items);
    const plan = await planResponsesPairCollapse(items, yes, { ...opts, responsesMode: 'mixed', keepTail: 0 });
    expect(plan.selectedIndices).toEqual([]);
    expect(plan.images).toHaveLength(0);
    expect(JSON.stringify(items)).toBe(original);
  });

  it('does not pair ids ambiguously across function/custom tools', async () => {
    const items = [...fnPair('duplicate'), ...customPair('duplicate')];
    const plan = await planResponsesPairCollapse(items, yes, opts);
    expect(plan.selectedIndices).toEqual([]);
    expect(plan.pairState.malformedItems).toBe(4);
  });

  it('counts open calls/orphan outputs without selecting them', async () => {
    const items = [customPair('open')[0]!, customPair('orphan')[1]!];
    const plan = await planResponsesPairCollapse(items, yes, opts);
    expect(plan.selectedIndices).toEqual([]);
    expect(plan.pairState.openCalls).toBe(1);
    expect(plan.pairState.orphanOutputs).toBe(1);
  });

  it.each(['pairs', 'mixed'] as const)('respects item references in %s mode', async responsesMode => {
    const items = [...customPair('reference'), ...customPair('safe'),
      { type: 'item_reference', id: 'output_reference' }];
    const plan = await planResponsesPairCollapse(items, yes, { ...opts, responsesMode, freezeChunk: 0 });
    expect(plan.selectedIndices).toEqual([2, 3]);
  });

  it('grows closed history coverage without rewriting sealed image prefixes', async () => {
    const settings = { ...opts, responsesMode: 'mixed' as const, freezeChunk: 1, sectionTokens: 300, keepRecentPairs: 1, keepTail: 1 };
    const before = await planResponsesPairCollapse(rounds(3), yes, settings);
    const after = await planResponsesPairCollapse(rounds(6), yes, settings);
    expect(before.pairState.collapsedPairs).toBe(2);
    expect(after.pairState.collapsedPairs).toBe(5);
    expect(Buffer.from(before.images[0]!.png)).not.toEqual(Buffer.from(before.images[1]!.png));
    expect(after.collapsedChars).toBeGreaterThan(before.collapsedChars);
    expect(after.baselineTokens!).toBeGreaterThan(before.baselineTokens!);
    for (let i = 0; i < before.images.length; i++) {
      expect(Buffer.from(after.images[i]!.png)).toEqual(Buffer.from(before.images[i]!.png));
    }
    expect(after.selectedIndices).not.toContain(0); // current user stays legible
    expect(after.selectedIndices.some(i => rounds(6)[i]!.type === 'reasoning')).toBe(false);
    const capped = await planResponsesPairCollapse(rounds(6), yes, { ...settings, maxImages: 1 });
    expect(capped.images.length).toBeLessThanOrEqual(1);
    const rejected = await planResponsesPairCollapse(rounds(6), () => false, settings);
    expect(rejected.selectedIndices).toEqual([]);
  });
});

describe('GPT-6 real transform custom history accounting', () => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  async function transform(n: number) {
    const input = rounds(n);
    input.push(customPair('active_open')[0]!);
    const result = await transformOpenAIResponses(enc.encode(JSON.stringify({ model: 'gpt-6-astra', input })));
    return { ...result, original: input, request: JSON.parse(dec.decode(result.body)) as { input: Item[] } };
  }

  it('increases the actual imaged baseline and estimated savings as eligible tools grow', async () => {
    const before = await transform(3), after = await transform(6);
    expect(before.info.responsesComposition?.collapsedFunctionPairs).toBe(2);
    expect(after.info.responsesComposition?.collapsedFunctionPairs).toBe(5);
    expect(after.info.baselineImagedTokens!).toBeGreaterThan(before.info.baselineImagedTokens!);
    const saved = (info: typeof after.info) => computeOpenAIBaselineRawTokens(100000,
      info.imageTokens!, info.baselineImagedTokens!, info.nativeInjectedTokens) - 100000;
    expect(saved(after.info)).toBeGreaterThan(saved(before.info));
    expect(saved(before.info)).toBeGreaterThan(0);
    expect(after.info.responsesComposition?.other).toBe(0);
    expect(after.info.responsesComposition?.functionCalls).toBeGreaterThan(0);
    expect(after.info.responsesComposition?.functionOutputs).toBeGreaterThan(0);
    expect(after.info.responsesComposition?.openFunctionCalls).toBe(1);
    const native = after.request.input.filter(i => i.type === 'custom_tool_call' || i.type === 'custom_tool_call_output');
    expect(native.map(i => i.call_id)).toEqual(['round_5', 'round_5', 'active_open']);
    expect(native).toEqual(after.original.filter(i => ['round_5', 'active_open'].includes(i.call_id as string)));
    expect(after.request.input.filter(i => i.type === 'reasoning'))
      .toEqual(after.original.filter(i => i.type === 'reasoning'));
    expect(after.request.input.find(i => i.role === 'user' && typeof i.content === 'string'))
      .toEqual(after.original[0]);
  });

  it('keeps multimodal custom output native and counts its image parts', async () => {
    const pair = customPair('multimodal');
    pair[1]!.output = [{ type: 'input_image', image_url: 'data:image/png;base64,fixture' }];
    const body = enc.encode(JSON.stringify({ model: 'gpt-6-astra', input: [{ role: 'user', content: 'Inspect this output.' }, ...pair] }));
    const result = await transformOpenAIResponses(body);
    expect(dec.decode(result.body)).toBe(dec.decode(body));
    expect(result.info.responsesComposition?.imageParts).toBe(1);
    expect(result.info.responsesComposition?.other).toBe(0);
  });

  it('emits a shared exact spelling once without changing sealed message prefixes', async () => {
    const before = await transform(3), after = await transform(6);
    type Part = { type: string; text?: string };
    const archives = (items: Item[]) => items.filter(i => Array.isArray(i.content)
      && (i.content as Part[]).some(p => p.type === 'input_image'));
    for (const result of [before, after]) {
      const copies = archives(result.request.input).flatMap(i => i.content as Part[])
        .filter(p => p.type === 'input_text' && p.text?.includes(sharedPath));
      expect(copies).toHaveLength(1);
      expect(result.info.imageSourceTexts?.some(s => s.includes(sharedPath))).toBe(true);
    }
    const prefix = archives(before.request.input);
    expect(prefix.length).toBeGreaterThan(0);
    expect(archives(after.request.input).slice(0, prefix.length)).toEqual(prefix);
  });
});
