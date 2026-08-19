import { createProxy, type ProxyConfig, type ProxyEvent } from './proxy.js';

export type ProviderProtocol = 'anthropic' | 'openai' | 'google';

export interface ProviderRouteDefinition {
  /** Stable route id used in `/providers/<id>/...`. */
  id: string;
  /** Wire protocol accepted by the configured upstream. */
  protocol: ProviderProtocol;
  /** Existing proxy configuration for this provider. Kept in memory only. */
  proxy: ProxyConfig;
}

export interface ProviderRouterConfig {
  /** Handles legacy unprefixed routes such as `/v1/messages`. */
  defaultProxy: ProxyConfig;
  /** Explicitly addressable providers. */
  providers: readonly ProviderRouteDefinition[];
  /** Optional observer invoked after the provider-specific observer. */
  onRequest?: (providerId: string, event: ProxyEvent) => void | Promise<void>;
}

export interface ParsedProviderRoute {
  providerId: string;
  upstreamPath: string;
}

export interface ProviderRouterInspection {
  defaultRoute: 'legacy';
  providers: Array<{
    id: string;
    protocol: ProviderProtocol;
    prefix: string;
  }>;
}

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,62}$/;
const PROVIDER_ROOT = '/providers';
const PREFIX = `${PROVIDER_ROOT}/`;

export function assertProviderId(id: string): void {
  if (!PROVIDER_ID.test(id)) {
    throw new Error(
      `invalid provider id ${JSON.stringify(id)}; expected lowercase letters, digits and dashes`,
    );
  }
}

/**
 * Parse an explicit provider-prefixed request path.
 *
 * The provider id is never accepted from a header, query string or body. This
 * keeps routing metadata outside the model payload and prevents an untrusted
 * client from overriding upstream selection through a forwarded header.
 */
export function parseProviderRoute(pathname: string): ParsedProviderRoute | null {
  if (!pathname.startsWith(PREFIX)) return null;
  const remainder = pathname.slice(PREFIX.length);
  const slash = remainder.indexOf('/');
  if (slash <= 0) return null;

  const providerId = remainder.slice(0, slash);
  if (!PROVIDER_ID.test(providerId)) return null;

  const upstreamPath = remainder.slice(slash);
  if (!upstreamPath.startsWith('/') || upstreamPath.startsWith('//')) return null;
  return { providerId, upstreamPath };
}

function isProviderNamespace(pathname: string): boolean {
  return pathname === PROVIDER_ROOT || pathname.startsWith(PREFIX);
}

function wrapProviderObserver(
  definition: ProviderRouteDefinition,
  routerObserver: ProviderRouterConfig['onRequest'],
): ProxyConfig {
  const providerObserver = definition.proxy.onRequest;
  return {
    ...definition.proxy,
    onRequest: async (event) => {
      await providerObserver?.(event);
      await routerObserver?.(definition.id, event);
    },
  };
}

function rewriteProviderRequest(request: Request, route: ParsedProviderRoute): Request {
  const sourceUrl = new URL(request.url);
  sourceUrl.pathname = route.upstreamPath;

  const bodyAllowed = request.method !== 'GET' && request.method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers: new Headers(request.headers),
    body: bodyAllowed ? request.body : undefined,
    redirect: request.redirect,
    signal: request.signal,
  };
  if (request.body) init.duplex = 'half';

  // The body stream is forwarded without decoding or re-encoding it. Tool
  // schemas, prompts, binary parts and structured-output contracts remain
  // untouched until the selected provider's normal transform pipeline runs.
  return new Request(sourceUrl, init);
}

function invalidProviderRoute(): Response {
  return new Response(
    JSON.stringify({ error: 'invalid_provider_route' }),
    {
      status: 400,
      headers: { 'content-type': 'application/json' },
    },
  );
}

/**
 * Create one request handler that multiplexes several provider-specific
 * `createProxy` instances behind one Web-standard request handler.
 *
 * Legacy paths continue through `defaultProxy`. Explicit provider paths use:
 *
 *   /providers/<provider-id>/<upstream-path>
 */
export function createProviderRouter(
  config: ProviderRouterConfig,
): ((request: Request) => Promise<Response>) & { inspect(): ProviderRouterInspection } {
  const defaultHandler = createProxy(config.defaultProxy);
  const handlers = new Map<string, ReturnType<typeof createProxy>>();
  const definitions = new Map<string, ProviderRouteDefinition>();

  for (const definition of config.providers) {
    assertProviderId(definition.id);
    if (definitions.has(definition.id)) {
      throw new Error(`duplicate provider id: ${definition.id}`);
    }
    definitions.set(definition.id, definition);
    handlers.set(
      definition.id,
      createProxy(wrapProviderObserver(definition, config.onRequest)),
    );
  }

  const route = async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname;
    const parsed = parseProviderRoute(pathname);
    // `/providers` is a reserved internal namespace. Malformed explicit routes
    // must never fall through to the legacy/default upstream.
    if (!parsed) return isProviderNamespace(pathname) ? invalidProviderRoute() : defaultHandler(request);

    const handler = handlers.get(parsed.providerId);
    if (!handler) {
      return new Response(
        JSON.stringify({
          error: 'unknown_provider',
          provider: parsed.providerId,
        }),
        {
          status: 404,
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    return handler(rewriteProviderRequest(request, parsed));
  };

  return Object.assign(route, {
    inspect(): ProviderRouterInspection {
      return {
        defaultRoute: 'legacy',
        providers: [...definitions.values()].map((definition) => ({
          id: definition.id,
          protocol: definition.protocol,
          prefix: `${PREFIX}${definition.id}`,
        })),
      };
    },
  });
}
