/**
 * Node entrypoint — `node:http` server + minimal CLI flag parsing.
 *
 * Wraps the runtime-agnostic `createProxy` from src/core/proxy.ts. The
 * heavy lifting (transform, render, PNG) is identical to the Worker
 * version; only the request/response plumbing differs.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createProxy, type ProxyConfig } from './core/proxy.js';
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

/** Runtime config. Single codepath: every behavior is on, all tuning
 *  parameters come from DEFAULTS in transform.ts. The only adjustables
 *  are deployment concerns (where to listen, what to proxy, where to log)
 *  and they're env-var only — no CLI flags. */
interface RuntimeConfig {
  port: number;
  upstream: string;
  eventsFile: string;
}

function parseCli(argv: string[]): RuntimeConfig {
  // Only flags accepted are --help and --version. Anything else is an
  // error — there is exactly ONE way to run pixelpipe and the dashboard
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
      console.error(`[pixelpipe] unknown option: ${a}`);
      console.error(`[pixelpipe] this build accepts no flags; run \`pixelpipe --help\` for env vars`);
      process.exit(2);
    }
  }
  return {
    port: Number(process.env.PORT ?? 47821),
    upstream: process.env.ANTHROPIC_UPSTREAM ?? 'https://api.anthropic.com',
    eventsFile:
      process.env.PIXELPIPE_LOG ??
      path.join(os.homedir(), '.pixelpipe', 'events.jsonl'),
  };
}

function printHelp(): void {
  console.log(`pixelpipe — token-saving proxy for Claude Code

Usage:
  pixelpipe                run the proxy (no flags)

The proxy always compresses tools, schemas, reminders, tool_results,
and history; always tracks events to disk; and always measures real
saved_pct via /v1/messages/count_tokens. Single codepath, no knobs.

Stats, sessions, and cleanup tools live in the dashboard at
  http://127.0.0.1:<port>/  (default port 47821)

Flags:
  -h, --help              show this help
      --version           show version

Environment (deployment-only):
  PORT                    listen port (default 47821)
  ANTHROPIC_UPSTREAM      upstream API base (default https://api.anthropic.com)
  PIXELPIPE_LOG           JSONL events path (default ~/.pixelpipe/events.jsonl)

Use with Claude Code:
  ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude
`);
}

