/**
 * C9+C10: coverage routing — classifies an already-eligible request as a
 * 'heavy' one-off analysis (today's full compression, unconditional) or a
 * 'light' small/repeatable request (respect the caller's existing cache
 * breakpoints instead of forcing a re-render). See docs/ROUTING.md for the
 * decision table this exercises.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyRequestWeight,
  HEAVY_BODY_BYTES_THRESHOLD,
  LIGHT_BODY_BYTES_THRESHOLD,
  LIGHT_MIN_MESSAGE_COUNT,
  shouldTransformAnthropicMessages,
} from '../src/core/applicability.js';

describe('classifyRequestWeight', () => {
  it('routes a large one-off body with no cache_control markers to heavy', () => {
    expect(classifyRequestWeight({
      bodyBytes: HEAVY_BODY_BYTES_THRESHOLD + 1,
      messageCount: 1,
      existingCacheControlMarkers: 0,
    })).toEqual({ tier: 'heavy', reason: 'large_body' });
  });

  it('routes a small body with existing cache_control markers to light', () => {
    expect(classifyRequestWeight({
      bodyBytes: 4_000,
      messageCount: 5,
      existingCacheControlMarkers: 2,
    })).toEqual({ tier: 'light', reason: 'stable_prefix_established' });
  });

  it('routes a small, multi-turn body with NO markers to light via turn count', () => {
    expect(classifyRequestWeight({
      bodyBytes: 4_000,
      messageCount: LIGHT_MIN_MESSAGE_COUNT,
      existingCacheControlMarkers: 0,
    })).toEqual({ tier: 'light', reason: 'small_repeated_turn' });
  });

  it('defaults to heavy when signals are absent entirely (matches todays unconditional behavior)', () => {
    expect(classifyRequestWeight({})).toEqual({ tier: 'heavy', reason: 'insufficient_signal' });
  });

  it('defaults to heavy for a cold first turn (small body, no markers, below min turn count)', () => {
    expect(classifyRequestWeight({
      bodyBytes: 4_000,
      messageCount: 1,
      existingCacheControlMarkers: 0,
    })).toEqual({ tier: 'heavy', reason: 'insufficient_signal' });
  });

  it('defaults to heavy for a mid-size body with markers that exceeds the light threshold', () => {
    expect(classifyRequestWeight({
      bodyBytes: LIGHT_BODY_BYTES_THRESHOLD + 1,
      messageCount: 10,
      existingCacheControlMarkers: 3,
    })).toEqual({ tier: 'heavy', reason: 'insufficient_signal' });
  });

  it('markers-only signal (bodyBytes unknown) still routes to light', () => {
    expect(classifyRequestWeight({ existingCacheControlMarkers: 1 }))
      .toEqual({ tier: 'light', reason: 'stable_prefix_established' });
  });

  describe('boundary thresholds', () => {
    it('bodyBytes exactly at HEAVY_BODY_BYTES_THRESHOLD is heavy (>=, not >)', () => {
      expect(classifyRequestWeight({ bodyBytes: HEAVY_BODY_BYTES_THRESHOLD }))
        .toEqual({ tier: 'heavy', reason: 'large_body' });
    });

    it('bodyBytes one below HEAVY_BODY_BYTES_THRESHOLD with markers is light (<=, not <)', () => {
      expect(classifyRequestWeight({
        bodyBytes: LIGHT_BODY_BYTES_THRESHOLD,
        existingCacheControlMarkers: 1,
      })).toEqual({ tier: 'light', reason: 'stable_prefix_established' });
    });

    it('bodyBytes exactly at LIGHT_BODY_BYTES_THRESHOLD with sufficient turns is light', () => {
      expect(classifyRequestWeight({
        bodyBytes: LIGHT_BODY_BYTES_THRESHOLD,
        messageCount: LIGHT_MIN_MESSAGE_COUNT,
        existingCacheControlMarkers: 0,
      })).toEqual({ tier: 'light', reason: 'small_repeated_turn' });
    });

    it('messageCount one below LIGHT_MIN_MESSAGE_COUNT falls back to heavy', () => {
      expect(classifyRequestWeight({
        bodyBytes: LIGHT_BODY_BYTES_THRESHOLD,
        messageCount: LIGHT_MIN_MESSAGE_COUNT - 1,
        existingCacheControlMarkers: 0,
      })).toEqual({ tier: 'heavy', reason: 'insufficient_signal' });
    });
  });

  it('is purely additive: does not change shouldTransformAnthropicMessages for the same input shape', () => {
    const base = { model: 'claude-fable-5', method: 'POST', path: '/v1/messages', bodyBytes: 10 };
    expect(shouldTransformAnthropicMessages(base)).toEqual({ eligible: true, reason: 'eligible' });
    // Weight classification is a separate, independent question from eligibility.
    expect(classifyRequestWeight({ ...base, messageCount: 1, existingCacheControlMarkers: 0 }))
      .toEqual({ tier: 'heavy', reason: 'insufficient_signal' });
  });
});
