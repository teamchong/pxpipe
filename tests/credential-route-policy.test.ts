/**
 * Which credential reaches which upstream.
 *
 * pxpipe sits on the wire with every request's authorization header in hand, so
 * the rule for what it forwards has to be a rule, not a side effect of which
 * branch a route fell into. Before this policy existed, two behaviours followed
 * from the same `if`:
 *
 *  - a Codex client's ChatGPT subscription OAuth was overwritten by the host's
 *    configured OpenAI key whenever one was set, billing the wrong account and
 *    usually failing with no visible reason;
 *  - an Anthropic-shaped bearer arriving on a direct OpenAI route was forwarded
 *    to OpenAI, because the `authorization` deletion only covered bridged
 *    requests. The route classifier already refused exactly this for the
 *    ambiguous `/v1/models` path, calling it "a credential leak, and a
 *    guaranteed 401"; the rule simply was not applied anywhere else.
 *
 * The table below is the contract. Classification is by shape only: no local
 * token store is ever read, and no credential content beyond its prefix and
 * segment structure is examined.
 *
 * Run just this file:  pnpm vitest run tests/credential-route-policy.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classifyInboundCredential,
  createProxy,
  resolveOpenAIRouteAuth,
  type InboundCredential,
  type ProxyConfig,
} from '../src/core/proxy.js';

let ambientPxpipeModels: string | undefined;
beforeAll(() => {
  ambientPxpipeModels = process.env.PXPIPE_MODELS;
  process.env.PXPIPE_MODELS = 'off';
});
afterAll(() => {
  if (ambientPxpipeModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = ambientPxpipeModels;
});

/** A structurally valid JWT. Contents are inert: header `{"alg":"none"}`. */
const JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.c2ln';
const ANTHROPIC_OAUTH = 'sk-ant-oat01-example';
const ANTHROPIC_KEY = 'sk-ant-api03-example';
const OPENAI_KEY = 'sk-proj-example';
const HOST_KEY = 'sk-host-configured';

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe('classifyInboundCredential reads shape, never content', () => {
  const cases: Array<[Record<string, string>, InboundCredential]> = [
    [{}, 'none'],
    [{ 'x-api-key': ANTHROPIC_KEY }, 'anthropic-key'],
    [{ authorization: `Bearer ${ANTHROPIC_OAUTH}` }, 'anthropic-bearer'],
    [{ authorization: `Bearer ${ANTHROPIC_KEY}` }, 'anthropic-bearer'],
    [{ authorization: `Bearer ${JWT}` }, 'oauth-jwt'],
    [{ authorization: `Bearer ${OPENAI_KEY}` }, 'api-key-bearer'],
    [{ authorization: 'Bearer opaque-gateway-token' }, 'opaque-bearer'],
    // An Anthropic bearer outranks a co-present x-api-key: it is the stronger
    // signal and the one that would actually be forwarded.
    [{ authorization: `Bearer ${ANTHROPIC_OAUTH}`, 'x-api-key': ANTHROPIC_KEY }, 'anthropic-bearer'],
  ];
  it.each(cases)('classifies %j', (init, expected) => {
    expect(classifyInboundCredential(headers(init))).toBe(expected);
  });

  it('does not mistake an empty header for a credential', () => {
    expect(classifyInboundCredential(headers({ authorization: '   ' }))).toBe('none');
    expect(classifyInboundCredential(headers({ 'x-api-key': '' }))).toBe('none');
  });
});

