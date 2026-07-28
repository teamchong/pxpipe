/**
 * The CONNECT proxy warp puts in front of the child process.
 *
 * Ported from wardex proxy.go, with two deliberate narrowings:
 *
 *  - wardex decrypts every host once --mitm is on; warp decrypts only hosts a
 *    route could match and blindly tunnels the rest. Under warp the agent
 *    believes it is talking straight to api.anthropic.com, so the less we
 *    terminate, the fewer ways that belief can break.
 *  - wardex owns its listener; warp attaches to the proxy server pxpipe is
 *    already running. CONNECT is a distinct event from a normal request, so one
 *    port serves both the origin-form traffic pxpipe handles and the
 *    absolute-form/CONNECT traffic a forward proxy handles.
 */

import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import {
  Agent as HttpsAgent,
  createServer as createHttpsServer,
  request as httpsRequest,
} from 'node:https';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

import type { CertificateAuthority } from './ca.js';
import { hostCouldMatch, matchRoute, rewriteUrl, type Route } from './route.js';

/**
 * Hop-by-hop headers are meaningful only on a single connection, so they must
 * not be copied onto the re-originated request (RFC 9110 7.6.1).
 */
const HOP_HEADERS = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface WarpHandlerOptions {
  routes: readonly Route[];
  ca: CertificateAuthority;
  /** Called the first time each route diverts a request, for the log. */
  onDivert?: (host: string, path: string, target: string) => void;
}

export interface WarpHandlers {
  /** Attach as the server's 'connect' listener. */
  handleConnect: (req: IncomingMessage, socket: Socket, head: Buffer) => void;
  /** Call from the request handler for absolute-form request targets. */
  handleAbsoluteForm: (req: IncomingMessage, res: ServerResponse) => void;
}

/**
 * A CONNECT handler reachable off-host is an open relay, and pxpipe's HOST env
 * var permits a non-loopback bind. The dashboard already refuses non-loopback
 * callers; the proxy duty needs the same guard for the same reason.
 */
function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
  );
}

function stripPort(value: string): string {
  if (value.startsWith('[')) return value.slice(1, value.indexOf(']'));
  const i = value.lastIndexOf(':');
  return i > 0 ? value.slice(0, i) : value;
}

function splitHostPort(value: string, fallbackPort: string): { host: string; port: string } {
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    const rest = value.slice(end + 1);
    return { host: value.slice(1, end), port: rest.startsWith(':') ? rest.slice(1) : fallbackPort };
  }
  const i = value.lastIndexOf(':');
  if (i < 0) return { host: value, port: fallbackPort };
  return { host: value.slice(0, i), port: value.slice(i + 1) };
}

/** `host:port`, bracketing IPv6 literals so the result is URL-parseable. */
function authority(host: string, port: string): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

function forwardHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function pipeSockets(a: Socket, b: Socket): void {
  a.pipe(b);
  b.pipe(a);
  const destroy = () => {
    a.destroy();
    b.destroy();
  };
  a.on('error', destroy);
  b.on('error', destroy);
  a.on('close', () => b.destroy());
  b.on('close', () => a.destroy());
}

/**
 * Every request the agent makes crosses this hop. Node's global agents default
 * to keepAlive:false, so without these each call pays a fresh TCP handshake —
 * plus a full TLS handshake to the real host on the passthrough path.
 */
const httpAgent = new HttpAgent({ keepAlive: true });
const httpsAgent = new HttpsAgent({ keepAlive: true });

