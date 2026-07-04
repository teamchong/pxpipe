/**
 * Tests for GPT-5 applicability gate, OpenAI vision-token cost model,
 * Chat Completions transformer, and Responses API transformer.
 */
import { describe, expect, it } from 'vitest';
import { isPxpipeSupportedGptModel } from '../src/core/applicability.js';
import { openAIVisionTokens, resolveVisionCost, transformOpenAIChatCompletions, transformOpenAIResponses } from '../src/core/openai.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── Task 1: applicability gate ──────────────────────────────────────────────

describe('isPxpipeSupportedGptModel', () => {
  it('matches GPT 5.6 by default; GPT 5.5 is opt-in only', () => {
    expect(isPxpipeSupportedGptModel('gpt-5')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-5.5')).toBe(false); // off by default — degrades on imaged context
    expect(isPxpipeSupportedGptModel('gpt-5.6')).toBe(true);
    expect(isPxpipeSupportedGptModel('gpt-5-mini')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-5.6-nano')).toBe(true);
    expect(isPxpipeSupportedGptModel('gpt-5.6[1m]')).toBe(true); // variant tag stripped
  });

  it('rejects non-GPT-5 models', () => {
    expect(isPxpipeSupportedGptModel('gpt-4o')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-50')).toBe(false);
    expect(isPxpipeSupportedGptModel('')).toBe(false);
    expect(isPxpipeSupportedGptModel(null)).toBe(false);
    expect(isPxpipeSupportedGptModel(undefined)).toBe(false);
  });
});

// ── Task 2: OpenAI vision-token cost ────────────────────────────────────────

describe('openAIVisionTokens', () => {
  it('gpt-5 at 768x1932 → 70 + 140*8 = 1190 (tile: 2×4 tiles)', () => {
    // 768x1932 with gpt-5 (tile): fits 2048 box (no resize needed); min(768,1932)=768≤768 (no resize);
    // tiles = ceil(768/512)*ceil(1932/512) = 2*4 = 8; cost = 70 + 140*8 = 1190.
    expect(openAIVisionTokens('gpt-5', 768, 1932)).toBe(1190);
  });

  it('gpt-4o at 768x1932 → 85 + 170*8 = 1445', () => {
    expect(openAIVisionTokens('gpt-4o', 768, 1932)).toBe(1445);
  });

  it('gpt-5-mini at 768x1932 → ceil(1464 * 1.62) = 2372', () => {
    // patch model: patches = ceil(768/32)*ceil(1932/32) = 24*61 = 1464; capped at 1536; 1464 < 1536.
    // cost = ceil(1464 * 1.62) = ceil(2371.68) = 2372.
    expect(openAIVisionTokens('gpt-5-mini', 768, 1932)).toBe(2372);
  });

  it('gpt-5 at 2048x2048 → collapses to 768x768 → 4 tiles → 630', () => {
    // 2048x2048: fits 2048 box exactly; min(2048,2048)=2048 > 768 → scale by 768/2048=0.375
    // W=floor(2048*0.375)=768, H=floor(2048*0.375)=768; tiles=ceil(768/512)*ceil(768/512)=2*2=4
    // cost = 70 + 140*4 = 630.
    expect(openAIVisionTokens('gpt-5', 2048, 2048)).toBe(630);
  });

  it('resolveVisionCost returns correct regimes', () => {
    expect(resolveVisionCost('gpt-5').regime).toBe('tile');
    expect(resolveVisionCost('gpt-5.6').regime).toBe('patch');
    expect(resolveVisionCost('gpt-5-mini').regime).toBe('patch');
    expect(resolveVisionCost('gpt-5.6-nano').regime).toBe('patch');
    expect(resolveVisionCost('gpt-4o').regime).toBe('tile');
    expect(resolveVisionCost('o1').regime).toBe('tile');
  });
});

// ── Task 2c + 3: Chat Completions transformer ────────────────────────────────

const BIG_SYSTEM = 'System instruction with lots of detail. '.repeat(500); // ~20k chars
const BIG_TOOL_DESC = 'Tool description with lots of context. '.repeat(200); // ~8k chars
const CHAT_TOOL_PARAMS = { type: 'object', description: 'Param root.', properties: { x: { type: 'string', description: 'x param' } } };
const CHAT_TOOL_DOC = `## Tool: do_thing\n${BIG_TOOL_DESC}\n\`\`\`json\n${JSON.stringify(CHAT_TOOL_PARAMS)}\n\`\`\``;

// Real `task`/`question` tools have a required parameter literally NAMED `description`
// (others collide with `title`/`default`). The strip must drop the annotation but KEEP
// the property: a naive "delete every key called description" walk removes the property
// itself, leaving `required:["description"]` dangling so the model can't satisfy it and
// the host rejects the call with `Missing key at ["description"]`. This shape is shared
// by the Chat and Responses regression tests below.
const TASK_LIKE_PARAMS = {
  type: 'object',
  properties: {
    description: { type: 'string', description: 'A short (3-5 words) description of the task' },
    prompt: { type: 'string', description: 'The task for the agent to perform' },
    title: { type: 'string', description: 'Property name collides with the title keyword' },
  },
  required: ['description', 'prompt'],
  additionalProperties: false,
};

describe('transformOpenAIChatCompletions (gpt-5.6)', () => {
  it('compresses GPT system + tool docs while preserving native tool selection metadata', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      messages: [
        { role: 'system', content: BIG_SYSTEM },
        { role: 'user', content: 'hello' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'do_thing',
          description: BIG_TOOL_DESC,
          parameters: CHAT_TOOL_PARAMS,
        },
      }],
    }));

    const result = await transformOpenAIChatCompletions(body, { charsPerToken: 1, minCompressChars: 1 });
    expect(result.info.compressed).toBe(true);
    expect(result.info.imageCount).toBeGreaterThan(0);
    const expectedImagedChars = `## SYSTEM MESSAGE\n${BIG_SYSTEM}\n\n${CHAT_TOOL_DOC}`.length;
    expect(result.info.origChars).toBe(expectedImagedChars);
    expect(result.info.compressedChars).toBe(expectedImagedChars);
    expect(result.info.bucketChars?.static_slab).toBe(expectedImagedChars);

    const out = JSON.parse(dec.decode(result.body)) as Record<string, unknown>;
    const messages = out.messages as Array<{ role: string; content: unknown }>;
    const firstUser = messages.find((m) => m.role === 'user')!;
    expect(Array.isArray(firstUser.content)).toBe(true);
    const parts = firstUser.content as Array<{ type: string; image_url?: { url: string } }>;
    // First part is an image.
    expect(parts[0]!.type).toBe('image_url');
    expect(parts[0]!.image_url!.url).toMatch(/^data:image\/png;base64,/);

    // Image width should be 768px (152 cols * 5px + 8px pad).
    expect(result.info.firstImageWidth).toBe(768);

    // System message replaced with pointer.
    const sysMsg = messages.find((m) => m.role === 'system')!;
    expect(typeof sysMsg.content === 'string'
      ? sysMsg.content
      : (sysMsg.content as Array<{ text?: string }>)[0]?.text ?? '').toContain('rendered into image');

    // Tool selection stays native; verbose schema prose moved into the image.
    const tools = out.tools as Array<{ function: { description?: string; parameters?: { description?: string; properties?: { x?: { description?: string } } } } }>;
    expect(tools[0]!.function.description).toBe(BIG_TOOL_DESC);
    expect(tools[0]!.function.parameters?.description).toBeUndefined();
    expect(tools[0]!.function.parameters?.properties?.x?.description).toBeUndefined();
  });

  it('images GPT tool definitions even when there is no instruction context', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        type: 'function',
        function: {
          name: 'do_thing',
          description: BIG_TOOL_DESC,
          parameters: CHAT_TOOL_PARAMS,
        },
      }],
    }));

    const result = await transformOpenAIChatCompletions(body, { charsPerToken: 1, minCompressChars: 1 });
    expect(result.info.compressed).toBe(true);
    expect(result.info.origChars).toBe(CHAT_TOOL_DOC.length);
    expect(result.info.compressedChars).toBe(CHAT_TOOL_DOC.length);
    const out = JSON.parse(dec.decode(result.body)) as any;
    expect(out.tools[0].function.description).toBe(BIG_TOOL_DESC);
    expect(out.tools[0].function.parameters.description).toBeUndefined();
  });

  it('keeps a parameter literally named "description" (task-tool regression)', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        type: 'function',
        function: { name: 'task', description: BIG_TOOL_DESC, parameters: TASK_LIKE_PARAMS },
      }],
    }));

    const result = await transformOpenAIChatCompletions(body, { charsPerToken: 1, minCompressChars: 1 });
    expect(result.info.compressed).toBe(true);
    const out = JSON.parse(dec.decode(result.body)) as any;
    const params = out.tools[0].function.parameters;
    // Property NAMES survive — including ones that collide with annotation keywords.
    expect(Object.keys(params.properties).sort()).toEqual(['description', 'prompt', 'title']);
    // `required` still points at real, present properties (this is what GPT failed before).
    expect(params.required).toEqual(['description', 'prompt']);
    for (const name of params.required) expect(params.properties[name]).toBeDefined();
    // …but the verbose annotation inside each property is gone (it lives in the image).
    expect(params.properties.description.type).toBe('string');
    expect(params.properties.description.description).toBeUndefined();
    expect(params.properties.title.description).toBeUndefined();
  });

  it('returns compressed=false with not_profitable reason for small input', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      messages: [
        { role: 'system', content: 'short' },
        { role: 'user', content: 'hi' },
      ],
    }));
    // Default minCompressChars=2000, so 'short' is below threshold.
    const result = await transformOpenAIChatCompletions(body);
    expect(result.info.compressed).toBe(false);
    expect(result.info.reason).toMatch(/below_min_chars|not_profitable/);
  });
});

