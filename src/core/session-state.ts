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
 * ## Why the state survives a restart
 *
 * The map lives in this process. A restart used to lose it, and the module
 * called that an accepted failure mode: an unknown session is treated as WARM
 * (no repack), so at worst we keep paying the old image count. That covers
 * `cold`, but not the floor. {@link recordFreezeStep} exists because a render at
 * a finer grid than the session was last frozen at re-keys every chunk (see
 * above), and after a restart the floor is 0 again: the next collapse is free to
 * pick a finer step than the one the cache was built on, and whether it does
 * depends on that request's image budget — exactly what the pin was added to
 * stop mattering.
 *
 * So the host may attach a {@link SessionStateStore}. Every mutation schedules a
 * debounced save ({@link PERSIST_DEBOUNCE_MS}); the record shape on disk is the
 * in-memory record plus its key. On configure the file is read back and records
 * idle for more than {@link PERSIST_MAX_IDLE_MS} are dropped — past the cold
 * horizon the clock already declares them cold, so nothing they pin is protecting
 * a live cache. Records already in memory win over the file. The core never
 * touches a filesystem: without a store the module behaves exactly as before.
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

/** On-disk format tag. Bump when a field changes meaning; older files are ignored. */
const PERSIST_FORMAT = 1;

/**
 * Records idle longer than this are not persisted and not restored. Well past
 * {@link COLD_HORIZON_MS}, where the clock alone already declares the session
 * cold and a repack is free — a pin that old protects nothing. 24 hours.
 */
const PERSIST_MAX_IDLE_MS = 24 * 3_600_000;

/**
 * Coalesce saves. Every request touches `lastSeenMs`, and a Claude Code turn can
 * be several requests in a burst; one write per burst is plenty. Short enough
 * that a supervisor hard-kill (no signal on Windows) loses at most this window
 * of clock updates — never a pin recorded on an earlier turn.
 */
const PERSIST_DEBOUNCE_MS = 250;

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
}

const sessions = new Map<string, SessionRecord>();

function touch(key: string): SessionRecord {
  const existing = sessions.get(key);
  if (existing) {
    sessions.delete(key); // refresh LRU position
    sessions.set(key, existing);
    return existing;
  }
  const fresh: SessionRecord = { lastSeenMs: 0, freezeStep: 0, cacheDead: false };
  sessions.set(key, fresh);
  evictToCapacity();
  return fresh;
}

function evictToCapacity(): void {
  while (sessions.size > SESSIONS_MAX) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

// --- persistence ------------------------------------------------------------

/**
 * Host-supplied storage for the session map. The core stays filesystem-free;
 * `node.ts` backs this with `~/.pxpipe/session-state.json`, tests with a string.
 * `load` returns the last saved text or `undefined` when nothing was saved yet.
 * `save` must be atomic from the reader's point of view (write-then-rename).
 */
export interface SessionStateStore {
  load(): string | undefined;
  save(text: string): void;
}

let store: SessionStateStore | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;

interface PersistedRecord extends SessionRecord {
  key: string;
}

interface PersistedState {
  format: number;
  saved_at_ms: number;
  sessions: PersistedRecord[];
}

/**
 * Attach (or with `undefined`, detach) the store and restore what it holds.
 * Flushes pending changes to the previous store first. Returns how many
 * sessions were restored. Never throws: a store that cannot be read leaves the
 * map as it was — the pre-persistence behaviour, which is safe (unknown = warm).
 */
export function configureSessionStateStore(
  next: SessionStateStore | undefined,
  nowMs: number = Date.now(),
): number {
  flushSessionState();
  store = next;
  if (!next) return 0;
  let text: string | undefined;
  try {
    text = next.load();
  } catch {
    return 0;
  }
  return restoreSessionState(text, nowMs);
}

/**
 * Merge a serialized snapshot into the map. Records already in memory win (they
 * are newer by construction); records idle past {@link PERSIST_MAX_IDLE_MS} or
 * malformed in any field are skipped. Returns the number restored.
 */
export function restoreSessionState(text: string | undefined, nowMs: number = Date.now()): number {
  if (!text) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 0;
  }
  if (!isPersistedState(parsed)) return 0;
  let restored = 0;
  for (const entry of parsed.sessions) {
    const rec = validRecord(entry, nowMs);
    if (!rec || sessions.has(entry.key)) continue;
    sessions.set(entry.key, rec);
    restored++;
  }
  evictToCapacity();
  return restored;
}

function isPersistedState(value: unknown): value is PersistedState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<PersistedState>;
  return v.format === PERSIST_FORMAT && Array.isArray(v.sessions);
}

