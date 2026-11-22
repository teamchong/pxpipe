import { describe, expect, it } from 'vitest';
import { parseRejectedBetas } from '../src/core/proxy.js';

describe('parseRejectedBetas', () => {
  it('extracts the beta count_tokens rejected', () => {
    const body = JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message:
          'Unexpected value(s) `tool-provenance-2026-10-26` for the `anthropic-beta` header. Please consult our documentation.',
      },
    });
    expect(parseRejectedBetas(body)).toEqual(['tool-provenance-2026-10-26']);
  });

  it('extracts several betas', () => {
    const msg = '{"error":{"message":"Unexpected value(s) `a-1`, `b-2` for the `anthropic-beta` header."}}';
    expect(parseRejectedBetas(msg)).toEqual(['a-1', 'b-2']);
  });

  it('returns nothing for unrelated 400s', () => {
    expect(parseRejectedBetas('{"error":{"message":"messages: field required"}}')).toEqual([]);
    expect(parseRejectedBetas('not json')).toEqual([]);
  });
});
