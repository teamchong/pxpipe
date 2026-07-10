import { describe, it, expect } from 'vitest';
import { toTrackEvent, JsonLogTracker, noopTracker, type TrackEvent } from '../src/core/tracker.js';
import type { ProxyEvent } from '../src/core/proxy.js';

describe('toTrackEvent', () => {
  it('keeps raw compression, provider cache, and component cost separate', () => {
    const out = toTrackEvent({
      method: 'POST', path: '/v1/responses', model: 'gpt-5.6', status: 200,
      durationMs: 12, client: 'codex-cli', protocol: 'openai-responses',
      profileVersion: 'gpt-5.6-sol@1', reqBodySha8: 'deadbeef',
      info: { compressed: true, origChars: 10, compressedChars: 10, imageCount: 1,
        imageBytes: 20, staticChars: 10, dynamicChars: 0, dynamicBlockCount: 0,
        baselineTokens: 120, imageTokens: 30, toolDocsChars: 7,
        outgoingTextChars: 80, imageDims: [{ width: 100, height: 1920 }] },
      usage: { input_tokens: 90, output_tokens: 4, cached_tokens: 20 },
    });
    expect(out.client).toBe('codex-cli');
    expect(out.protocol).toBe('openai-responses');
    expect(out.profile_version).toBe('gpt-5.6-sol@1');
    expect(out.image_dimensions).toEqual([{ width: 100, height: 1920 }]);
    expect(out.raw_compression).toEqual({ scope: 'provider_count_tokens', pre_native_text_tokens: 120,
      post_native_text_tokens: null, pre_image_tokens: 0, post_image_tokens: 30 });
    expect(out.provider_cache?.cached_tokens).toBe(20);
    expect(out.component_cost).toEqual({ image_tokens: 30, fact_sheet_chars: null,
      framing_pointer_guard_chars: null });
    expect(JSON.stringify(out)).not.toContain('secret prompt');
  });
  it('flattens ProxyEvent + TransformInfo + Usage into a single record', () => {
    const ev: ProxyEvent = {
      method: 'POST',
      path: '/v1/messages',
      model: 'gpt-5.5',
      status: 200,
      durationMs: 1234,
      firstByteMs: 200,
      info: {
        compressed: true,
        origChars: 16000,
        imageCount: 1,
        imageBytes: 2103,
        staticChars: 14000,
        dynamicChars: 500,
        dynamicBlockCount: 2,
        systemSha8: 'a1b2c3d4',
        claudeMdSha8: 'cafebabe',
        firstUserSha8: 'deadbeef',
        unknownStaticTags: ['recent_files'],
        env: {
          cwd: '/Users/me/code/pp',
          isGitRepo: true,
          gitBranch: 'main',
          platform: 'darwin',
          osVersion: 'Darwin 25.0.0',
          today: '2026-05-18',
        },
      },
      usage: {
        input_tokens: 42,
        output_tokens: 7,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 100,
      },
    };
    const out = toTrackEvent(ev);
    // Spot-check every category of field made it across with the right
    // snake_case names.
    expect(out.method).toBe('POST');
    expect(out.path).toBe('/v1/messages');
    expect(out.model).toBe('gpt-5.5');
    expect(out.status).toBe(200);
    expect(out.duration_ms).toBe(1234);
    expect(out.first_byte_ms).toBe(200);
    expect(out.compressed).toBe(true);
    expect(out.orig_chars).toBe(16000);
    expect(out.static_chars).toBe(14000);
    expect(out.dynamic_chars).toBe(500);
    expect(out.dynamic_block_count).toBe(2);
    expect(out.system_sha8).toBe('a1b2c3d4');
    expect(out.claude_md_sha8).toBe('cafebabe');
    expect(out.first_user_sha8).toBe('deadbeef');
    expect(out.unknown_static_tags).toEqual(['recent_files']);
    expect(out.cwd).toBe('/Users/me/code/pp');
    expect(out.git_branch).toBe('main');
    expect(out.is_git_repo).toBe(true);
    expect(out.input_tokens).toBe(42);
    expect(out.cache_read_tokens).toBe(100);
    expect(out.cache_create_tokens).toBe(0);
    // ts is ISO8601
    expect(out.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('captures the nested cache_creation split and server_tool_use counters', () => {
    // Anthropic's `usage` block carries some fields inline and others nested
    // under `cache_creation` / `server_tool_use`. The flat 4-field view we
    // historically copied silently dropped 3 real billing dimensions:
    //   - output_tokens (rate-multiplier ×5 — see dashboard math)
    //   - cache_creation.ephemeral_5m_input_tokens (1.25× rate)
    //   - cache_creation.ephemeral_1h_input_tokens (2× rate — meaningful $)
    //   - server_tool_use.web_search_requests (billed per request, not token)
    // Regression guard for the May-2026 audit that surfaced the gap.
    const out = toTrackEvent({
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      durationMs: 100,
      usage: {
        input_tokens: 10,
        output_tokens: 250,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 50,
        cache_creation: {
          ephemeral_5m_input_tokens: 900,
          ephemeral_1h_input_tokens: 100,
        },
        server_tool_use: {
          web_search_requests: 3,
        },
      },
    });
    expect(out.output_tokens).toBe(250);
    expect(out.cache_create_tokens).toBe(1000);
    expect(out.cache_create_5m_tokens).toBe(900);
    expect(out.cache_create_1h_tokens).toBe(100);
    expect(out.web_search_requests).toBe(3);
  });

  it('omits the nested usage fields when Anthropic does not return them', () => {
    // Older API versions and non-cache requests return only the flat
    // fields. The optional copies must stay undefined, not zero — zero is
    // a real value that means "we measured it and it was zero".
    const out = toTrackEvent({
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      durationMs: 100,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    expect(out.cache_creation_5m_tokens).toBeUndefined();
    expect(out.cache_creation_1h_tokens).toBeUndefined();
    expect(out.web_search_requests).toBeUndefined();
  });

  it('surfaces bucket_chars and history_text_chars when present', () => {
    // Phase 1 of Task #18: per-block char attribution by content shape.
    // The rolling cpt regression in tests/proxy-usage.test.ts and the
    // dashboard read this back, so getting the snake_case names + nested
    // shape right matters. Absent buckets must be omitted entirely so the
    // happy-path events stay lean.
    const out = toTrackEvent({
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      durationMs: 50,
      info: {
        compressed: true,
        origChars: 30000,
        bucketChars: {
          static_slab: 27000,
          reminder: 1500,
          tool_result_log: 800,
          tool_result_prose: 400,
          history: 300,
        },
        historyTextChars: 300,
      },
    });
    expect(out.bucket_chars).toEqual({
      static_slab: 27000,
      reminder: 1500,
      tool_result_log: 800,
      tool_result_prose: 400,
      history: 300,
    });
    expect(out.history_text_chars).toBe(300);
  });

  it('omits bucket_chars when no gates fired and the bucket map is empty', () => {
    // Pass-through requests (compress=false, parse errors) never call
    // bumpBucket. `info.bucketChars` either stays undefined or — if
    // something allocated the sub-object without writing — should still
    // not show up in the persisted event. Otherwise consumers can't tell
    // "we measured zero buckets" from "we never ran the gate".
    const noBuckets = toTrackEvent({
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      durationMs: 10,
      info: { compressed: false, reason: 'compress=false', origChars: 0 },
    });
    expect(noBuckets.bucket_chars).toBeUndefined();
    expect(noBuckets.history_text_chars).toBeUndefined();

    const emptyBucketMap = toTrackEvent({
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      durationMs: 10,
      info: { compressed: true, origChars: 100, bucketChars: {} },
    });
    expect(emptyBucketMap.bucket_chars).toBeUndefined();
  });

  it('handles a minimal ProxyEvent (no info, no usage) without throwing', () => {
    const out = toTrackEvent({
      method: 'GET',
      path: '/health',
      status: 200,
      durationMs: 4,
    });
    expect(out.method).toBe('GET');
    expect(out.compressed).toBeUndefined();
    expect(out.cwd).toBeUndefined();
    expect(out.input_tokens).toBeUndefined();
  });

  it('maps stopReason → stop_reason without flagging benign reasons', () => {
    const out = toTrackEvent({
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      durationMs: 10,
      stopReason: 'end_turn',
    });
    expect(out.stop_reason).toBe('end_turn');
    expect(out.safety_flagged).toBeUndefined();
  });

  it.each(['refusal', 'content_filter'])(
    'sets safety_flagged for stop reason %s',
    (reason) => {
      const out = toTrackEvent({
        method: 'POST',
        path: '/v1/messages',
        status: 200,
        durationMs: 10,
        stopReason: reason,
      });
      expect(out.stop_reason).toBe(reason);
      expect(out.safety_flagged).toBe(true);
    },
  );

  it('omits stop_reason entirely when the event has none', () => {
    const out = toTrackEvent({
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      durationMs: 10,
    });
    expect('stop_reason' in out).toBe(false);
    expect('safety_flagged' in out).toBe(false);
  });
});

describe('JsonLogTracker', () => {
  it('emits one JSON line per event to the sink', () => {
    const lines: string[] = [];
    const t = new JsonLogTracker((s) => lines.push(s));
    t.emit({ ts: '2026-05-18T00:00:00Z', method: 'POST', path: '/v1/messages', status: 200, duration_ms: 1 } as TrackEvent);
    t.emit({ ts: '2026-05-18T00:00:01Z', method: 'POST', path: '/v1/messages', status: 200, duration_ms: 2 } as TrackEvent);
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].duration_ms).toBe(1);
    expect(parsed[1].duration_ms).toBe(2);
  });

  it('swallows sink errors — tracker must never break a request', () => {
    const t = new JsonLogTracker(() => {
      throw new Error('disk full');
    });
    expect(() =>
      t.emit({ ts: 'x', method: 'POST', path: '/v1/messages', status: 200, duration_ms: 1 } as TrackEvent),
    ).not.toThrow();
  });
});

describe('noopTracker', () => {
  it('discards events silently', () => {
    expect(() =>
      noopTracker.emit({ ts: 'x', method: 'POST', path: '/v1/messages', status: 200, duration_ms: 1 } as TrackEvent),
    ).not.toThrow();
  });
});

describe('toTrackEvent body-sample mapping', () => {
  const baseEv = {
    method: 'POST',
    path: '/v1/messages',
    status: 400,
    durationMs: 100,
  };

  it('inlines small gzipped bodies as req_body_sample_b64', () => {
    const small = new Uint8Array(64).fill(0x1f);
    const out = toTrackEvent({
      ...baseEv,
      reqBodySha8: 'deadbeef',
      reqBodyGz: small,
    } as ProxyEvent);
    expect(out.req_body_sha8).toBe('deadbeef');
    expect(out.req_body_sample_b64).toBeDefined();
    expect(out.req_body_sample_b64!.length).toBeLessThanOrEqual(128);
    expect(out.req_body_sample_path).toBeUndefined();
  });

  it('drops oversized gzipped bodies that lack a sidecar path', () => {
    // 40 KiB of gz bytes → ~53 KiB base64 → exceeds the 32 KiB cap, and we
    // didn't pre-write a sidecar → must silently drop the inline body
    // (Workers path). req_body_sha8 still lands.
    const big = new Uint8Array(40 * 1024).fill(0x42);
    const out = toTrackEvent({
      ...baseEv,
      reqBodySha8: 'cafef00d',
      reqBodyGz: big,
    } as ProxyEvent);
    expect(out.req_body_sha8).toBe('cafef00d');
    expect(out.req_body_sample_b64).toBeUndefined();
    expect(out.req_body_sample_path).toBeUndefined();
  });

  it('prefers reqBodySamplePath over inlining when both are set', () => {
    const someGz = new Uint8Array(64).fill(0x1f);
    const out = toTrackEvent({
      ...baseEv,
      reqBodySha8: 'feedface',
      reqBodyGz: someGz,
      reqBodySamplePath: '/tmp/4xx-bodies/x.json.gz',
    } as ProxyEvent);
    // Sidecar path wins; we don't double-encode inline.
    expect(out.req_body_sample_path).toBe('/tmp/4xx-bodies/x.json.gz');
    expect(out.req_body_sample_b64).toBeUndefined();
  });

  it('sets req_body_sha8 on 2xx events too (correlation across statuses)', () => {
    const out = toTrackEvent({
      ...baseEv,
      status: 200,
      reqBodySha8: '01234567',
    } as ProxyEvent);
    expect(out.req_body_sha8).toBe('01234567');
    // No body sample fields for 2xx.
    expect(out.req_body_sample_b64).toBeUndefined();
    expect(out.req_body_sample_path).toBeUndefined();
  });
});
