import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearCodexCacheState,
  getCodexCacheHint,
  invalidateCodexCacheState,
  noteCodexCacheOutcome,
} from '../src/core/codex-cache-state.js';

beforeEach(() => clearCodexCacheState());

describe('Codex cache observation state', () => {
  it('records explicit trustworthy provider cache usage', () => {
    noteCodexCacheOutcome('s', {
      inputTokens: 1_000,
      cachedTokens: 900,
      compressed: true,
      historySegmentShas: ['a', 'b'],
    }, 123);

    expect(getCodexCacheHint('s')).toEqual({
      inputTokens: 1_000,
      cachedTokens: 900,
      cacheShare: 0.9,
      compressed: true,
      historySegmentShas: ['a', 'b'],
      lastSeenMs: 123,
    });
  });

  it('does not turn missing or malformed cache telemetry into a cold signal', () => {
    noteCodexCacheOutcome('s', {
      inputTokens: 1_000,
      cachedTokens: 900,
      compressed: false,
    }, 123);

    const trusted = getCodexCacheHint('s');
    expect(trusted).toBeDefined();

    const malformed = [
      {
        inputTokens: 1_000,
        cachedTokens: undefined,
        compressed: false,
      },
      {
        inputTokens: 1_000,
        cachedTokens: Number.NaN,
        compressed: false,
      },
      {
        inputTokens: 1_000,
        cachedTokens: -1,
        compressed: false,
      },
      {
        inputTokens: 1_000,
        cachedTokens: 1.5,
        compressed: false,
      },
      {
        inputTokens: 1_000,
        cachedTokens: Number.MAX_SAFE_INTEGER + 1,
        compressed: false,
      },
      {
        inputTokens: 1_000,
        cachedTokens: 1_001,
        compressed: false,
      },
      {
        inputTokens: 1.5,
        cachedTokens: 0,
        compressed: false,
      },
      {
        inputTokens: Number.MAX_SAFE_INTEGER + 1,
        cachedTokens: 0,
        compressed: false,
      },
    ];

    for (const outcome of malformed) {
      noteCodexCacheOutcome('s', outcome, 999);
      expect(getCodexCacheHint('s')).toEqual(trusted);
    }
  });

  it('accepts an explicit zero cached-token measurement as a cold signal', () => {
    noteCodexCacheOutcome('s', {
      inputTokens: 1_000,
      cachedTokens: 0,
      compressed: false,
    });

    expect(getCodexCacheHint('s')?.cacheShare).toBe(0);
  });

  it('does not retain page hashes for a native request', () => {
    noteCodexCacheOutcome('s', {
      inputTokens: 1_000,
      cachedTokens: 900,
      compressed: false,
      historySegmentShas: ['must-not-survive'],
    });

    expect(getCodexCacheHint('s')?.historySegmentShas).toEqual([]);
  });

  it('invalidates only the requested trajectory', () => {
    noteCodexCacheOutcome('a', {
      inputTokens: 1_000,
      cachedTokens: 900,
      compressed: false,
    });

    noteCodexCacheOutcome('b', {
      inputTokens: 2_000,
      cachedTokens: 1_800,
      compressed: false,
    });

    invalidateCodexCacheState('a');

    expect(getCodexCacheHint('a')).toBeUndefined();
    expect(getCodexCacheHint('b')).toBeDefined();
  });
});