describe('resolveOpenAIRouteAuth: inbound credential x configured key', () => {
  const matrix: Array<[InboundCredential, boolean, 'keep-inbound' | 'replace' | 'drop']> = [
    // An Anthropic credential must never reach OpenAI, key configured or not.
    ['anthropic-bearer', false, 'drop'],
    ['anthropic-bearer', true, 'replace'],
    ['anthropic-key', false, 'drop'],
    ['anthropic-key', true, 'replace'],
    // Subscription OAuth is the caller's, and outranks a configured host key.
    ['oauth-jwt', false, 'keep-inbound'],
    ['oauth-jwt', true, 'keep-inbound'],
    // Ordinary keys: the host key replaces when present, otherwise forward.
    ['api-key-bearer', false, 'keep-inbound'],
    ['api-key-bearer', true, 'replace'],
    ['opaque-bearer', false, 'keep-inbound'],
    ['opaque-bearer', true, 'replace'],
    // Nothing to keep.
    ['none', false, 'drop'],
    ['none', true, 'replace'],
  ];
  it.each(matrix)('%s with configured=%s -> %s', (inbound, configured, action) => {
    expect(resolveOpenAIRouteAuth(inbound, configured).action).toBe(action);
  });

  it('never returns replace when no key is configured', () => {
    const inbounds: InboundCredential[] = [
      'none',
      'anthropic-key',
      'anthropic-bearer',
      'oauth-jwt',
      'api-key-bearer',
      'opaque-bearer',
    ];
    for (const inbound of inbounds) {
      expect(resolveOpenAIRouteAuth(inbound, false).action).not.toBe('replace');
    }
  });

  it('always states a reason, so a decision can be explained', () => {
    expect(resolveOpenAIRouteAuth('oauth-jwt', true).reason).toContain('subscription');
    expect(resolveOpenAIRouteAuth('anthropic-bearer', false).reason).toContain('never-crosses');
  });
});

interface Seen {
  authorization: string | null;
  apiKey: string | null;
  restore: () => void;
}

function captureUpstream(): Seen {
  const real = globalThis.fetch;
  const seen: Seen = {
    authorization: null,
    apiKey: null,
    restore: () => {
      globalThis.fetch = real;
    },
  };
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const r = input instanceof Request ? input : new Request(String(input), init);
    seen.authorization = r.headers.get('authorization');
    seen.apiKey = r.headers.get('x-api-key');
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return seen;
}

function proxy(openAIApiKey?: string): ReturnType<typeof createProxy> {
  const config: ProxyConfig = {
    upstream: 'https://anthropic.invalid',
    openAIUpstream: 'https://openai.invalid',
    transform: { compress: false },
    ...(openAIApiKey === undefined ? {} : { openAIApiKey }),
  };
  return createProxy(config);
}

function responsesRequest(auth: Record<string, string>): Request {
  return new Request('http://127.0.0.1:47821/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hi' }),
  });
}

describe('the policy holds on a real OpenAI route', () => {
  it('preserves subscription OAuth even when a host key is configured', async () => {
    const seen = captureUpstream();
    try {
      await proxy(HOST_KEY)(responsesRequest({ authorization: `Bearer ${JWT}` }));
      expect(seen.authorization).toBe(`Bearer ${JWT}`);
    } finally {
      seen.restore();
    }
  });

  it('does not forward an Anthropic bearer to the OpenAI upstream', async () => {
    const seen = captureUpstream();
    try {
      await proxy()(responsesRequest({ authorization: `Bearer ${ANTHROPIC_OAUTH}` }));
      expect(seen.authorization).toBeNull();
    } finally {
      seen.restore();
    }
  });

  it('substitutes the host key for an Anthropic bearer rather than leaking it', async () => {
    const seen = captureUpstream();
    try {
      await proxy(HOST_KEY)(responsesRequest({ authorization: `Bearer ${ANTHROPIC_OAUTH}` }));
      expect(seen.authorization).toBe(`Bearer ${HOST_KEY}`);
      expect(seen.authorization).not.toContain('sk-ant-');
    } finally {
      seen.restore();
    }
  });

  it('never forwards x-api-key to the OpenAI upstream', async () => {
    const seen = captureUpstream();
    try {
      await proxy()(responsesRequest({ 'x-api-key': ANTHROPIC_KEY }));
      expect(seen.apiKey).toBeNull();
    } finally {
      seen.restore();
    }
  });

  it('forwards an OpenAI key unchanged when the host configured none', async () => {
    const seen = captureUpstream();
    try {
      await proxy()(responsesRequest({ authorization: `Bearer ${OPENAI_KEY}` }));
      expect(seen.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    } finally {
      seen.restore();
    }
  });
});