// ── Task 3: Responses API transformer ───────────────────────────────────────

const BIG_INSTRUCTIONS = 'These are detailed instructions. '.repeat(600); // ~20k chars
const BIG_FLAT_TOOL_DESC = 'Flat tool description with lots of context. '.repeat(200); // ~8k chars
const RESPONSES_TOOL_PARAMS = { type: 'object', description: 'Param root.', properties: { x: { type: 'string', description: 'x param' } } };
const RESPONSES_TOOL_DOC = `## Tool: do_thing\n${BIG_FLAT_TOOL_DESC}\n\`\`\`json\n${JSON.stringify(RESPONSES_TOOL_PARAMS)}\n\`\`\``;

describe('transformOpenAIResponses (gpt-5.6)', () => {
  it('compresses GPT Responses instructions + tool docs while preserving native tool selection metadata', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      instructions: BIG_INSTRUCTIONS,
      input: [
        { role: 'user', content: 'Please do the thing.' },
      ],
      tools: [{
        type: 'function',
        name: 'do_thing',
        description: BIG_FLAT_TOOL_DESC,
        parameters: RESPONSES_TOOL_PARAMS,
      }],
    }));

    const result = await transformOpenAIResponses(body, { charsPerToken: 1, minCompressChars: 1 });
    expect(result.info.compressed).toBe(true);
    expect(result.info.imageCount).toBeGreaterThan(0);
    expect(result.info.firstUserSha8).toMatch(/^[0-9a-f]{8}$/);
    const expectedImagedChars = `## INSTRUCTIONS\n${BIG_INSTRUCTIONS}\n\n${RESPONSES_TOOL_DOC}`.length;
    expect(result.info.origChars).toBe(expectedImagedChars);
    expect(result.info.compressedChars).toBe(expectedImagedChars);
    expect(result.info.bucketChars?.static_slab).toBe(expectedImagedChars);

    const out = JSON.parse(dec.decode(result.body)) as Record<string, unknown>;
    // instructions replaced with pointer.
    expect(out.instructions as string).toContain('rendered into image');
    expect(out.instructions as string).not.toContain('These are detailed');

    // First user item gains input_image parts.
    const inputItems = out.input as Array<{ role: string; content: unknown }>;
    const firstUser = inputItems.find((i) => i.role === 'user')!;
    expect(Array.isArray(firstUser.content)).toBe(true);
    const parts = firstUser.content as Array<{ type: string; image_url?: string }>;
    expect(parts[0]!.type).toBe('input_image');
    expect(parts[0]!.image_url).toMatch(/^data:image\/png;base64,/);

    // Tool selection stays native; verbose schema prose moved into the image.
    const tools = out.tools as Array<{ description?: string; parameters?: { description?: string; properties?: { x?: { description?: string } } } }>;
    expect(tools[0]!.description).toBe(BIG_FLAT_TOOL_DESC);
    expect(tools[0]!.parameters?.description).toBeUndefined();
    expect(tools[0]!.parameters?.properties?.x?.description).toBeUndefined();
  });

  it('images developer/system items whose content is an input_text part array, not just a string', async () => {
    // Responses allows message content as a string OR an array of parts. The
    // array form for a developer/system item used to be dropped: not imaged and
    // not stubbed, so the verbose text rode uncompressed as native input.
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: BIG_INSTRUCTIONS }] },
        { role: 'user', content: 'Please do the thing.' },
      ],
    }));

    const result = await transformOpenAIResponses(body, { charsPerToken: 1, minCompressChars: 1 });
    expect(result.info.compressed).toBe(true);
    expect(result.info.imageCount).toBeGreaterThan(0);
    // The array-form developer text is now counted as static context.
    expect(result.info.staticChars).toBeGreaterThanOrEqual(BIG_INSTRUCTIONS.length);

    const out = JSON.parse(dec.decode(result.body)) as { input: Array<{ role: string; content: unknown }> };
    const dev = out.input.find((i) => i.role === 'developer')!;
    // Array shape preserved, but the big text is gone — replaced by a pointer part.
    expect(Array.isArray(dev.content)).toBe(true);
    const devParts = dev.content as Array<{ type: string; text?: string }>;
    expect(devParts).toHaveLength(1);
    expect(devParts[0]!.type).toBe('input_text');
    expect(devParts[0]!.text).toContain('rendered into image');
    expect(JSON.stringify(dev.content)).not.toContain('These are detailed');
  });

  it('images GPT Responses tool definitions even when there is no instruction context', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      input: [{ role: 'user', content: 'Please do the thing.' }],
      tools: [{
        type: 'function',
        name: 'do_thing',
        description: BIG_FLAT_TOOL_DESC,
        parameters: RESPONSES_TOOL_PARAMS,
      }],
    }));

    const result = await transformOpenAIResponses(body, { charsPerToken: 1, minCompressChars: 1 });
    expect(result.info.compressed).toBe(true);
    expect(result.info.origChars).toBe(RESPONSES_TOOL_DOC.length);
    expect(result.info.compressedChars).toBe(RESPONSES_TOOL_DOC.length);
    const out = JSON.parse(dec.decode(result.body)) as any;
    expect(out.tools[0].description).toBe(BIG_FLAT_TOOL_DESC);
    expect(out.tools[0].parameters.description).toBeUndefined();
  });

  it('keeps a parameter literally named "description" (task-tool regression)', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      input: [{ role: 'user', content: 'Please do the thing.' }],
      tools: [{ type: 'function', name: 'task', description: BIG_FLAT_TOOL_DESC, parameters: TASK_LIKE_PARAMS }],
    }));

    const result = await transformOpenAIResponses(body, { charsPerToken: 1, minCompressChars: 1 });
    expect(result.info.compressed).toBe(true);
    const out = JSON.parse(dec.decode(result.body)) as any;
    const params = out.tools[0].parameters;
    expect(Object.keys(params.properties).sort()).toEqual(['description', 'prompt', 'title']);
    expect(params.required).toEqual(['description', 'prompt']);
    for (const name of params.required) expect(params.properties[name]).toBeDefined();
    expect(params.properties.description.type).toBe('string');
    expect(params.properties.description.description).toBeUndefined();
  });

  it('handles bare string input (wraps into user item with images)', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      instructions: BIG_INSTRUCTIONS,
      input: 'Do the thing please.',
    }));

    const result = await transformOpenAIResponses(body, { charsPerToken: 1, minCompressChars: 1 });
    expect(result.info.compressed).toBe(true);
    expect(result.info.firstUserSha8).toMatch(/^[0-9a-f]{8}$/);

    const out = JSON.parse(dec.decode(result.body)) as Record<string, unknown>;
    // input should now be an array.
    expect(Array.isArray(out.input)).toBe(true);
    const inputItems = out.input as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    expect(inputItems[0]!.role).toBe('user');
    const parts = inputItems[0]!.content;
    expect(parts[0]!.type).toBe('input_image');
    // Original string preserved as input_text part.
    const textParts = parts.filter((p) => p.type === 'input_text');
    expect(textParts.some((p) => p.text?.includes('Do the thing'))).toBe(true);
  });

  it('returns compressed=false with not_profitable/below_min reason for small input', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      instructions: 'Short.',
      input: [{ role: 'user', content: 'hi' }],
    }));
    const result = await transformOpenAIResponses(body);
    expect(result.info.compressed).toBe(false);
    expect(result.info.reason).toMatch(/below_min_chars|not_profitable/);
  });
});

