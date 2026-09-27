/**
 * Tests for user-pinned instructions (#155), with the OpenCode ingestion path
 * that shipped dead.
 *
 * #155 read pin commands from exactly one place: the leading `<system-reminder>`
 * run of message 0, which is where Claude Code inlines CLAUDE.md. OpenCode inlines
 * AGENTS.md into the SYSTEM PROMPT instead, unwrapped and unlabelled, so a user
 * whose AGENTS.md was full of valid pin commands got no pins, no strip, and no
 * error — the feature was simply absent.
 *
 * Contract being verified:
 *   - System-prompt pin commands are folded, at the durable 'file' tier.
 *   - They are stripped from the outbound system, and the surrounding rules text
 *     survives the strip intact.
 *   - A system block emptied by stripping hands its `cache_control` breakpoint to
 *     the block in front, so the cache boundary does not move.
 *   - `unpin` cannot drop a file-tier pin (it comes back next request anyway).
 *   - The Claude Code path is untouched: same pins from message 0, and a system
 *     prompt with no commands is returned unchanged, by identity.
 *   - End to end through transform: the pins land in the tail block, after the
 *     cached prefix, and the commands are gone from the system slab.
 */

import { describe, expect, it } from 'vitest';
import {
  appendPinBlock,
  foldPins,
  pinBlockText,
  stripPinCommands,
  stripPinCommandsFromSystem,
} from '../src/core/pin.js';
import type { Message, SystemField, TextBlock } from '../src/core/types.js';

/** An OpenCode-shaped system prompt: AGENTS.md inlined raw, one cache breakpoint. */
function opencodeSystem(rules: string): SystemField {
  return [
    { type: 'text', text: 'You are opencode, an interactive CLI tool.' },
    { type: 'text', text: rules, cache_control: { type: 'ephemeral' } },
  ];
}

/** A Claude Code-shaped message 0: CLAUDE.md behind the reminder envelope. */
function claudeCodeMessages(rules: string, typed = 'hello'): Message[] {
  return [{
    role: 'user',
    content: [{
      type: 'text',
      text: `<system-reminder>\nContents of /repo/CLAUDE.md:\n\n${rules}\n</system-reminder>\n${typed}`,
    }],
  }];
}

const AGENTS_MD = [
  '# Rules',
  '',
  '@pxpipe pin be concise, no walls of text',
  '@pxpipe pin never commit without asking',
  '',
  'Some prose that is not a pin.',
].join('\n');

describe('foldPins: system prompt ingestion (OpenCode)', () => {
  it('folds pin commands out of the system prompt', () => {
    const pins = foldPins([], opencodeSystem(AGENTS_MD));
    expect(pins.map((p) => p.text)).toContain('be concise, no walls of text');
    expect(pins.map((p) => p.text)).toContain('never commit without asking');
  });

  it('classifies them as the durable file tier', () => {
    const pins = foldPins([], opencodeSystem(AGENTS_MD));
    expect(pins.every((p) => p.source === 'file')).toBe(true);
  });

  it('is the exact regression: message-only scanning finds nothing', () => {
    // The #155 call shape. Same request, pins invisible — this is the bug.
    expect(foldPins([])).toEqual([]);
  });

  it('needs no <system-reminder> wrapper, which OpenCode never emits', () => {
    expect(opencodeSystem(AGENTS_MD).toString()).not.toContain('system-reminder');
    expect(foldPins([], opencodeSystem(AGENTS_MD)).length).toBeGreaterThan(0);
  });

  it('accepts a plain-string system field', () => {
    const pins = foldPins([], `preamble\n@pxpipe pin stay on task`);
    expect(pins.map((p) => p.text)).toEqual(['stay on task']);
  });

  it('folds system before messages, so pins read in wire order', () => {
    const msgs: Message[] = [{ role: 'user', content: '@pxpipe pin typed last' }];
    const pins = foldPins(msgs, opencodeSystem('@pxpipe pin from file'));
    expect(pins.map((p) => p.text)).toEqual(['from file', 'typed last']);
  });

  it('ignores non-text system blocks without throwing', () => {
    const sys = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
      { type: 'text', text: '@pxpipe pin survives' },
    ] as unknown as SystemField;
    expect(foldPins([], sys).map((p) => p.text)).toEqual(['survives']);
  });

  it('refuses to let unpin drop a file-tier pin', () => {
    // It is inlined from AGENTS.md every request, so "removing" it would be a lie.
    const msgs: Message[] = [{ role: 'user', content: '@pxpipe unpin be concise' }];
    const pins = foldPins(msgs, opencodeSystem(AGENTS_MD));
    expect(pins.map((p) => p.text)).toContain('be concise, no walls of text');
  });

  it('folds markdown quote-prefixed pin commands (>pxpipe pin and > pxpipe pin)', () => {
    const markdownAgents = [
      '# Personal Rules',
      '',
      '>pxpipe pin ## npm Auth',
      '>pxpipe pin',
      '>pxpipe pin Every shell command must begin with token refresh',
      '> pxpipe pin - Be concise',
      '> @pxpipe pin - No walls of text',
      'pxpipe pin - Lead with results',
    ].join('\n');
    const pins = foldPins([], opencodeSystem(markdownAgents));
    expect(pins.map((p) => p.text)).toEqual([
      '## npm Auth',
      '',
      'Every shell command must begin with token refresh',
      '- Be concise',
      '- No walls of text',
      '- Lead with results',
    ]);
  });
});

