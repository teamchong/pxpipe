import { describe, expect, it } from 'vitest';
import { BIP39_WORDS } from '../src/core/bip39-words.js';
import { WordlistDecodeError, wordlistDecode, wordlistEncode } from '../src/core/wordlist.js';

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Deterministic byte stream so the substitution-detection counts are stable.
function lcgBytes(seed: number, n: number): Uint8Array {
  let s = seed >>> 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

describe('bip39 wordlist', () => {
  it('is the standard 2048-word english list', () => {
    expect(BIP39_WORDS.length).toBe(2048);
    expect(BIP39_WORDS[0]).toBe('abandon');
    expect(BIP39_WORDS[2047]).toBe('zoo');
    expect(new Set(BIP39_WORDS).size).toBe(2048);
  });
});

describe('wordlistEncode', () => {
  it('matches the BIP39 reference vectors for 128-bit entropy', async () => {
    const vectors: Array<[string, string]> = [
      [
        '00000000000000000000000000000000',
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      ],
      [
        '7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f',
        'legal winner thank year wave sausage worth useful legal winner thank yellow',
      ],
      [
        '80808080808080808080808080808080',
        'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
      ],
      [
        'ffffffffffffffffffffffffffffffff',
        'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
      ],
    ];
    for (const [entropy, mnemonic] of vectors) {
      expect((await wordlistEncode(hexBytes(entropy))).join(' ')).toBe(mnemonic);
    }
  });

  it('encodes a 64-bit handle as 6 words', async () => {
    const words = await wordlistEncode(hexBytes('deadbeef01020304'));
    expect(words.length).toBe(6);
    for (const w of words) expect(BIP39_WORDS).toContain(w);
  });

  it('rejects payloads that are not a positive multiple of 4 bytes', async () => {
    await expect(wordlistEncode(new Uint8Array(0))).rejects.toThrow(/multiple of 4/);
    await expect(wordlistEncode(new Uint8Array(7))).rejects.toThrow(/multiple of 4/);
  });
});

describe('wordlistDecode', () => {
  it('round-trips payloads of every supported size', async () => {
    for (const size of [4, 8, 12, 16, 20, 32]) {
      const payload = lcgBytes(size * 7919, size);
      const words = await wordlistEncode(payload);
      expect(words.length).toBe(((size * 8 * 33) / 32) / 11);
      expect(await wordlistDecode(words)).toEqual(payload);
    }
  });

  it('flags out-of-lexicon words (single-glyph misreads) instead of guessing', async () => {
    const words = await wordlistEncode(hexBytes('deadbeef01020304'));
    const misread = [...words];
    misread[0] = misread[0].replace(/.$/, (c) => (c === 'x' ? 'y' : 'x')); // glyph-level corruption
    const err = await wordlistDecode(misread).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WordlistDecodeError);
    expect((err as WordlistDecodeError).reason).toBe('unknown-word');
  });

  it('rejects impossible word counts', async () => {
    const err = await wordlistDecode(['abandon']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WordlistDecodeError);
    expect((err as WordlistDecodeError).reason).toBe('bad-word-count');
  });

  it('never returns the original payload for a valid-word substitution, and detects most', async () => {
    // A substituted word either trips the checksum (detected) or decodes to a
    // *different* payload; it must never silently reproduce the original.
    for (const [size, minRate] of [
      [8, 0.7], // 2 checksum bits -> expect ~75% detected
      [16, 0.9], // 4 checksum bits -> expect ~94% detected
    ] as const) {
      let tried = 0;
      let caught = 0;
      for (let trial = 0; trial < 60; trial++) {
        const payload = lcgBytes(size * 1000 + trial, size);
        const words = await wordlistEncode(payload);
        const rng = lcgBytes(trial + 424242, 4);
        const pos = rng[0] % words.length;
        const original = words[pos];
        let replacement = BIP39_WORDS[((rng[1] << 8) | rng[2]) % 2048];
        if (replacement === original) replacement = BIP39_WORDS[(((rng[1] << 8) | rng[2]) + 1) % 2048];
        const mutated = [...words];
        mutated[pos] = replacement;
        tried++;
        try {
          const decoded = await wordlistDecode(mutated);
          expect(decoded).not.toEqual(payload); // survived checksum -> still not a silent "same value"
        } catch (err) {
          expect(err).toBeInstanceOf(WordlistDecodeError);
          expect((err as WordlistDecodeError).reason).toBe('checksum-mismatch');
          caught++;
        }
      }
      expect(caught / tried).toBeGreaterThanOrEqual(minRate);
    }
  });
});