// -- Task 4: GPT history-image collapse (the growing transcript) ---------------

const BIG_SLAB = 'You are a coding agent with detailed instructions. '.repeat(80); // ~4k chars
const OPENING_PROMPT_MARKER = 'OPENING_PROMPT_SHOULD_BE_HISTORY';
const LIVE_PROMPT_MARKER = 'LIVE_CURRENT_PROMPT_SHOULD_STAY_TEXT';

/** A long Responses `input`: first user, then many closed tool-call turns + a
 *  recent tail. Each turn is ~600 chars so the collapsed prefix clears the 8000
 *  minCollapseChars floor. */
function buildResponsesInput(turns: number): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [
    { role: 'user', content: `${OPENING_PROMPT_MARKER} `.repeat(40) },
  ];
  for (let i = 0; i < turns; i++) {
    const id = `call_${i}`;
    items.push({ role: 'assistant', content: `Working on step ${i}. `.repeat(30) });
    items.push({ type: 'function_call', call_id: id, name: 'read', arguments: `{"path":"f${i}"}` });
    items.push({ type: 'function_call_output', call_id: id, output: `result ${i} `.repeat(50) });
    items.push({
      role: 'user',
      content: i === turns - 1
        ? `${LIVE_PROMPT_MARKER} `.repeat(20)
        : `Continue with ${i}. `.repeat(20),
    });
  }
  return items;
}