describe('stripPinCommandsFromSystem', () => {
  it('removes the command lines and keeps the surrounding rules', () => {
    const out = stripPinCommandsFromSystem(opencodeSystem(AGENTS_MD)) as TextBlock[];
    const text = out.map((b) => b.text).join('\n');
    expect(text).not.toContain('@pxpipe pin');
    expect(text).toContain('# Rules');
    expect(text).toContain('Some prose that is not a pin.');
  });

  it('returns undefined when there is nothing to strip', () => {
    // Identity preserved => a Claude Code request serializes byte-for-byte as before.
    expect(stripPinCommandsFromSystem(opencodeSystem('# Rules\nno commands here'))).toBeUndefined();
    expect(stripPinCommandsFromSystem('plain preamble')).toBeUndefined();
    expect(stripPinCommandsFromSystem(undefined)).toBeUndefined();
  });

  it('strips a plain-string system field', () => {
    expect(stripPinCommandsFromSystem('keep\n@pxpipe pin go')).toBe('keep');
    expect(stripPinCommandsFromSystem('keep\n>pxpipe pin go\n> pxpipe pin also')).toBe('keep');
  });

  it('hands cache_control forward when a block is emptied', () => {
    const sys: SystemField = [
      { type: 'text', text: 'preamble' },
      { type: 'text', text: '@pxpipe pin only this', cache_control: { type: 'ephemeral' } },
    ];
    const out = stripPinCommandsFromSystem(sys) as TextBlock[];
    // The emptied block cannot stay (`{text: ''}` is rejected), but dropping its
    // breakpoint with it would move the cache boundary.
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('preamble');
    expect(out[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('keeps an emptied leading block rather than lose its breakpoint', () => {
    const sys: SystemField = [
      { type: 'text', text: '@pxpipe pin alone', cache_control: { type: 'ephemeral' } },
    ];
    const out = stripPinCommandsFromSystem(sys) as TextBlock[];
    expect(out[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('drops an emptied block that carried no breakpoint', () => {
    const sys: SystemField = [
      { type: 'text', text: 'preamble' },
      { type: 'text', text: '@pxpipe pin only this' },
    ];
    expect(stripPinCommandsFromSystem(sys)).toHaveLength(1);
  });
});

describe('Claude Code path is unaffected', () => {
  it('still folds CLAUDE.md pins from message 0', () => {
    const pins = foldPins(claudeCodeMessages(AGENTS_MD));
    expect(pins.map((p) => p.text)).toContain('be concise, no walls of text');
    expect(pins.some((p) => p.source === 'file')).toBe(true);
  });

  it('still attributes the file path from the harness label', () => {
    const pins = foldPins(claudeCodeMessages(AGENTS_MD));
    expect(pins.find((p) => p.text.startsWith('be concise'))?.path).toBe('/repo/CLAUDE.md');
  });

  it('produces identical pins with or without an empty system argument', () => {
    const msgs = claudeCodeMessages(AGENTS_MD);
    expect(foldPins(msgs, [{ type: 'text', text: 'unrelated preamble' }]))
      .toEqual(foldPins(msgs));
  });

  it('still strips the commands out of message 0', () => {
    const out = stripPinCommands(claudeCodeMessages(AGENTS_MD));
    expect(JSON.stringify(out)).not.toContain('@pxpipe pin');
    expect(JSON.stringify(out)).toContain('hello');
  });
});

describe('stripPinCommands: malformed input', () => {
  it('does not throw on a null assistant content block after a pin command', () => {
    // A null block passes isPinReply's length check; without the element guard
    // (that every sibling has) blocks[0].type throws, silently disabling pinning
    // for the whole request instead of passing the malformed turn through.
    const messages: Message[] = [
      { role: 'user', content: '@pxpipe pin be concise' },
      { role: 'assistant', content: [null as unknown as TextBlock] },
    ];
    expect(() => stripPinCommands(messages)).not.toThrow();
  });
});

describe('emission', () => {
  it('renders file pins unbulleted, preserving the user’s own markdown', () => {
    // Pinning is per line and opt-in: unmarked prose stays in the file, and a
    // marked line keeps the formatting the user wrote instead of being bulleted.
    const sys = opencodeSystem('# Rules\n@pxpipe pin ## Style\n@pxpipe pin | a | b |');
    const text = pinBlockText(foldPins([], sys));
    expect(text).toContain('## Style');
    expect(text).toContain('| a | b |');
    expect(text).not.toContain('- ## Style');
    expect(text).not.toContain('# Rules\n');
  });

  it('appends the block to the tail, after every cache breakpoint', () => {
    const msgs: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'do the thing' }] }];
    const pins = foldPins(msgs, opencodeSystem(AGENTS_MD));
    expect(appendPinBlock(msgs, pins)).toBeGreaterThan(0);
    const blocks = msgs[0]!.content as TextBlock[];
    expect(blocks[blocks.length - 1]!.text).toContain('[pxpipe pin]');
    expect(blocks[blocks.length - 1]!.text).toContain('be concise, no walls of text');
  });
});
