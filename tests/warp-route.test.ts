import { describe, expect, it } from 'vitest';

import { hostCouldMatch, matchRoute, parseRoute, rewriteUrl } from '../src/warp/route.js';

describe('warp route port selection', () => {
  const front = 'http://127.0.0.1:47821';

  it('matches a pattern with no port against any port', () => {
    const routes = [parseRoute(`api.anthropic.com/v1/messages*=${front}`)];
    expect(matchRoute(routes, 'api.anthropic.com:443', '/v1/messages')).not.toBeNull();
    expect(hostCouldMatch(routes, 'api.anthropic.com:443')).toBe(true);
  });

  it('honours the port when the pattern names one', () => {
    const routes = [parseRoute(`127.0.0.1:9090/v1/*=${front}`)];
    expect(matchRoute(routes, '127.0.0.1:9090', '/v1/responses')).not.toBeNull();
    // Same host, different port: the pxpipe front door must not divert to itself.
    expect(matchRoute(routes, '127.0.0.1:47821', '/v1/responses')).toBeNull();
    expect(hostCouldMatch(routes, '127.0.0.1:47821')).toBe(false);
  });

  it('preserves the path and query when rewriting', () => {
    const route = parseRoute(`127.0.0.1:9090/v1/*=${front}`);
    expect(rewriteUrl(route, '/v1/responses?stream=true')).toBe(
      'http://127.0.0.1:47821/v1/responses?stream=true',
    );
  });

  it('rejects a spec with no target', () => {
    expect(() => parseRoute('127.0.0.1:9090/v1/*')).toThrow(/PATTERN=http/);
  });
});
