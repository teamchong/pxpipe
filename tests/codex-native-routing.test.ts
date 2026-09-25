import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildCodexConfigArgs,
  buildCodexEnvironment,
  buildCodexProxyConfig,
  codexProviderBaseUrl,
  parseCodexInvocation,
  resolveCodexPersistentProxy,
} from '../src/core/codex.js';
import { resolveCodexModelSelection } from '../src/core/codex-model.js';
import { createProviderRouter } from '../src/core/provider-router.js';

interface Call {
  url: string;
  auth: string | null;
  gatewayAuth: string | null;
  body: string;
}

function installFetch(calls: Call[], responseBody = '{}'): void {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const request = input instanceof Request
      ? input
      : new Request(String(input), { ...init, ...(init?.body ? { duplex: 'half' as const } : {}) });
    calls.push({
      url: request.url,
      auth: request.headers.get('authorization'),
      gatewayAuth: request.headers.get('cf-aig-authorization'),
      body: request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text(),
    });
    return new Response(responseBody, { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('Codex launcher contract', () => {
  it('uses the persistent provider route and native OpenAI provider identity', () => {
    const base = codexProviderBaseUrl(47821);
    expect(base).toBe('http://127.0.0.1:47821/providers/codex/backend-api/codex');
    expect(buildCodexConfigArgs(base)).toEqual([
      '-c', 'model_providers.pxpipe.name=OpenAI',
      '-c', `model_providers.pxpipe.base_url=${base}`,
      '-c', 'model_providers.pxpipe.wire_api=responses',
      '-c', 'model_providers.pxpipe.requires_openai_auth=true',
      '-c', 'model_providers.pxpipe.supports_websockets=false',
      '-c', 'model_provider=pxpipe',
    ]);
  });

  it('supports alternate Codex binaries without changing their home/auth state', () => {
    expect(parseCodexInvocation(['codex', '--binary', 'codex-ar', '--', 'exec', 'hello'])).toEqual({
      binary: 'codex-ar',
      direct: false,
      args: ['exec', 'hello'],
    });
    const env = buildCodexEnvironment({
      CODEX_HOME: '/tmp/codex-alt',
      OPENAI_BASE_URL: 'https://stale.example',
      HTTPS_PROXY: 'http://127.0.0.1:9999',
      NO_PROXY: 'example.test',
    });
    expect(env.CODEX_HOME).toBe('/tmp/codex-alt');
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toContain('127.0.0.1');
    expect(env.NO_PROXY).toContain('localhost');
  });

  it('preserves the caller environment for direct launches', () => {
    const source = {
      CODEX_HOME: '/tmp/codex-alt',
      OPENAI_BASE_URL: 'https://custom-openai.example/v1',
      HTTPS_PROXY: 'http://127.0.0.1:9999',
      NO_PROXY: 'example.test',
    };

    const env = buildCodexEnvironment(source, 'direct');

    expect(env).toEqual(source);
    expect(env).not.toBe(source);
  });

  it('resolves explicit model, profile model, then top-level config', () => {
    const config = `
model = "gpt-config"
profile = "work"

[profiles.work]
model = "gpt-profile"
`;
    expect(resolveCodexModelSelection(['--model', 'gpt-cli'], config, 'gpt-ref')).toEqual({
      model: 'gpt-cli', source: 'cli',
    });
    expect(resolveCodexModelSelection([], config, 'gpt-ref')).toEqual({
      model: 'gpt-profile', source: 'profile', profile: 'work',
    });
    expect(resolveCodexModelSelection([], 'model = "gpt-config"', 'gpt-ref')).toEqual({
      model: 'gpt-config', source: 'config',
    });
  });

  it('health-checks the existing listener without starting another one', async () => {
    const calls: Call[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      calls.push({
        url: String(input),
        auth: null,
        gatewayAuth: null,
        body: '',
      });
      return new Response('{}', { status: 200 });
    });
    await expect(resolveCodexPersistentProxy({ PORT: '47821' }, fetchFn)).resolves.toEqual({
      baseUrl: codexProviderBaseUrl(47821),
      port: 47821,
    });
    expect(calls[0]!.url).toBe('http://127.0.0.1:47821/proxy-stats');
  });
});

describe('Codex provider route', () => {
  function router() {
    return createProviderRouter({
      defaultProxy: { upstream: 'https://api.anthropic.example' },
      providers: [{
        id: 'codex',
        protocol: 'openai',
        proxy: {
          upstream: 'https://chatgpt.com',
          openAIUpstream: 'https://chatgpt.com',
          openAIModels: [],
          cloudflareModels: [],
        },
      }],
    });
  }

  it('forwards ChatGPT Responses to the exact native endpoint and preserves caller OAuth', async () => {
    const calls: Call[] = [];
    installFetch(calls, '{"id":"resp_test"}');
    const jwt = 'Bearer eyJhbGciOiJub25lIn0.abc.def';
    const response = await router()(new Request(
      'http://127.0.0.1:47821/providers/codex/backend-api/codex/responses',
      {
        method: 'POST',
        headers: { authorization: jwt, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-unconfigured-test', input: 'hello', stream: false }),
      },
    ));
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(calls[0]!.auth).toBe(jwt);
  });

  it('does not inherit gateway routing or credentials into the Codex route', async () => {
    const calls: Call[] = [];
    installFetch(calls);

    const isolated = buildCodexProxyConfig({
      provider: 'cloudflare-ai-gateway',
      gatewayBaseUrl: 'https://gateway.example',
      gatewayHeaders: {
        'cf-aig-authorization': 'Bearer gateway-secret',
      },
      upstream: 'https://legacy-anthropic.example',
      openAIUpstream: 'https://legacy-openai.example',
      cloudflareUpstream: 'https://legacy-cloudflare.example',
      cloudflareApiKey: 'cloudflare-secret',
    });

    const gatewayRouter = createProviderRouter({
      defaultProxy: {
        upstream: 'https://legacy-anthropic.example',
      },
      providers: [{
        id: 'codex',
        protocol: 'openai',
        proxy: isolated,
      }],
    });

    const oauth = 'Bearer chatgpt-oauth-token';

    const response = await gatewayRouter(new Request(
      'http://127.0.0.1:47821/providers/codex/backend-api/codex/responses',
      {
        method: 'POST',
        headers: {
          authorization: oauth,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-unconfigured-test',
          input: 'hello',
          stream: false,
        }),
      },
    ));

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url)
      .toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(calls[0]!.auth).toBe(oauth);
    expect(calls[0]!.gatewayAuth).toBeNull();
  });

  it('forwards native compact byte-for-byte on the same authenticated route', async () => {
    const calls: Call[] = [];
    installFetch(calls);
    const body = '{"model":"gpt-test","input":[{"type":"opaque","value":"  exact  "}]}';
    const jwt = 'Bearer eyJhbGciOiJub25lIn0.abc.def';
    const response = await router()(new Request(
      'http://127.0.0.1:47821/providers/codex/backend-api/codex/responses/compact',
      {
        method: 'POST',
        headers: { authorization: jwt, 'content-type': 'application/json' },
        body,
      },
    ));
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://chatgpt.com/backend-api/codex/responses/compact');
    expect(calls[0]!.auth).toBe(jwt);
    expect(calls[0]!.body).toBe(body);
  });
});
