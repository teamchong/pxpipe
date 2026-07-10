/**
 * END-TO-END design-behaviour contract through the REAL proxy.
 *
 * After "don't bust the cache" (cache-stability-e2e) and "don't overclaim"
 * (savings-honesty / savings-math), this asserts the three things pxpipe is
 * actually FOR behave per design, end to end:
 *
 *   1. SYSTEM PROMPT  — the bulky system/slab is imaged out of the request
 *                       (no longer billed as text), live content preserved.
 *   2. HISTORY COLLAPSE — old closed turns become images; recent turns stay as
 *                         legible text (the working set the model still acts on).
 *   3. TOOLS IN RECENT TURNS — a tool_use/tool_result in the recent tail stays
 *                              text (usable), and no tool_result is ever orphaned
 *                              from its tool_use across the image boundary.
 *
 *   fake api  = upstream output (canned response + count_tokens)
 *   our input = pxpipe's transform of the request
 *
 * Run just this file:  pnpm vitest run tests/design-behavior-e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProxy } from '../src/core/proxy.js';

// These proxy-contract tests deliberately exercise the opt-in Sol transform.
// Snapshot the developer shell so the suite is deterministic now that Sol is
// intentionally absent from the built-in default scope.
let ambientPxpipeModels: string | undefined;
beforeAll(() => {
  ambientPxpipeModels = process.env.PXPIPE_MODELS;
  process.env.PXPIPE_MODELS = 'claude-fable-5,gpt-5.6-sol';
});
afterAll(() => {
  if (ambientPxpipeModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = ambientPxpipeModels;
});

function fakeUpstream() {
  const main: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(req.url).pathname;
    if (path.endsWith('/count_tokens')) {
      return new Response(JSON.stringify({ input_tokens: 9999 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    main.push(await req.clone().text());
    if (path.includes('chat/completions')) {
      return new Response(
        JSON.stringify({
          id: 'c1', object: 'chat.completion',
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        id: 'm1', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-fable-5', stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { main, restore: () => { globalThis.fetch = real; } };
}

const FORCE = { charsPerToken: 1, minCompressChars: 1 } as const;
const big = (n: number) => 'x'.repeat(n);

async function drive(path: string, body: string): Promise<any> {
  const cap = fakeUpstream();
  const proxy = createProxy({
    upstream: 'http://anthropic.test', apiKey: 'sk-ant',
    openAIUpstream: 'https://openai.test', openAIApiKey: 'sk-oai',
    transform: FORCE, onRequest: () => {},
  });
  const res = await proxy(
    new Request(`http://localhost${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    }),
  );
  await res.text();
  cap.restore();
  return JSON.parse(cap.main[0]!);
}

const imageCount = (out: any, key: 'messages' | 'input' = 'messages'): number => {
  let n = 0;
  for (const m of out[key] ?? []) {
    if (!Array.isArray(m.content)) continue;
    for (const c of m.content) if (c?.type === 'image' || c?.type === 'image_url' || c?.type === 'input_image') n++;
  }
  return n;
};

// ===========================================================================
describe('design: SYSTEM PROMPT imaging (Anthropic)', () => {
  it('moves the bulky system slab into images and drops it from the request text', async () => {
    const out = await drive(
      '/v1/messages',
      JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 16,
        system: [{ type: 'text', text: 'SLAB_SECRET_' + big(80_000), cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: 'LIVE_QUESTION here' }],
      }),
    );
    const hay = JSON.stringify(out);
    // The slab is no longer billed as text anywhere…
    expect(hay).not.toContain('SLAB_SECRET_');
    // …it became image(s), which land in the first user message.
    expect(imageCount(out)).toBeGreaterThan(0);
    // The system field no longer carries the slab (Anthropic forbids images there).
    expect(JSON.stringify(out.system ?? '')).not.toContain('SLAB_SECRET_');
    // The live turn is preserved verbatim and legible.
    expect(hay).toContain('LIVE_QUESTION here');
  });
});

// ===========================================================================
describe('design: HISTORY COLLAPSE (Anthropic)', () => {
  it('images OLD turns but keeps RECENT turns as legible text', async () => {
    const turns = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `TURNMARK_${i} ${big(4000)}`,
    }));
    const out = await drive(
      '/v1/messages',
      JSON.stringify({ model: 'claude-fable-5', max_tokens: 16, system: 'short', messages: turns }),
    );
    const hay = JSON.stringify(out);
    expect(imageCount(out)).toBeGreaterThan(0);
    // Recent turns survive as legible text BODY (the working set the model still reasons over).
    expect(hay).toContain('TURNMARK_29 ' + 'x'.repeat(100));
    expect(hay).toContain('TURNMARK_28 ' + 'x'.repeat(100));
    // A mid-history turn's BODY was collapsed into an image → its content is not legible text.
    // Its bare identifier may appear in the verbatim fact-sheet beside the image (by design —
    // precision-critical tokens are preserved as text); the 4000-char body is not.
    expect(hay).not.toContain('TURNMARK_5 ' + 'x'.repeat(100));
  });
});

// ===========================================================================
describe('design: TOOLS IN RECENT TURNS (Anthropic)', () => {
  it('keeps a recent tool_use/tool_result as live text and never orphans a result', async () => {
    const msgs: any[] = [{ role: 'user', content: 'start' }];
    for (let i = 0; i < 16; i++) {
      msgs.push({ role: i % 2 === 0 ? 'assistant' : 'user', content: `FILL_${i} ${big(4000)}` });
    }
    // An OLD tool pair (deep in history) and a RECENT one (in the live tail).
    msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'tool_OLD', name: 'bash', input: { cmd: 'old' } }] });
    msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_OLD', content: 'OLDRESULT' }] });
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: i % 2 === 0 ? 'assistant' : 'user', content: `MID_${i} ${big(4000)}` });
    }
    msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'tool_RECENT', name: 'bash', input: { cmd: 'recent' } }] });
    msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_RECENT', content: 'RECENTRESULT' }] });
    msgs.push({ role: 'user', content: 'LIVE_ASK answer me' });

    const out = await drive(
      '/v1/messages',
      JSON.stringify({ model: 'claude-fable-5', max_tokens: 16, system: 'short', messages: msgs }),
    );
    const hay = JSON.stringify(out);

    expect(imageCount(out)).toBeGreaterThan(0);
    // The recent tool round-trip stays usable (text, not imaged).
    expect(hay).toContain('tool_RECENT');
    expect(hay).toContain('RECENTRESULT');
    // The live ask is preserved.
    expect(hay).toContain('LIVE_ASK answer me');

    // PAIRING INTEGRITY: every tool_result still present as TEXT must have its
    // tool_use present as TEXT too — the image boundary never splits a pair
    // (an orphaned tool_result is a 400 from Anthropic).
    const textToolUseIds = new Set<string>();
    const textToolResultIds: string[] = [];
    for (const m of out.messages ?? []) {
      if (!Array.isArray(m.content)) continue;
      for (const c of m.content) {
        if (c?.type === 'tool_use') textToolUseIds.add(c.id);
        if (c?.type === 'tool_result') textToolResultIds.push(c.tool_use_id);
      }
    }
    for (const id of textToolResultIds) expect(textToolUseIds.has(id)).toBe(true);
  });
});

// ===========================================================================
describe('design: RECENT REQUEST stays legible (GPT)', () => {
  it('images the system slab but keeps the most-recent user request as readable text', async () => {
    const turns = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `gturn ${i} ${big(2000)}`,
    }));
    turns.push({ role: 'user', content: 'FINAL_REQUEST_MARKER please answer' });
    const out = await drive(
      '/v1/chat/completions',
      JSON.stringify({
        model: 'gpt-5.6-sol',
        messages: [{ role: 'system', content: 'SYS ' + big(60_000) }, ...turns],
      }),
    );
    const hay = JSON.stringify(out);
    expect(imageCount(out)).toBeGreaterThan(0); // system imaged
    // The agent's live request must remain legible text, never OCR-only.
    expect(hay).toContain('FINAL_REQUEST_MARKER please answer');
  });
});
