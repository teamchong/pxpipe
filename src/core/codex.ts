/** First-class Codex CLI routing through the persistent PXPipe listener. */

import type { ProxyConfig } from './proxy.js';

export const CODEX_PROVIDER_ID = 'codex';
export const CODEX_MODEL_PROVIDER_ID = 'pxpipe';
export const CODEX_NATIVE_PROVIDER_NAME = 'OpenAI';
export const DEFAULT_CODEX_PORT = 47821;
export const DEFAULT_CODEX_CHATGPT_BASE = 'https://chatgpt.com';

/**
 * Derive the dedicated Codex route from the main listener configuration.
 *
 * Operational settings such as transform policy, observers, size limits and
 * timeouts are inherited. Provider/gateway routing and credentials are not:
 * Codex must always forward the caller's own ChatGPT authentication directly
 * to the ChatGPT Codex origin.
 */
export function buildCodexProxyConfig(base: ProxyConfig): ProxyConfig {
  return {
    ...base,

    // Never inherit an alternate provider/gateway from the default listener.
    provider: undefined,
    gatewayBaseUrl: undefined,
    gatewayHeaders: undefined,

    upstream: DEFAULT_CODEX_CHATGPT_BASE,
    apiKey: undefined,
    authToken: undefined,

    openAIUpstream: DEFAULT_CODEX_CHATGPT_BASE,
    openAIApiKey: undefined,

    // A provider-specific Cloudflare route or credential must not bleed into
    // the ChatGPT OAuth path either.
    cloudflareUpstream: undefined,
    cloudflareApiKey: undefined,

    openAIModels: [],
    cloudflareModels: [],

    // Cache/materiality-aware Responses history admission is deliberately
    // enabled only on this isolated Codex route.
    codexOptimization: true,
  };
}

/**
 * Codex appends `/responses`, `/responses/compact`, and `/models` to this base.
 * The provider router removes `/providers/codex`; the remaining ChatGPT path is
 * forwarded by the isolated Codex proxy configuration.
 */
export function codexProviderBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/providers/${CODEX_PROVIDER_ID}/backend-api/codex`;
}

/** Temporary Codex config overrides. No Codex files are modified. */
export function buildCodexConfigArgs(baseUrl: string): string[] {
  const provider = `model_providers.${CODEX_MODEL_PROVIDER_ID}`;
  return [
    '-c', `${provider}.name=${CODEX_NATIVE_PROVIDER_NAME}`,
    '-c', `${provider}.base_url=${baseUrl}`,
    '-c', `${provider}.wire_api=responses`,
    '-c', `${provider}.requires_openai_auth=true`,
    '-c', `${provider}.supports_websockets=false`,
    '-c', `model_provider=${CODEX_MODEL_PROVIDER_ID}`,
  ];
}

function isLoopbackProxyUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const { hostname } = new URL(value.includes('://') ? value : `http://${value}`);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

function appendNoProxy(existing: string | undefined): string {
  const wanted = ['127.0.0.1', 'localhost', '::1'];
  const have = (existing ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  for (const entry of wanted) if (!have.includes(entry)) have.push(entry);
  return have.join(',');
}

/**
 * Build a child environment without disturbing CODEX_HOME/auth state.
 *
 * Endpoint overrides from other wrappers are removed because this launcher uses
 * Codex's model-provider config layer. Loopback Warp proxies are removed so the
 * plain HTTP hop to the persistent listener cannot be intercepted recursively.
 */
export type CodexEnvironmentMode = 'proxied' | 'direct';

export function buildCodexEnvironment(
  source: NodeJS.ProcessEnv,
  mode: CodexEnvironmentMode = 'proxied',
): NodeJS.ProcessEnv {
  const env = { ...source };

  // A direct launch must be observationally equivalent to invoking Codex
  // without PXPipe: preserve caller endpoint/proxy configuration untouched.
  if (mode === 'direct') return env;

  delete env.OPENAI_BASE_URL;
  for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy'] as const) {
    if (isLoopbackProxyUrl(env[key])) delete env[key];
  }
  env.NO_PROXY = appendNoProxy(env.NO_PROXY);
  env.no_proxy = appendNoProxy(env.no_proxy);
  return env;
}

export interface CodexInvocation {
  binary: string;
  direct: boolean;
  args: string[];
}

/** `pxpipe codex [--binary NAME] [--direct] [--] [codex args...]` */
export function parseCodexInvocation(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CodexInvocation {
  const rest = argv[0] === 'codex' ? argv.slice(1) : [...argv];
  let binary = env.PXPIPE_CODEX_BINARY?.trim() || 'codex';
  let direct = false;
  let index = 0;
  for (; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === '--') {
      index += 1;
      break;
    }
    if (arg === '--binary') {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error('--binary requires an executable name or path');
      }
      binary = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--binary=')) {
      binary = arg.slice('--binary='.length);
      if (!binary) throw new Error('--binary requires an executable name or path');
      continue;
    }
    if (arg === '--direct') {
      direct = true;
      continue;
    }
    break;
  }
  return { binary, direct, args: rest.slice(index) };
}

export function buildCodexCommandArgs(
  baseUrl: string,
  args: readonly string[],
  resolvedModel?: string,
): string[] {
  const modelArgs = resolvedModel?.trim() ? ['-c', `model=${resolvedModel.trim()}`] : [];
  return [...buildCodexConfigArgs(baseUrl), ...modelArgs, ...args];
}

export function resolveCodexPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PORT ?? DEFAULT_CODEX_PORT);
  return Number.isSafeInteger(raw) && raw > 0 && raw <= 65535 ? raw : DEFAULT_CODEX_PORT;
}

/** Health-check the already-running PXPipe listener; never binds another port. */
export async function resolveCodexPersistentProxy(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<{ baseUrl: string; port: number } | null> {
  const port = resolveCodexPort(env);
  try {
    const response = await fetchFn(`http://127.0.0.1:${port}/proxy-stats`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return null;
  } catch {
    return null;
  }
  return { baseUrl: codexProviderBaseUrl(port), port };
}