function buildChatMessages(turns: number): Array<Record<string, unknown>> {
  const msgs: Array<Record<string, unknown>> = [
    { role: 'system', content: BIG_SLAB },
    { role: 'user', content: `${OPENING_PROMPT_MARKER} `.repeat(40) },
  ];
  for (let i = 0; i < turns; i++) {
    const id = `call_${i}`;
    msgs.push({
      role: 'assistant',
      content: `Working on step ${i}. `.repeat(30),
      tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: `{"path":"f${i}"}` } }],
    });
    msgs.push({ role: 'tool', tool_call_id: id, content: `result ${i} `.repeat(50) });
    msgs.push({
      role: 'user',
      content: i === turns - 1
        ? `${LIVE_PROMPT_MARKER} `.repeat(20)
        : `Continue with ${i}. `.repeat(20),
    });
  }
  return msgs;
}

describe('transformOpenAIResponses — history collapse', () => {
  it('collapses the OLD transcript prefix into history images, keeps the tail as text', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      instructions: BIG_SLAB,
      input: buildResponsesInput(20),
    }));
    const result = await transformOpenAIResponses(body, { charsPerToken: 1, minCompressChars: 1 });
    expect(result.info.compressed).toBe(true);
    expect(result.info.historyReason).toBe('collapsed');
    expect(result.info.collapsedImages ?? 0).toBeGreaterThan(0);
    expect(result.info.collapsedTurns ?? 0).toBeGreaterThanOrEqual(10);
    // baselineImagedTokens (o200k text) must exceed imageTokens (vision) — the win.
    expect(result.info.baselineImagedTokens ?? 0).toBeGreaterThan(result.info.imageTokens ?? 0);

    const out = JSON.parse(dec.decode(result.body)) as { input: Array<Record<string, unknown>> };
    // The first user item (slab anchor) is still present and first.
    expect((out.input[0] as { role?: string }).role).toBe('user');
    // Exactly one synthetic history item carries input_image parts beyond the slab.
    const historyItems = out.input.filter((item) => {
      const c = (item as { content?: unknown }).content;
      return (
        Array.isArray(c) &&
        c.some((p) => (p as { type?: string }).type === 'input_image') &&
        c.some((p) => (p as { text?: string }).text?.includes('attribute every turn strictly by its tag'))
      );
    });
    expect(historyItems).toHaveLength(1);
    const historyIdx = out.input.indexOf(historyItems[0]!);
    expect((out.input[historyIdx + 1] as { role?: string }).role).toBe('developer');
    expect(JSON.stringify(out.input[historyIdx + 1])).toContain('live current request');
    const serialized = JSON.stringify(out.input);
    // The opening prompt's BODY was collapsed into an image → its legible text is gone.
    // Its bare marker may surface once in the verbatim fact-sheet beside the image (by
    // design — precision-critical ids are kept as text); the repeated body does not.
    expect(serialized).not.toContain(`${OPENING_PROMPT_MARKER} ${OPENING_PROMPT_MARKER}`);
    expect(serialized).toContain(LIVE_PROMPT_MARKER);
    // The recent tail is still raw text items (function_call / user), not collapsed.
    const lastUser = [...out.input].reverse().find(
      (item) => (item as { role?: string }).role === 'user',
    ) as { content?: string };
    expect(typeof lastUser.content === 'string' && lastUser.content.includes(LIVE_PROMPT_MARKER)).toBe(true);
  });

  it('produces a byte-stable history image sha across identical requests', async () => {
    const make = () => enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      instructions: BIG_SLAB,
      input: buildResponsesInput(20),
    }));
    const a = await transformOpenAIResponses(make(), { charsPerToken: 1, minCompressChars: 1 });
    const b = await transformOpenAIResponses(make(), { charsPerToken: 1, minCompressChars: 1 });
    expect(a.info.historyImageSha).toBeDefined();
    expect(a.info.historyImageSha).toBe(b.info.historyImageSha);
  });

  it('does not collapse when collapseHistory is off', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      instructions: BIG_SLAB,
      input: buildResponsesInput(20),
    }));
    const result = await transformOpenAIResponses(body, {
      charsPerToken: 1,
      minCompressChars: 1,
      collapseHistory: false,
    });
    expect(result.info.compressed).toBe(true);
    expect(result.info.historyReason).not.toBe('collapsed');
    expect(result.info.collapsedImages ?? 0).toBe(0);
  });

  it('partially collapses GPT history up to the image cap and leaves the rest as text', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      instructions: BIG_SLAB,
      input: buildResponsesInput(30),
    }));
    const result = await transformOpenAIResponses(body, {
      charsPerToken: 1,
      minCompressChars: 1,
      gptHistory: { collapseChunk: 0, sectionTokens: 100, maxImages: 2 },
    });
    expect(result.info.compressed).toBe(true);
    expect(result.info.historyReason).toBe('collapsed');
    expect(result.info.collapsedImages ?? 0).toBeGreaterThan(0);
    expect(result.info.collapsedImages ?? 0).toBeLessThanOrEqual(2);

    const out = JSON.parse(dec.decode(result.body)) as { input: Array<Record<string, unknown>> };
    const serialized = JSON.stringify(out.input);
    // Oldest prefix became a bounded history-image item, while later history and
    // the current prompt remain plain text after the cap.
    expect(serialized).toContain('attribute every turn strictly by its tag');
    expect(serialized).toContain('Continue with 28');
    expect(serialized).toContain(LIVE_PROMPT_MARKER);
  });
});