function isBool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function validRecord(entry: unknown, nowMs: number): SessionRecord | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const e = entry as Partial<PersistedRecord>;
  if (typeof e.key !== 'string' || e.key === '') return undefined;
  if (typeof e.lastSeenMs !== 'number' || !Number.isFinite(e.lastSeenMs) || e.lastSeenMs <= 0) return undefined;
  if (nowMs - e.lastSeenMs > PERSIST_MAX_IDLE_MS) return undefined;
  if (typeof e.freezeStep !== 'number' || !Number.isFinite(e.freezeStep) || e.freezeStep < 0) return undefined;
  if (!isBool(e.cacheDead)) return undefined;
  const rec: SessionRecord = { lastSeenMs: e.lastSeenMs, freezeStep: e.freezeStep, cacheDead: e.cacheDead };
  if (isBool(e.lastCacheAlive)) rec.lastCacheAlive = e.lastCacheAlive;
  if (isBool(e.everCacheAlive)) rec.everCacheAlive = e.everCacheAlive;
  return rec;
}

/** The map as JSON, oldest session first (LRU order), stale records omitted. */
export function serializeSessionState(nowMs: number = Date.now()): string {
  const out: PersistedRecord[] = [];
  for (const [key, rec] of sessions) {
    if (rec.lastSeenMs <= 0 || nowMs - rec.lastSeenMs > PERSIST_MAX_IDLE_MS) continue;
    out.push({ key, ...rec });
  }
  const state: PersistedState = { format: PERSIST_FORMAT, saved_at_ms: nowMs, sessions: out };
  return JSON.stringify(state);
}

function scheduleSave(): void {
  if (!store) return;
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    flushSessionState();
  }, PERSIST_DEBOUNCE_MS);
  // Never keep the process alive for a bookkeeping write.
  (saveTimer as { unref?: () => void }).unref?.();
}

/**
 * Write pending changes now. Returns true when a save happened. Called by the
 * debounce timer, on store change, and by the host on shutdown. A failing store
 * is swallowed: persistence is an optimisation and must never fail a request.
 */
export function flushSessionState(): boolean {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  if (!store || !dirty) return false;
  dirty = false;
  try {
    store.save(serializeSessionState());
    return true;
  } catch {
    return false;
  }
}

// --- request-path API -------------------------------------------------------

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
  scheduleSave();
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
  scheduleSave();
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
  if (step > rec.freezeStep) {
    rec.freezeStep = step;
    scheduleSave();
  }
}

/**
 * Mark this session's upstream cache as gone: the last request was rejected, so
 * nothing was cached and the next one may re-cut the grid for density. Call on
 * the failure paths that leave no cache entry (oversized request → opaque 500).
 */
export function markCacheDead(sessionKey: string | undefined): void {
  if (!sessionKey) return;
  touch(sessionKey).cacheDead = true;
  scheduleSave();
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

/** Test seam: drop all session state and any pending save. The store stays attached. */
export function resetSessionState(): void {
  sessions.clear();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  dirty = false;
}

/** Test/telemetry seam: inspect a session without mutating its clock. */
export function peekSessionState(
  sessionKey: string,
): { lastSeenMs: number; freezeStep: number; cacheDead: boolean } | undefined {
  const rec = sessions.get(sessionKey);
  return rec ? { ...rec } : undefined;
}

/** Complete client boilerplate elements, with no user prose between them. */
const BOILERPLATE_ELEMENT_RE = /<(system-notice|system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args)>[\s\S]*?<\/\1>/g;

export function isBoilerplateText(text: string): boolean {
  return text.replace(BOILERPLATE_ELEMENT_RE, '').trim() === '';
}

/**
 * Pick the text that identifies a conversation, from the text blocks of its
 * opening user turn(s) in order (everything before the first assistant message).
 *
 * Blocks that are wholly a harness envelope are skipped: they are boilerplate
 * the client injects into every session (omp opens each one with the same
 * `<system-notice>` device inventory; Claude Code with the project's CLAUDE.md
 * `<system-reminder>` and local slash-command output), so keying on them merges every concurrent session into
 * one record, and each session's cache outcomes then re-cut the others' history
 * grids. The first non-envelope block is the user's own prompt. When every block
 * is an envelope, the first one is still better than no key. Capped at 4 KiB.
 */
export function sessionAnchorText(texts: readonly string[]): string {
  const anchor = texts.find((t) => !isBoilerplateText(t)) ?? texts[0] ?? '';
  return anchor.slice(0, 4096);
}

/** Telemetry seam: how many sessions are currently tracked. */
export function sessionStateSize(): number {
  return sessions.size;
}
