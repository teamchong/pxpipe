// BIP39-style checksummed wordlist encoding for high-entropy spans (issue #38).
//
// Hex digits are the worst glyph class under vision readback: '0'/'8'/'3'/'b'
// confusions flip silently to another valid value. Encoding the same bytes as
// words from the standard BIP39 lexicon gives two properties:
//   1. a single-glyph substitution almost never lands on another valid word,
//      so noise surfaces as an out-of-lexicon token the reader can flag;
//   2. the appended SHA-256 checksum turns the residual failure mode from
//      "confident wrong read" into "detected mismatch".
//
// Scheme (generalized BIP39): for an ENT-bit payload (ENT % 32 === 0) append
// the first ENT/32 bits of SHA-256(payload), then emit one word per 11 bits.
// For 16/20/24/28/32-byte payloads this is exactly standard BIP39, so the
// 128-bit vectors from the reference implementation apply verbatim.

import { BIP39_WORDS } from './bip39-words.js';

export type WordlistDecodeFailure = 'unknown-word' | 'bad-word-count' | 'checksum-mismatch';

/** Decode failure that a reader should surface instead of guessing. */
export class WordlistDecodeError extends Error {
  readonly reason: WordlistDecodeFailure;
  constructor(reason: WordlistDecodeFailure, message: string) {
    super(message);
    this.name = 'WordlistDecodeError';
    this.reason = reason;
  }
}

let wordIndex: Map<string, number> | undefined;
function indexOfWord(word: string): number | undefined {
  if (!wordIndex) {
    const m = new Map<string, number>();
    BIP39_WORDS.forEach((w, i) => m.set(w, i));
    wordIndex = m;
  }
  return wordIndex.get(word);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  // Cast: Web Crypto accepts Uint8Array at runtime despite the BufferSource type.
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return new Uint8Array(digest);
}

function bitAt(bytes: Uint8Array, i: number): number {
  return ((bytes[i >> 3] ?? 0) >> (7 - (i & 7))) & 1;
}

/**
 * Encode a payload (length must be a positive multiple of 4 bytes) as
 * checksummed words: (ENT + ENT/32) / 11 words, e.g. a 64-bit handle -> 6 words.
 */
export async function wordlistEncode(payload: Uint8Array): Promise<string[]> {
  if (payload.length === 0 || payload.length % 4 !== 0) {
    throw new Error(`wordlistEncode: payload must be a positive multiple of 4 bytes, got ${payload.length}`);
  }
  const ent = payload.length * 8;
  const csBits = ent / 32;
  const digest = await sha256(payload);
  const total = ent + csBits;
  const words: string[] = [];
  for (let w = 0; w < total / 11; w++) {
    let idx = 0;
    for (let b = w * 11; b < (w + 1) * 11; b++) {
      const bit = b < ent ? bitAt(payload, b) : bitAt(digest, b - ent);
      idx = (idx << 1) | bit;
    }
    const word = BIP39_WORDS[idx];
    if (word === undefined) throw new Error(`wordlistEncode: index out of range: ${idx}`);
    words.push(word);
  }
  return words;
}

/**
 * Decode words produced by {@link wordlistEncode}, verifying the checksum.
 * Throws {@link WordlistDecodeError} instead of returning a guessed value.
 */
export async function wordlistDecode(words: readonly string[]): Promise<Uint8Array> {
  const total = words.length * 11;
  // total = ENT + ENT/32 = 33 * ENT / 32, so ENT = total * 32 / 33.
  const ent = (total * 32) / 33;
  if (words.length === 0 || !Number.isInteger(ent) || ent % 32 !== 0) {
    throw new WordlistDecodeError('bad-word-count', `wordlistDecode: invalid word count ${words.length}`);
  }
  const bits: number[] = [];
  for (const word of words) {
    const idx = indexOfWord(word);
    if (idx === undefined) {
      throw new WordlistDecodeError('unknown-word', `wordlistDecode: word not in lexicon: ${JSON.stringify(word)}`);
    }
    for (let b = 10; b >= 0; b--) bits.push((idx >> b) & 1);
  }
  const payload = new Uint8Array(ent / 8);
  for (let i = 0; i < ent; i++) {
    if (bits[i]) payload[i >> 3] = (payload[i >> 3] ?? 0) | (1 << (7 - (i & 7)));
  }
  const digest = await sha256(payload);
  for (let i = ent; i < total; i++) {
    if (bits[i] !== bitAt(digest, i - ent)) {
      throw new WordlistDecodeError('checksum-mismatch', 'wordlistDecode: checksum mismatch (misread or corrupted words)');
    }
  }
  return payload;
}