describe('transformOpenAIChatCompletions — history collapse', () => {
  it('collapses the OLD transcript into a synthetic user message with image_url parts', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      messages: buildChatMessages(20),
    }));
    const result = await transformOpenAIChatCompletions(body, { charsPerToken: 1, minCompressChars: 1 });
    expect(result.info.compressed).toBe(true);
    expect(result.info.historyReason).toBe('collapsed');
    expect(result.info.collapsedImages ?? 0).toBeGreaterThan(0);

    const out = JSON.parse(dec.decode(result.body)) as { messages: Array<Record<string, unknown>> };
    const historyMsgs = out.messages.filter((m) => {
      const c = (m as { content?: unknown }).content;
      return (
        Array.isArray(c) &&
        c.some((p) => (p as { type?: string }).type === 'image_url') &&
        c.some((p) => (p as { text?: string }).text?.includes('attribute every turn strictly by its tag'))
      );
    });
    expect(historyMsgs).toHaveLength(1);
    const historyIdx = out.messages.indexOf(historyMsgs[0]!);
    expect((out.messages[historyIdx + 1] as { role?: string }).role).toBe('developer');
    expect(JSON.stringify(out.messages[historyIdx + 1])).toContain('live current request');
    const serialized = JSON.stringify(out.messages);
    // The opening prompt's BODY was collapsed into an image → its legible text is gone.
    // Its bare marker may surface once in the verbatim fact-sheet beside the image (by
    // design — precision-critical ids are kept as text); the repeated body does not.
    expect(serialized).not.toContain(`${OPENING_PROMPT_MARKER} ${OPENING_PROMPT_MARKER}`);
    expect(serialized).toContain(LIVE_PROMPT_MARKER);
  });
});

