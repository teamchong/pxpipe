/**
 * Node entrypoint — `node:http` server + minimal CLI flag parsing.
 *
 * Wraps the runtime-agnostic `createProxy` from src/core/proxy.ts. The
 * heavy lifting (transform, render, PNG) is identical to the Worker
 * version; only the request/response plumbing differs.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createWarpRuntime } from './warp/index.js';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as os from 'node:os';
import { isIP } from 'node:net';
import { spawnSync } from 'node:child_process';
import { createProxy, parseGatewayHeaders, resolveUpstreams, type ProxyConfig } from './core/proxy.js';
import {
  chatCompletionsUrl,
} from './core/messages-chat-bridge.js';
import {
  parseExportArgv,
  runExportCore,
  type ExportParsed,
  type ExportResult,
} from './core/export.js';
import { readExportTextFile } from './export-collect.js';
import {
  toTrackEvent,
  TRACK_BODY_INLINE_MAX,
  type Tracker,
  type TrackEvent,
} from './core/tracker.js';
import {
  DashboardState,
  dashboardPath,
  type DashboardRoute,
} from './dashboard.js';
import { evaluateHealth } from './core/health.js';
import { HealthCounters } from './health-counters.js';
import { buildHealthReport, buildHealthState } from './health-state.js';
import { CodexUsageIndex } from './codex-usage.js';
import { acquireEventsFileLock, type EventsFileLock } from './events-lock.js';
import {
  modelScopeFile,
  loadPersistedModelScope,
  savePersistedModelScope,
  clearPersistedModelScope,
} from './model-scope-store.js';
import { setAllowedModelBases } from './core/applicability.js';

/** Runtime config. The core transform tuning comes from DEFAULTS in
 *  transform.ts; startup knobs cover deployment plus emergency GPT scope
 *  control. No CLI flags beyond --help/--version. */
interface RuntimeConfig {
  port: number;
  /** Interface to bind. Defaults to 127.0.0.1; non-loopback bindings expose
   *  only the proxy API because dashboard routes remain loopback-only. */
  host: string;
  upstream: string;
  openAIUpstream: string;
  openAIApiKey?: string;
  /** Independent Cloudflare OpenAI-compatible endpoint. */
  cloudflareUpstream?: string;
  cloudflareApiKey?: string;
  openAIModels?: string[];
  cloudflareModels?: string[];
  provider?: 'cloudflare-ai-gateway';
  gatewayBaseUrl?: string;
  gatewayHeaders?: Record<string, string>;
  eventsFile: string;
  /** Persist 4xx request and upstream error bodies for debugging. Off unless
   *  PXPIPE_DEBUG_CAPTURE_4XX=1. */
  captureErrorReqBody: boolean;
  /** Exact trusted proxy address for loopback-published dashboard traffic. */
  trustedDashboardProxy?: string;
  /** Public origins accepted for dashboard mutations behind a reverse proxy
   * (PXPIPE_DASHBOARD_ORIGINS, comma-separated). */
  dashboardOrigins?: readonly string[];
  /** Explicit acknowledgement that an external boundary (for example the
   * bundled Compose loopback port publication) protects a non-loopback bind
   * that injects server-owned upstream credentials. */
  allowNonLoopbackCredentials: boolean;
}

const DEFAULT_CONFIG_FILE = path.join(os.homedir(), '.config', 'pxpipe', 'config.json');

function normalizeModelsConfig(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const models = value.map((v) => String(v).trim()).filter(Boolean);
    return models.length > 0 ? models.join(',') : 'off';
  }
  if (typeof value === 'string') return value.trim() || 'off';
  return undefined;
}

