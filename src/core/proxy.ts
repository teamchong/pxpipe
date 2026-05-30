/**
 * The pixelpipe proxy as a single Web-standard fetch handler.
 *
 * Both `src/node.ts` and `src/worker.ts` adapt this to their respective
 * runtimes (node:http server vs CF Worker `fetch` export). The handler
 * itself only uses `Request`, `Response`, `URL`, and global `fetch` — all
 * of which exist identically in Node 18+ and Workers.
 */

import { transformRequest, type TransformOptions, type TransformInfo } from './transform.js';
import { isPixelpipeSupportedModel } from './applicability.js';
import {
  buildBaselineCountTokensBody,
  buildCacheablePrefixCountTokensBody,
} from './measurement.js';
import type { Usage } from './types.js';

export interface ProxyConfig {
  /** Anthropic API base, no trailing slash. Defaults to api.anthropic.com. */
  upstream?: string;
  /** Override or supply an API key. If unset, we forward whatever the client sent. */
  apiKey?: string;
  /** Per-request transform options. Pass a function when the host wants to
   *  inject DYNAMIC values per request (e.g. live empirical `charsPerToken`
   *  from the dashboard's converging fit) — the proxy invokes it once per
   *  /v1/messages POST. Static object form is used by the Workers host and
   *  tests that don't need dynamic state. */
  transform?: TransformOptions | (() => TransformOptions);
  /** Called after every request — useful for logging / metrics in the host. */
  onRequest?: (event: ProxyEvent) => void | Promise<void>;
}

export interface ProxyEvent {
  method: string;
  path: string;
  status: number;
  /** Wall-clock ms from request start to event fire (≈ end of upstream response
   *  body, since we now wait for usage extraction). For first-byte latency see
   *  firstByteMs. */
  durationMs: number;
  /** Wall-clock ms from request start to upstream response headers. */
  firstByteMs?: number;
  info?: TransformInfo;
  /** Usage block from Anthropic's response — input/output/cache tokens. */
  usage?: Usage;
  error?: string;
  /** First ~2 KiB of the upstream response body when status is in [400, 499].
   *  Lets us see what Anthropic actually rejected without re-running the request.
   *  Not captured for 2xx (no error) or 5xx (we synthesize our own message). */
  errorBody?: string;
  /** sha256[0..8] of the TRANSFORMED outgoing request body. Set on every
   *  /v1/messages POST regardless of status. Lets future debuggers correlate
   *  "same payload, sometimes works, sometimes fails" without storing bodies. */
  reqBodySha8?: string;
  /** Full gzipped transformed body, populated only on 4xx. The Node host may
   *  redirect this to a sidecar file (see reqBodySamplePath) before the
   *  tracker serializes the event; Workers always inline-cap at 32 KiB. */
  reqBodyGz?: Uint8Array;
  /** Set by the Node host *in place of* reqBodyGz when it wrote the gzipped
   *  body to a sidecar file. The path lands in the JSONL as
   *  `req_body_sample_path`. */
  reqBodySamplePath?: string;
  /** Ground-truth output measurement extracted from the response stream itself,
   *  independent of Anthropic's `usage.output_tokens`. Lets the dashboard show
   *  how much of the billed output was redacted_thinking (opaque server-encoded
   *  bytes) vs real text/thinking/tool_use. Absent on requests that didn't
   *  yield a body we could scan (no upstream response, 5xx, unknown
   *  content-type). See OutputMeasurement for field meanings. */
  measurement?: OutputMeasurement;
}

/** Max chars of upstream error body we surface on ProxyEvent. Keeps the JSONL
 *  line small while still being big enough to hold Anthropic's full error JSON
 *  (typically a few hundred bytes). */
const ERROR_BODY_MAX = 2048;

/** Cheap, bounded read of the top-level `model` field from an Anthropic
 *  /v1/messages body. The field sits near the start of the JSON, so we decode
 *  only the head rather than JSON-parsing the (potentially multi-MB) full
 *  conversation just to read one string. Returns null when not found — callers
 *  treat null as "outside supported scope" (fail-closed). */
function readModelField(body: Uint8Array): string | null {
  try {
    const head = new TextDecoder().decode(body.subarray(0, 8192));
    const m = /"model"\s*:\s*"([^"]{1,80})"/.exec(head);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/** Gzip a byte buffer using the standard `CompressionStream`. Available in
 *  Node 18+ and Cloudflare Workers — no Buffer / no zlib. */