// Autonomous agent shape (OpenCode / gpt-5.5): ONE human request, then a long
// run of assistant + tool turns and NO further user turns. The lone request is the
// OLDEST turn, so without pinning it is the first thing imaged and the model loses
// it ("I wonder what the user actually asked" → off-task drift). The pin keeps the
// most-recent (here: only) user turn as legible text while the work still images.
function buildAutonomousResponses(turns: number): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [
    { role: 'user', content: `${LIVE_PROMPT_MARKER} `.repeat(40) },
  ];
  for (let i = 0; i < turns; i++) {
    const id = `call_${i}`;
    items.push({ role: 'assistant', content: `Working on step ${i}. `.repeat(30) });
    items.push({ type: 'function_call', call_id: id, name: 'read', arguments: `{"path":"f${i}"}` });
    items.push({ type: 'function_call_output', call_id: id, output: `result ${i} `.repeat(50) });
  }
  return items;
}

function buildAutonomousChat(turns: number): Array<Record<string, unknown>> {
  const msgs: Array<Record<string, unknown>> = [
    { role: 'system', content: BIG_SLAB },
    { role: 'user', content: `${LIVE_PROMPT_MARKER} `.repeat(40) },
  ];
  for (let i = 0; i < turns; i++) {
    const id = `call_${i}`;
    msgs.push({
      role: 'assistant',
      content: `Working on step ${i}. `.repeat(30),
      tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: `{"path":"f${i}"}` } }],
    });
    msgs.push({ role: 'tool', tool_call_id: id, content: `result ${i} `.repeat(50) });
  }
  return msgs;
}