export function createWarpHandlers(options: WarpHandlerOptions): WarpHandlers {
  const { routes, ca, onDivert } = options;
  const announced = new Set<string>();

  /** Re-originate one request, to a route target or to the real host. */
  const forward = (
    req: IncomingMessage,
    res: ServerResponse,
    host: string,
    requestUri: string,
    // Where the bytes actually go when no route matches. Passed in rather than
    // rebuilt from `host`: a plain `http://host:8080` request reaching us in
    // absolute form must not be re-originated as `https://host:443`.
    origin: string,
  ) => {
    const path = requestUri.split('?')[0] ?? '/';
    const route = matchRoute(routes, host, path);

    const target = new URL(route ? rewriteUrl(route, requestUri) : `${origin}${requestUri}`);
    if (route && !announced.has(route.pattern)) {
      announced.add(route.pattern);
      onDivert?.(host, path, target.origin);
    }

    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const outbound = send({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: target.pathname + target.search,
      // Keep the agent's original Host: the downstream routes (and an upstream
      // may sign) on the vhost, not on wherever we happened to send the bytes.
      headers: forwardHeaders(req.headers),
      setHost: false,
      agent: target.protocol === 'https:' ? httpsAgent : httpAgent,
    });

    let upstreamRes: IncomingMessage | undefined;
    outbound.on('response', (upstream) => {
      upstreamRes = upstream;
      res.writeHead(upstream.statusCode ?? 502, forwardHeaders(upstream.headers));
      // Streamed, never buffered: /v1/messages is SSE and must arrive token by
      // token or the agent appears to hang until the response completes.
      upstream.pipe(res);
    });
    outbound.on('error', (err) => {
      // Our own teardown below surfaces here as ECONNRESET; the client is
      // already gone, so writing a 502 into it would throw.
      if (res.writableEnded || res.destroyed) return;
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`pxpipe warp: upstream error: ${err.message}`);
    });
    // An SSE completion only ends when the model stops. If the agent is killed
    // mid-stream nothing else cancels the upstream: the response keeps draining
    // into a dead socket, and the keepAlive agent later hands that same
    // half-consumed connection to the next request.
    res.on('close', () => {
      if (res.writableFinished) return;
      upstreamRes?.destroy();
      outbound.destroy();
    });
    req.pipe(outbound);
  };

  const handleDecrypted = (req: IncomingMessage, res: ServerResponse): void => {
    const servername = (req.socket as TLSSocket).servername || '';
    // A client that CONNECTed to a non-443 port repeats it in Host, which is
    // the only place the original port survives the hijack into mitmServer.
    const { host, port } = splitHostPort(req.headers.host || servername, '443');
    forward(req, res, host, req.url ?? '/', `https://${authority(host, port)}`);
  };

  /**
   * Upgrades always go to the real host, never to a route. Route targets speak
   * HTTP, and the control plane behind /remote-control pairing is exactly the
   * traffic that has to stay first-party, so this splices raw TLS instead of
   * re-originating through an HTTP client (which would drop the Upgrade and can
   * never produce a 101).
   */
  const handleUpgrade = (req: IncomingMessage, clientSocket: Socket, head: Buffer): void => {
    const servername = (req.socket as TLSSocket).servername || '';
    const { host, port } = splitHostPort(req.headers.host || servername, '443');
    const upstream = tlsConnect({ host, port: Number(port), servername: host }, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (const [key, value] of Object.entries(req.headers)) {
        for (const v of Array.isArray(value) ? value : [value]) {
          if (v !== undefined) lines.push(`${key}: ${v}`);
        }
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      pipeSockets(clientSocket, upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  };

  // Forcing http/1.1 via ALPN keeps the decrypted stream parseable by
  // http.Server; without it Node negotiates h2 and the request handler never
  // fires. This server never listens — it exists to be handed hijacked sockets.
  const mitmServer = createHttpsServer({
    SNICallback: (name, cb) => {
      try {
        cb(null, ca.secureContextFor(name));
      } catch (err) {
        cb(err as Error);
      }
    },
    ALPNProtocols: ['http/1.1'],
  });
  mitmServer.on('request', handleDecrypted);
  mitmServer.on('upgrade', handleUpgrade);
  mitmServer.on('clientError', (_err, socket) => socket.destroy());

  const handleConnect = (req: IncomingMessage, clientSocket: Socket, head: Buffer): void => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const { host, port } = splitHostPort(req.url ?? '', '443');

    if (!hostCouldMatch(routes, host)) {
      const upstream = netConnect({ host, port: Number(port) }, () => {
        clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
        if (head?.length) upstream.write(head);
        pipeSockets(clientSocket, upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
      return;
    }

    clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    if (head?.length) clientSocket.unshift(head);
    // Handing the raw socket to the TLS server lets Node do the handshake, the
    // HTTP parsing and the upgrade detection for us.
    mitmServer.emit('connection', clientSocket);
  };

  const handleAbsoluteForm = (req: IncomingMessage, res: ServerResponse): void => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('pxpipe warp: forward proxy is loopback-only');
      return;
    }
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('pxpipe warp: bad absolute URI');
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('pxpipe warp: unsupported scheme');
      return;
    }
    // target.origin, not a rebuilt https:// URL: scheme and non-default port
    // are part of where this request was actually going.
    forward(req, res, stripPort(target.host), target.pathname + target.search, target.origin);
  };

  return { handleConnect, handleAbsoluteForm };
}
