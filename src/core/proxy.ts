/**
 * pxpipe proxy as a single Web-standard fetch handler.
 * Adapted by src/node.ts and src/worker.ts; uses only Request/Response/URL/fetch.
 */

import { transformRequest, type TransformOptions, type TransformInfo } from './transform.js';
import { isClaudeModel, transformOpenAIChatCompletions, transformOpenAIResponses } from './openai.js';
import { isAnthropicMessagesPath, isPxpipeSupportedGptModel, isPxpipeSupportedModel } from './applicability.js';
import {
  buildBaselineCountTokensBody,
  buildCacheablePrefixCountTokensBody,
} from './measurement.js';
import type { Usage } from './types.js';
import {
  anthropicMessagesToOpenAIResponses,
  openAIResponsesToAnthropicResponse,
} from './messages-responses-bridge.js';
import {
  anthropicMessagesToOpenAIChat,
  chatCompletionsUrl,
  openAIChatToAnthropicResponse,
} from './messages-chat-bridge.js';

export interface ProxyConfig {
  /** 'cloudflare-ai-gateway': routes both families through gatewayBaseUrl;
   *  OpenAI paths drop the `/v1` prefix to match gateway shape. */
  provider?: 'cloudflare-ai-gateway';
  /** Gateway base URL (account/gateway-scoped). Required when provider is set. */
  gatewayBaseUrl?: string;
  /** Extra headers injected on every upstream request (e.g. gateway auth). */
  gatewayHeaders?: Record<string, string>;
  /** Anthropic API base, no trailing slash. Defaults to api.anthropic.com. */
  upstream?: string;
  /** Override or supply an API key. If unset, we forward whatever the client sent. */
  apiKey?: string;
  /** OpenAI API base for GPT chat completions, no trailing slash. */
  openAIUpstream?: string;
  /** Override or supply an OpenAI API key. If unset, we forward Authorization. */
  openAIApiKey?: string;
  /** Cloudflare's OpenAI-compatible Chat Completions endpoint and bearer key. */
  cloudflareUpstream?: string;
  cloudflareApiKey?: string;
  /** Exact model ids routed to each non-default provider. Unlisted Claude
   * models retain normal Anthropic routing. */
  openAIModels?: string[];
  cloudflareModels?: string[];
  /** Pass a function to inject dynamic values per-request (e.g. live charsPerToken);
   *  static object for Workers/tests. */
  transform?: TransformOptions | (() => TransformOptions);
  /** Called after every request — useful for logging / metrics in the host. */
  onRequest?: (event: ProxyEvent) => void | Promise<void>;
  /** Persist the gzipped request body on 4xx (→ reqBodyGz, sidecar/inline).
   *  Off by default: request bodies hold full prompts and any secrets in
   *  context, so raw-body capture is opt-in debugging only. The upstream
   *  error body (errorBody) is unaffected — it carries no user content. */
  captureErrorReqBody?: boolean;
}

export interface ProxyEvent {
  method: string;
  path: string;
  /** Top-level request model when present. Used for telemetry/dashboard labels only. */
  model?: string;
  /** Provider cost/usage semantics after any internal wire bridge. Unlike
   * `path`, this describes the upstream that actually billed the request. */
  accountingProvider?: 'anthropic' | 'openai';
  status: number;
  /** Wall-clock ms from request start to event fire (≈ end of upstream body). */
  durationMs: number;
  /** Wall-clock ms from request start to upstream response headers. */
  firstByteMs?: number;
  info?: TransformInfo;
  /** Usage block from Anthropic's response — input/output/cache tokens. */
  usage?: Usage;
  /** Model stop reason from the response ("end_turn", "tool_use", "max_tokens",
   *  "refusal", …). "refusal" = safety classifier fired on the transformed request —
   *  scorers must fail cost comparisons on refusal rows (refusals emit almost no
   *  output and would otherwise look "cheaper"). OpenAI finish_reason ("stop",
   *  "length", "content_filter", …) is normalized into the same field. */
  stopReason?: string;
  error?: string;
  /** First ~2 KiB of the upstream 4xx body (not captured on 2xx or 5xx). */
  errorBody?: string;
  /** sha256[0..8] of the transformed outgoing body — set on every /v1/messages POST for correlation. */
  reqBodySha8?: string;
  /** Gzipped transformed body, populated only on 4xx. Node may write to sidecar (see reqBodySamplePath). */
  reqBodyGz?: Uint8Array;
  /** Set by the Node host instead of reqBodyGz when the body was written to a sidecar file. */
  reqBodySamplePath?: string;
  /** Ground-truth char counts from the response stream, independent of usage.output_tokens.
   *  Absent when the body couldn't be scanned (5xx, unknown content-type). See OutputMeasurement. */
  measurement?: OutputMeasurement;
}