describe('GPT history collapse — pins the live request as text (autonomous shape)', () => {
  it('Responses: lone request kept as legible text + echoed in the guard, work imaged', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      instructions: BIG_SLAB,
      input: buildAutonomousResponses(24),
    }));
    const result = await transformOpenAIResponses(body, { charsPerToken: 1, minCompressChars: 1 });
    expect(result.info.historyReason).toBe('collapsed');
    expect(result.info.collapsedImages ?? 0).toBeGreaterThan(0);

    const out = JSON.parse(dec.decode(result.body)) as { input: Array<Record<string, unknown>> };
    const serialized = JSON.stringify(out.input);
    // The request survives as LEGIBLE TEXT (not OCR-only) under the pin banner.
    expect(serialized).toContain('CURRENT USER REQUEST');
    expect(serialized).toContain(LIVE_PROMPT_MARKER);
    // The synthetic HISTORY item (not the slab) carries the pinned text + images.
    const hist = out.input.find((it) => {
      const c = (it as { content?: unknown }).content;
      return (
        Array.isArray(c) &&
        c.some((p) => (p as { type?: string }).type === 'input_image') &&
        c.some((p) => (p as { text?: string }).text?.includes('attribute every turn strictly by its tag'))
      );
    }) as { content: Array<{ type: string; text?: string }> };
    expect(hist).toBeDefined();
    expect(hist.content.some((p) => p.type === 'input_text' && p.text?.includes(LIVE_PROMPT_MARKER))).toBe(true);
    // The developer guard echoes the request verbatim.
    const dev = out.input.find((it) => (it as { role?: string }).role === 'developer');
    expect(JSON.stringify(dev)).toContain(LIVE_PROMPT_MARKER);
  });

  it('Chat: lone request kept as legible text + echoed in the guard, work imaged', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      messages: buildAutonomousChat(24),
    }));
    const result = await transformOpenAIChatCompletions(body, { charsPerToken: 1, minCompressChars: 1 });
    expect(result.info.historyReason).toBe('collapsed');
    expect(result.info.collapsedImages ?? 0).toBeGreaterThan(0);

    const out = JSON.parse(dec.decode(result.body)) as { messages: Array<Record<string, unknown>> };
    const serialized = JSON.stringify(out.messages);
    expect(serialized).toContain('CURRENT USER REQUEST');
    expect(serialized).toContain(LIVE_PROMPT_MARKER);
    const hist = out.messages.find((m) => {
      const c = (m as { content?: unknown }).content;
      return (
        Array.isArray(c) &&
        c.some((p) => (p as { type?: string }).type === 'image_url') &&
        c.some((p) => (p as { text?: string }).text?.includes('attribute every turn strictly by its tag'))
      );
    }) as { content: Array<{ type: string; text?: string }> };
    expect(hist).toBeDefined();
    expect(hist.content.some((p) => p.type === 'text' && p.text?.includes(LIVE_PROMPT_MARKER))).toBe(true);
    const dev = out.messages.find((m) => (m as { role?: string }).role === 'developer');
    expect(JSON.stringify(dev)).toContain(LIVE_PROMPT_MARKER);
  });

  it('Responses: byte-stable history image sha across identical autonomous requests', async () => {
    const make = () => enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      instructions: BIG_SLAB,
      input: buildAutonomousResponses(24),
    }));
    const a = await transformOpenAIResponses(make(), { charsPerToken: 1, minCompressChars: 1 });
    const b = await transformOpenAIResponses(make(), { charsPerToken: 1, minCompressChars: 1 });
    expect(a.info.historyImageSha).toBeDefined();
    expect(a.info.historyImageSha).toBe(b.info.historyImageSha);
  });
});