async function gzipBytes(body: Uint8Array): Promise<Uint8Array> {
  // `body as BufferSource`: TS doesn't model Response taking a Uint8Array
  // directly even though it works in both runtimes.
  const stream = new Response(body as BufferSource).body!.pipeThrough(
    new CompressionStream('gzip'),
  );
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** sha256[0..8] of a byte buffer, hex. Same shape as the existing sha8(text)
 *  helper in transform.ts but works on raw bytes (no extra encode pass). */
async function sha8Bytes(body: Uint8Array): Promise<string> {
  // Cast to BufferSource — Web Crypto accepts Uint8Array at runtime.
  const digest = await crypto.subtle.digest('SHA-256', body as BufferSource);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 4; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Ground-truth output measurement extracted from the response stream itself.
 *
 *  - `textChars` / `thinkingChars` / `toolUseChars` count Unicode code units
 *    of the corresponding payload (`text_delta`, `thinking_delta`, and
 *    `input_json_delta` for SSE; `content[].text` / `.thinking` /
 *    JSON-encoded `.input` for non-stream responses).
 *  - `redactedBlockCount` is the number of `redacted_thinking` content blocks
 *    Anthropic returned — chars are unavailable for these (the field is
 *    opaque server-encrypted bytes), so they get a low/mid/high estimate at
 *    the dashboard layer instead of a precise char count.
 *
 * These numbers are independent of Anthropic's `usage.output_tokens` — they
 * give us a real ruler against the redacted_thinking-inflated bill, which is
 * exactly the gap the May-2026 weekly-meter audit surfaced. Live on `info`,
 * so they ride the existing TrackEvent pipeline; the dashboard layer turns
 * them into `output_chars_measured`, `tool_use_chars_measured`, etc.
 */
export interface OutputMeasurement {
  textChars: number;
  thinkingChars: number;
  toolUseChars: number;
  redactedBlockCount: number;
}

/** Walk a single SSE event (`event: …\ndata: …`) and fold it into the running
 *  usage + measurement accumulators. Quiet on malformed events — a stream
 *  with one corrupt line should not break the host's event log. */
function processSseEvent(
  block: string,
  m: OutputMeasurement,
  state: { usage: Usage | undefined },
): void {
  // Each SSE event is one or more lines; we only care about `event:` + `data:`.
  // Continuation `data:` lines concatenate per the SSE spec, though Anthropic
  // ships single-line JSON in practice.
  let event = '';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).replace(/^\s/, '');
  }
  if (!data) return;
  let j: unknown;
  try {
    j = JSON.parse(data);
  } catch {
    return;
  }
  const obj = j as Record<string, unknown>;

  if (event === 'message_start') {
    const msg = obj.message as { usage?: Usage } | undefined;
    if (msg?.usage) state.usage = { ...msg.usage };
  } else if (event === 'content_block_start') {
    const cb = obj.content_block as { type?: string } | undefined;
    if (cb?.type === 'redacted_thinking') m.redactedBlockCount += 1;
  } else if (event === 'content_block_delta') {
    const d = obj.delta as
      | { type?: string; text?: string; thinking?: string; partial_json?: string }
      | undefined;
    if (d?.type === 'text_delta' && typeof d.text === 'string') {
      m.textChars += d.text.length;
    } else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
      m.thinkingChars += d.thinking.length;
    } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
      m.toolUseChars += d.partial_json.length;
    }
  } else if (event === 'message_delta') {
    // Authoritative final output_tokens lives here; merge over the message_start
    // baseline so the host event records the billed number, not the placeholder
    // (message_start ships `output_tokens: 1` on day-zero Sonnet 4).
    const u = obj.usage as Partial<Usage> | undefined;
    if (u) {
      if (!state.usage) state.usage = {} as Usage;
      const cur = state.usage;
      if (typeof u.output_tokens === 'number') cur.output_tokens = u.output_tokens;
      if (typeof u.input_tokens === 'number' && cur.input_tokens === undefined) {
        cur.input_tokens = u.input_tokens;
      }
      if (typeof u.cache_creation_input_tokens === 'number') {
        cur.cache_creation_input_tokens = u.cache_creation_input_tokens;
      }
      if (typeof u.cache_read_input_tokens === 'number') {
        cur.cache_read_input_tokens = u.cache_read_input_tokens;
      }
    }
  }
}