function applyConfigFileDefaults(): void {
  const file = process.env.PXPIPE_CONFIG ?? DEFAULT_CONFIG_FILE;
  if (!fs.existsSync(file)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (e) {
    console.warn(`[pxpipe] ignored invalid config ${file}: ${(e as Error).message}`);
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const cfg = parsed as Record<string, unknown>;

  // Env wins over file config. The dashboard can still override the scope at
  // runtime (in-memory) for an emergency live flip.
  if (process.env.PXPIPE_MODELS === undefined) {
    const models = normalizeModelsConfig(cfg.models);
    if (models !== undefined) process.env.PXPIPE_MODELS = models;
  }
}

function parseCli(argv: string[]): RuntimeConfig {
  // Only flags accepted are --help and --version. Anything else is an
  // error — there is exactly ONE way to run pxpipe and the dashboard
  // exposes every metric the operator might want to inspect.
  for (const a of argv) {
    if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    }
    if (a === '--version') {
      printVersion();
      process.exit(0);
    }
    if (a.startsWith('-')) {
      console.error(`[pxpipe] unknown option: ${a}`);
      console.error(`[pxpipe] this build accepts no flags; run \`pxpipe --help\` for env vars`);
      process.exit(2);
    }
  }
  applyConfigFileDefaults();
  const sharedUpstream = process.env.PXPIPE_UPSTREAM;
  const cfAccount = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const cfToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const parseModels = (value: string | undefined): string[] | undefined => {
    if (value === undefined) return undefined;
    return value.split(',').map((model) => model.trim()).filter(Boolean);
  };
  const cloudflareUpstream = cfAccount && cfToken
    ? `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/ai/v1`
    : undefined;
  return {
    port: Number(process.env.PORT ?? 47821),
    // Loopback by default; opt into all-interfaces exposure explicitly via HOST.
    host: process.env.HOST?.trim() || '127.0.0.1',
    // Env-driven upstream URLs are .trim()-ed here (and again in
    // resolveUpstreams) to defend against whitespace sneaking in from the
    // surrounding shell. A stray space in OPENAI_UPSTREAM /
    // ANTHROPIC_UPSTREAM / PXPIPE_GATEWAY_BASE_URL — typically from a
    // cmd.exe `set VAR=...` line, a copy-paste with a trailing space, or a
    // shell-quoting bug in a launcher script — would otherwise build URLs
    // like "https://api.openai.com /v1/...". fetch() then throws
    // "Failed to parse URL" with no actionable log line and the operator
    // is left guessing. Trimming at the env boundary keeps the failure
    // mode loud (the proxy still returns 401/502 from upstream) instead
    // of silent.
    upstream: (process.env.ANTHROPIC_UPSTREAM ?? sharedUpstream ?? 'https://api.anthropic.com').trim(),
    openAIUpstream: (process.env.OPENAI_UPSTREAM ?? sharedUpstream ?? 'https://api.openai.com').trim(),
    openAIApiKey: process.env.OPENAI_API_KEY,
    cloudflareUpstream,
    cloudflareApiKey: cfToken,
    openAIModels: parseModels(process.env.OPENAI_MODELS),
    cloudflareModels: parseModels(process.env.CLOUDFLARE_MODELS),
    provider: parseProvider(process.env.PXPIPE_PROVIDER),
    gatewayBaseUrl: process.env.PXPIPE_GATEWAY_BASE_URL?.trim(),
    gatewayHeaders: parseGatewayHeaders(process.env.PXPIPE_GATEWAY_HEADERS),
    eventsFile:
      process.env.PXPIPE_LOG ??
      path.join(os.homedir(), '.pxpipe', 'events.jsonl'),
    // Off by default: either side of a 4xx may hold prompts or secrets.
    // Opt in for debugging only. (issue #69)
    captureErrorReqBody: process.env.PXPIPE_DEBUG_CAPTURE_4XX === '1',
    trustedDashboardProxy: process.env.PXPIPE_TRUSTED_DASHBOARD_PROXY?.trim() || undefined,
    dashboardOrigins: process.env.PXPIPE_DASHBOARD_ORIGINS
      ?.split(',').map((s) => s.trim()).filter(Boolean),
    allowNonLoopbackCredentials:
      process.env.PXPIPE_ALLOW_NON_LOOPBACK_CREDENTIALS === '1',
  };
}

function parseProvider(v: string | undefined): 'cloudflare-ai-gateway' | undefined {
  if (v === undefined || v === '') return undefined;
  if (v === 'cloudflare-ai-gateway') return v;
  console.error(`[pxpipe] unknown PXPIPE_PROVIDER: ${v}`);
  process.exit(2);
}

function printHelp(): void {
  console.log(`pxpipe — token-saving proxy for Claude Code

Usage:
  pxpipe                run the proxy (no flags)
  pxpipe export [...]   render files/diff to PNG pages + cost report (see pxpipe export --help)
  pxpipe warp -- CMD    run CMD behind the proxy without a custom base URL, so
                        client-side first-party gates (/remote-control,
                        claude.ai connectors) keep working

The proxy compresses eligible tools, schemas, reminders, tool_results,
and history; tracks events to disk; and measures real saved_pct via
/v1/messages/count_tokens. Dashboard controls can disable compression live.

Stats, sessions, and cleanup tools live in the dashboard at
  http://127.0.0.1:<port>/  (default port 47821)

Flags:
  -h, --help              show this help
      --version           show version

Environment:
  PORT                    listen port (default 47821)
  HOST                    interface to bind (default 127.0.0.1, loopback only).
                          Non-loopback bindings expose only the proxy API;
                          dashboard routes remain loopback-only.
  PXPIPE_UPSTREAM         upstream API base for every API family
  ANTHROPIC_UPSTREAM      Anthropic API base; overrides PXPIPE_UPSTREAM
                           (default https://api.anthropic.com)
  OPENAI_UPSTREAM         OpenAI API base; overrides PXPIPE_UPSTREAM
                           (default https://api.openai.com)
  OPENAI_API_KEY          optional OpenAI key override; otherwise forwarded
  OPENAI_MODELS           comma-separated exact model ids routed to OpenAI
                          Responses
  CLOUDFLARE_MODELS       comma-separated exact model ids routed to Cloudflare
  CLOUDFLARE_ACCOUNT_ID   with CLOUDFLARE_API_TOKEN, zero-config Cloudflare
  CLOUDFLARE_API_TOKEN    Workers AI endpoint and bearer token
  PXPIPE_PROVIDER         optional: 'cloudflare-ai-gateway' — route both API
                          families through one gateway base URL
  PXPIPE_GATEWAY_BASE_URL gateway base URL (required with PXPIPE_PROVIDER)
  PXPIPE_GATEWAY_HEADERS  extra upstream headers: JSON object or k=v;k2=v2
  PXPIPE_MODELS           comma-separated model bases to image (Claude/Gemini/GPT/Grok);
                          default claude-fable-5,gemini-3.6-flash (Sol/Opus/GPT-5.5/Grok opt-in);
                          off disables
  PXPIPE_CONFIG           JSON config path (default ~/.config/pxpipe/config.json)
                          supports {"models": [...]} or {"models": "off"}
  PXPIPE_LOG              JSONL events path (default ~/.pxpipe/events.jsonl)
  PXPIPE_LOG_MAX_MB       rotate the events file once it exceeds this size
                          (default 100)
  PXPIPE_LOG_KEEP         number of rotated generations to retain on disk,
                          .1 .. .N (default 1)
  PXPIPE_LOG_COMPRESS     set to 1 to gzip each rotated generation as
                          .1.gz, .2.gz, ...
  PXPIPE_LOG_FSYNC_MS     periodic fsync interval in ms; 0 = fsync only on
                          shutdown (default 0)
  PXPIPE_DUMP_DIR         debug: write every rendered PNG here (what the model
                          sees); off unless set. Compress arm only.
  PXPIPE_DEBUG_CAPTURE_4XX  debug: set to 1 to persist full 4xx request and
                          upstream error bodies (prompts + any secrets in
                          context) to disk. Off by default.
  PXPIPE_ALLOW_NON_LOOPBACK_CREDENTIALS
                          set to 1 only when an external access boundary protects
                          a non-loopback HOST (the bundled loopback-only Compose
                          publication sets this explicitly)
  PXPIPE_TRUSTED_DASHBOARD_PROXY
                          exact source address of a trusted reverse proxy in
                          front of the dashboard; such a request is allowed
                          without a loopback Host. Host validation stays
                          mandatory for every other source.
  PXPIPE_DASHBOARD_ORIGINS
                          comma-separated public origins accepted for dashboard
                          mutations behind that proxy (e.g.
                          https://pxpipe.example.com). Cross-site writes are
                          still rejected via Sec-Fetch-Site.

Use with Claude Code:
  ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude

Use with OpenAI-compatible GPT clients:
  OPENAI_BASE_URL=http://127.0.0.1:47821/v1
`);
}

// Package version, inlined at bundle time by scripts/build.mjs via esbuild
// `define`. Under a non-bundled dev runner (tsx) the identifier is not defined;
// `typeof` returns "undefined" instead of throwing (ECMA-262 §13.5.3), so the
// guard is safe. `npm_package_version` is only a dev fallback: npm sets it just
// inside its own run-script env, so for `npx pxpipe-proxy` or a global bin it is
// undefined (or reflects the *consumer's* package), never this tool's version.
declare const __PXPIPE_VERSION__: string | undefined;

function printVersion(): void {
  const injected = typeof __PXPIPE_VERSION__ === 'string' ? __PXPIPE_VERSION__ : undefined;
  console.log(injected ?? process.env.npm_package_version ?? 'unknown');
}

// ---- node:http <-> Web Request/Response bridge ---------------------------

function toWebRequest(req: IncomingMessage): Request {
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'http';
  const host = req.headers.host ?? 'localhost';
  const url = `${proto}://${host}${req.url ?? '/'}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((vv) => headers.append(k, vv));
    else headers.append(k, v);
  }

  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';

  // Buffer the body — proxy needs to read /v1/messages bodies fully anyway,
  // and Node's IncomingMessage → ReadableStream conversion has duplex quirks.
  let body: BodyInit | undefined;
  if (hasBody) {
    body = new ReadableStream<Uint8Array>({
      start(controller) {
        req.on('data', (chunk) => controller.enqueue(chunk));
        req.on('end', () => controller.close());
        req.on('error', (e) => controller.error(e));
      },
    });
  }

  return new Request(url, {
    method,
    headers,
    body,
    // @ts-expect-error — duplex is required for streamed request bodies in Node 18+
    duplex: hasBody ? 'half' : undefined,
  });
}

function isConnectionAbort(err: unknown): boolean {
  const e = err as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    cause?: { code?: unknown; message?: unknown };
  };
  const name = typeof e?.name === 'string' ? e.name : '';
  const code = typeof e?.code === 'string'
    ? e.code
    : typeof e?.cause?.code === 'string'
      ? e.cause.code
      : '';
  const message = typeof e?.message === 'string' ? e.message : '';
  const causeMessage = typeof e?.cause?.message === 'string' ? e.cause.message : '';
  return name === 'AbortError' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    message === 'client response closed' ||
    message === 'terminated' ||
    message.includes('aborted') ||
    causeMessage.includes('other side closed');
}

function waitForDrain(out: ServerResponse): Promise<void> {
  // Do NOT use Promise.race([once(out,'drain'), once(out,'close')]): the losing
  // once() never detaches its listener, and events.once() also attaches an
  // implicit 'error' listener. On a long streamed response every backpressure
  // cycle would then leak one 'close' + one 'error' listener on the same
  // ServerResponse, triggering MaxListenersExceededWarning, unbounded heap
  // growth, and eventually a silent OOM exit of the proxy. Manage the listeners
  // manually and remove all of them on whichever event fires first. 'error' must
  // be handled too: with no 'error' listener attached, an error emitted while we
  // wait would crash the process as an unhandled 'error' event.
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      out.off('drain', onDrain);
      out.off('close', onClose);
      out.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('client response closed'));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    out.once('drain', onDrain);
    out.once('close', onClose);
    out.once('error', onError);
  });
}

async function writeWebResponse(res: Response, out: ServerResponse): Promise<void> {
  out.statusCode = res.status;
  res.headers.forEach((v, k) => out.setHeader(k, v));
  if (!res.body) {
    out.end();
    return;
  }
  const reader = res.body.getReader();
  let finished = false;
  const cancelBody = () => {
    if (!finished) void reader.cancel().catch(() => undefined);
  };
  out.once('close', cancelBody);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && !out.write(value)) await waitForDrain(out);
    }
    if (!out.writableEnded) out.end();
  } catch (err) {
    if (isConnectionAbort(err) || out.destroyed || out.writableEnded) {
      if (!out.destroyed && !out.writableEnded) out.destroy(err instanceof Error ? err : undefined);
      return;
    }
    throw err;
  } finally {
    finished = true;
    out.off('close', cancelBody);
    reader.releaseLock();
  }
}

/** Read the entire request body as text. Bounded at 1 MiB — every dashboard
 *  POST is tiny JSON (a few hundred bytes). The cap is a defense against a
 *  pathological/malicious client; legitimate proxy traffic doesn't hit these
 *  routes. */
async function readRequestBody(req: IncomingMessage): Promise<string> {
  const MAX = 1024 * 1024;
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = chunk as Buffer;
    bytes += b.byteLength;
    if (bytes > MAX) throw new Error('request body too large');
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.')
    || address.startsWith('::ffff:127.');
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '[::1]' || host === '::1'
    || (isIP(host) === 4 && host.split('.')[0] === '127');
}

function isAllowedDashboardClient(
  address: string | undefined,
  hostname: string,
  trustedDashboardProxy: string | undefined,
): boolean {
  // A request from the explicitly configured trusted proxy has already passed
  // the operator's access boundary; requiring a loopback Host on top of that
  // only forces the proxy to forge one. Host validation stays mandatory for
  // every other source.
  if (trustedDashboardProxy && address === trustedDashboardProxy) return true;
  return isLoopbackHostname(hostname) && isLoopbackAddress(address);
}

function injectedCredentialSources(opts: RuntimeConfig): string[] {
  const sources: string[] = [];
  if (opts.openAIApiKey?.trim()) sources.push('OPENAI_API_KEY');
  if (opts.cloudflareApiKey?.trim()) sources.push('CLOUDFLARE_API_TOKEN');
  // Gateway headers are operator-controlled and their names are arbitrary;
  // treating only familiar auth names as sensitive would let a custom header
  // such as `x-upstream-credential` (or a neutral-looking quota key) bypass
  // the non-loopback guard.
  if (Object.keys(opts.gatewayHeaders ?? {}).length > 0) {
    sources.push('PXPIPE_GATEWAY_HEADERS');
  }
  return sources;
}

function assertCredentialInjectionIsLocal(opts: RuntimeConfig): void {
  // Bind hosts may be DNS names. Do not treat an arbitrary hostname beginning
  // with "127." as loopback: only validated 127/8 IP literals, ::1, and the
  // exact localhost name are local.
  const loopbackBind = isLoopbackHostname(opts.host);
  const sources = injectedCredentialSources(opts);
  if (loopbackBind || sources.length === 0 || opts.allowNonLoopbackCredentials) return;
  throw new Error(
    `refusing non-loopback HOST=${opts.host} with server-owned credentials from ` +
      `${sources.join(', ')}; bind HOST to loopback, or set ` +
      'PXPIPE_ALLOW_NON_LOOPBACK_CREDENTIALS=1 only when a trusted external access boundary is in place',
  );
}

function isDashboardMutation(route: DashboardRoute, method: string): boolean {
  return method === 'POST' && (
    route.kind === 'api-compression'
    || (route.kind === 'fragment' && (
      route.name === 'toggle' || route.name === 'models' || route.name === 'models/reset'
    ))
  );
}

/** Reject browser cross-site writes to the unauthenticated loopback dashboard. */
function isSameOriginDashboardRequest(
  req: IncomingMessage,
  url: URL,
  allowedOrigins: readonly string[] = [],
): boolean {
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true; // local CLI/curl clients do not send Origin
  try {
    const reqOrigin = new URL(origin).origin;
    // Same origin, or an operator-declared public origin for a reverse-proxied
    // dashboard (PXPIPE_DASHBOARD_ORIGINS).
    return reqOrigin === url.origin || allowedOrigins.includes(reqOrigin);
  } catch {
    return false;
  }
}

function ensurePrivateDirectory(dir: string): void {
  const existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existed) {
    fs.chmodSync(dir, 0o700);
  } else if ((fs.statSync(dir).mode & 0o077) !== 0) {
    throw new Error('directory is accessible by other users');
  }
}

/**
 * Dispatch a matched DashboardRoute to the appropriate handler. Returns
 * undefined when the method/route combination doesn't apply so the caller
 * can fall through to the upstream proxy (e.g. a GET path that's only
 * defined for POST). Keeps the createServer body small + readable.
 */
async function dispatchDashboard(
  dashboard: DashboardState,
  route: DashboardRoute,
  req: IncomingMessage,
  url: URL,
  port: number,
): Promise<Response | undefined> {
  const method = req.method ?? 'GET';
  switch (route.kind) {
    case 'html':
      if (method !== 'GET') return undefined;
      return dashboard.serveHtml(port);
    case 'stats':
      if (method !== 'GET') return undefined;
      return dashboard.serveStats();
    case 'recent':
      if (method !== 'GET') return undefined;
      return dashboard.serveRecent();
    case 'png': {
      if (method !== 'GET') return undefined;
      const idRaw = url.searchParams.get('id');
      const idNum = idRaw != null ? Number(idRaw) : NaN;
      return dashboard.servePng(Number.isFinite(idNum) ? idNum : undefined);
    }
    case 'api-image-source': {
      if (method !== 'GET') return undefined;
      const idRaw = url.searchParams.get('id');
      const idNum = idRaw != null ? Number(idRaw) : NaN;
      return dashboard.serveImageSource(Number.isFinite(idNum) ? idNum : undefined);
    }
    case 'api-sessions': {
      if (method !== 'GET') return undefined;
      return dashboard.serveSessionsJson({
        project: url.searchParams.get('project') ?? undefined,
        since: url.searchParams.get('since') ?? undefined,
      });
    }
    case 'api-stats':
      if (method !== 'GET') return undefined;
      return dashboard.serveApiStats();
    case 'current-session':
      if (method !== 'GET') return undefined;
      return dashboard.serveCurrentSessionJson();
    case 'fragment': {
      // /fragments/toggle is the one mutating fragment - htmx POSTs the next
      // state (urlencoded hx-vals or JSON), the server flips the switch and
      // returns the re-rendered toggle markup.
      if (route.name === 'toggle' && method === 'POST') {
        let enabled = false;
        try {
          const raw = await readRequestBody(req);
          try {
            enabled = (JSON.parse(raw) as { enabled?: unknown }).enabled === true;
          } catch {
            enabled = new URLSearchParams(raw).get('enabled') === 'true';
          }
        } catch {
          return new Response('bad request body', { status: 400 });
        }
        dashboard.handleCompressionToggle({ enabled });
        return dashboard.serveFragment('toggle', url, port);
      }
      // /fragments/models POSTs one chip flip {model, on}, or a whole-scope
      // rewrite {list: "csv"} from the PXPIPE_MODELS textbox. Server mutates
      // the runtime compress scope and returns the re-rendered rows.
      if (route.name === 'models' && method === 'POST') {
        let model = '';
        let on = false;
        let list: string | null = null;
        try {
          const raw = await readRequestBody(req);
          try {
            const j = JSON.parse(raw) as { model?: unknown; on?: unknown; list?: unknown };
            model = typeof j.model === 'string' ? j.model : '';
            on = j.on === true;
            if (typeof j.list === 'string') list = j.list;
          } catch {
            const p = new URLSearchParams(raw);
            model = p.get('model') ?? '';
            on = p.get('on') === 'true';
            list = p.get('list');
          }
        } catch {
          return new Response('bad request body', { status: 400 });
        }
        if (list !== null) dashboard.handleModelsSet(list);
        else if (model) dashboard.handleModelsToggle(model, on);
        return dashboard.serveFragment('models', url, port);
      }
      if (route.name === 'models/reset' && method === 'POST') {
        dashboard.handleModelsReset();
        return dashboard.serveFragment('models', url, port);
      }
      if (method !== 'GET') return undefined;
      return dashboard.serveFragment(route.name, url, port);
    }
    case 'api-compression': {
      if (method !== 'POST') {
        return new Response(
          JSON.stringify({ error: 'use POST' }),
          { status: 405, headers: { 'content-type': 'application/json' } },
        );
      }
      let body: Record<string, unknown> = {};
      try {
        const raw = await readRequestBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch (e) {
        return new Response(
          JSON.stringify({ error: 'bad request body', detail: (e as Error).message }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return dashboard.handleCompressionToggle({ enabled: body.enabled });
    }
  }
}

// ---- FileTracker ----------------------------------------------------------

/**
 * Append-only JSONL tracker with size-based rotation. One line per request.
 *
 * Node-only — uses node:fs. The Worker host uses tracker.JsonLogTracker with
 * console.log instead (Cloudflare ingests that as Workers Logs).
 *
 * Rotation: when the current file exceeds the configured max (default 100 MB
 * via PXPIPE_LOG_MAX_MB), the file is rotated out. By default a single .1
 * generation is kept (PXPIPE_LOG_KEEP=1); raise it to retain a chain .1, .2,
 * ... up to N. Set PXPIPE_LOG_COMPRESS=1 to gzip each rotated generation
 * (.1.gz, .2.gz, ...) so long-term retention costs less.
 *
 * Durability: by default fsync runs only on shutdown. Set
 * PXPIPE_LOG_FSYNC_MS to a positive interval (e.g. 500) to fsync on a
 * unref'd timer so a hard kill (SIGKILL / Windows TerminateProcess / power
 * loss) loses at most that many ms of writes. Cost is one fsync per tick.
 *
 * Failures here NEVER propagate — the proxy must keep serving requests even
 * if the disk is full or the path is unwritable.
 */
class FileTracker implements Tracker {
  // Defaults preserve the original hardcoded behavior. Override via
  // FileTracker.configure() from main() with env-driven values. Static so
  // existing tests that construct FileTracker directly keep working.
  private static config: {
    maxBytes: number;
    keep: number;
    compress: boolean;
    fsyncMs: number;
  } = {
    maxBytes: 100 * 1024 * 1024,
    keep: 1,
    compress: false,
    fsyncMs: 0,
  };

  /** Apply env-driven defaults from main(). Safe to call once at startup. */
  static configure(env: {
    maxMb?: number;
    keep?: number;
    compress?: boolean;
    fsyncMs?: number;
  }): void {
    if (typeof env.maxMb === 'number' && env.maxMb > 0) {
      FileTracker.config.maxBytes = Math.floor(env.maxMb * 1024 * 1024);
    }
    if (typeof env.keep === 'number' && env.keep >= 1) {
      FileTracker.config.keep = Math.floor(env.keep);
    }
    if (typeof env.compress === 'boolean') {
      FileTracker.config.compress = env.compress;
    }
    if (typeof env.fsyncMs === 'number' && env.fsyncMs >= 0) {
      FileTracker.config.fsyncMs = Math.floor(env.fsyncMs);
    }
  }

  private fd: number | null = null;
  private bytesWritten = 0;
  private brokenLogged = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly writerLock: EventsFileLock;

  constructor(private readonly filePath: string) {
    // Fail startup explicitly rather than allow two append fds whose rotations
    // and prune coordination could silently split or lose the log.
    this.writerLock = acquireEventsFileLock(filePath, 'writer');
    if (FileTracker.config.fsyncMs > 0) {
      // unref() so the timer never blocks process exit; flush() on a null fd
      // is a no-op so the tick is safe even after close().
      this.flushTimer = setInterval(() => this.flush(), FileTracker.config.fsyncMs);
      this.flushTimer.unref();
    }
  }

  private ensureOpen(): boolean {
    if (this.fd != null) return true;
    try {
      const parent = path.dirname(this.filePath);
      const parentExists = fs.existsSync(parent);
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      if (!parentExists) fs.chmodSync(parent, 0o700);
    } catch {
      /* dir may already exist or be unmkable; openSync below will surface */
    }
    try {
      const st = fs.statSync(this.filePath);
      this.bytesWritten = st.size;
    } catch {
      this.bytesWritten = 0;
    }
    try {
      this.fd = fs.openSync(this.filePath, 'a', 0o600);
      fs.chmodSync(this.filePath, 0o600);
      return true;
    } catch (err) {
      if (!this.brokenLogged) {
        console.error(
          `[pxpipe] FileTracker disabled — cannot open ${this.filePath}: ${(err as Error).message}`,
        );
        this.brokenLogged = true;
      }
      return false;
    }
  }

  private rotate(): void {
    if (this.fd != null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
    }

    const { keep, compress } = FileTracker.config;
    const ext = (n: number) => `.${n}${compress ? '.gz' : ''}`;

    // Cascade: shift .N -> .(N+1) until the cap. The oldest is dropped to
    // make room. With keep=1 this matches the original single-rename behavior.
    for (let n = keep; n >= 1; n--) {
      const oldName = this.filePath + ext(n);
      if (n === keep) {
        try {
          fs.unlinkSync(oldName);
        } catch {
          /* may not exist on first rotation */
        }
        continue;
      }
      const newName = this.filePath + ext(n + 1);
      try {
        fs.renameSync(oldName, newName);
      } catch {
        /* oldName may not exist; ignore */
      }
    }

    // Move current -> .1 (or .1.gz). On a compression failure fall back to a
    // plain rename so we never drop events on disk.
    const target = this.filePath + ext(1);
    if (compress) {
      try {
        const data = fs.readFileSync(this.filePath);
        const gz = zlib.gzipSync(data, { level: zlib.constants.Z_BEST_SPEED });
        fs.writeFileSync(target, gz, { mode: 0o600 });
        fs.unlinkSync(this.filePath);
      } catch {
        try {
          fs.renameSync(this.filePath, this.filePath + '.1');
        } catch {
          /* keep growing */
        }
      }
    } else {
      try {
        fs.renameSync(this.filePath, this.filePath + '.1');
      } catch {
        /* if rename fails (e.g. .1 locked) we'll just keep growing — better
           than dropping events */
      }
    }

    this.bytesWritten = 0;
  }

  emit(ev: TrackEvent): void {
    if (!this.ensureOpen()) return;
    try {
      const line = JSON.stringify(ev) + '\n';
      const buf = Buffer.from(line, 'utf8');
      fs.writeSync(this.fd!, buf);
      this.bytesWritten += buf.length;
      if (this.bytesWritten > FileTracker.config.maxBytes) this.rotate();
    } catch (err) {
      if (!this.brokenLogged) {
        console.error(
          `[pxpipe] FileTracker write failed: ${(err as Error).message}`,
        );
        this.brokenLogged = true;
      }
    }
  }

  flush(): void {
    if (this.fd != null) {
      try {
        fs.fsyncSync(this.fd);
      } catch {
        /* ignore */
      }
    }
  }

  close(): void {
    if (this.flushTimer != null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.fd != null) {
      try {
        fs.fsyncSync(this.fd);
      } catch {
        /* ignore */
      }
      try {
        fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
    }
    this.writerLock.release();
  }
}

// ---- 4xx body sidecar writer ---------------------------------------------

/**
 * For oversized 4xx body samples that won't fit inline in the JSONL row, we
 * write them to a sidecar file at `<dir>/${ts}-${sha8}.json.gz`. The path
 * lands in the event as `req_body_sample_path`. Survives log rotation and
 * stays out of the streaming dashboard.
 *
 * Failure mode: directory unwritable or write fails → returns undefined and
 * the body sample is silently dropped (we still keep the sha8 and error_body
 * for diagnostics; the request itself was never blocked by this).
 */
async function maybeWriteBodySidecar(
  bytesGz: Uint8Array,
  sha8: string | undefined,
  dir: string,
): Promise<string | undefined> {
  try {
    // Lazy mkdir — only when we actually need to write.
    ensurePrivateDirectory(dir);
  } catch {
    return undefined;
  }
  // Filename: timestamp + sha8 keeps collisions effectively impossible and
  // makes the file naturally sortable. Sha8 fallback covers the edge case
  // where the hash wasn't computed (zero-byte body, etc.).
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const tag = sha8 ?? 'nohash';
  const filePath = path.join(dir, `${ts}-${tag}.json.gz`);
  try {
    await fs.promises.writeFile(filePath, bytesGz, { mode: 0o600 });
    await fs.promises.chmod(filePath, 0o600);
    return filePath;
  } catch {
    return undefined;
  }
}

// ---- pxpipe export -------------------------------------------------------

function printExportHelp(): void {
  console.log(`pxpipe export — render code/text to PNG pages for compressed LLM context

Usage:
  pxpipe export [target ...]    default target is "." (current directory)

Targets:
  Files or directories to include. Multiple targets are joined with a header
  separator line. Defaults to "." when none are given.

Options:
  --include <glob>   include only files matching glob (repeatable)
  --exclude <glob>   exclude files matching glob (repeatable)
  --git              render "git diff HEAD" plus untracked files
  --diff <ref>       render "git diff <ref>"
  --stdin            read source text from stdin instead of files
  --out <dir>        base output directory (default \$TMPDIR or /tmp)
  --model <id>       model id for vision-token estimate (default claude-sonnet-4-5)
  --json             print report as JSON
  --open             reveal the output folder when done (macOS) so you can
                     drag the PNG pages straight into your chat
  -h, --help         show this help

Output:
  <out>/pxpipe-export-<hash>/
    page-001.png ...  rendered image pages
    factsheet.txt     verbatim precision tokens (paths, SHAs, ids, numbers)
    manifest.json     metadata + token report
    prompt.txt        paste-ready agent instruction referencing the images

Report columns:
  text tokens   approximate tokens if the source were sent as plain text
  image tokens  estimated tokens to send the rendered PNG pages
  % saved       (text − image) / text × 100

Examples:
  pxpipe export .                              # whole directory
  pxpipe export --include "*.ts" src/          # TypeScript files only
  pxpipe export --git                          # uncommitted changes
  pxpipe export --diff HEAD~3                  # last 3 commits
  pxpipe export --open src/                    # render src/, then reveal the folder
  cat big-file.txt | pxpipe export --stdin
`);
}

/** Directories never descended into when walking files. */
const WALK_SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build',
  '__pycache__', '.cache', '.next', '.nuxt', '.turbo',
]);

interface CollectedFile {
  relPath: string;
  content: string;
}

/** Recursively walk a directory, collecting text files that pass include/exclude filters. */
function walkDir(
  dir: string,
  rootDir: string,
  include: string[],
  exclude: string[],
  out: CollectedFile[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(rootDir, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (WALK_SKIP_DIRS.has(entry.name)) continue;
      walkDir(full, rootDir, include, exclude, out);
    } else if (entry.isFile()) {
      // Bulk directory walk: skip silently on any gate miss (per-file warnings
      // would be noise across a whole tree).
      const r = readExportTextFile(full, rel, include, exclude);
      if (r.kind === 'ok') out.push({ relPath: rel, content: r.content });
    }
  }
}

/** Collect files from a list of targets (files or directories). */
function collectFilesFromTargets(
  targets: string[],
  include: string[],
  exclude: string[],
): CollectedFile[] {
  const files: CollectedFile[] = [];
  for (const target of targets) {
    let st: fs.Stats;
    try { st = fs.statSync(target); } catch {
      console.warn(`[pxpipe export] skipping inaccessible target: ${target}`);
      continue;
    }
    if (st.isDirectory()) {
      walkDir(target, target, include, exclude, files);
    } else if (st.isFile()) {
      const rel = path.basename(target);
      const r = readExportTextFile(target, rel, include, exclude);
      if (r.kind === 'ok') files.push({ relPath: rel, content: r.content });
      else if (r.kind !== 'excluded') {
        console.warn(`[pxpipe export] skipping ${r.kind} file: ${target}`);
      }
    }
  }
  return files;
}

/** Run a git command in `cwd`, return stdout string or null on failure. */
function gitRun(args: string[], cwd: string): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0 || result.error) return null;
  return result.stdout ?? null;
}

/** Collect source text for the export run. Returns [sourceText, sourceFiles[]] */
async function collectSource(opts: ExportParsed): Promise<[string, string[]]> {
  // --stdin
  if (opts.stdin) {
    const chunks: string[] = [];
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      if (typeof chunk === 'string') chunks.push(chunk);
    }
    return [chunks.join(''), []];
  }

  // --diff <ref>
  if (opts.diff !== undefined) {
    const cwd = opts.targets.length > 0 ? opts.targets[0]! : process.cwd();
    const diff = gitRun(['diff', opts.diff], cwd);
    if (diff === null) {
      console.error(`[pxpipe export] git diff ${opts.diff} failed`);
      process.exit(1);
    }
    return [diff, []];
  }

  // --git
  if (opts.git) {
    const cwd = opts.targets.length > 0 ? opts.targets[0]! : process.cwd();
    const diff = gitRun(['diff', 'HEAD'], cwd) ?? '';
    // Collect untracked files
    const untrackedOut = gitRun(['ls-files', '--others', '--exclude-standard'], cwd) ?? '';
    const untrackedFiles = untrackedOut
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    let untracked = '';
    for (const rel of untrackedFiles) {
      const full = path.join(cwd, rel);
      // Same include/exclude + size + binary gate as directory mode. Untracked
      // files previously bypassed all of it: --include/--exclude were ignored
      // and an oversized file was read fully into memory.
      const r = readExportTextFile(full, rel, opts.include, opts.exclude);
      if (r.kind === 'ok') untracked += `\n===== ${rel} =====\n` + r.content;
      else if (r.kind !== 'excluded') {
        console.warn(`[pxpipe export] skipping ${r.kind} untracked file: ${rel}`);
      }
    }
    const sourceText = diff + untracked;
    return [sourceText, []];
  }

  // File/directory mode (default)
  const targets = opts.targets.length > 0 ? opts.targets : ['.'];
  const files = collectFilesFromTargets(targets, opts.include, opts.exclude);
  if (files.length === 0) {
    console.warn('[pxpipe export] no files collected');
  }
  const sourceText = files
    .map((f) => `===== ${f.relPath} =====\n${f.content}`)
    .join('\n\n');
  const sourceFiles = files.map((f) => f.relPath);
  return [sourceText, sourceFiles];
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function printExportReport(opts: ExportParsed, outDir: string, sourceFiles: string[], result: ExportResult): void {
  const { manifest } = result;
  const { tokenReport, pages } = manifest;
  const totalPngBytes = pages.reduce((s, p) => s + p.bytes, 0);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({
        outDir,
        fileCount: sourceFiles.length,
        sourceChars: manifest.sourceChars,
        pageCount: pages.length,
        totalPngBytes,
        textTokens: tokenReport.textTokens,
        imageTokens: tokenReport.imageTokens,
        percentSaved: tokenReport.percentSaved,
        factsheetItemCount: tokenReport.factsheetItemCount,
        factsheetDropped: tokenReport.factsheetDropped,
        model: manifest.model,
        cols: manifest.cols,
        generatedAt: manifest.generatedAt,
      }) + '\n',
    );
    return;
  }

  const saved = tokenReport.percentSaved;
  const savedStr = saved >= 0 ? `${saved.toFixed(1)}% saved` : `${Math.abs(saved).toFixed(1)}% more expensive`;
  const droppedNote = tokenReport.factsheetDropped > 0
    ? ` (${tokenReport.factsheetDropped} dropped)`
    : '';
  console.log(
    `\npxpipe export\n` +
    `  out:            ${outDir}\n` +
    `  files:          ${formatNumber(sourceFiles.length)}\n` +
    `  source chars:   ${formatNumber(manifest.sourceChars)}\n` +
    `  pages:          ${pages.length} (${formatNumber(totalPngBytes)} bytes)\n` +
    `  text tokens:    ~${formatNumber(tokenReport.textTokens)}\n` +
    `  image tokens:   ~${formatNumber(tokenReport.imageTokens)}  (${savedStr})\n` +
    `  factsheet:      ${tokenReport.factsheetItemCount} items${droppedNote}\n`,
  );
  console.log(
    `next — get this into your chat:\n` +
    `  1. attach the ${pages.length} page-*.png file${pages.length === 1 ? '' : 's'} from that folder\n` +
    `  2. paste prompt.txt alongside them (it tells the model what the images are)\n` +
    `     factsheet.txt has the verbatim paths / ids / numbers if you need exact strings\n` +
    (opts.open ? `  opening the folder…\n` : `  tip: add --open to reveal the folder automatically\n`),
  );
}

async function runExport(argv: string[]): Promise<void> {
  const parseResult = parseExportArgv(argv);

  if (parseResult.kind === 'help') {
    printExportHelp();
    process.exit(0);
  }
  if (parseResult.kind === 'error') {
    console.error(`[pxpipe export] ${parseResult.message}`);
    console.error(`[pxpipe export] run \`pxpipe export --help\` for usage`);
    process.exit(2);
  }

  const opts = parseResult.parsed;

  // Collect source text
  const [sourceText, sourceFiles] = await collectSource(opts);

  // Unique output dir: <out>/pxpipe-export-XXXXXX/. mkdtemp guarantees a fresh, random
  // directory so concurrent runs never collide and stale page-NNN.png never bleed in.
  fs.mkdirSync(opts.out, { recursive: true });
  const outDir = fs.mkdtempSync(path.join(opts.out, 'pxpipe-export-'));

  // Run core export
  const result = await runExportCore(sourceText, {
    sourceFiles,
    cols: opts.cols,
    model: opts.model,
  });

  // Write artifacts
  for (const artifact of result.artifacts) {
    fs.writeFileSync(path.join(outDir, artifact.filename), artifact.data);
  }

  // Print report
  printExportReport(opts, outDir, sourceFiles, result);

  // --open: reveal the output folder (macOS `open`) so the PNG pages can be
  // dragged straight into a chat. Best-effort; a failed open is non-fatal
  // since the report already printed the path.
  if (opts.open) {
    spawnSync('open', [outDir], { stdio: 'ignore' });
  }
}

