/**
 * `relocateOpenAIPins` must MOVE a pin on every input shape, never copy it.
 *
 * pin.ts states the contract in three places ("pins are MOVED, not copied";
 * "A mixed turn keeps its prose and loses only the command lines, so the model is
 * not distracted by configuration in the middle of a request it has to act on").
 * The OpenAI relocator honours it by stripping commands from `instructions` and
 * from every system/developer/user item — but `items` is undefined when
 * `/v1/responses` is called with a bare STRING `input`, which the function
 * explicitly supports, so that shape appended the tail block and left the command
 * line sitting in the prompt.
 *
 * Observed before the fix, for `input: 'explain this function\n@pxpipe pin be concise'`:
 *   string input  -> "explain this function\n@pxpipe pin be concise\n\n<system-reminder>…"
 *   array input   -> "explain this function"                        + the block
 *   chat messages -> "explain this function"                        + the block
 *
 * It reaches upstream: `transformOpenAIResponses` captures the relocated string
 * as `originalInputString` and wraps it back into `req.input` verbatim
 * (openai.ts), so nothing downstream removes it.
 *
 * Contract being verified:
 *   - No input shape forwards a pin command, and all three fold the same pin.
 *   - The user's surrounding prose survives the strip.
 *   - `instructions` (where Codex puts AGENTS.md) still strips alongside a string
 *     input, and a request with no pins is left alone.
 */

import { describe, expect, it } from 'vitest';

import { relocateOpenAIPins } from '../src/core/pin.js';

const PIN = '@pxpipe pin be concise, no walls of text';
const PROSE = 'explain this function';

/** Every string in a relocated request, so a leaked command cannot hide in one. */
function allText(req: unknown): string {
  return JSON.stringify(req);
}

describe('relocateOpenAIPins: the command is moved, not copied', () => {
  it('strips the command from a bare string input', () => {
    const req: { input: string } = { input: `${PROSE}\n${PIN}` };
    const chars = relocateOpenAIPins(req);

    expect(chars).toBeGreaterThan(0);
    expect(req.input).not.toContain('@pxpipe pin');
    expect(req.input).toContain(PROSE);
    expect(req.input).toContain('be concise, no walls of text'); // folded into the block
    expect(req.input).toContain('[pxpipe pin]');
  });

  it('strips it from an array input (control: already worked)', () => {
    const req = {
      input: [{ role: 'user', content: [{ type: 'input_text', text: `${PROSE}\n${PIN}` }] }],
    };
    const chars = relocateOpenAIPins(req);

    expect(chars).toBeGreaterThan(0);
    expect(allText(req)).not.toContain('@pxpipe pin');
    expect(req.input[0]!.content[0]!.text).toBe(PROSE);
    expect(req.input[0]!.content[1]!.text).toContain('[pxpipe pin]');
  });

  it('strips it from chat-completions messages (control: already worked)', () => {
    const req = { messages: [{ role: 'user', content: `${PROSE}\n${PIN}` }] };
    const chars = relocateOpenAIPins(req);

    expect(chars).toBeGreaterThan(0);
    expect(allText(req)).not.toContain('@pxpipe pin');
    expect(req.messages[0]!.content).toContain(PROSE);
  });

  it('strips a string input and the instructions that hold AGENTS.md', () => {
    const req: { instructions: string; input: string } = {
      instructions: `You are Codex.\n${PIN}`,
      input: `${PROSE}\n@pxpipe pin use tabs`,
    };
    relocateOpenAIPins(req);

    expect(allText(req)).not.toContain('@pxpipe pin');
    expect(req.instructions).toContain('You are Codex.');
    // Both pins land in the one relocated block, file tier first (wire order).
    expect(req.input).toContain('be concise, no walls of text');
    expect(req.input).toContain('use tabs');
  });

  it('leaves a string input that carries no pin untouched', () => {
    const req = { input: PROSE };
    expect(relocateOpenAIPins(req)).toBe(0);
    expect(req.input).toBe(PROSE);
  });

  it('does not strip a command out of an assistant turn it never folded', () => {
    // foldPins reads user turns only, so an assistant item quoting the syntax is
    // not a pin; stripping it would edit the model's own words out of history.
    const req = {
      input: [
        { role: 'assistant', content: [{ type: 'output_text', text: `type ${PIN}` }] },
        { role: 'user', content: [{ type: 'input_text', text: `${PROSE}\n${PIN}` }] },
      ],
    };
    relocateOpenAIPins(req);

    expect(req.input[0]!.content[0]!.text).toBe(`type ${PIN}`);
    expect(req.input[1]!.content[0]!.text).toBe(PROSE);
  });
});