/** Measure non-stream `messages.content[]` directly. Same shape as the SSE
 *  accumulator — output_*_chars carry char counts, redactedBlockCount counts
 *  `redacted_thinking` blocks (no chars available). */
function measureFromMessageJson(j: unknown): OutputMeasurement {
  const m: OutputMeasurement = { textChars: 0, thinkingChars: 0, toolUseChars: 0, redactedBlockCount: 0 };
  const content = (j as { content?: unknown })?.content;
  if (!Array.isArray(content)) return m;
  for (const block of content) {
    const b = block as { type?: string; text?: unknown; thinking?: unknown; input?: unknown };
    if (b?.type === 'text' && typeof b.text === 'string') {
      m.textChars += b.text.length;
    } else if (b?.type === 'thinking' && typeof b.thinking === 'string') {
      m.thinkingChars += b.thinking.length;
    } else if (b?.type === 'redacted_thinking') {
      m.redactedBlockCount += 1;
    } else if (b?.type === 'tool_use') {
      try {
        m.toolUseChars += JSON.stringify(b.input ?? {}).length;
      } catch {
        /* circular / unserialisable input — leave the counter as-is */
      }
    }
  }
  return m;
}

/**
 * Tee the response body so we can scan for the usage block AND the per-event
 * char counts for honest output measurement. Returns the un-touched response
 * to forward to the client + a Promise that resolves to the parsed Usage and
 * a Promise that resolves to the measurement (both `undefined` when we can't
 * extract them — e.g. unknown content-type, 5xx, no body).
 *
 * Streaming responses are scanned to EOF (not the old 64 KiB cap) because the
 * final `output_tokens` lives in the `message_delta` at the end of the stream
 * and `redacted_thinking` blocks can appear anywhere. The scanner is cheap
 * (regex-free incremental SSE parser) and the tee back-pressure is no worse
 * than the previous "drain to /dev/null in the background" path.
 *
 * For upstream 4xx responses, we tee the body to capture up to `ERROR_BODY_MAX`
 * chars so the host can log what Anthropic actually rejected. 5xx still bails.
 */
