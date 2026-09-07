/**
 * Per-session cache-liveness state for the history collapse.
 *
 * ## Why this exists
 *
 * The history grid is append-only: chunk N's pixels are a pure function of its
 * message range, so old chunks stay byte-identical as the conversation grows and
 * ride Anthropic's prompt cache as `cache_read` forever. That freeze is worth a
 * lot — but only while a cache actually exists. Where there is none, the freeze
 * protects nothing and the grid is free to be re-cut for *density* instead:
 * {@link HistoryCollapseOptions.packFill} raises the freeze step until the pages
 * are nearly full, which roughly halves image tokens on long sessions of short
 * turns (#161: 317 images at 43% fill).
 *
 * ## How we know whether a cache exists
 *
 * The provider tells us, and that beats inferring it. {@link noteCacheOutcome}
 * feeds each response's accounting back in: a `cache_read` proves the prefix was
 * live, a `cache_create` proves one was just written. Only when both are zero is
 * there nothing to lose by re-cutting.
 *
 * This module used to decide from the wall clock alone, treating any gap past the
 * ephemeral 5-minute TTL as cold. That was wrong most of the times it fired —
 * measured over 143 gaps on a production host, the cache was still warm in 66% of
 * gaps past 5.5 minutes, 40% past 15 minutes, 13% past an hour. Claude Code marks
 * some blocks with the 1-hour TTL, so the short constant never described this
 * traffic. The worst case was a session repacked three times in one hour on
 * ~10-minute gaps, each repack re-keying the whole prefix — and each preceded by a
 * turn that had just *written* a cache, which the clock could not see.
 *
 * The clock survives only as a backstop for responses whose accounting never
 * arrived: {@link COLD_HORIZON_MS}. And a rejected request still marks the session
 * dead outright ({@link markCacheDead}) — but only a 413 or a too-long 400, not
 * a transient 5xx: see {@link responseLeftNoCache}.
 *
 * ## Why the step is sticky
 *
 * Once a session has been repacked coarse, every later turn must keep at least
 * that step. Falling back to the fine grid would re-cut the same messages into
 * different chunks — every chunk's bytes change, and the whole history re-keys as
 * `cache_create`. {@link recordFreezeStep} pins the floor; the collapse only ever
 * doubles it.
 *
 * ## Failure mode we deliberately accept
 *
 * State is in-memory and per proxy process. After a restart a live session looks
 * *unknown*, and unknown is treated as WARM (no repack) — the conservative
 * choice: at worst we keep paying the old image count, we never nuke a live cache
 * on a guess. The state re-arms itself on the first idle gap after the restart.
 */

/** Sessions tracked before the oldest is evicted. One small record each. */
const SESSIONS_MAX = 512;

/**
 * Grace added to the provider TTL before we call a cache dead. Our clock is the
 * request-arrival time, the provider's is its own; a request that lands one
 * second inside the window can still miss. Only gaps clearly past the TTL flip
 * the session cold, so a borderline case keeps the (cheap, correct) warm path.
 */
const COLD_GRACE_MS = 30_000;

/**
 * Idle gap past which we treat an unobserved cache as gone.
 *
 * Not the ephemeral-tier TTL (`CACHE_TTL_SEC`, 5 minutes). Using that here declared sessions cold while their caches were
 * demonstrably alive: 66% of gaps past 5.5 minutes still cache-read, 40% past
 * 15 minutes, 13% past an hour (143 gaps, one production host). Claude Code marks
 * some blocks with the 1-hour TTL, so the short constant never described this
 * traffic.
 *
 * An hour plus the grace is where the evidence turns: past it, warmth is the
 * exception. This is only a backstop anyway — {@link noteCacheOutcome} answers
 * from the provider's own accounting whenever a response has been seen.
 */
const COLD_HORIZON_MS = 3_600_000 + COLD_GRACE_MS;

interface SessionRecord {
  /** Wall-clock ms of the last request we saw for this session. */
  lastSeenMs: number;
  /** Coarsest freeze step this session has been rendered at, in messages. */
  freezeStep: number;
  /** Set when a request for this session failed in a way that leaves no cache. */
  cacheDead: boolean;
  /**
   * Did the provider's own accounting show a cache for this session on the last
   * response — either read from it, or written to it? `undefined` = not observed
   * yet. This is the server's answer to a question the clock can only guess at.
   */
  lastCacheAlive?: boolean;
  /**
   * Has this session EVER shown a cache? Absence of caching is not the same fact
   * as a cache that died: a request carrying no `cache_control` marker reports
   * both counters zero forever, and repacking such a session every turn would
   * re-cut the grid over and over for a cache that never existed. Only a session
   * that once had one, and then lost it, has provably free room to re-cut.
   */
  everCacheAlive?: boolean;
  /**
   * Consecutive 429s for this session, reset on any non-429 response. See
   * {@link isRateLimitCircuitOpen}.
   */
  consecutive429: number;
}