function printVersion(): void {
  // Filled in at bundle time by esbuild.define; falls back here.
  console.log(process.env.npm_package_version ?? '0.2.0');
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

async function writeWebResponse(res: Response, out: ServerResponse): Promise<void> {
  out.statusCode = res.status;
  res.headers.forEach((v, k) => out.setHeader(k, v));
  if (!res.body) {
    out.end();
    return;
  }
  const reader = res.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out.write(value);
  }
  out.end();
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
 * Rotation: when the current file exceeds MAX_FILE_BYTES (100 MB by default),
 * it's renamed to `<path>.1` (overwriting any previous .1) and a fresh file
 * is opened. Keeps one generation of history; for longer retention pipe
 * the file off-host yourself.
 *
 * Failures here NEVER propagate — the proxy must keep serving requests even
 * if the disk is full or the path is unwritable.
 */
class FileTracker implements Tracker {
  private fd: number | null = null;
  private bytesWritten = 0;
  private brokenLogged = false;
  private static readonly MAX_FILE_BYTES = 100 * 1024 * 1024;

  constructor(private readonly filePath: string) {}

  private ensureOpen(): boolean {
    if (this.fd != null) return true;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
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
      this.fd = fs.openSync(this.filePath, 'a');
      return true;
    } catch (err) {
      if (!this.brokenLogged) {
        console.error(
          `[pixelpipe] FileTracker disabled — cannot open ${this.filePath}: ${(err as Error).message}`,
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
    try {
      fs.renameSync(this.filePath, this.filePath + '.1');
    } catch {
      /* if rename fails (e.g. .1 locked) we'll just keep growing — better
         than dropping events */
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
      if (this.bytesWritten > FileTracker.MAX_FILE_BYTES) this.rotate();
    } catch (err) {
      if (!this.brokenLogged) {
        console.error(
          `[pixelpipe] FileTracker write failed: ${(err as Error).message}`,
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
    fs.mkdirSync(dir, { recursive: true });
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
    await fs.promises.writeFile(filePath, bytesGz);
    return filePath;
  } catch {
    return undefined;
  }
}

// ---- main ----------------------------------------------------------------

async function main(): Promise<void> {
  // No subcommands — pixelpipe is just the proxy. Stats / sessions / cleanup
  // tools live in the dashboard (see http://127.0.0.1:${port}/).
  const argv = process.argv.slice(2);
  const opts = parseCli(argv);
  // Transform options pass through empty — the proxy uses the DEFAULTS
  // baked into transform.ts. There are no behavior toggles: system slab,
  // reminders, tool_results, and history compression all run
  // unconditionally; the per-block break-even gate decides per-call
  // whether to actually image each piece. Per-request α
  // injection happens later via the function-form `transform` in
  // ProxyConfig so the gate gets the dashboard's live empirical rate.
  const tracker: Tracker = new FileTracker(opts.eventsFile);

  // Sidecar dir for oversized 4xx request-body samples. Lives next to the
  // events.jsonl so a single `rm -rf` cleans up both. Lazy-mkdir'd on first
  // sidecar write (see maybeWriteBodySidecar).
  const bodySidecarDir = path.join(path.dirname(opts.eventsFile), '4xx-bodies');

  // Live dashboard state — populated on every request via onRequest below,
  // served via the route interception in front of the proxy handler. The
  // SessionsPaths handle lets the dashboard surface session/disk/stats data
  // without reaching back into module-scope globals.
  const dashboard = new DashboardState({
    eventsFile: opts.eventsFile,
    sidecarDir: bodySidecarDir,
  });
  // Seed the "recent requests" table from the JSONL log so a process restart
  // doesn't reset what you can see in the UI. Best-effort; ignored on error.
  await dashboard.replay(opts.eventsFile).catch(() => {});

  const config: ProxyConfig = {
    upstream: opts.upstream,
    // Per-request transform options:
    //   1. Runtime kill switch — when the dashboard "passthrough" toggle
    //      is off, force compress=false so /v1/messages forwards
    //      untransformed. Lets the operator instantly disable the proxy
    //      when upstream is unhealthy without restarting.
    //   2. Otherwise use DEFAULTS in transform.ts for break-even gating.
    transform: () => {
      if (!dashboard.getCompressionEnabled()) return { compress: false };
      return {};
    },
    onRequest: async (e) => {
      // Feed the dashboard BEFORE tracker.emit — toTrackEvent strips
      // info.firstImagePng, so capturing has to happen on the raw event.
      dashboard.update(e);
      // Terse human-readable console line.
      const extra: string[] = [];
      if (e.info?.reminderImgs) extra.push(`rem+${e.info.reminderImgs}`);
      if (e.info?.toolResultImgs) extra.push(`tr+${e.info.toolResultImgs}`);
      const extraTag = extra.length > 0 ? ` (${extra.join(' ')})` : '';
      const tag = e.info?.compressed
        ? `compressed ${e.info.origChars}ch → ${e.info.imageCount}img/${e.info.imageBytes}B${extraTag}`
        : (e.info?.reason ?? '');
      const cacheRead = e.usage?.cache_read_input_tokens ?? 0;
      const inputTokens = e.usage?.input_tokens ?? 0;
      const usageTag =
        e.usage !== undefined
          ? ` tokens=${inputTokens}+${e.usage.output_tokens ?? 0} cache_read=${cacheRead}`
          : '';
      console.log(
        `[${new Date().toISOString()}] ${e.method} ${e.path} → ${e.status} (${e.durationMs}ms) ${tag}${usageTag}`,
      );

      // Surface upstream 4xx error bodies inline so a regression in the
      // request shape is obvious without having to grep events.jsonl. The
      // tracker JSONL already has the full ~2 KiB capture.
      if (e.errorBody) {
        const trimmed = e.errorBody.length > 400
          ? e.errorBody.slice(0, 400) + '…'
          : e.errorBody;
        console.warn(`[pixelpipe ${e.status}] upstream body: ${trimmed}`);
      }

      // Canary: surface unknown tag-shaped blocks so a Claude Code release
      // that adds a new dynamic tag is caught within hours.
      if (e.info?.unknownStaticTags && e.info.unknownStaticTags.length > 0) {
        console.warn(
          `[pixelpipe warn] unknown tag(s) in static slab: ${e.info.unknownStaticTags.join(', ')}  ` +
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

      // Persistent JSONL event for offline analysis (pixelpipe stats etc.).
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
        const route = dashboardPath(url.pathname);
        if (route) {
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
        console.error('[pixelpipe] handler error:', err);
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      });
  });

  server.listen(opts.port, () => {
    console.log(`[pixelpipe] listening on http://127.0.0.1:${opts.port} → ${opts.upstream}`);
    console.log(`[pixelpipe] tracking events → ${opts.eventsFile}`);
    console.log(`[pixelpipe] dashboard → http://127.0.0.1:${opts.port}/`);
  });

  const shutdown = (sig: string) => {
    console.log(`[pixelpipe] ${sig} — shutting down`);
    // Flush+close the tracker so we don't drop the last few events on exit.
    if (tracker instanceof FileTracker) tracker.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[pixelpipe] fatal:', err);
  process.exit(1);
});