function teeForUsage(res: Response): {
  response: Response;
  usagePromise: Promise<Usage | undefined>;
  errorBodyPromise: Promise<string | undefined>;
  measurementPromise: Promise<OutputMeasurement | undefined>;
} {
  // No body at all: nothing to extract on either path.
  if (!res.body) {
    return {
      response: res,
      usagePromise: Promise.resolve(undefined),
      errorBodyPromise: Promise.resolve(undefined),
      measurementPromise: Promise.resolve(undefined),
    };
  }
  // 4xx: tee for the error body but skip usage scanning entirely.
  if (res.status >= 400 && res.status < 500) {
    const [forClient, forUs] = res.body.tee();
    const errorBodyPromise = (async (): Promise<string | undefined> => {
      const reader = forUs.getReader();
      const decoder = new TextDecoder();
      let out = '';
      try {
        while (out.length < ERROR_BODY_MAX) {
          const { done, value } = await reader.read();
          if (done) break;
          out += decoder.decode(value, { stream: true });
        }
        out += decoder.decode();
        // Drain the rest so the tee buffer doesn't hold the stream open.
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        /* client may have aborted; whatever we got is fine */
      }
      return out.length > ERROR_BODY_MAX ? out.slice(0, ERROR_BODY_MAX) : out;
    })();
    return {
      response: new Response(forClient, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      }),
      usagePromise: Promise.resolve(undefined),
      errorBodyPromise,
      measurementPromise: Promise.resolve(undefined),
    };
  }
  // 5xx: skip both (the host already synthesizes an error message).
  if (res.status >= 500) {
    return {
      response: res,
      usagePromise: Promise.resolve(undefined),
      errorBodyPromise: Promise.resolve(undefined),
      measurementPromise: Promise.resolve(undefined),
    };
  }
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  const [forClient, forUs] = res.body.tee();

  // Single scan resolves both usage and measurement together. We expose them
  // as separate promises (resolved from the same shared payload) so callers
  // can stay readable; both wait on the same underlying read loop.
  const scanResult = (async (): Promise<{
    usage: Usage | undefined;
    measurement: OutputMeasurement | undefined;
  }> => {
    const reader = forUs.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    try {
      if (ct.includes('text/event-stream')) {
        // SSE: walk every event to EOF. Final output_tokens is in message_delta
        // (last event before message_stop); redacted_thinking blocks can appear
        // anywhere. Tee back-pressure is bounded by the slower-reader's buffer,
        // which here is whichever of the proxy/scanner falls behind — both run
        // at network speed in practice.
        const m: OutputMeasurement = {
          textChars: 0,
          thinkingChars: 0,
          toolUseChars: 0,
          redactedBlockCount: 0,
        };
        const state: { usage: Usage | undefined } = { usage: undefined };
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // Drain every complete event (terminated by a blank line per SSE spec).
          let evEnd: number;
          while ((evEnd = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, evEnd);
            buf = buf.slice(evEnd + 2);
            processSseEvent(block, m, state);
          }
        }
        buf += decoder.decode();
        // Trailing partial event (no blank line) — try once for robustness.
        if (buf.trim().length > 0) processSseEvent(buf, m, state);
        return { usage: state.usage, measurement: m };
      }

      if (ct.includes('application/json')) {
        // Non-stream: buffer fully (capped at 4 MiB).
        const MAX = 4 * 1024 * 1024;
        while (buf.length < MAX) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
        }
        try {
          const j = JSON.parse(buf);
          return {
            usage: j?.usage as Usage | undefined,
            measurement: measureFromMessageJson(j),
          };
        } catch {
          return { usage: undefined, measurement: undefined };
        }
      }
    } catch {
      /* tee may be released early if the client aborts — ignore */
    }
    // Unknown content-type: drain so the tee buffer doesn't hold the stream open.
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      /* ignore */
    }
    return { usage: undefined, measurement: undefined };
  })();

  return {
    response: new Response(forClient, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    }),
    usagePromise: scanResult.then((s) => s.usage),
    errorBodyPromise: Promise.resolve(undefined),
    measurementPromise: scanResult.then((s) => s.measurement),
  };
}

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';

/** Headers we strip on the way out — they're hop-by-hop or proxy-injected. */
const STRIP_REQ_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'content-length', // we recompute
  'expect',
  'accept-encoding', // let upstream choose
]);

const STRIP_RES_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding', // we don't re-encode
  'content-length',   // body may differ after streaming
]);

function filterHeaders(src: Headers, strip: Set<string>): Headers {
  const out = new Headers();
  src.forEach((v, k) => {
    if (!strip.has(k.toLowerCase())) out.append(k, v);
  });
  return out;
}

/** POST /v1/messages/count_tokens with the given body. Returns the upstream's
 *  `input_tokens` number or null on any failure. count_tokens is documented
 *  as a free endpoint (no input-token billing) — we use it once per request
 *  on the PRE-COMPRESSION body to get the ground-truth baseline. Actual
 *  post-compression tokens already come back free in the /v1/messages usage
 *  block (input_tokens + cache_create + cache_read), so no second probe. */
