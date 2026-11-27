/**
 * A text part the pin strip EMPTIES must not be sent upstream as `text: ''`.
 *
 * pin.ts states the rule twice on the Messages wire. stripFromMessage drops the
 * block — "`{text: ''}` is rejected by the API, so the block cannot stay" — and
 * returns the message unchanged when that would leave it with nothing, because
 * "an empty `content` is rejected by the API, and dropping a lone message would
 * break role alternation". stripPinCommandsFromSystem does the same.
 *
 * The OpenAI and Gemini relocators mapped stripLines over the parts in place, so
 * neither half of the rule applied. A pin command is answered locally, but the
 * client keeps it in its transcript, so EVERY later request in the session
 * replays that turn through the relocator — the live-turn short circuit
 * (isPinOnlyRequest -> liveTurn) only ever looks at the last turn.
 *
 * Observed before the fix, history [pin command, confirmation, "what is 2+2"]:
 *
 *   wire       turn 0 sent upstream
 *   Messages   (dropped with its confirmation)
 *   Chat       {role: 'user', content: ''}
 *   Responses  {role: 'user', content: [{type: 'input_text', text: ''}]}
 *   Gemini     {role: 'user', parts: [{text: ''}]}
 *
 * Contract being verified:
 *   - A turn the strip would empty is forwarded as the client sent it.
 *   - One emptied part among several is dropped, not blanked, and the rest of
 *     the turn survives.
 *   - A part that was ALREADY blank is left untouched — not ours to rewrite.
 *   - Non-text parts and mixed prose turns keep working, and the pin block is
 *     still relocated to the last user turn in every case.
 */

import { describe, expect, it } from 'vitest';

import { relocateGooglePins, relocateOpenAIPins, stripPinCommands } from '../src/core/pin.js';
import type { Message } from '../src/core/types.js';

const CMD = '@pxpipe pin use tabs';
const CONFIRMATION = '@pxpipe 1 pinned\nsession   (@pxpipe unpin <n>, or unpin all)\n\n1. use tabs';
const PIN_BLOCK = /\[pxpipe pin\]/;

/** Every text a turn carries, in order. */
const texts = (parts: unknown): string[] =>
  (parts as Array<{ text?: unknown }>).map((p) => (typeof p?.text === 'string' ? p.text : '\u0000'));

describe('Chat Completions: an emptied turn is left as sent', () => {
  it('keeps a replayed command-only turn verbatim instead of sending content: ""', () => {
    const req = {
      messages: [
        { role: 'user', content: CMD },
        { role: 'assistant', content: CONFIRMATION },
        { role: 'user', content: 'what is 2+2' },
      ],
    };

    expect(relocateOpenAIPins(req)).toBeGreaterThan(0);
    expect(req.messages[0]!.content).toBe(CMD);
    // Still relocated onto the live turn, which is the point of the pass.
    expect(req.messages[2]!.content).toMatch(PIN_BLOCK);
  });

  it('still strips the command from a mixed turn', () => {
    const req = {
      messages: [
        { role: 'user', content: `${CMD}\nalso fix the parser` },
        { role: 'user', content: 'go on' },
      ],
    };

    expect(relocateOpenAIPins(req)).toBeGreaterThan(0);
    expect(req.messages[0]!.content).toBe('also fix the parser');
  });

  it('leaves a turn the client already sent empty alone', () => {
    const req = {
      messages: [
        { role: 'user', content: '' },
        { role: 'user', content: CMD + '\nship it' },
      ],
    };

    expect(relocateOpenAIPins(req)).toBeGreaterThan(0);
    expect(req.messages[0]!.content).toBe('');
  });
});

