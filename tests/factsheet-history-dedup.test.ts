import { describe, expect, it } from 'vitest';
import { extractFactSheetTokens, factSheetText } from '../src/core/factsheet.js';
import { historyFactSheet } from '../src/core/openai.js';
import { resolveGptProfile } from '../src/core/gpt-model-profiles.js';

const path = 'src/feature/shared-build-hook.ts';
const other = 'src/feature/fresh-build-hook.ts';
const profile = resolveGptProfile('gpt-6-astra');

describe('request-local exact-spelling deduplication', () => {
  it('omits only an exact spelling already present in emitted native text', () => {
    const first = historyFactSheet(`Read ${path}`, profile);
    const seen = new Set(extractFactSheetTokens(first));
    expect(first).toContain(path);
    const next = historyFactSheet(`Read ${path} then ${other}`, profile, seen);
    expect(next).not.toContain(path);
    expect(next).toContain(other);
    expect(historyFactSheet(`Read ${path}`, profile, new Set())).toContain(path);
    expect(factSheetText(`Read ${path}`, 'compact', new Set([path + '.bak']))).toContain(path);
  });

  it('retains local repetition counts even if the spelling appeared earlier', () => {
    expect(historyFactSheet(`${path} and ${path}`, profile, new Set([path]))).toContain(path);
  });

  it('leaves native opaque-value excerpts byte-for-byte intact', () => {
    const ids = Array.from({ length: 160 }, (_, i) => (0xabc00000 + i).toString(16));
    const source = '[tool_use synthetic_lookup]\n{}\n[tool_result synthetic_lookup]\n'
      + ids.map((id, i) => `id=${id} duration=${i}`).join('\n');
    const before = historyFactSheet(source, profile);
    expect(before).toContain('Archived exact-value excerpts');
    expect(historyFactSheet(source, profile, new Set(ids))).toBe(before);
  });

  it('does not mutate coverage during profitability checks or rendering', () => {
    const seen = new Set([path]);
    historyFactSheet(`Read ${path} and ${other}`, profile, seen);
    expect([...seen]).toEqual([path]);
    expect(historyFactSheet(`Read ${other}`, profile)).toContain(other);
  });
});