// ── Vision cost: gpt-5.x FLAGSHIP patch model (multiplier 1.0, original detail) ──
// Per OpenAI docs (patch tokenization): flagship gpt-5.4/5.5/5.6 have NO listed
// multiplier (= 1.0); the 1.62/2.46 values are mini/nano ONLY. And `detail:original`
// (gpt-5.5's default) gives a 10,000-patch / 6000px budget vs `high`'s 2,500 / 2048px.
// pxpipe renders dense text, so it must use the LARGER budget or OpenAI downscales
// the image and the text becomes unreadable.
describe('openAIVisionTokens — gpt-5.x flagship patch model', () => {
  it('flagship multiplier is 1.0, not the mini 1.62', () => {
    // 768x1932 → patches = ceil(768/32)*ceil(1932/32) = 24*61 = 1464; ×1.0 = 1464.
    expect(openAIVisionTokens('gpt-5.6', 768, 1932)).toBe(1464);
    expect(openAIVisionTokens('gpt-5.5', 768, 1932)).toBe(1464);
  });

  it('flagship patch budget is 10,000 (original detail), not 2,500', () => {
    // 4000x4000 → patches = 125*125 = 15625, capped at the budget.
    // Pre-fix (cap 2500, ×1.62) this returned 4050; correct is min(15625,10000)=10000.
    expect(openAIVisionTokens('gpt-5.6', 4000, 4000)).toBe(10000);
  });

  it('resolveVisionCost flagship = patch, multiplier 1, cap 10000; mini stays 1.62/1536', () => {
    expect(resolveVisionCost('gpt-5.6')).toMatchObject({ regime: 'patch', multiplier: 1, patchCap: 10000 });
    expect(resolveVisionCost('gpt-5.5')).toMatchObject({ regime: 'patch', multiplier: 1, patchCap: 10000 });
    expect(resolveVisionCost('gpt-5.6-mini')).toMatchObject({ regime: 'patch', multiplier: 1.62, patchCap: 1536 });
    expect(resolveVisionCost('gpt-5.6-nano')).toMatchObject({ regime: 'patch', multiplier: 2.46, patchCap: 1536 });
    // mini at 768x1932: patches 1464 (<1536) × 1.62 = ceil(2371.68) = 2372 (unchanged).
    expect(openAIVisionTokens('gpt-5.6-mini', 768, 1932)).toBe(2372);
  });
});

describe('image parts request detail = "original" (avoid downscale of dense text)', () => {
  it('Chat Completions image_url parts use detail:"original"', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      messages: [
        { role: 'system', content: BIG_SYSTEM },
        { role: 'user', content: 'hello' },
      ],
    }));
    const result = await transformOpenAIChatCompletions(body, { charsPerToken: 1, minCompressChars: 1 });
    expect(result.info.compressed).toBe(true);
    const out = JSON.parse(dec.decode(result.body)) as { messages: Array<{ role: string; content: unknown }> };
    const firstUser = out.messages.find((m) => m.role === 'user')!;
    const parts = firstUser.content as Array<{ type: string; image_url?: { detail?: string } }>;
    const imgs = parts.filter((p) => p.type === 'image_url');
    expect(imgs.length).toBeGreaterThan(0);
    for (const p of imgs) expect(p.image_url!.detail).toBe('original');
  });

  it('Responses input_image parts use detail:"original"', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'gpt-5.6',
      instructions: BIG_INSTRUCTIONS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    }));
    const result = await transformOpenAIResponses(body, { charsPerToken: 1, minCompressChars: 1 });
    expect(result.info.compressed).toBe(true);
    const out = JSON.parse(dec.decode(result.body)) as { input: Array<{ role?: string; content?: unknown }> };
    const firstUser = out.input.find((m) => m.role === 'user')!;
    const parts = firstUser.content as Array<{ type: string; detail?: string }>;
    const imgs = parts.filter((p) => p.type === 'input_image');
    expect(imgs.length).toBeGreaterThan(0);
    for (const p of imgs) expect(p.detail).toBe('original');
  });
});