/** Max chars of 4xx error body captured on ProxyEvent — enough for Anthropic's full error JSON. */
const ERROR_BODY_MAX = 2048;

/** Read the actual top-level `model` field. The body is already buffered for
 * transformation, so parsing it is both safer and simpler than a prefix regex
 * (which could mistake `metadata.model` for the routing model). */
function readModelField(body: Uint8Array): string | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(body)) as { model?: unknown };
    return typeof value.model === 'string' && value.model.length <= 200 ? value.model : null;
  } catch {
    return null;
  }
}

// Claude Code only admits gateway-discovered ids beginning with "claude" or
// "anthropic". Prefix provider ids for discovery, then remove that compatibility
// prefix before PXPIPE_MODELS matching and upstream routing.
const CLAUDE_GATEWAY_MODEL_PREFIX = 'claude-';

function claudeGatewayModelId(model: string): string {
  if (model.startsWith('claude-') || model.startsWith('anthropic')) return model;
  return CLAUDE_GATEWAY_MODEL_PREFIX + model;
}

function resolveClaudeGatewayModelId(model: string | null): string | undefined {
  if (!model?.startsWith(CLAUDE_GATEWAY_MODEL_PREFIX)) return undefined;
  const providerModel = model.slice(CLAUDE_GATEWAY_MODEL_PREFIX.length);
  return providerModel.includes('/') ? providerModel : undefined;
}

function cloudflareModelDisplayName(model: string): string {
  return /kimi-k3/i.test(model) ? 'Kimi K3 (Cloudflare)' : model;
}