/**
 * Consecutive 429s after which a session stops being imaged. See
 * {@link isRateLimitCircuitOpen}.
 */
const RATE_LIMIT_CIRCUIT_THRESHOLD = 3;

const sessions = new Map<string, SessionRecord>();

function touch(key: string): SessionRecord {
  const existing = sessions.get(key);
  if (existing) {
    sessions.delete(key); // refresh LRU position
    sessions.set(key, existing);
    return existing;
  }
  const fresh: SessionRecord = { lastSeenMs: 0, freezeStep: 0, cacheDead: false, consecutive429: 0 };
  sessions.set(key, fresh);
  while (sessions.size > SESSIONS_MAX) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
  return fresh;
}

export interface HistorySessionState {
  /** The upstream prefix cache is provably gone — re-cutting the grid is free. */
  cold: boolean;
  /** Floor for the freeze step, in messages. 0 = no constraint. */
  minFreezeStep: number;
}

/** Neutral answer for callers without a session identity (no fingerprint yet). */
const UNKNOWN_STATE: HistorySessionState = { cold: false, minFreezeStep: 0 };

/**
 * Record a request for `sessionKey` and report what the history collapse may
 * assume about the upstream cache. Call once per transformed request, BEFORE the
 * collapse runs; it advances the session's last-seen clock.
 *
 * A session we have never seen counts as warm (see module docs) — unknown must
 * never authorize a repack.
 */
export function noteHistoryRequest(
  sessionKey: string | undefined,
  nowMs: number = Date.now(),
): HistorySessionState {
  if (!sessionKey) return UNKNOWN_STATE;
  const rec = touch(sessionKey);
  const known = rec.lastSeenMs > 0;
  const idleMs = nowMs - rec.lastSeenMs;

  // Server truth beats the clock. If the provider's accounting showed a cache on
  // the last response — read from OR written to — one exists now, and re-cutting
  // the grid would throw it away.
  //
  // The clock alone was wrong most of the time it mattered. Measured over 143
  // gaps on a production host: past a 5.5-minute gap the cache was still warm in
  // 66% of cases, past 15 minutes in 40%, past an hour in 13%. One session was
  // repacked three times in an hour on ~10-minute gaps, each time re-keying the
  // whole prefix — and each of those turns had just WRITTEN a cache
  // (create 60-98k, read 0), which the clock could not see and this can.
  const serverSaysAlive = rec.lastCacheAlive === true;
  // "Gone" requires that one existed. A session whose counters were always zero
  // is not a dead cache, it is a session that never had one — repacking it every
  // turn would churn the grid forever for nothing to reclaim.
  const serverSaysGone = rec.lastCacheAlive === false && rec.everCacheAlive === true;

  // Backstop for the case the server cannot answer: no observation yet, or an
  // observation old enough that warmth is empirically rare (13% past an hour).
  const beyondHorizon = known && idleMs > COLD_HORIZON_MS;

  const cold = rec.cacheDead || (!serverSaysAlive && (serverSaysGone || beyondHorizon));
  rec.lastSeenMs = nowMs;
  rec.cacheDead = false; // consumed: this request gets the repack
  return { cold, minFreezeStep: rec.freezeStep };
}

/**
 * Feed the provider's cache accounting back in, once per response.
 *
 * `read > 0` proves the prefix was live. `create > 0` proves one was just
 * written, which is the case the wall clock got wrong: a turn that paid to build
 * a cache looks identical to a turn that found none, and repacking on top of it
 * discards the thing just paid for.
 *
 * Both zero means nothing is cached for this session, so a repack costs nothing
 * — that is the only situation where coarsening the grid is free.
 */
export function noteCacheOutcome(
  sessionKey: string | undefined,
  cacheReadTokens: number | undefined,
  cacheCreateTokens: number | undefined,
): void {
  if (!sessionKey) return;
  const rec = sessions.get(sessionKey);
  if (!rec) return; // never transformed under this key — nothing to attribute
  const alive = (cacheReadTokens ?? 0) > 0 || (cacheCreateTokens ?? 0) > 0;
  rec.lastCacheAlive = alive;
  if (alive) rec.everCacheAlive = true;
}

/**
 * Pin the grid this session was last rendered at. Monotonic: the floor only ever
 * rises, because a later, finer render would re-key every chunk it re-cuts.
 */
export function recordFreezeStep(
  sessionKey: string | undefined,
  step: number | undefined,
): void {
  if (!sessionKey || !step || !Number.isFinite(step) || step <= 0) return;
  const rec = touch(sessionKey);
  if (step > rec.freezeStep) rec.freezeStep = step;
}