describe('Responses: an emptied part is dropped, not blanked', () => {
  it('keeps a replayed command-only turn verbatim', () => {
    const req = {
      input: [
        { role: 'user', content: [{ type: 'input_text', text: CMD }] },
        { role: 'assistant', content: [{ type: 'output_text', text: CONFIRMATION }] },
        { role: 'user', content: [{ type: 'input_text', text: 'what is 2+2' }] },
      ],
    };

    expect(relocateOpenAIPins(req)).toBeGreaterThan(0);
    expect(texts(req.input[0]!.content)).toEqual([CMD]);
    expect(texts(req.input[2]!.content)[1]).toMatch(PIN_BLOCK);
  });

  it('drops the emptied part when the turn has another one to keep', () => {
    const req = {
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: CMD },
            { type: 'input_text', text: 'what is 2+2' },
          ],
        },
      ],
    };

    expect(relocateOpenAIPins(req)).toBeGreaterThan(0);
    const out = texts(req.input[0]!.content);
    expect(out[0]).toBe('what is 2+2');
    expect(out[1]).toMatch(PIN_BLOCK);
    expect(out).toHaveLength(2); // no `text: ''` left behind
  });

  it('leaves a part the client already sent blank, and non-text parts, untouched', () => {
    const req = {
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: '' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
            { type: 'input_text', text: CMD },
          ],
        },
      ],
    };

    expect(relocateOpenAIPins(req)).toBeGreaterThan(0);
    const content = req.input[0]!.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: 'input_text', text: '' });
    expect(content[1]).toEqual({ type: 'input_image', image_url: 'data:image/png;base64,AAA' });
    expect(content[2]!.text).toMatch(PIN_BLOCK);
  });
});

describe('Gemini: an emptied part is dropped, not blanked', () => {
  it('keeps a replayed command-only turn verbatim', () => {
    const req = {
      contents: [
        { role: 'user', parts: [{ text: CMD }] },
        { role: 'model', parts: [{ text: CONFIRMATION }] },
        { role: 'user', parts: [{ text: 'what is 2+2' }] },
      ],
    };

    expect(relocateGooglePins(req)).toBeGreaterThan(0);
    expect(texts(req.contents[0]!.parts)).toEqual([CMD]);
    expect(texts(req.contents[2]!.parts)[1]).toMatch(PIN_BLOCK);
  });

  it('drops the emptied part when the turn has another one to keep', () => {
    const req = {
      contents: [
        { role: 'user', parts: [{ text: CMD }, { text: 'what is 2+2' }] },
      ],
    };

    expect(relocateGooglePins(req)).toBeGreaterThan(0);
    const out = texts(req.contents[0]!.parts);
    expect(out[0]).toBe('what is 2+2');
    expect(out[1]).toMatch(PIN_BLOCK);
    expect(out).toHaveLength(2);
  });

  it('leaves inlineData parts and an already-blank part untouched', () => {
    const req = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: '' },
            { inlineData: { mimeType: 'image/png', data: 'AAA' } },
            { text: CMD },
          ],
        },
      ],
    };

    expect(relocateGooglePins(req)).toBeGreaterThan(0);
    const parts = req.contents[0]!.parts as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ text: '' });
    expect(parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: 'AAA' } });
    expect(parts[2]!.text).toMatch(PIN_BLOCK);
  });

  it('keeps a systemInstruction the strip would empty', () => {
    const req = {
      systemInstruction: { parts: [{ text: CMD }] },
      contents: [{ role: 'user', parts: [{ text: 'what is 2+2' }] }],
    };

    expect(relocateGooglePins(req)).toBeGreaterThan(0);
    expect(texts(req.systemInstruction.parts)).toEqual([CMD]);
  });

  it('drops an emptied systemInstruction part beside one that survives', () => {
    const req = {
      systemInstruction: { parts: [{ text: CMD }, { text: 'be terse' }] },
      contents: [{ role: 'user', parts: [{ text: 'what is 2+2' }] }],
    };

    expect(relocateGooglePins(req)).toBeGreaterThan(0);
    expect(texts(req.systemInstruction.parts)).toEqual(['be terse']);
  });
});

describe('control: the Messages wire already followed this rule', () => {
  it('drops the emptied block and keeps the rest of the turn', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: CMD },
          { type: 'text', text: 'what is 2+2' },
        ],
      },
    ];

    const out = stripPinCommands(messages);
    expect(out[0]!.content).toEqual([{ type: 'text', text: 'what is 2+2' }]);
  });

  it('leaves a command-only turn alone when there is no reply to pair it with', () => {
    const messages: Message[] = [{ role: 'user', content: CMD }];

    expect(stripPinCommands(messages)).toEqual(messages);
  });
});
