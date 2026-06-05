/**
 * Cloudflare Workers entrypoint. Identical proxy logic to the Node build,
 * just wired up through the Worker `fetch` export.
 *
 * Deploy:
 *   npx wrangler deploy
 *
 * Dev:
 *   npx wrangler dev
 *
 * Config lives in wrangler.toml.
 */

import { createProxy, type ProxyConfig } from './core/proxy.js';
import type { TransformOptions } from './core/transform.js';
import { toTrackEvent, JsonLogTracker, noopTracker, type Tracker } from './core/tracker.js';

export interface Env {
  ANTHROPIC_UPSTREAM?: string;
  /** Optional override — if set, replaces whatever x-api-key the client sent. */
  ANTHROPIC_API_KEY?: string;
  OPENAI_UPSTREAM?: string;
  /** Optional override — if set, replaces whatever Authorization the client sent. */
  OPENAI_API_KEY?: string;
  COMPRESS?: string;
  COMPRESS_TOOLS?: string;
  COMPRESS_SCHEMAS?: string;
  COMPRESS_REMINDERS?: string;
  COMPRESS_TOOL_RESULTS?: string;
  MIN_COMPRESS_CHARS?: string;
  MIN_REMINDER_CHARS?: string;
  MIN_TOOL_RESULT_CHARS?: string;
  COLS?: string;
  /** R2 multi-column packing — default 1 (off). 2 squeezes ~2× source rows
   *  per image; OCR-verify before flipping in production. */
  MULTI_COL?: string;
  /** When "0" / "false", disable per-request event JSON logs. Default-on.
   *  Cloudflare ingests console.log as Workers Logs; pipe via Logpush to
   *  R2/S3 for the same JSONL shape Node writes to disk. */
  PIXELPIPE_TRACK?: string;
}

const truthy = (v: string | undefined, fallback: boolean): boolean =>
  v == null ? fallback : v === '1' || v.toLowerCase() === 'true';

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const transform: TransformOptions = {
      compress: truthy(env.COMPRESS, true),
      compressTools: truthy(env.COMPRESS_TOOLS, true),
      compressSchemas: truthy(env.COMPRESS_SCHEMAS, true),
      compressReminders: truthy(env.COMPRESS_REMINDERS, true),
      compressToolResults: truthy(env.COMPRESS_TOOL_RESULTS, true),
      minCompressChars: env.MIN_COMPRESS_CHARS ? Number(env.MIN_COMPRESS_CHARS) : 2000,
      // 500 chars — CPU/latency floor only, not a correctness guard. The
      // No floors — the content-aware `isCompressionProfitable()` gate
      // decides per-block based on actual pixel cost vs text cost. Host
      // can still set a floor via env if they want observability buckets
      // (e.g. MIN_TOOL_RESULT_CHARS=200 to skip absurdly small dumps).
      minReminderChars: env.MIN_REMINDER_CHARS ? Number(env.MIN_REMINDER_CHARS) : 0,
      minToolResultChars: env.MIN_TOOL_RESULT_CHARS ? Number(env.MIN_TOOL_RESULT_CHARS) : 0,
      cols: env.COLS ? Number(env.COLS) : 100,
      // R2 multi-column ON (2 cols) — single-col drops below break-even on
      // real tool-doc slabs. Override via MULTI_COL=1 if OCR misreads layout.
      multiCol: env.MULTI_COL ? Math.max(1, Number(env.MULTI_COL) | 0) : 2,
    };
    const trackingOn = truthy(env.PIXELPIPE_TRACK, true);
    // Workers Logs ingests stdout as separate log lines. Emit one JSON line
    // per event so downstream (Logpush → R2/S3) reads the same JSONL shape
    // the Node host writes to disk.
    const tracker: Tracker = trackingOn ? new JsonLogTracker((s) => console.log(s)) : noopTracker;

    const config: ProxyConfig = {
      upstream: env.ANTHROPIC_UPSTREAM ?? 'https://api.anthropic.com',
      apiKey: env.ANTHROPIC_API_KEY,
      openAIUpstream: env.OPENAI_UPSTREAM ?? 'https://api.openai.com',
      openAIApiKey: env.OPENAI_API_KEY,
      transform,
      onRequest: (e) => {
        // Terse human-readable line (separate from the JSON event below;
        // shows up in `wrangler tail`).
        const tag = e.info?.compressed
          ? `compressed ${e.info.origChars}ch → ${e.info.imageCount}img/${e.info.imageBytes}B`
          : (e.info?.reason ?? '');
        const cacheRead = e.usage?.cache_read_input_tokens ?? 0;
        console.log(`${e.method} ${e.path} → ${e.status} (${e.durationMs}ms) ${tag} cache_read=${cacheRead}`);

        if (e.info?.unknownStaticTags && e.info.unknownStaticTags.length > 0) {
          console.warn(
            `[pixelpipe warn] unknown tag(s) in static slab: ${e.info.unknownStaticTags.join(', ')}`,
          );
        }

        tracker.emit(toTrackEvent(e));
      },
    };
    const handle = createProxy(config);
    return handle(req);
  },
};