// ---- main ----------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'export') {
    await runExport(argv.slice(1));
    return; // server never starts
  }
  // `warp` runs an agent behind a CONNECT proxy and redirects its inference
  // traffic into the pxpipe already running. It starts no proxy of its own, so
  // it exits through its own branch below rather than falling through here.
  let warpCommand: string[] | undefined;
  let cliArgv = argv;
  if (argv[0] === 'warp') {
    const sep = argv.indexOf('--');
    warpCommand = sep < 0 ? [] : argv.slice(sep + 1);
    cliArgv = argv.slice(1, sep < 0 ? argv.length : sep);
  }
  // Stats / sessions / cleanup tools live in the dashboard
  // (see http://127.0.0.1:${port}/).
  const opts = parseCli(cliArgv);

  // warp only redirects traffic: it decrypts the agent's TLS and re-points the
  // inference path at the pxpipe you already have running, so that instance
  // does the transforming, the tracking and the dashboard. Everything below —
  // tracker, proxy pipeline, listener — belongs to that instance, not to us.
  if (warpCommand) {
    createWarpRuntime({ port: opts.port }).launch(warpCommand);
    return;
  }
  // A non-loopback unauthenticated proxy plus a server-owned upstream key lets
  // any reachable client spend that credential. Docker binds 0.0.0.0 only
  // inside its network namespace and explicitly acknowledges the host-side
  // loopback publication in compose.yml; other deployments must fail closed.
  assertCredentialInjectionIsLocal(opts);
  // A/B harness passthrough switch (see the `transform` callback below).
  const forcePassthrough = /^(1|true|yes|on)$/i.test(process.env.PXPIPE_DISABLE ?? '');
  if (forcePassthrough) {
    console.log('[pxpipe] PXPIPE_DISABLE set — passthrough mode (compress=false), still logging usage + baselines');
  }
  // Debug aid: when PXPIPE_DUMP_DIR is set, persist every rendered PNG this
  // process emits, so you can eyeball exactly what the model received (OCR /
  // legibility audits, demo inspection). Best-effort — never affects requests.
  // Note: the PXPIPE_DISABLE arm renders nothing, so only the compress proxy
  // produces files here.
  let imageDumpDir: string | undefined = process.env.PXPIPE_DUMP_DIR?.trim() || undefined;
  let imageDumpSeq = 0;
  if (imageDumpDir) {
    try {
      ensurePrivateDirectory(imageDumpDir);
      console.log(`[pxpipe] PXPIPE_DUMP_DIR set — dumping rendered PNGs to ${imageDumpDir}`);
    } catch (err) {
      console.warn(`[pxpipe] PXPIPE_DUMP_DIR unusable (${(err as Error).message}) — image dumping disabled`);
      imageDumpDir = undefined;
    }
  }
  // Transform options pass through empty — the proxy uses the DEFAULTS
  // baked into transform.ts. There are no behavior toggles: system slab,
  // reminders, tool_results, and history compression all run
  // unconditionally; the per-block break-even gate decides per-call
  // whether to actually image each piece. The function-form `transform`
  // below is ONLY a kill switch (PXPIPE_DISABLE / dashboard toggle →
  // compress:false); on the active path it returns {}, so the gate always
  // runs on static DEFAULTS — charsPerToken=4, priorWarm*=0 — which leaves
  // the warm-baseline and anti-flapping burn terms inert. That is
  // deliberate, NOT an oversight: there is no live-α feedback loop from
  // the dashboard. Telemetry (2026-06, 897 sessions / 21,347 measured
  // rows) showed 5 mode flips ever and losses at 0.8% of wins — all
  // one-time cache-create amortization — so closing the loop would not
  // change decisions. Re-run that reconciliation before wiring one in.
  // FileTracker knobs read straight from env. Defaults inside the class
  // match the previous hardcoded behavior (100 MB, keep 1, no compression,
  // fsync only on shutdown) so this is a no-op when the env vars are unset.
  FileTracker.configure({
    maxMb: Number(process.env.PXPIPE_LOG_MAX_MB) || undefined,
    keep: Number(process.env.PXPIPE_LOG_KEEP) || undefined,
    compress: process.env.PXPIPE_LOG_COMPRESS === '1',
    fsyncMs: Number(process.env.PXPIPE_LOG_FSYNC_MS) || undefined,
  });
  const tracker: Tracker = new FileTracker(opts.eventsFile);

  // Sidecar dir for oversized 4xx request-body samples. Lives next to the
  // events.jsonl so a single `rm -rf` cleans up both. Lazy-mkdir'd on first
  // sidecar write (see maybeWriteBodySidecar).
  const bodySidecarDir = path.join(path.dirname(opts.eventsFile), '4xx-bodies');

  // Live dashboard state — populated on every request via onRequest below,
  // served via the route interception in front of the proxy handler. The
  // SessionsPaths handle lets the dashboard surface session/disk/stats data
  // without reaching back into module-scope globals.
  const codexUsage = new CodexUsageIndex();
  codexUsage.start();
  // A dashboard choice is an explicit operator override: it takes precedence
  // over PXPIPE_MODELS and survives launcher restarts. Reset deletes only this
  // sidecar, preserving any deliberately configured PXPIPE_CONFIG defaults.
  const scopeFile = modelScopeFile(opts.eventsFile);
  const persistedScope = loadPersistedModelScope(scopeFile);
  if (persistedScope !== null) setAllowedModelBases(persistedScope);
  const dashboard = new DashboardState(
    {
      eventsFile: opts.eventsFile,
      sidecarDir: bodySidecarDir,
    },
    undefined,
    (bases) => {
      if (bases === null) clearPersistedModelScope(scopeFile);
      else savePersistedModelScope(scopeFile, bases);
    },
    () => codexUsage.snapshot(),
  );
  // Rolling counter of recent /backend-api/codex/* traffic, feeding the
  // evidence-driven Codex-upstream health check (see /healthz below).
  const healthCounters = new HealthCounters();
  // Seed the "recent requests" table from the JSONL log so a process restart
  // doesn't reset what you can see in the UI. Best-effort; ignored on error.
  await dashboard.replay(opts.eventsFile).catch(() => {});

  const config: ProxyConfig = {
    provider: opts.provider,
    gatewayBaseUrl: opts.gatewayBaseUrl,
    gatewayHeaders: opts.gatewayHeaders,
    upstream: opts.upstream,
    openAIUpstream: opts.openAIUpstream,
    openAIApiKey: opts.openAIApiKey,
    cloudflareUpstream: opts.cloudflareUpstream,
    cloudflareApiKey: opts.cloudflareApiKey,
    openAIModels: opts.openAIModels,
    cloudflareModels: opts.cloudflareModels,
    captureErrorReqBody: opts.captureErrorReqBody,
    // Per-request transform options:
    //   1. Runtime kill switch — when the dashboard "passthrough" toggle
    //      is off, force compress=false so /v1/messages forwards
    //      untransformed. Lets the operator instantly disable the proxy
    //      when upstream is unhealthy without restarting.
    //   2. Otherwise use DEFAULTS in transform.ts for break-even gating.
    transform: () => {
      // A/B harness: PXPIPE_DISABLE=1 forces passthrough (compress=false) for the
      // whole process, so the "normal" arm can be scripted on its own port while
      // still logging real usage + count_tokens baselines to its own PXPIPE_LOG.
      // (The dashboard kill switch does the same thing at runtime.)
      if (forcePassthrough || !dashboard.getCompressionEnabled()) return { compress: false };
      // Active path: use DEFAULTS in transform.ts for break-even gating.
      return {};
    },
    onRequest: async (e) => {
      // Feed the health counter first — cheap and must never be skipped by an
      // early return further down. Best-effort; never throw into onRequest.
      try {
        healthCounters.record(e.path, e.status, Date.now());
      } catch {
        /* ignore */
      }
      // Feed the dashboard BEFORE tracker.emit — toTrackEvent strips
      // info.firstImagePng, so capturing has to happen on the raw event.
      dashboard.update(e);
      // Debug: persist this request's rendered PNGs (see PXPIPE_DUMP_DIR above).
      // Filenames sort by request order: <stamp>_reqNNN_<model>_pNN.png.
      if (imageDumpDir && e.info?.imagePngs && e.info.imagePngs.length > 0) {
        const seq = ++imageDumpSeq;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const modelTag = (e.model ?? 'model').replace(/[^A-Za-z0-9._-]+/g, '_');
        const pngs = e.info.imagePngs;
        for (let i = 0; i < pngs.length; i++) {
          const name = `${stamp}_req${String(seq).padStart(3, '0')}_${modelTag}_p${String(i + 1).padStart(2, '0')}.png`;
          try {
            fs.writeFileSync(path.join(imageDumpDir, name), pngs[i]!, { mode: 0o600 });
          } catch (err) {
            console.warn(`[pxpipe] PNG dump write failed: ${(err as Error).message}`);
            break; // dir vanished / full — stop hammering it this request
          }
        }
        console.log(`  ↳ dumped ${pngs.length} rendered png(s) → ${imageDumpDir}`);
      }
      // Terse human-readable console line.
      const extra: string[] = [];
      if (e.info?.toolResultImgs) extra.push(`tr+${e.info.toolResultImgs}`);
      const extraTag = extra.length > 0 ? ` (${extra.join(' ')})` : '';
      const tag = e.info?.compressed
        ? `compressed ${e.info.origChars}ch → ${e.info.imageCount}img/${e.info.imageBytes}B${extraTag}`
        : e.info?.reason
          ? e.info.reason === 'unsupported_model' && e.model
            ? `skip(unsupported=${e.model})`
            : `skip(${e.info.reason})`
          : '';
      const cacheRead = e.usage?.cache_read_input_tokens ?? 0;
      const inputTokens = e.usage?.input_tokens ?? 0;
      const usageTag =
        e.usage !== undefined
          ? ` tokens=${inputTokens}+${e.usage.output_tokens ?? 0} cache_read=${cacheRead}`
          : '';
      console.log(
        `[${new Date().toISOString()}] ${e.method} ${e.path} → ${e.status} (${e.durationMs}ms) ${tag}${usageTag}`,
      );

      // Upstream error bodies are present only under PXPIPE_DEBUG_CAPTURE_4XX;
      // custom gateways may echo prompt fragments or credentials in them.
      if (e.errorBody) {
        const trimmed = e.errorBody.length > 400
          ? e.errorBody.slice(0, 400) + '…'
          : e.errorBody;
        console.warn(`[pxpipe ${e.status}] upstream body: ${trimmed}`);
      }

      // Canary: surface unknown tag-shaped blocks so a Claude Code release
      // that adds a new dynamic tag is caught within hours.
      if (e.info?.unknownStaticTags && e.info.unknownStaticTags.length > 0) {
        console.warn(
          `[pxpipe warn] unknown tag(s) in static slab: ${e.info.unknownStaticTags.join(', ')}  ` +
            `— may need to add to DYNAMIC_BLOCK_TAGS (per-turn) or KNOWN_STATIC_TAGS (static) in src/core/transform.ts`,
        );
      }

      // If the proxy captured a gzipped 4xx body that won't fit inline in
      // the JSONL row, write it to a sidecar file and put the path on the
      // event instead. Threshold: gz_bytes * 4/3 > inline cap (b64 expansion).
      if (e.reqBodyGz && e.reqBodyGz.byteLength * 4 > TRACK_BODY_INLINE_MAX * 3) {
        const writtenPath = await maybeWriteBodySidecar(
          e.reqBodyGz,
          e.reqBodySha8,
          bodySidecarDir,
        );
        if (writtenPath) {
          e.reqBodySamplePath = writtenPath;
          e.reqBodyGz = undefined; // tracker will pick up the path instead
        }
        // If write failed: leave reqBodyGz; the tracker will silently drop
        // it (still too big to inline). We never lose the sha8 / error_body.
      }

      // Persistent JSONL event for offline analysis (pxpipe stats etc.).
      tracker.emit(toTrackEvent(e));
    },
  };
  const handle = createProxy(config);

  const server = createServer((req, res) => {
    Promise.resolve()
      .then(async () => {
        // Local dashboard routes — handled BEFORE the proxy so they never hit
        // api.anthropic.com (which would 404 them).
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        // Health endpoints — host-level (compose config + counters + dashboard),
        // handled before the dashboard router. A failure in the diagnostics
        // themselves is unhealthy: probes must not silently fail open.
        if (url.pathname === '/healthz' || url.pathname === '/api/health.json') {
          if (!isAllowedDashboardClient(req.socket.remoteAddress, url.hostname, opts.trustedDashboardProxy)) {
            await writeWebResponse(new Response('health endpoint is loopback-only', { status: 403 }), res);
            return;
          }
          const report = buildHealthReport(config, dashboard, healthCounters, Date.now());
          const payload = JSON.stringify({
            ok: report.ok,
            findings: report.findings,
            state: report.state,
          }, null, 2);
          const status = url.pathname === '/healthz' ? report.httpStatus : 200;
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(payload);
          return;
        }
        const route = dashboardPath(url.pathname);
        if (route) {
          if (!isAllowedDashboardClient(req.socket.remoteAddress, url.hostname, opts.trustedDashboardProxy)) {
            await writeWebResponse(new Response('dashboard is loopback-only', { status: 403 }), res);
            return;
          }
          if (isDashboardMutation(route, req.method ?? 'GET')
            && !isSameOriginDashboardRequest(req, url, opts.dashboardOrigins)) {
            await writeWebResponse(new Response('cross-origin dashboard mutation denied', { status: 403 }), res);
            return;
          }
          const webRes = await dispatchDashboard(dashboard, route, req, url, opts.port);
          if (webRes) {
            await writeWebResponse(webRes, res);
            return;
          }
        }
        const webReq = toWebRequest(req);
        const webRes = await handle(webReq);
        await writeWebResponse(webRes, res);
      })
      .catch((err) => {
        if (isConnectionAbort(err) && (req.aborted || res.destroyed)) return;
        console.error('[pxpipe] handler error:', err);
        if (!res.headersSent) res.statusCode = 500;
        if (!res.writableEnded) res.end();
      });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[pxpipe] ⛔ port ${opts.port} is already in use — another pxpipe (or process) is bound to ${opts.host}:${opts.port}.`);
      console.error(`[pxpipe]    Find it:  Get-NetTCPConnection -LocalPort ${opts.port} -State Listen | Select-Object OwningProcess`);
      console.error(`[pxpipe]    Stop it:  Stop-Process -Id <PID> -Force`);
      console.error(`[pxpipe]    Then re-run the launcher.`);
    } else {
      console.error(`[pxpipe] server error: ${err.message}`);
    }
    process.exit(1);
  });

  // IPv6 literals need bracket notation to form a valid URL (http://[::1]:47821).
  const displayHost = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
  const isLoopbackHost =
    opts.host === '127.0.0.1' || opts.host === 'localhost' || opts.host === '::1';
  const announce = () => {
    const routes = resolveUpstreams(config);
    console.log(`[pxpipe] anthropic upstream → ${routes.anthropic}`);
    console.log(`[pxpipe] openai upstream → ${routes.openai}`);
    if (opts.cloudflareUpstream !== undefined) {
      console.log(
        `[pxpipe] cloudflare upstream → ${chatCompletionsUrl(opts.cloudflareUpstream)} ` +
          `(models: ${opts.cloudflareModels?.join(', ') || 'none'})`,
      );
    }
    console.log(`[pxpipe] tracking events → ${opts.eventsFile}`);
    if (opts.captureErrorReqBody) {
      console.warn(
        `[pxpipe] PXPIPE_DEBUG_CAPTURE_4XX=1 — persisting full 4xx request and ` +
          `upstream error bodies (prompts + any secrets in context) to ${bodySidecarDir}. ` +
          `Debugging only.`,
      );
    }
  };

  server.listen(opts.port, opts.host, () => {
    console.log(`[pxpipe] listening on http://${displayHost}:${opts.port}`);
    if (!isLoopbackHost) {
      console.warn(
        `[pxpipe] bound to ${opts.host}; proxy API is reachable off-host, ` +
          `but dashboard and health routes remain loopback-only.`,
      );
    }
    announce();
    console.log(`[pxpipe] dashboard → http://127.0.0.1:${opts.port}/`);
    try {
      const findings = evaluateHealth(buildHealthState(config, dashboard, healthCounters, Date.now()));
      for (const f of findings) {
        if (f.severity !== 'error' && f.severity !== 'warn') continue;
        const mark = f.severity === 'error' ? '⛔' : '⚠️';
        console.warn(`[pxpipe] ${mark} ${f.title}`);
        console.warn(`[pxpipe]    ${f.detail}`);
        if (f.remediation) console.warn(`[pxpipe]    fix: ${f.remediation.durableHint}`);
      }
    } catch {
      /* never block startup on a health-print failure */
    }
  });

  // server.close() only stops accepting new connections and waits for open
  // ones to drain — it does NOT end idle keep-alive sockets. The dashboard tab
  // (htmx polls every 2s) and the Claude Code client both hold keep-alive
  // sockets open, so a naive close() never fires its callback and the first
  // Ctrl+C appears to hang. We drop idle sockets immediately, force-close any
  // in-flight ones after a short grace period, and let a second signal exit now.
  let shuttingDown = false;
  const shutdown = (sig: string) => {
    if (shuttingDown) {
      console.log(`[pxpipe] ${sig} again — forcing exit`);
      process.exit(130);
    }
    shuttingDown = true;
    console.log(`[pxpipe] ${sig} — shutting down`);
    codexUsage.stop();
    // Flush+close the tracker so we don't drop the last few events on exit.
    if (tracker instanceof FileTracker) tracker.close();
    server.close(() => process.exit(0));
    // Drop idle keep-alive sockets so close()'s callback can actually fire.
    server.closeIdleConnections?.();
    // Hard deadline: if a streaming /v1/messages response (or slow upstream)
    // is still in flight, force the rest closed and exit anyway.
    const deadline = setTimeout(() => {
      server.closeAllConnections?.();
      process.exit(0);
    }, 1500);
    deadline.unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[pxpipe] fatal:', err);
  process.exit(1);
});
