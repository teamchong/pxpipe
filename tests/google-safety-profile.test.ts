import { describe, expect, it } from 'vitest';

import { transformGoogleGenerateContent } from '../src/core/google.js';
import {
  mergeCompressionProfileOptions,
  resolveCompressionProfile,
} from '../src/core/safety-policy.js';

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

describe('Google coding-safe enforcement', () => {
  it('keeps Gemini system authority native under coding-safe', async () => {
    const request = {
      systemInstruction: {
        parts: [{
          text:
            'AUTHORITATIVE CODING INSTRUCTIONS\n'
            + 'Never alter exact source state.\n'.repeat(4_000),
        }],
      },
      contents: [{
        role: 'user',
        parts: [{ text: 'Inspect the repository.' }],
      }],
    };

    const original = encode(request);
    const options = mergeCompressionProfileOptions(
      resolveCompressionProfile('coding-safe'),
    );

    const result = await transformGoogleGenerateContent(
      original,
      'gemini-3.6-flash',
      options,
    );

    expect(result.info.compressed).toBe(false);
    expect(result.info.reason).toMatch(/^below_min_chars/);
    expect(result.body).toEqual(original);
  });

  it('tightens Gemini history thresholds under coding-safe', async () => {
    // Ordinary Gemini history policy can collapse this transcript.
    //
    // coding-safe raises:
    //   keepTail          6  -> 12
    //   minCollapsePrefix 10 -> 16
    //   minCollapseTokens 2000 -> 4000
    //
    // The same request must therefore remain native in coding-safe mode.
    const contents = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'model',
      parts: [{
        text:
          `turn-${index}\n`
          + 'payload_0123456789 '.repeat(250),
      }],
    }));

    const request = { contents };
    const original = encode(request);

    const ordinary = await transformGoogleGenerateContent(
      original,
      'gemini-3.6-flash',
      {
        compressTools: false,
        compressToolResults: false,
      },
    );

    expect(ordinary.info.compressed).toBe(true);
    expect(ordinary.body).not.toEqual(original);

    const safeOptions = mergeCompressionProfileOptions(
      resolveCompressionProfile('coding-safe'),
    );

    const safe = await transformGoogleGenerateContent(
      original,
      'gemini-3.6-flash',
      safeOptions,
    );

    expect(safe.info.compressed).toBe(false);
    expect(safe.body).toEqual(original);
  });
});