/** Gzip via CompressionStream — available in Node 18+ and Cloudflare Workers. */
async function gzipBytes(body: Uint8Array): Promise<Uint8Array> {
  // Cast: TS doesn't model Response(Uint8Array) even though it works in both runtimes.
  const stream = new Response(body as BufferSource).body!.pipeThrough(
    new CompressionStream('gzip'),
  );
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** sha256[0..8] hex of a byte buffer. */
async function sha8Bytes(body: Uint8Array): Promise<string> {
  // Cast: Web Crypto accepts Uint8Array at runtime despite the BufferSource type.
  const digest = await crypto.subtle.digest('SHA-256', body as BufferSource);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 4; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Ground-truth char counts from the response stream, independent of usage.output_tokens.
 * redactedBlockCount blocks are opaque server bytes — no char count available for those.
 */
export interface OutputMeasurement {
  textChars: number;
  thinkingChars: number;
  toolUseChars: number;
  redactedBlockCount: number;
}

/** Parse one SSE block into the running usage + measurement accumulators. Silent on malformed input. */
function processSseEvent(
  block: string,
  m: OutputMeasurement,
  state: { usage: Usage | undefined; stopReason: string | undefined },
): void {
  // Parse `event:` + `data:` lines; continuation data: lines concatenate per SSE spec.
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

  // OpenAI chunks have no `event:` line; usage only present when stream_options.include_usage is set.
  const openAIUsage = normalizeUsage((obj as { usage?: unknown }).usage);
  if (openAIUsage) state.usage = openAIUsage;
  // OpenAI Responses API streams usage nested under `response` on the terminal
  // `response.completed` (or `.incomplete`) event — not at the top level.
  if (event === 'response.completed' || event === 'response.incomplete') {
    const resp = obj.response as
      | { usage?: unknown; incomplete_details?: { reason?: unknown } }
      | undefined;
    const respUsage = normalizeUsage(resp?.usage);
    if (respUsage) state.usage = respUsage;
    // Responses API has no stop_reason; normalize the terminal status/reason instead.
    const reason = resp?.incomplete_details?.reason;
    state.stopReason = typeof reason === 'string' ? reason
      : event === 'response.incomplete' ? 'incomplete' : 'stop';
  }
  measureOpenAIChoices(obj, m);
  // OpenAI chat chunks: the final chunk carries choices[].finish_reason (earlier chunks ship null).
  const choices = obj.choices;
  if (Array.isArray(choices)) {
    for (const c of choices) {
      const fr = (c as { finish_reason?: unknown } | undefined)?.finish_reason;
      if (typeof fr === 'string') state.stopReason = fr;
    }
  }

  if (event === 'message_start') {
    const msg = obj.message as { usage?: Usage } | undefined;
    const usage = normalizeUsage(msg?.usage);
    if (usage) state.usage = usage;
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
    // Anthropic ships the final stop_reason here ("end_turn", "refusal", …).
    const d = obj.delta as { stop_reason?: unknown } | undefined;
    if (typeof d?.stop_reason === 'string') state.stopReason = d.stop_reason;
    // Authoritative final output_tokens; merge over message_start (which ships output_tokens: 1).
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

function normalizeUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const out: Usage = {};

  if (typeof u.input_tokens === 'number') out.input_tokens = u.input_tokens;
  if (typeof u.output_tokens === 'number') out.output_tokens = u.output_tokens;
  if (typeof u.cache_creation_input_tokens === 'number') {
    out.cache_creation_input_tokens = u.cache_creation_input_tokens;
  }
  if (typeof u.cache_read_input_tokens === 'number') {
    out.cache_read_input_tokens = u.cache_read_input_tokens;
  }
  if (typeof u.cache_creation === 'object' && u.cache_creation !== null) {
    out.cache_creation = u.cache_creation as Usage['cache_creation'];
  }
  if (typeof u.server_tool_use === 'object' && u.server_tool_use !== null) {
    out.server_tool_use = u.server_tool_use as Usage['server_tool_use'];
  }

  // OpenAI field aliases.
  if (typeof u.prompt_tokens === 'number') out.input_tokens = u.prompt_tokens;
  if (typeof u.completion_tokens === 'number') out.output_tokens = u.completion_tokens;
  // OpenAI prompt-cache hits live in a details sub-object: Responses uses
  // `input_tokens_details.cached_tokens`, Chat uses `prompt_tokens_details`.
  const details =
    (u.input_tokens_details as Record<string, unknown> | undefined) ??
    (u.prompt_tokens_details as Record<string, unknown> | undefined);
  if (details && typeof details.cached_tokens === 'number') {
    out.cached_tokens = details.cached_tokens;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function measureOpenAIChoices(obj: Record<string, unknown>, m: OutputMeasurement): void {
  const choices = obj.choices;
  if (!Array.isArray(choices)) return;
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue;
    const c = choice as { delta?: unknown; message?: unknown };
    const payload = (c.delta ?? c.message) as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') continue;
    if (typeof payload.content === 'string') m.textChars += payload.content.length;
    const toolCalls = payload.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const fn = (tc as { function?: unknown } | undefined)?.function;
        const args = (fn as { arguments?: unknown } | undefined)?.arguments;
        if (typeof args === 'string') m.toolUseChars += args.length;
      }
    }
  }
}

/** Measure non-streaming messages.content[] — same OutputMeasurement shape as the SSE accumulator. */
function measureFromMessageJson(j: unknown): OutputMeasurement {
  const m: OutputMeasurement = { textChars: 0, thinkingChars: 0, toolUseChars: 0, redactedBlockCount: 0 };
  if (j && typeof j === 'object') measureOpenAIChoices(j as Record<string, unknown>, m);
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

/** Stop reason from a non-streaming response JSON: Anthropic `stop_reason`,
 *  OpenAI chat `choices[].finish_reason`, Responses `incomplete_details.reason`. */
function readStopReasonFromJson(j: unknown): string | undefined {
  if (!j || typeof j !== 'object') return undefined;
  const obj = j as {
    stop_reason?: unknown;
    choices?: unknown;
    status?: unknown;
    incomplete_details?: { reason?: unknown };
  };
  if (typeof obj.stop_reason === 'string') return obj.stop_reason;
  if (Array.isArray(obj.choices)) {
    for (const c of obj.choices) {
      const fr = (c as { finish_reason?: unknown } | undefined)?.finish_reason;
      if (typeof fr === 'string') return fr;
    }
  }
  if (obj.status === 'incomplete') {
    const reason = obj.incomplete_details?.reason;
    return typeof reason === 'string' ? reason : 'incomplete';
  }
  return undefined;
}

/**
 * Tee the response body to extract usage + output measurement without blocking the client.
 * Streams are scanned to EOF (final output_tokens is in message_delta; redacted_thinking
 * blocks can appear anywhere). 4xx bodies are capped at ERROR_BODY_MAX. 5xx is skipped.
 */
function teeForUsage(res: Response): {
  response: Response;
  usagePromise: Promise<Usage | undefined>;
  errorBodyPromise: Promise<string | undefined>;
  measurementPromise: Promise<OutputMeasurement | undefined>;
  stopReasonPromise: Promise<string | undefined>;
} {
  // No body at all: nothing to extract on either path.
  if (!res.body) {
    return {
      response: res,
      usagePromise: Promise.resolve(undefined),
      errorBodyPromise: Promise.resolve(undefined),
      measurementPromise: Promise.resolve(undefined),
      stopReasonPromise: Promise.resolve(undefined),
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
        /* client may have aborted */
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
      stopReasonPromise: Promise.resolve(undefined),
    };
  }
  // 5xx: skip both (the host already synthesizes an error message).
  if (res.status >= 500) {
    return {
      response: res,
      usagePromise: Promise.resolve(undefined),
      errorBodyPromise: Promise.resolve(undefined),
      measurementPromise: Promise.resolve(undefined),
      stopReasonPromise: Promise.resolve(undefined),
    };
  }
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  const [forClient, forUs] = res.body.tee();

  // Single read loop resolves all three; exposed as separate promises for call-site readability.
  const scanResult = (async (): Promise<{
    usage: Usage | undefined;
    measurement: OutputMeasurement | undefined;
    stopReason: string | undefined;
  }> => {
    const reader = forUs.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    try {
      if (ct.includes('text/event-stream')) {
        // Walk every SSE event to EOF — message_delta (final output_tokens) is last.
        const m: OutputMeasurement = {
          textChars: 0,
          thinkingChars: 0,
          toolUseChars: 0,
          redactedBlockCount: 0,
        };
        const state: { usage: Usage | undefined; stopReason: string | undefined } = {
          usage: undefined,
          stopReason: undefined,
        };
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // SSE events are terminated by a blank line.
          let evEnd: number;
          while ((evEnd = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, evEnd);
            buf = buf.slice(evEnd + 2);
            processSseEvent(block, m, state);
          }
        }
        buf += decoder.decode();
        if (buf.trim().length > 0) processSseEvent(buf, m, state); // trailing partial event
        return { usage: state.usage, measurement: m, stopReason: state.stopReason };
      }

      if (ct.includes('application/json')) {
        // Buffer fully, capped at 4 MiB.
        const MAX = 4 * 1024 * 1024;
        while (buf.length < MAX) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
        }
        try {
          const j = JSON.parse(buf);
          return {
            usage: normalizeUsage(j?.usage),
            measurement: measureFromMessageJson(j),
            stopReason: readStopReasonFromJson(j),
          };
        } catch {
          return { usage: undefined, measurement: undefined, stopReason: undefined };
        }
      }
    } catch {
      /* tee released early (client abort) */
    }
    // Unknown content-type: drain to release the tee buffer.
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      /* ignore */
    }
    return { usage: undefined, measurement: undefined, stopReason: undefined };
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
    stopReasonPromise: scanResult.then((s) => s.stopReason),
  };
}

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';
const DEFAULT_OPENAI_UPSTREAM = 'https://api.openai.com';

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

const PASSTHROUGH_PREFIXES = [
  '/anthropic/',
  '/openai/',
  '/google-ai-studio/',
  '/compat/',
] as const;

function isProviderPrefixedPath(pathname: string): boolean {
  return PASSTHROUGH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isOpenAIChatPath(pathname: string): boolean {
  return pathname === '/v1/chat/completions' || pathname === '/openai/v1/chat/completions';
}

function isOpenAIResponsesPath(pathname: string): boolean {
  return pathname === '/v1/responses'
    || pathname === '/openai/v1/responses'
    || pathname === '/openai/responses';
}

function isCanonicalOpenAIPath(pathname: string, headers: Headers, hasOpenAIKey: boolean): boolean {
  const isModelsPath = pathname === '/v1/models' || pathname.startsWith('/v1/models/');
  // `/v1/models` exists on BOTH APIs, so it is routed by auth style — but an
  // `sk-ant-…` bearer is Anthropic by construction (Claude Code subscription
  // auth sends `authorization: Bearer sk-ant-oat01-…` with no x-api-key).
  // Without this check that OAuth token would be forwarded to the OpenAI
  // upstream: a credential leak, and a guaranteed 401.
  const bearerIsAnthropic = /^Bearer\s+sk-ant-/i.test(headers.get('authorization') ?? '');
  const looksOpenAIAuth =
    hasOpenAIKey || (headers.has('authorization') && !headers.has('x-api-key') && !bearerIsAnthropic);
  return pathname === '/v1/chat/completions'
    || pathname === '/v1/responses'
    || pathname.startsWith('/v1/responses/')
    || (isModelsPath && looksOpenAIAuth);
}

/** POST /v1/messages/count_tokens with the given body. Returns the upstream's
 *  `input_tokens` number or null on any failure. count_tokens is documented
 *  as a free endpoint (no input-token billing) — we use it once per request
 *  on the PRE-COMPRESSION body to get the ground-truth baseline. Actual
 *  post-compression tokens already come back free in the /v1/messages usage
 *  block (input_tokens + cache_create + cache_read), so no second probe. */
async function countTokensUpstream(
  countTokensUrl: string,
  body: Uint8Array,
  headers: Headers,
): Promise<number | null> {
  try {
    const res = await fetch(countTokensUrl, {
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

/** Resolve upstream URLs from config. Pure — unit-testable. */
export function resolveUpstreams(config: ProxyConfig): {
  anthropic: string;
  openai: string;
  stripOpenAIV1: boolean;
} {
  if (config.provider === 'cloudflare-ai-gateway') {
    const base = (config.gatewayBaseUrl ?? '').replace(/\/+$/, '');
    if (!base) {
      throw new Error(
        "provider 'cloudflare-ai-gateway' requires gatewayBaseUrl (PXPIPE_GATEWAY_BASE_URL)",
      );
    }
    return { anthropic: `${base}/anthropic`, openai: `${base}/openai`, stripOpenAIV1: true };
  }
  return {
    anthropic: (config.upstream ?? DEFAULT_UPSTREAM).replace(/\/+$/, ''),
    openai: (config.openAIUpstream ?? DEFAULT_OPENAI_UPSTREAM).replace(/\/+$/, ''),
    stripOpenAIV1: false,
  };
}

/** Parse PXPIPE_GATEWAY_HEADERS — JSON object or `k=v;k2=v2`. */
export function parseGatewayHeaders(spec: string | undefined): Record<string, string> {
  if (!spec) return {};
  const trimmed = spec.trim();
  if (trimmed.startsWith('{')) {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = String(v);
    return out;
  }
  const out: Record<string, string> = {};
  for (const pair of trimmed.split(';')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

/** Build the proxy fetch handler. */
export function createProxy(config: ProxyConfig = {}) {
  const modelRoutes = new Map<string, 'openai' | 'cloudflare'>();
  // Explicit precedence: Cloudflare > OpenAI > normal family routing.
  for (const model of config.openAIModels ?? []) {
    const id = model.trim();
    if (id) modelRoutes.set(id, 'openai');
  }
  for (const model of config.cloudflareModels ?? []) {
    const id = model.trim();
    if (id) modelRoutes.set(id, 'cloudflare');
  }
  if ((config.cloudflareModels?.length ?? 0) > 0 && config.cloudflareUpstream === undefined) {
    throw new Error('cloudflareModels requires a Cloudflare chat upstream');
  }
  const routes = resolveUpstreams(config);
  const upstream = routes.anthropic;
  const openAIUpstream = routes.openai;
  const passthroughUpstream = config.provider === 'cloudflare-ai-gateway'
    ? (config.gatewayBaseUrl ?? '').replace(/\/+$/, '')
    : upstream;
  const gatewayHeaders = config.gatewayHeaders ?? {};
  const applyGatewayHeaders = (h: Headers): Headers => {
    for (const [k, v] of Object.entries(gatewayHeaders)) h.set(k, v);
    return h;
  };

  return async function handle(req: Request): Promise<Response> {
    const t0 = Date.now();
    const url = new URL(req.url);
    const path = url.pathname + url.search;

    // Reversibly disguise the configured upstream id for Claude Code's model
    // picker, matching CLIProxyAPI. The id decodes back to the exact provider
    // model on /v1/messages, so discovery and routing cannot drift apart.
    if (req.method === 'GET' && url.pathname === '/v1/models'
        && config.cloudflareUpstream !== undefined) {
      const configuredModels = config.cloudflareModels?.filter(Boolean) ?? [];
      const models = configuredModels.map((model) => ({
            id: claudeGatewayModelId(model),
            type: 'model',
            display_name: cloudflareModelDisplayName(model),
            created_at: '1970-01-01T00:00:00Z',
          }));
      return new Response(JSON.stringify({
        data: models,
        has_more: false,
        first_id: models[0]?.id ?? '',
        last_id: models.at(-1)?.id ?? '',
      }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // reqBodyBytes: kept for lazy gzip on 4xx. reqBodySha8: computed eagerly for correlation.
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
      stopReason?: string,
    ): void => {
      const is4xx = status >= 400 && status < 500;
      // Gzip body lazily (only on 4xx). Async IIFE keeps fire() synchronous.
      const finalize = async (): Promise<void> => {
        let reqBodyGz: Uint8Array | undefined;
        if (config.captureErrorReqBody && is4xx && reqBodyBytes && reqBodyBytes.byteLength > 0) {
          try {
            reqBodyGz = await gzipBytes(reqBodyBytes);
          } catch {
            // Non-fatal — drop body sample.
          }
        }
        // Await both count_tokens probes so baseline numbers land on the same event row.
        // Each probe is independent; null leaves the field absent and dashboard math degrades cleanly.
        if (info && baselineStatusApplies) {
          // Track both halves so the dashboard can gate on probe completeness (partial vs ok).
          // A missing cacheable-prefix probe must NOT be treated as cacheable=0 — that fabricates savings.
          let baselineResolved: number | null = null;
          let cacheableExpected = false;
          let cacheableResolved: number | null = null;
          if (baselinePromise) {
            try {
              baselineResolved = await baselinePromise;
              if (baselineResolved !== null) info.baselineTokens = baselineResolved;
            } catch {
              /* probe threw — drop */
            }
          }
          if (baselineCacheablePromise) {
            cacheableExpected = true;
            try {
              cacheableResolved = await baselineCacheablePromise;
              if (cacheableResolved !== null) info.baselineCacheableTokens = cacheableResolved;
            } catch {
              /* probe threw */
            }
          }
          if (baselineResolved === null) {
            info.baselineProbeStatus = 'failed';
          } else if (cacheableExpected && cacheableResolved === null) {
            info.baselineProbeStatus = 'partial'; // dashboard excludes row; must not treat as cacheable=0
          } else {
            info.baselineProbeStatus = 'ok';
          }
        }
        // The Messages compatibility response exposes Anthropic's disjoint
        // usage buckets to the client. Dashboard accounting still needs the
        // original Responses semantics: input includes the cached subset.
        const eventUsage = bridgedGptMessages && usage
          ? {
              ...usage,
              input_tokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
              cached_tokens: usage.cache_read_input_tokens ?? 0,
            }
          : usage;
        await config.onRequest?.({
          method: req.method,
          path: url.pathname,
          model: requestModel,
          // Provider-prefixed OpenCode routes such as `/openai/responses` are
          // Responses-shaped even though they are not canonical `/v1/*` paths.
          // Classify by the parsed wire route, otherwise the dashboard ignores
          // GPT image/baseline telemetry and renders As text / Saved as dashes.
          accountingProvider:
            isOpenAIChat || isOpenAIResponses || bridgedGptMessages || bridgedChatMessages
              ? 'openai'
              : 'anthropic',
          status,
          durationMs: Date.now() - t0,
          firstByteMs,
          info,
          usage: eventUsage,
          error,
          errorBody,
          reqBodySha8,
          reqBodyGz,
          measurement,
          stopReason,
        });
      };
      void finalize();
    };

    // Transform only known shapes; everything else passes through.
    const providerPrefixed = isProviderPrefixedPath(url.pathname);
    const isMessages = req.method === 'POST' && isAnthropicMessagesPath(url.pathname);
    const isOpenAIChat = req.method === 'POST' && isOpenAIChatPath(url.pathname);
    const isOpenAIResponses = req.method === 'POST' && isOpenAIResponsesPath(url.pathname);
    const isOpenAIPath = isCanonicalOpenAIPath(
      url.pathname,
      req.headers,
      config.openAIApiKey !== undefined,
    );
    const upstreamBase = providerPrefixed ? passthroughUpstream : isOpenAIPath ? openAIUpstream : upstream;

    let bodyOut: BodyInit | null = null;
    let info: TransformInfo | undefined;
    let requestModel: string | undefined;
    let bridgedGptMessages = false;
    let bridgedChatMessages = false;
    let modelRouteForRequest: 'openai' | 'cloudflare' | undefined;

    // Two count_tokens probes on the pre-compression body (see docs/HISTORY_CACHE_MODEL.md):
    //   baselinePromise          → full-body input_tokens
    //   baselineCacheablePromise → input_tokens truncated at last cache_control marker
    // Dashboard combines them for cache-aware baseline. Both run in parallel with the main forward.
    let baselinePromise: Promise<number | null> | undefined;
    let baselineCacheablePromise: Promise<number | null> | undefined;
    let baselineStatusApplies = false;

    if (isMessages || isOpenAIChat || isOpenAIResponses) {
      const bodyIn = new Uint8Array(await req.arrayBuffer());
      try {
        const transformOpts =
          typeof config.transform === 'function' ? config.transform() : config.transform;
        // Fail-closed: unreadable model → no compression, not a risky guess.
        const model = readModelField(bodyIn);
        requestModel = model ?? undefined;
        // /v1/messages is only a wire schema: Claude Code can target a non-
        // Anthropic model (for example GPT-5.6 Sol). Do not apply Claude's
        // renderer or Anthropic count_tokens merely because the route is
        // Messages-shaped. Enabled GPT models take the standalone
        // Messages→Responses bridge; unsupported models still fail closed.
        // Claude Code model aliases decode back to exact Cloudflare model IDs.
        const decodedByAlias = [...modelRoutes.keys()]
          .find((candidate) => claudeGatewayModelId(candidate) === model);
        const decodedChatModel = decodedByAlias ?? resolveClaudeGatewayModelId(model);
        const routedModel = decodedChatModel ?? model;
        const modelRoute = routedModel ? modelRoutes.get(routedModel) : undefined;
        modelRouteForRequest = modelRoute;
        const forceChat = isMessages && modelRoute === 'cloudflare';
        const messagesAnthropic = isMessages
          && modelRoute === undefined && !forceChat && isClaudeModel(model);
        // Provider routing is explicit. Unlisted Messages models use the
        // default Anthropic route, regardless of how their id is shaped.
        bridgedGptMessages =
          isMessages && !messagesAnthropic && !forceChat
          && modelRoute === 'openai';
        // Messages → Chat Completions bridge toward Cloudflare Workers AI.
        bridgedChatMessages = forceChat;
        const chatStamp = bridgedChatMessages ? routedModel : undefined;
        const effectiveModel = chatStamp ?? model;
        const modelOk = isMessages
          ? (messagesAnthropic && isPxpipeSupportedModel(model))
            || bridgedGptMessages
            || (bridgedChatMessages && isPxpipeSupportedGptModel(effectiveModel))
          : isPxpipeSupportedGptModel(model);
        // Compression eligibility and telemetry follow the model that actually
        // receives the request, not Claude Code's local gateway alias.
        if (bridgedChatMessages && effectiveModel) requestModel = effectiveModel;
        const effectiveOpts = modelOk
          ? transformOpts
          : { ...transformOpts, compress: false };
        const bridgeBody = bridgedGptMessages
          ? anthropicMessagesToOpenAIResponses(bodyIn)
          : bridgedChatMessages
            ? anthropicMessagesToOpenAIChat(bodyIn, chatStamp ?? undefined)
            : bodyIn;
        const r = isMessages
          ? bridgedGptMessages
            ? await transformOpenAIResponses(bridgeBody, effectiveOpts)
            : bridgedChatMessages
              ? await transformOpenAIChatCompletions(bridgeBody, effectiveOpts)
              : await transformRequest(bodyIn, effectiveOpts)
          : isOpenAIChat
            ? await transformOpenAIChatCompletions(bodyIn, effectiveOpts)
            : await transformOpenAIResponses(bodyIn, effectiveOpts);
        if (!modelOk) r.info.reason = 'unsupported_model';
        bodyOut = r.body as unknown as BodyInit; // TS narrows Uint8Array away from BodyInit
        info = r.info;
        reqBodyBytes = r.body;
        if (r.body.byteLength > 0) {
          reqBodySha8 = await sha8Bytes(r.body);
        }

        if (isMessages && messagesAnthropic) {
          baselineStatusApplies = true;
          // Probes fire on the ORIGINAL body before the main forward so all three overlap.
          // count_tokens is not billed; ~30-80ms latency is hidden by the main forward.
          const ctBody = buildBaselineCountTokensBody(bodyIn);
          if (ctBody) {
            const ctHeaders = applyGatewayHeaders(filterHeaders(req.headers, STRIP_REQ_HEADERS));
            ctHeaders.set('content-type', 'application/json');
            if (config.apiKey) ctHeaders.set('x-api-key', config.apiKey);
            // Mirror the actual outbound request base+path: count_tokens lives at
            // `<messages-path>/count_tokens`, so provider-prefixed routes like
            // `/anthropic/messages` probe `/anthropic/messages/count_tokens`.
            const ctBase = providerPrefixed ? passthroughUpstream : upstream;
            const ctUrl = ctBase + url.pathname + '/count_tokens';
            baselinePromise = countTokensUpstream(ctUrl, ctBody, ctHeaders);
            // Null = no markers → cacheable=0 by definition, no probe needed.
            const ctCacheableBody = buildCacheablePrefixCountTokensBody(bodyIn);
            if (ctCacheableBody) {
              baselineCacheablePromise = countTokensUpstream(
                ctUrl,
                ctCacheableBody,
                new Headers(ctHeaders),
              );
            }
          }
        }
      } catch (e) {
        if ((bridgedGptMessages || bridgedChatMessages) && (e as Error).name === 'MessagesBridgeInvalidRequest') {
          fire(400, undefined, `invalid_request: ${(e as Error).message}`);
          return new Response(JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: (e as Error).message },
          }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
        fire(502, undefined, `transform_error: ${(e as Error).message}`);
        return new Response(JSON.stringify({ error: 'pxpipe transform failed' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
    } else {
      bodyOut = req.body; // pass through unchanged
    }

    const outHeaders = filterHeaders(req.headers, STRIP_REQ_HEADERS);
    if (isOpenAIPath || bridgedGptMessages || bridgedChatMessages) {
      outHeaders.delete('x-api-key');
      // Never forward a Messages client's bearer credential across providers.
      // A configured upstream key is installed below; otherwise auth stays absent.
      if (bridgedGptMessages || bridgedChatMessages) outHeaders.delete('authorization');
      const anthropicHeaders: string[] = [];
      outHeaders.forEach((_value, name) => {
        if (name.toLowerCase().startsWith('anthropic-')) anthropicHeaders.push(name);
      });
      for (const name of anthropicHeaders) outHeaders.delete(name);
      // The chat bridge uses the Cloudflare token; Responses uses the OpenAI key.
      const bridgeKey = bridgedChatMessages
        ? config.cloudflareApiKey
        : config.openAIApiKey;
      if (bridgeKey) outHeaders.set('authorization', `Bearer ${bridgeKey}`);
    } else if (config.apiKey && (!providerPrefixed || url.pathname.startsWith('/anthropic/'))) {
      outHeaders.set('x-api-key', config.apiKey);
    }

    applyGatewayHeaders(outHeaders);

    // Gateway OpenAI routes drop the `/v1` prefix; provider-prefixed passthrough
    // routes keep their full path so ocproxy-style upstreams see `/openai/*`,
    // `/google-ai-studio/*`, etc. exactly as the client sent them.
    // The chat bridge forwards to the configured Cloudflare upstream at its
    // /chat/completions endpoint (chatCompletionsUrl normalizes a bare base,
    // a /v1 base, or a full …/chat/completions URL). Every other route appends
    // a path to its resolved base.
    let upstreamUrl: string;
    if (bridgedChatMessages) {
      upstreamUrl = chatCompletionsUrl(config.cloudflareUpstream ?? '');
    } else {
      const outPath = bridgedGptMessages
        ? (routes.stripOpenAIV1 ? '/responses' : '/v1/responses')
        : isOpenAIPath && routes.stripOpenAIV1 ? path.replace(/^\/v1(?=\/)/, '') : path;
      const requestUpstreamBase = bridgedGptMessages ? openAIUpstream : upstreamBase;
      upstreamUrl = requestUpstreamBase + outPath;
    }
    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        method: req.method,
        headers: outHeaders,
        body: bodyOut,
        // duplex is required by spec when sending a stream as body
        ...(bodyOut instanceof ReadableStream ? { duplex: 'half' } : {}),
      } as RequestInit);
      if (bridgedGptMessages) {
        upstreamRes = await openAIResponsesToAnthropicResponse(upstreamRes, requestModel ?? '');
      } else if (bridgedChatMessages) {
        upstreamRes = await openAIChatToAnthropicResponse(upstreamRes, requestModel ?? '');
      }
    } catch (e) {
      fire(502, info, `upstream_error: ${(e as Error).message}`);
      return new Response(JSON.stringify({ error: 'pxpipe upstream unreachable' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    }

    const firstByteMs = Date.now() - t0;

    // Tee: client gets one side; scanner reads the other for usage/measurement/error body.
    const { response: teed, usagePromise, errorBodyPromise, measurementPromise, stopReasonPromise } =
      teeForUsage(upstreamRes);

    // Fire event in background once all four resolve (all share the same stream read).
    void Promise.all([
      usagePromise.catch(() => undefined),
      errorBodyPromise.catch(() => undefined),
      measurementPromise.catch(() => undefined),
      stopReasonPromise.catch(() => undefined),
    ]).then(([usage, errorBody, measurement, stopReason]) =>
      fire(upstreamRes.status, info, undefined, firstByteMs, usage, errorBody, measurement, stopReason),
    );

    return new Response(teed.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: filterHeaders(upstreamRes.headers, STRIP_RES_HEADERS),
    });
  };
}
