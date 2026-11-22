import { describe, expect, it } from 'vitest';
import { transformRequest } from '../src/core/transform.js';
import { collapseHistory } from '../src/core/history.js';
import { isCompressionProfitable } from '../src/core/transform.js';
import type { SplitBlock, SplitBlockInput } from '../src/core/split-block.js';
import type { Message } from '../src/core/types.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

const LINES = Array.from({ length: 400 }, (_unused, index) => `row ${index}: the build step finished and wrote its report to disk`);
const TOOL_TEXT = LINES.join('\n');

function toolRequest(): Uint8Array {
  return enc.encode(JSON.stringify({
    model: 'claude-3-5-sonnet',
    system: 'x'.repeat(80_000),
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: TOOL_TEXT }] }],
  }));
}

function lineOffset(text: string, line: number): number {
  let offset = 0;
  for (let index = 0; index < line; index++) offset = text.indexOf('\n', offset) + 1;
  return offset;
}

describe('splitBlock hook', () => {
  it('an image plan gives the same bytes as no hook, and a failed or invalid plan never images', async () => {
    const plain = await transformRequest(toolRequest(), { charsPerToken: 2 });
    const hooked = await transformRequest(toolRequest(), { charsPerToken: 2, splitBlock: async () => ({ kind: 'image' }) });
    expect(dec.decode(hooked.body)).toBe(dec.decode(plain.body));
    expect(dec.decode(plain.body)).toContain('"type":"image"');
    const failing: SplitBlock = async () => {
      throw new Error('plugin bug');
    };
    const invalid: SplitBlock = async (input) => ({
      kind: 'segments',
      segments: [{ kind: 'image', start: 0, end: input.text.length - 1 }],
    });
    for (const splitBlock of [failing, invalid]) {
      const { body } = await transformRequest(toolRequest(), { charsPerToken: 2, splitBlock });
      expect(dec.decode(body)).not.toContain('"type":"image"');
    }
  });

  it('renders tool_result segments in source order and keeps text segments exact', async () => {
    const sites: string[] = [];
    const hook: SplitBlock = async (input) => {
      sites.push(input.site);
      if (input.site !== 'tool_result') return { kind: 'image' };
      const textStart = lineOffset(input.text, 150);
      const textEnd = lineOffset(input.text, 160);
      return {
        kind: 'segments',
        segments: [
          { kind: 'image', start: 0, end: textStart },
          { kind: 'text', start: textStart, end: textEnd },
          { kind: 'image', start: textEnd, end: input.text.length },
        ],
        stats: { selected: 1 },
      };
    };
    const { body, info } = await transformRequest(toolRequest(), { charsPerToken: 2, splitBlock: hook });
    expect(sites).toContain('tool_result');
    const message = JSON.parse(dec.decode(body)).messages.find((entry: Message) => entry.role === 'user');
    const result = message.content.find((block: { type: string }) => block.type === 'tool_result');
    const kinds = result.content.map((part: { type: string }) => part.type);
    const firstText = kinds.indexOf('text');
    expect(firstText).toBeGreaterThan(0);
    expect(kinds.lastIndexOf('text')).toBe(firstText);
    expect(kinds.slice(firstText + 1)).toContain('image');
    expect(result.content[firstText].text).toBe(LINES.slice(150, 160).join('\n') + '\n');
    expect(info.splitStats).toEqual({ selected: 1 });
  });

  it('history spans cover only the role tags, and split chunks keep their text', async () => {
    const messages: Message[] = [];
    for (let index = 0; index < 12; index++) {
      const body = `turn ${index} ` + 'detail '.repeat(400);
      messages.push(index % 2 === 0
        ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${index}`, content: body }] }
        : { role: 'assistant', content: [{ type: 'text', text: body }] });
    }
    const inputs: Array<Pick<SplitBlockInput, 'text' | 'protectedSpans'>> = [];
    const { messages: out, info } = await collapseHistory(messages, isCompressionProfitable, {
      keepTail: 2,
      minCollapsePrefix: 5,
      collapseChunk: 0,
      splitBlock: async (text, protectedSpans) => {
        inputs.push({ text, protectedSpans });
        const firstTurnEnd = text.indexOf('\n\n') + 2;
        return {
          kind: 'segments',
          segments: [
            { kind: 'text', start: 0, end: firstTurnEnd },
            { kind: 'image', start: firstTurnEnd, end: text.length },
          ],
        };
      },
    });
    expect(info.reason).toBeUndefined();
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      const tags = input.protectedSpans.map((span) => input.text.slice(span.start, span.end));
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) expect(tag).toMatch(/^<\/?(user|assistant)( t="\d+")?>$/);
    }
    const synthetic = out.find((message) => Array.isArray(message.content) && message.content.some((block) => block.type === 'image'))!;
    const texts = (synthetic.content as Array<{ type: string; text?: string }>).filter((block) => block.type === 'text').map((block) => block.text);
    const firstTurn = inputs[0]!.text.slice(0, inputs[0]!.text.indexOf('\n\n') + 2);
    expect(texts).toContain(firstTurn);
  });

  it('with a hook, history never uses the default render', async () => {
    const pasted = Array.from({ length: 400 }, (_unused, index) => `pasted log line ${index}`).join('\n');
    const messages: Message[] = [];
    for (let index = 0; index < 12; index++) {
      const body = `turn ${index} ` + 'detail '.repeat(400);
      messages.push(index % 2 === 0
        ? { role: 'user', content: index === 2 ? [{ type: 'text', text: pasted }] : [{ type: 'tool_result', tool_use_id: `toolu_${index}`, content: body }] }
        : { role: 'assistant', content: [{ type: 'text', text: body }] });
    }
    const options = { keepTail: 2, minCollapsePrefix: 5, collapseChunk: 0 };
    const plain = await collapseHistory(messages, isCompressionProfitable, options);
    expect(JSON.stringify(plain.messages)).not.toContain('pasted log line 399');
    const wholeImage = await collapseHistory(messages, isCompressionProfitable, {
      ...options,
      splitBlock: async (text) => ({ kind: 'segments', segments: [{ kind: 'image', start: 0, end: text.length }] }),
    });
    expect(wholeImage.info.reason).toBeUndefined();
    expect(JSON.stringify(wholeImage.messages)).toContain(JSON.stringify(pasted).slice(1, -1));
    expect(wholeImage.info.collapsedImages).toBeGreaterThan(0);
    let hookCalls = 0;
    const overBudget = await collapseHistory(messages, isCompressionProfitable, {
      ...options,
      imageBudget: 2,
      splitBlock: async (text) => {
        hookCalls++;
        const cuts = [0, ...[1, 2, 3, 4, 5, 6, 7].map((part) => text.indexOf('detail ', (text.length * part) >> 3)), text.length];
        return { kind: 'segments', segments: cuts.slice(1).map((end, index) => ({ kind: 'image' as const, start: cuts[index]!, end })) };
      },
    });
    expect(hookCalls).toBeGreaterThan(0);
    expect(overBudget.info.reason).toBe('over_budget');
    expect(overBudget.info.freezeStep).toBeUndefined();
    expect(overBudget.messages).toBe(messages);
  });
});
