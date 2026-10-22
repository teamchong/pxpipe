/**
 * The two forward paths must offer `matchRoute` the same authority.
 *
 * warp serves a route pattern over two code paths, and a pattern that names a
 * port is matched against "host:port" (route.ts: "a pattern that names one must
 * be matched against host:port and a pattern that does not must keep matching
 * any port"):
 *
 *   CONNECT / decrypted   connect.ts  forward(..., authority(host, port), ...)
 *   absolute-form         connect.ts  forward(..., target.host, ...)
 *
 * `authority()` always emits a port. `URL.host` omits a DEFAULT one — it is
 * "api.anthropic.com" for `https://api.anthropic.com/v1/messages` and
 * "example.com" for `http://example.com/x`. So a pattern naming :443 or :80
 * matched the CONNECT of a host and then silently failed to match the identical
 * request arriving in absolute form. A pattern naming a NON-default port never
 * saw this (URL.host keeps those), which is why the documented loopback case
 * — 127.0.0.1:9090 — always worked.
 *
 * Observed before the fix, with route `api.anthropic.com:443/v1/*`:
 *   matchRoute('api.anthropic.com:443', '/v1/messages')  -> MATCH   (CONNECT)
 *   matchRoute('api.anthropic.com',     '/v1/messages')  -> null    (absolute)
 *
 * These drive the real `handleAbsoluteForm` and observe `onDivert`, which
 * `forward` fires synchronously once a route matches — so a match is asserted at
 * the actual call site rather than against a re-derived authority string. The
 * outbound request to the (closed) front-door port errors asynchronously
 * afterwards and is irrelevant to the assertion.
 *
 * Contract being verified:
 *   - A pattern naming a default port diverts absolute-form traffic, and the
 *     authority handed to matchRoute carries the implied port.
 *   - Non-default ports and port-less patterns are unchanged.
 *   - An IPv6 literal is not double-bracketed when the port is implied.
 *   - Off-host callers are still refused (the loopback guard is untouched).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';

import type { CertificateAuthority } from '../src/warp/ca.js';
import { createWarpHandlers } from '../src/warp/connect.js';
import { parseRoute } from '../src/warp/route.js';

const FRONT = 'http://127.0.0.1:47821';

/** ca is only consulted by the MITM server's SNICallback, never in absolute form. */
const CA = { secureContextFor: () => undefined } as unknown as CertificateAuthority;

type Divert = { host: string; path: string; target: string };

/** Drive handleAbsoluteForm for one absolute URI and report any route divert. */
function requestAbsolute(
  patterns: string[],
  absoluteUri: string,
  remoteAddress = '127.0.0.1',
): { diverts: Divert[]; status: number | undefined } {
  const diverts: Divert[] = [];
  const { handleAbsoluteForm } = createWarpHandlers({
    routes: patterns.map((p) => parseRoute(`${p}=${FRONT}`)),
    ca: CA,
    onDivert: (host, path, target) => diverts.push({ host, path, target }),
  });

  let status: number | undefined;
  const req = {
    method: 'POST',
    url: absoluteUri,
    headers: { host: new URL(absoluteUri).host },
    socket: { remoteAddress },
    pipe: () => undefined,
    on: () => undefined,
  } as unknown as IncomingMessage;
  const res = {
    writeHead: (code: number) => { status = code; },
    end: () => undefined,
    on: () => undefined,
    headersSent: false,
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
  } as unknown as ServerResponse;

  handleAbsoluteForm(req, res);
  return { diverts, status };
}

describe('absolute-form authority carries the implied default port', () => {
  it('diverts https traffic for a pattern naming :443', () => {
    const { diverts } = requestAbsolute(
      ['api.anthropic.com:443/v1/*'],
      'https://api.anthropic.com/v1/messages',
    );
    expect(diverts).toHaveLength(1);
    expect(diverts[0]!.host).toBe('api.anthropic.com:443');
    expect(diverts[0]!.target).toBe(FRONT);
  });

  it('diverts plain-http traffic for a pattern naming :80', () => {
    const { diverts } = requestAbsolute(
      ['example.com:80/v1/*'],
      'http://example.com/v1/messages',
    );
    expect(diverts).toHaveLength(1);
    expect(diverts[0]!.host).toBe('example.com:80');
  });

  it('still diverts a pattern that names a non-default port', () => {
    const { diverts } = requestAbsolute(
      ['127.0.0.1:9090/v1/*'],
      'http://127.0.0.1:9090/v1/responses',
    );
    expect(diverts).toHaveLength(1);
    expect(diverts[0]!.host).toBe('127.0.0.1:9090');
  });

  it('still diverts a pattern that names no port, and matches any port', () => {
    for (const uri of [
      'https://api.anthropic.com/v1/messages',
      'https://api.anthropic.com:8443/v1/messages',
    ]) {
      const { diverts } = requestAbsolute(['api.anthropic.com/v1/*'], uri);
      expect(diverts).toHaveLength(1);
    }
  });

  it('does not divert when the named port is not the request port', () => {
    // The front door must never divert to itself: same host, different port.
    const { diverts } = requestAbsolute(
      ['127.0.0.1:9090/v1/*'],
      'http://127.0.0.1:47821/v1/responses',
    );
    expect(diverts).toHaveLength(0);
  });

  it('does not double-bracket an IPv6 literal when the port is implied', () => {
    const { diverts } = requestAbsolute(['[::1]:80/v1/*'], 'http://[::1]/v1/messages');
    expect(diverts).toHaveLength(1);
    expect(diverts[0]!.host).toBe('[::1]:80');
  });

  it('still refuses an off-host caller', () => {
    const { diverts, status } = requestAbsolute(
      ['api.anthropic.com:443/v1/*'],
      'https://api.anthropic.com/v1/messages',
      '203.0.113.7',
    );
    expect(status).toBe(403);
    expect(diverts).toHaveLength(0);
  });
});
