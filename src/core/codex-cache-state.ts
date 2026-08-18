/**
 * Small in-memory cache observation store for the dedicated Codex route.
 *
 * OpenAI prompt caching is automatic and prefix-based. A history transform that
 * rewrites an already-warm prefix can cost far more than the raw text→image
 * delta saves. The transform path therefore needs one fact from the PREVIOUS
 * accepted request in the same Codex trajectory: was that request already warm,
 * and which frozen history wire segments did it send?
 *
 * No prompt/tool text is retained here. Keys are opaque per-thread SHA-256
 * fingerprints supplied by the proxy, and segment values are sha8 digests of
 * exact synthetic Responses items.
 */

const MAX_SESSIONS = 512;

export interface CodexCacheHint {
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly cacheShare: number;
  readonly compressed: boolean;
  readonly historySegmentShas: readonly string[];
  readonly lastSeenMs: number;
}

export interface CodexCacheOutcome {
  inputTokens?: number;
  cachedTokens?: number;
  compressed: boolean;
  historySegmentShas?: readonly string[];
}

interface RecordState {
  inputTokens: number;
  cachedTokens: number;
  compressed: boolean;
  historySegmentShas: string[];
  lastSeenMs: number;
}

const sessions = new Map<string, RecordState>();

function nonNegativeSafeInteger(value: number | undefined): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
}

function touch(key: string, value: RecordState): void {
  sessions.delete(key);
  sessions.set(key, value);

  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

export function getCodexCacheHint(
  sessionKey: string | undefined,
): CodexCacheHint | undefined {
  if (!sessionKey) return undefined;

  const state = sessions.get(sessionKey);
  if (!state) return undefined;

  touch(sessionKey, state);

  return {
    inputTokens: state.inputTokens,
    cachedTokens: state.cachedTokens,
    cacheShare: state.cachedTokens / state.inputTokens,
    compressed: state.compressed,
    historySegmentShas: [...state.historySegmentShas],
    lastSeenMs: state.lastSeenMs,
  };
}

/**
 * Record only complete, provider-grounded cache telemetry.
 *
 * `cachedTokens` is intentionally required. Missing cache details mean cache
 * status is unknown, not zero. Malformed counters and an impossible cached
 * subset larger than total input also fail closed and leave the last trustworthy
 * observation untouched.
 */
export function noteCodexCacheOutcome(
  sessionKey: string | undefined,
  outcome: CodexCacheOutcome,
  nowMs: number = Date.now(),
): void {
  if (!sessionKey) return;

  const inputTokens = nonNegativeSafeInteger(outcome.inputTokens);
  const cachedTokens = nonNegativeSafeInteger(outcome.cachedTokens);

  if (
    inputTokens === undefined
    || inputTokens <= 0
    || cachedTokens === undefined
    || cachedTokens > inputTokens
  ) {
    return;
  }

  touch(sessionKey, {
    inputTokens,
    cachedTokens,
    compressed: outcome.compressed,
    historySegmentShas: outcome.compressed
      ? [...(outcome.historySegmentShas ?? [])]
      : [],
    lastSeenMs: nowMs,
  });
}

/**
 * Drop one trajectory's adaptive observation.
 *
 * A successful native Codex compaction replaces the request history while
 * retaining the thread identity. The previous token/cache measurement therefore
 * no longer describes the new trajectory and must not authorize a transition.
 */
export function invalidateCodexCacheState(
  sessionKey: string | undefined,
): void {
  if (!sessionKey) return;
  sessions.delete(sessionKey);
}

/** Tests only. */
export function clearCodexCacheState(): void {
  sessions.clear();
}