async function countTokensUpstream(
  upstream: string,
  body: Uint8Array,
  headers: Headers,
): Promise<number | null> {
  try {
    const res = await fetch(upstream + '/v1/messages/count_tokens', {
      method: 'POST',
      headers,
      body: body as unknown as BodyInit,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { input_tokens?: unknown };
    return typeof json.input_tokens === 'number' ? json.input_tokens : null;
  } catch {
    return null;
  }
}

/** Build the proxy fetch handler bound to a config. */
export function createProxy(config: ProxyConfig = {}) {
  const upstream = (config.upstream ?? DEFAULT_UPSTREAM).replace(/\/+$/, '');

  return async function handle(req: Request): Promise<Response> {
    const t0 = Date.now();
    const url = new URL(req.url);
    const path = url.pathname + url.search;

    // Captured during the transform step. `reqBodyBytes` is the raw
    // transformed body — kept around so we can gzip it lazily on 4xx without
    // having to re-stringify. `reqBodySha8` is computed eagerly because
    // it's cheap and lands on every event (4xx and 2xx) for correlation.
    let reqBodyBytes: Uint8Array | undefined;
    let reqBodySha8: string | undefined;

    const fire = (
      status: number,
      info?: TransformInfo,
      error?: string,
      firstByteMs?: number,
      usage?: Usage,
      errorBody?: string,
      measurement?: OutputMeasurement,
    ): void => {
      const is4xx = status >= 400 && status < 500;
      // Gzip the full body only when we actually need it — i.e. status is 4xx
      // and we have bytes to capture. Awaiting inside an async IIFE keeps the
      // fire() signature unchanged; the host receives the event once the
      // gzip resolves (or immediately if not 4xx).
      const finalize = async (): Promise<void> => {
        let reqBodyGz: Uint8Array | undefined;
        if (is4xx && reqBodyBytes && reqBodyBytes.byteLength > 0) {
          try {
            reqBodyGz = await gzipBytes(reqBodyBytes);
          } catch {
            // gzip failure is non-fatal — drop the body sample, keep the rest.
          }
        }
        // Wait for the baseline count_tokens probes before persisting the
        // event so both numbers land on the same row as the usage block.
        // Each probe is independent: full-body baseline can land even if the
        // cacheable-prefix probe fails (and vice versa). null/missing leaves
        // the field absent; the dashboard's per-event math degrades cleanly.
        if (info) {
          // Track both halves of the cache-aware baseline so we can honestly
          // report whether a row is fully measured, partially measured, or
          // un-measured. Without this, a missing cacheable-prefix probe was
          // silently bucketed as cacheable=0 by the dashboard, which inflates
          // the baseline and thus "$ saved". See dashboard.ts for the gating.
          let baselineResolved: number | null = null;
          let cacheableExpected = false;
          let cacheableResolved: number | null = null;
          if (baselinePromise) {
            try {
              baselineResolved = await baselinePromise;
              if (baselineResolved !== null) info.baselineTokens = baselineResolved;
            } catch {
              /* probe threw — drop, keep the rest of the event intact */
            }
          }
          if (baselineCacheablePromise) {
            cacheableExpected = true;
            try {
              cacheableResolved = await baselineCacheablePromise;
              if (cacheableResolved !== null) info.baselineCacheableTokens = cacheableResolved;
            } catch {
              /* probe threw — leave field absent */
            }
          }
          if (baselineResolved === null) {
            info.baselineProbeStatus = 'failed';
          } else if (cacheableExpected && cacheableResolved === null) {
            // Body had cache_control markers but the prefix probe didn't
            // come back. The dashboard MUST NOT treat this as cacheable=0
            // (that would charge the unproxied counterfactual as if it had
            // no cache reuse, fabricating savings). It excludes the row.
            info.baselineProbeStatus = 'partial';
          } else {
            // Either both probes resolved, or the body had no markers and
            // cacheable=0 is exact by construction. Either way, honest.
            info.baselineProbeStatus = 'ok';
          }
        }
        await config.onRequest?.({
          method: req.method,
          path: url.pathname,
          status,
          durationMs: Date.now() - t0,
          firstByteMs,
          info,
          usage,
          error,
          errorBody,
          reqBodySha8,
          reqBodyGz,
          measurement,
        });
      };
      void finalize();
    };

    // Only intercept /v1/messages POSTs. Everything else passes through.
    const isMessages = req.method === 'POST' && url.pathname === '/v1/messages';

    let bodyOut: BodyInit | null = null;
    let info: TransformInfo | undefined;

    // Ground-truth baseline measurement. Fires /v1/messages/count_tokens TWO
    // ways on the PRE-COMPRESSION body in parallel with the main forward:
    //   baselinePromise          → full-body input_tokens (cold cost)
    //   baselineCacheablePromise → input_tokens of the body TRUNCATED at the
    //                              last cache_control marker (the prefix that
    //                              would have cached on the unproxied path)
    // Difference of the two is `cold_tail_tokens` (always-cold input on both
    // proxied and unproxied paths). The dashboard combines them with the
    // actual usage block's cache class to get an exact cache-aware baseline,
    // not a cold-every-time approximation. Both resolve to a number or null
    // (probe failed or no markers); land on info.baseline*Tokens before the
    // host event persists.
    let baselinePromise: Promise<number | null> | undefined;
    let baselineCacheablePromise: Promise<number | null> | undefined;

    if (isMessages) {
      const bodyIn = new Uint8Array(await req.arrayBuffer());
      try {
        const transformOpts =
          typeof config.transform === 'function' ? config.transform() : config.transform;
        // Model-scope gate (proxy boundary): pixelpipe is validated only for
        // the models in isPixelpipeSupportedModel (Opus 4.7+). Anything else
        // passes through untransformed, mirroring the library wrapper's gate.
        // The pure transformRequest primitive stays model-agnostic — scope is
        // policy enforced here at the edge. Fail-closed: an unreadable model
        // means no compression rather than a risky guess.
        const modelOk = isPixelpipeSupportedModel(readModelField(bodyIn));
        const r = await transformRequest(
          bodyIn,
          modelOk ? transformOpts : { ...transformOpts, compress: false },
        );
        if (!modelOk) r.info.reason = 'unsupported_model';
        // Cast: TS narrows Uint8Array<ArrayBufferLike> away from BodyInit, but
        // it's a valid body and we never use SharedArrayBuffer.
        bodyOut = r.body as unknown as BodyInit;
        info = r.info;
        reqBodyBytes = r.body;
        if (r.body.byteLength > 0) {
          reqBodySha8 = await sha8Bytes(r.body);
        }

        // Kick off the count_tokens probes on the ORIGINAL body BEFORE the
        // main forward so all three calls (full probe, cacheable-prefix probe,
        // main /v1/messages) overlap. Anthropic doesn't bill count_tokens, so
        // the cost is wall-clock only — typically ~30-80ms, fully hidden by
        // the main forward latency.
        const ctBody = buildBaselineCountTokensBody(bodyIn);
        if (ctBody) {
          const ctHeaders = filterHeaders(req.headers, STRIP_REQ_HEADERS);
          ctHeaders.set('content-type', 'application/json');
          if (config.apiKey) ctHeaders.set('x-api-key', config.apiKey);
          baselinePromise = countTokensUpstream(upstream, ctBody, ctHeaders);
          // Second probe: body truncated at the last cache_control marker.
          // Null body = no markers exist → cacheable=0 by definition, no
          // probe needed.
          const ctCacheableBody = buildCacheablePrefixCountTokensBody(bodyIn);
          if (ctCacheableBody) {
            baselineCacheablePromise = countTokensUpstream(
              upstream,
              ctCacheableBody,
              new Headers(ctHeaders),
            );
          }
        }
      } catch (e) {
        fire(502, undefined, `transform_error: ${(e as Error).message}`);
        return new Response(JSON.stringify({ error: 'pixelpipe transform failed' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
    } else {
      // Pass body through unchanged.
      bodyOut = req.body;
    }

    const outHeaders = filterHeaders(req.headers, STRIP_REQ_HEADERS);
    if (config.apiKey) outHeaders.set('x-api-key', config.apiKey);

    const upstreamUrl = upstream + path;
    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        method: req.method,
        headers: outHeaders,
        body: bodyOut,
        // duplex is required by spec when sending a stream as body
        ...(bodyOut instanceof ReadableStream ? { duplex: 'half' } : {}),
      } as RequestInit);
    } catch (e) {
      fire(502, info, `upstream_error: ${(e as Error).message}`);
      return new Response(JSON.stringify({ error: 'pixelpipe upstream unreachable' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    }

    const firstByteMs = Date.now() - t0;

    // Tee the upstream body so we can extract Anthropic's usage block. The
    // client gets one side immediately; we read the other in the background.
    // For 4xx responses we also tee to capture the error body (up to 2 KiB)
    // so the host can log what Anthropic actually rejected.
    const { response: teed, usagePromise, errorBodyPromise, measurementPromise } =
      teeForUsage(upstreamRes);

    // Fire the host event once usage AND any captured error body AND the output
    // measurement are known (or once we've given up on finding them). Don't
    // await — the response below is what unblocks the client; fire happens in
    // the background. measurementPromise resolves from the same shared stream
    // read as usagePromise, so this Promise.all doesn't add latency.
    void Promise.all([
      usagePromise.catch(() => undefined),
      errorBodyPromise.catch(() => undefined),
      measurementPromise.catch(() => undefined),
    ]).then(([usage, errorBody, measurement]) =>
      fire(upstreamRes.status, info, undefined, firstByteMs, usage, errorBody, measurement),
    );

    return new Response(teed.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: filterHeaders(upstreamRes.headers, STRIP_RES_HEADERS),
    });
  };
}