/**
 * Mark this session's upstream cache as gone: the last request was rejected, so
 * nothing was cached and the next one may re-cut the grid for density. Call on
 * the failure paths that leave no cache entry (oversized request → opaque 500).
 */
export function markCacheDead(sessionKey: string | undefined): void {
  if (!sessionKey) return;
  touch(sessionKey).cacheDead = true;
}

/**
 * Did this response leave the upstream prefix cache unpopulated?
 *
 * A cache entry is written by a request the provider actually *accepted*. Three
 * outcomes mean it never got that far, so the frozen grid we were protecting
 * protects nothing and the next turn may re-cut for density:
 *
 *  - `413` — the payload was rejected outright;
 *  - `400` whose body says the prompt is too long (Anthropic's wording varies:
 *    `prompt is too long`, `prompt_too_long`, `request_too_large`).
 *
 * NOT any 5xx, which is what this used to say. Production disagreed: of 20871
 * requests on one host the 5xx population was 177 × `529 overloaded`, 2 × `500`
 * and 1 × `503` — and 129 of 250 repacks fired directly after one of them. A 529
 * means the provider declined to process the request; the prefix cache it never
 * touched is still there, and re-cutting the grid threw it away for nothing.
 *
 * Nor any other 4xx. A bad key or a rate limit says nothing about the cache.
 *
 * A cache that genuinely died needs no error to be noticed: {@link
 * noteCacheOutcome} sees the next response report neither a read nor a write, and
 * that is both accurate and free.
 */
export function responseLeftNoCache(status: number, errorBody?: string): boolean {
  if (status === 413) return true;
  if (status === 400 && errorBody) {
    return /prompt[\s_-]*(is\s*)?too[\s_-]*long|request[\s_-]*too[\s_-]*large|too many (images|tokens)/i
      .test(errorBody);
  }
  return false;
}

/**
 * Feed a response's status back in for rate-limit tracking. Call once per
 * response, alongside {@link noteCacheOutcome}.
 *
 * A 429 on a request whose bytes are unchanged from the last attempt (retried
 * verbatim by the client) means imaging bought nothing: the provider never got
 * far enough to populate a fresh prefix cache, the retry re-sends the same
 * imaged bytes, and it fails the same way. Three in a row is past "unlucky
 * timing" and into "this session cannot get a compressed request through
 * right now" — see {@link isRateLimitCircuitOpen}.
 *
 * Any other status clears the counter: a single retry that gets through means
 * whatever was throttling the account has room again.
 */
export function noteRateLimitOutcome(sessionKey: string | undefined, status: number): void {
  if (!sessionKey) return;
  // touch(), not a get-or-skip: unlike noteCacheOutcome (which only refines a
  // record transformRequest is guaranteed to have created earlier in the same
  // call), this is the sole writer for consecutive429 and must not silently
  // no-op if some other response path reaches here first.
  const rec = touch(sessionKey);
  rec.consecutive429 = status === 429 ? rec.consecutive429 + 1 : 0;
}

/**
 * Has this session hit {@link RATE_LIMIT_CIRCUIT_THRESHOLD} consecutive 429s?
 * Callers use this to skip imaging and send plain text instead, so a session
 * stuck behind a rate limit stops re-sending the same doomed imaged bytes and
 * gets a chance to complete a request — which is also the only way its own
 * prefix cache (see {@link noteCacheOutcome}) gets a chance to come back.
 *
 * Deliberately has no time-based reset: a session that tripped this is still
 * the same session next request, and a fixed cooldown would either reopen too
 * early (back to the same failure) or too late (stuck on text past the point
 * the rate limit cleared) with no way to know which. Bounded instead by the
 * session's own natural lifetime — 512 sessions tracked, oldest evicted first
 * (see `SESSIONS_MAX`) — and by the fact that a session back under budget just
 * needs one successful request of any kind to clear the counter.
 */
export function isRateLimitCircuitOpen(sessionKey: string | undefined): boolean {
  if (!sessionKey) return false;
  const rec = sessions.get(sessionKey);
  return (rec?.consecutive429 ?? 0) >= RATE_LIMIT_CIRCUIT_THRESHOLD;
}

/** Test seam: drop all session state. */
export function resetSessionState(): void {
  sessions.clear();
}

/** Test/telemetry seam: inspect a session without mutating its clock. */
export function peekSessionState(
  sessionKey: string,
): { lastSeenMs: number; freezeStep: number; cacheDead: boolean; consecutive429: number } | undefined {
  const rec = sessions.get(sessionKey);
  return rec ? { ...rec } : undefined;
}
