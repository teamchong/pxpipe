/**
 * Routes re-point a matching request at a different upstream, so pxpipe can
 * transform it without the agent ever seeing a non-first-party base URL.
 *
 * That indirection is the whole point. Claude Code hides /remote-control the
 * moment ANTHROPIC_BASE_URL is custom (and gates connectors on the same
 * "firstParty" check), so pointing the agent at pxpipe directly costs you the
 * feature. Under warp the agent still talks to api.anthropic.com; only the one
 * path we rewrite is diverted, and auth, telemetry and the control plane go to
 * the real host untouched.
 *
 * Ported from wardex route.go.
 */

export interface Route {
  /** Original spec text, for banners and logs. */
  readonly pattern: string;
  /** Anchored matcher against "host/path". */
  readonly re: RegExp;
  /**
   * Host-only matcher, used to decide whether a CONNECT is worth decrypting at
   * all — a CONNECT carries no path.
   */
  readonly hostRe: RegExp;
  /**
   * Whether the pattern named a port. Loopback targets make the port the only
   * thing distinguishing two hosts (127.0.0.1:9090 vs 127.0.0.1:47821), so a
   * pattern that names one must be matched against "host:port" and a pattern
   * that does not must keep matching any port.
   */
  readonly hasPort: boolean;
  readonly target: URL;
  /**
   * Target path prefix, normalized to "" or "/foo" (no trailing slash). Kept
   * separately because URL.pathname cannot represent the empty path: assigning
   * "" to a special-scheme URL silently snaps it back to "/", which would make
   * every rewrite emit a doubled "//v1/messages".
   */
  readonly prefix: string;
}

function quoteMeta(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turn a host/path glob into an anchored regexp. "*" spans anything including
 * "/", matching wardex's semantics.
 */
function compilePattern(pattern: string): RegExp {
  const withPath = pattern.includes('/') ? pattern : `${pattern}/*`;
  const parts = withPath.toLowerCase().split('*').map(quoteMeta);
  return new RegExp(`^${parts.join('.*')}$`, 'i');
}

/**
 * parseRoute reads one PATTERN=TARGET rule:
 *
 *   api.anthropic.com/v1/messages*=http://127.0.0.1:47821
 *   re:^api\.anthropic\.com/v1/messages(/.*)?$=http://127.0.0.1:47821
 *
 * PATTERN matches "host/path" with no scheme and no query. TARGET is
 * scheme://host[:port][/prefix]; the original path and query ride along.
 */
export function parseRoute(spec: string): Route {
  // The target always ends the spec and always carries a scheme, so split on
  // the scheme rather than on "=" — patterns are regexps and may contain "=".
  let i = spec.lastIndexOf('=http://');
  const j = spec.lastIndexOf('=https://');
  if (j > i) i = j;
  if (i < 0) throw new Error(`route ${JSON.stringify(spec)}: want PATTERN=http://host:port`);

  const pattern = spec.slice(0, i);
  const rawTarget = spec.slice(i + 1);
  if (!pattern) throw new Error(`route ${JSON.stringify(spec)}: empty pattern`);

  let re: RegExp;
  try {
    re = compilePattern(pattern);
  } catch (err) {
    throw new Error(`route ${JSON.stringify(spec)}: bad pattern: ${(err as Error).message}`);
  }

  let target: URL;
  try {
    target = new URL(rawTarget);
  } catch {
    throw new Error(`route ${JSON.stringify(spec)}: bad target: ${rawTarget}`);
  }
  if (!target.host) throw new Error(`route ${JSON.stringify(spec)}: target has no host`);
  if (target.search || target.hash) {
    throw new Error(`route ${JSON.stringify(spec)}: target must not carry a query or fragment`);
  }
  const prefix = target.pathname === '/' ? '' : target.pathname.replace(/\/$/, '');

  const hostGlob = pattern.split('/')[0]!;
  const hostRe = new RegExp(`^${hostGlob.toLowerCase().split('*').map(quoteMeta).join('.*')}$`, 'i');
  const hasPort = /:\d/.test(hostGlob);

  return { pattern, re, hostRe, hasPort, target, prefix };
}

/** Drop a trailing ":port", leaving IPv6 literals in brackets intact. */
function stripPort(hostPort: string): string {
  if (hostPort.startsWith('[')) return hostPort.slice(0, hostPort.indexOf(']') + 1);
  const i = hostPort.lastIndexOf(':');
  return i > 0 ? hostPort.slice(0, i) : hostPort;
}

/**
 * First match wins, so earlier rules shadow later ones.
 *
 * `hostPort` carries the port so a pattern may select on it; patterns that name
 * no port are matched against the bare host and so still match any port.
 */
export function matchRoute(routes: readonly Route[], hostPort: string, path: string): Route | null {
  const lower = hostPort.toLowerCase();
  const bare = stripPort(lower);
  for (const route of routes) {
    if (route.re.test((route.hasPort ? lower : bare) + path)) return route;
  }
  return null;
}

/**
 * Whether any rule could match this host. Decryption is decided at CONNECT
 * time, before a path exists, so this is deliberately permissive: guessing
 * "yes" costs a needless MITM, guessing "no" silently breaks the route.
 */
export function hostCouldMatch(routes: readonly Route[], hostPort: string): boolean {
  const lower = hostPort.toLowerCase();
  const bare = stripPort(lower);
  return routes.some((route) => route.hostRe.test(route.hasPort ? lower : bare));
}

/**
 * Absolute URL a matched request is sent to. Path and query are preserved so
 * the downstream sees the same request the agent made.
 */
export function rewriteUrl(route: Route, requestUri: string): string {
  return `${route.target.protocol}//${route.target.host}${route.prefix}${requestUri}`;
}

export function routeDestination(route: Route): string {
  return `${route.target.protocol}//${route.target.host}${route.prefix}`;
}
