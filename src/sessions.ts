/**
 * Shared data layer for the dashboard's session views. Node-only (filesystem
 * I/O) — never imported from `src/core/`.
 *
 * ## Why we group by first_user_sha8 (Path B)
 *
 * Every TrackEvent carries `first_user_sha8` (see src/core/tracker.ts), an
 * sha256 prefix of the conversation's first user message. Within a single
 * Claude Code session that hash is stable across every turn; across two
 * different sessions it is virtually never the same. That makes it a
 * better-than-good-enough session key without coupling pxpipe to Claude
 * Code's internal file layout for *correctness*.
 *
 * We *do* read `~/.claude/projects/` opportunistically (see `claudeCodeMap`)
 * to enrich the dashboard with real Claude Code session IDs + project
 * paths — but it's best-effort: missing or unreadable files just leave the
 * synthetic ID standing alone.
 *
 * ## File layout we manage
 *
 * - `~/.pxpipe/events.jsonl` — append-only JSONL written by FileTracker
 * - `~/.pxpipe/4xx-bodies/${iso-ts}-${sha8}.json.gz` — gzipped failure
 *   bodies referenced from JSONL rows via `req_body_sample_path`
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as readline from 'node:readline';
import type { TrackEvent } from './core/tracker.js';
import {
  computeActualInputEff,
  computeBaselineInputEff,
} from './core/baseline.js';

// ---- Types -----------------------------------------------------------------

export interface SessionSummary {
  /** The synthetic session ID = first_user_sha8 (or '<unknown>' if missing). */
  id: string;
  /** Working directory of the first event in the session, if any. */
  project: string | undefined;
  /** ISO timestamp of the first event we saw for this session. */
  firstSeen: string;
  /** ISO timestamp of the last event we saw for this session. */
  lastSeen: string;
  /** Number of events recorded against this session. */
  requestCount: number;
  /** `tokensSavedEst × 4` — a coarse byte-equivalent of the token savings,
   *  useful only as a rough "we shaved X kB off the wire" callout. Not
   *  load-bearing math; the real number is `tokensSavedEst`. */
  charsSaved: number;
  /** Real input-side tokens saved: sum of `baseline_tokens − (input +
   *  cache_create×1.25 + cache_read×0.10)` across events that carry both
   *  a /v1/messages/count_tokens probe and an upstream usage block.
   *  Events missing either side contribute to requestCount but not here.
   *  No estimation — can go negative when a compression net-lost. */
  tokensSavedEst: number;
  /** Sum of cache_read_input_tokens — actual prompt-cache hits. */
  cacheReadTokens: number;
  /** Bytes attributable to this session in events.jsonl (sum of line lengths
   *  including the trailing newline). */
  jsonlBytes: number;
  /** Bytes attributable to this session in 4xx-bodies/ sidecars. */
  sidecarBytes: number;
}

export interface DiskUsage {
  eventsJsonlBytes: number;
  sidecarsBytes: number;
  sidecarCount: number;
  totalBytes: number;
}

/** Resolved paths a sessions invocation will touch. Single source of truth so
 *  tests can point the whole module at a tmpdir. */
export interface SessionsPaths {
  eventsFile: string;
  sidecarDir: string;
}

export function defaultPaths(): SessionsPaths {
  const home = os.homedir();
  const eventsFile =
    process.env.PXPIPE_LOG ?? path.join(home, '.pxpipe', 'events.jsonl');
  // The sidecar directory is `4xx-bodies` next to the events file, matching
  // what src/node.ts writes.
  const sidecarDir = path.join(path.dirname(eventsFile), '4xx-bodies');
  return { eventsFile, sidecarDir };
}

// ---- Core reader -----------------------------------------------------------

/** Lazily stream events.jsonl line by line. Yields parsed TrackEvents plus
 *  the raw line (we need byte length for jsonlBytes accounting). Malformed
 *  lines are silently dropped — matches `pxpipe stats` behavior. */
export async function* readEvents(
  eventsFile: string,
): AsyncGenerator<{ ev: TrackEvent; rawBytes: number }> {
  if (!fs.existsSync(eventsFile)) return;
  const stream = fs.createReadStream(eventsFile, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let ev: TrackEvent;
    try {
      ev = JSON.parse(line) as TrackEvent;
    } catch {
      continue;
    }
    // +1 for the newline FileTracker writes after each row.
    yield { ev, rawBytes: Buffer.byteLength(line, 'utf8') + 1 };
  }
}

// ---- Aggregation -----------------------------------------------------------

export const UNKNOWN_SESSION = '<unknown>';

function sessionIdOf(ev: TrackEvent): string {
  return ev.first_user_sha8 ?? UNKNOWN_SESSION;
}

export interface AggregateResult {
  sessions: Map<string, SessionSummary>;
  /** sessionId -> set of absolute sidecar paths referenced by its events. */
  sidecarsBySession: Map<string, Set<string>>;
}

/** Build a map of sessionId -> SessionSummary by scanning every event. Also
 *  tracks which sidecars belong to which session so prune can clean them. */
export async function aggregateSessions(
  paths: SessionsPaths,
): Promise<AggregateResult> {
  const sessions = new Map<string, SessionSummary>();
  const sidecarsBySession = new Map<string, Set<string>>();

  // Stat sidecar sizes once up front. Looking up size per event would be
  // O(N²) syscalls; the directory is small enough to read fully.
  const sidecarSizes = sidecarFileSizes(paths.sidecarDir);

  for await (const { ev, rawBytes } of readEvents(paths.eventsFile)) {
    const id = sessionIdOf(ev);
    let s = sessions.get(id);
    if (!s) {
      s = {
        id,
        project: ev.cwd,
        firstSeen: ev.ts,
        lastSeen: ev.ts,
        requestCount: 0,
        charsSaved: 0,
        tokensSavedEst: 0,
        cacheReadTokens: 0,
        jsonlBytes: 0,
        sidecarBytes: 0,
      };
      sessions.set(id, s);
    }
    s.requestCount++;
    s.jsonlBytes += rawBytes;
    if (ev.ts < s.firstSeen) s.firstSeen = ev.ts;
    if (ev.ts > s.lastSeen) s.lastSeen = ev.ts;
    // Cling to whichever cwd we saw first; sessions that hop directories are
    // rare and the first cwd is the most stable identifier.
    if (s.project === undefined && ev.cwd) s.project = ev.cwd;
    // Real per-session savings, cache-aware. See src/core/baseline.ts for
    // the full derivation and the May-2026 regression that motivated the
    // rewrite — the previous formula collapsed every warm turn's unproxied
    // counterfactual to 100% cache_read × 0.10 and flipped the headline
    // negative whenever the proxied path paid real cache_create.
    // Events missing either probe stay out of the rollup — no estimation.
    const inp = ev.input_tokens ?? 0;
    const cc = ev.cache_create_tokens ?? 0;
    const cr = ev.cache_read_tokens ?? 0;
    const haveUsage = inp > 0 || cc > 0 || cr > 0;
    const baseline = ev.baseline_tokens;
    if (
      typeof baseline === 'number' &&
      baseline > 0 &&
      haveUsage
    ) {
      const baselineEff = computeBaselineInputEff(
        baseline,
        ev.baseline_cacheable_tokens ?? 0,
        cc,
        cr,
      );
      const actualEff = computeActualInputEff(inp, cc, cr);
      const tokensSaved = baselineEff - actualEff;
      s.tokensSavedEst += Math.round(tokensSaved);
      s.charsSaved += Math.round(tokensSaved * 4);
    }
    if (typeof ev.cache_read_tokens === 'number') {
      s.cacheReadTokens += ev.cache_read_tokens;
    }
    if (ev.req_body_sample_path) {
      let set = sidecarsBySession.get(id);
      if (!set) {
        set = new Set();
        sidecarsBySession.set(id, set);
      }
      set.add(ev.req_body_sample_path);
      const size = sidecarSizes.get(ev.req_body_sample_path);
      if (typeof size === 'number') s.sidecarBytes += size;
    }
  }

  return { sessions, sidecarsBySession };
}

// ---- list / filter --------------------------------------------------------

export interface ListOptions {
  /** Substring or basename match against `cwd`. */
  project?: string;
  /** ISO timestamp; only sessions whose lastSeen >= since survive. */
  since?: string;
}

/** Sort SessionSummary entries most-recent-first and apply optional filters.
 *  Pure: the dashboard maps query-string params straight into ListOptions. */
export function filterSessions(
  sessions: Map<string, SessionSummary>,
  opts: ListOptions,
): SessionSummary[] {
  return [...sessions.values()]
    .filter((s) => {
      if (opts.project) {
        if (!s.project) return false;
        if (
          s.project !== opts.project &&
          path.basename(s.project) !== opts.project &&
          !s.project.includes(opts.project)
        ) {
          return false;
        }
      }
      if (opts.since && s.lastSeen < opts.since) return false;
      return true;
    })
    .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
}

function sidecarFileSizes(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!fs.existsSync(dir)) return out;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.isFile()) out.set(full, st.size);
    } catch {
      /* concurrent delete is fine */
    }
  }
  return out;
}

// ---- prune -----------------------------------------------------------------

export interface PruneOptions {
  /** Drop sessions whose lastSeen is older than N days. */
  olderThanDays?: number;
  /** Keep only the N most-recently-active sessions. */
  keepLast?: number;
  /** Drop a single session by ID. */
  sessionId?: string;
  /** Drop multiple sessions in one atomic pass — bulk-delete from the
   *  dashboard's checkbox UI. Unknown IDs are silently ignored (the
   *  caller may have raced a concurrent prune). Coexists with
   *  `sessionId` (single) — both contribute to the removal set. */
  sessionIds?: string[];
  /** When true, actually delete. When false (the default), report only. */
  force: boolean;
}

export interface PruneReport {
  sessionsRemoved: string[];
  eventsRemoved: number;
  eventsKept: number;
  jsonlBytesFreed: number;
  sidecarsRemoved: number;
  sidecarBytesFreed: number;
  /** True when this was a real run (force=true). False for dry-run. */
  applied: boolean;
}

/** Decide which sessions to remove based on the prune options. Pure — no
 *  I/O — so it's easy to unit-test against a synthetic aggregation. */
export function selectSessionsToRemove(
  sessions: Map<string, SessionSummary>,
  opts: PruneOptions,
  now: Date = new Date(),
): Set<string> {
  const toRemove = new Set<string>();
  const all = [...sessions.values()];

  if (opts.sessionId) {
    if (sessions.has(opts.sessionId)) toRemove.add(opts.sessionId);
  }

  if (Array.isArray(opts.sessionIds)) {
    for (const id of opts.sessionIds) {
      // Silently skip unknown IDs — the client may have raced a concurrent
      // prune. The report will reflect what we actually removed.
      if (typeof id === 'string' && sessions.has(id)) toRemove.add(id);
    }
  }

  if (typeof opts.olderThanDays === 'number') {
    const cutoff = new Date(
      now.getTime() - opts.olderThanDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    for (const s of all) {
      if (s.lastSeen < cutoff) toRemove.add(s.id);
    }
  }

  if (typeof opts.keepLast === 'number') {
    // Most-recently-active first; everything after keepLast goes.
    const sorted = [...all].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
    for (const s of sorted.slice(opts.keepLast)) toRemove.add(s.id);
  }

  return toRemove;
}

/**
 * Rewrite events.jsonl with rows from `toRemove` sessions stripped out, and
 * delete the matching 4xx-body sidecars. Atomic: writes to a sibling `.tmp`
 * file with fsync, then renames over the original.
 *
 * Concurrency note: if the live proxy appends during prune, those new lines
 * will be lost (the proxy holds an fd to the pre-rename inode and keeps
 * writing to it). For a single-user dev tool that's an acceptable tradeoff;
 * the dashboard's confirm dialog warns the user before the destructive op.
 */
export async function prune(
  paths: SessionsPaths,
  opts: PruneOptions,
  now: Date = new Date(),
): Promise<PruneReport> {
  const { sessions, sidecarsBySession } = await aggregateSessions(paths);
  const toRemove = selectSessionsToRemove(sessions, opts, now);

  let jsonlBytesFreed = 0;
  let eventsRemoved = 0;
  let eventsKept = 0;
  for (const s of sessions.values()) {
    if (toRemove.has(s.id)) {
      jsonlBytesFreed += s.jsonlBytes;
      eventsRemoved += s.requestCount;
    } else {
      eventsKept += s.requestCount;
    }
  }

  // Collect sidecar paths up for deletion (and their on-disk sizes).
  const sidecarsToDelete: { path: string; size: number }[] = [];
  for (const id of toRemove) {
    const set = sidecarsBySession.get(id);
    if (!set) continue;
    for (const p of set) {
      try {
        const st = fs.statSync(p);
        sidecarsToDelete.push({ path: p, size: st.size });
      } catch {
        /* already gone — fine */
      }
    }
  }
  const sidecarBytesFreed = sidecarsToDelete.reduce((n, s) => n + s.size, 0);

  const report: PruneReport = {
    sessionsRemoved: [...toRemove],
    eventsRemoved,
    eventsKept,
    jsonlBytesFreed,
    sidecarsRemoved: sidecarsToDelete.length,
    sidecarBytesFreed,
    applied: false,
  };

  if (!opts.force) return report;
  if (toRemove.size === 0) {
    report.applied = true;
    return report;
  }

  // Atomic rewrite: stream the original through a filter into events.jsonl.tmp,
  // fsync, then rename. Any partial state on crash leaves the original intact.
  await rewriteEventsFile(paths.eventsFile, toRemove);

  for (const { path: p } of sidecarsToDelete) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore — leftover sidecars are harmless */
    }
  }

  report.applied = true;
  return report;
}

async function rewriteEventsFile(
  eventsFile: string,
  toRemove: Set<string>,
): Promise<void> {
  if (!fs.existsSync(eventsFile)) return;
  const tmp = eventsFile + '.tmp';
  // Open with 'w' (truncate). We never reuse a stale .tmp.
  const outFd = fs.openSync(tmp, 'w');
  try {
    const stream = fs.createReadStream(eventsFile, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let ev: TrackEvent;
      try {
        ev = JSON.parse(line) as TrackEvent;
      } catch {
        // Preserve malformed lines so we don't silently eat data we can't parse.
        fs.writeSync(outFd, line + '\n');
        continue;
      }
      if (toRemove.has(sessionIdOf(ev))) continue;
      fs.writeSync(outFd, line + '\n');
    }
    fs.fsyncSync(outFd);
  } finally {
    fs.closeSync(outFd);
  }
  fs.renameSync(tmp, eventsFile);
}

// ---- disk usage ------------------------------------------------------------

export function diskUsage(paths: SessionsPaths): DiskUsage {
  let eventsJsonlBytes = 0;
  try {
    eventsJsonlBytes = fs.statSync(paths.eventsFile).size;
  } catch {
    /* no events file — leave at 0 */
  }
  const sidecarSizes = sidecarFileSizes(paths.sidecarDir);
  let sidecarsBytes = 0;
  for (const s of sidecarSizes.values()) sidecarsBytes += s;
  return {
    eventsJsonlBytes,
    sidecarsBytes,
    sidecarCount: sidecarSizes.size,
    totalBytes: eventsJsonlBytes + sidecarsBytes,
  };
}

// ---- Claude Code session fingerprint map -----------------------------------

export interface ClaudeCodeSessionRef {
  /** The Claude Code session ID (file basename without .jsonl). */
  sessionId: string;
  /** The decoded project path. Encoded form: `-Users-me-code-foo` →
   *  `/Users/me/code/foo`. Best-effort: dashes in actual path segments
   *  (e.g. `my-project`) round-trip as slashes, so this is for display
   *  only — don't `fs.existsSync` against it. */
  projectPath: string;
  /** First user message text, truncated for display. */
  firstUserPreview: string;
}

/** Path where Claude Code stores per-session JSONL transcripts. */
export function claudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Compute the sha256 prefix the proxy uses for `first_user_sha8` (see
 * src/core/transform.ts:firstUserText + sha8). Crucially this must match
 * exactly — same 4 KiB cap, same first-8-hex-char prefix — or the map will
 * silently miss every entry.
 */
export function fingerprintFirstUser(text: string): string {
  const trimmed = text.slice(0, 4096);
  const hash = crypto.createHash('sha256').update(trimmed, 'utf8').digest('hex');
  return hash.slice(0, 8);
}

/** Pull the first user message text out of a single Claude Code session
 *  JSONL file. Walks the file line by line and stops at the first row with
 *  `type === 'user'` that has parseable user content. */
export async function readFirstUserFromClaudeSession(
  filePath: string,
): Promise<string | undefined> {
  // createReadStream doesn't throw synchronously for ENOENT — the error fires
  // on the 'error' event when read() starts. Pre-check with existsSync so
  // we can return undefined cleanly without an unhandled rejection.
  if (!fs.existsSync(filePath)) return undefined;
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  } catch {
    return undefined;
  }
  // Defensive: still attach an error handler so a permission/race-deletion
  // surface doesn't bubble out of readline's async iterator.
  stream.on('error', () => {
    /* swallow — the iterator will end with no rows */
  });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      if (r.type !== 'user') continue;
      const msg = r.message;
      if (!msg || typeof msg !== 'object') {
        // Older Claude Code format: content may live at the top level.
        const content = r.content;
        if (typeof content === 'string') return content;
        return undefined;
      }
      const content = (msg as Record<string, unknown>).content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === 'object' &&
            (block as Record<string, unknown>).type === 'text'
          ) {
            const t = (block as Record<string, unknown>).text;
            if (typeof t === 'string') return t;
          }
        }
      }
      // Found a user row but couldn't read it — give up on this file so we
      // don't accidentally hash a later message and produce a wrong mapping.
      return undefined;
    }
  } finally {
    stream.close();
  }
  return undefined;
}

/** Convert Claude Code's project directory encoding back to a path. The
 *  encoding is lossy (every `/`, `_`, and original `-` all become `-` in the
 *  directory name) so this is display-only. */
export function decodeClaudeProjectDir(name: string): string {
  if (name.startsWith('-')) return '/' + name.slice(1).replaceAll('-', '/');
  return name.replaceAll('-', '/');
}

/**
 * Best-effort scan of `~/.claude/projects/*.jsonl`. Returns a map keyed by
 * the same `first_user_sha8` the proxy emits. If `~/.claude/projects/` is
 * missing, returns an empty map without throwing — pxpipe must keep
 * working for non-Claude-Code clients.
 *
 * This is O(number_of_sessions) file opens. On a heavy user's machine
 * that's a few hundred small reads — well under a second on an SSD. We
 * don't poll continuously; the dashboard re-invokes this on each refresh.
 */
export async function claudeCodeMap(
  rootDir: string = claudeProjectsDir(),
): Promise<Map<string, ClaudeCodeSessionRef>> {
  const out = new Map<string, ClaudeCodeSessionRef>();
  let projects: fs.Dirent[];
  try {
    projects = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out; // No Claude Code install or unreadable — that's fine.
  }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const projDir = path.join(rootDir, proj.name);
    let sessions: string[];
    try {
      sessions = fs.readdirSync(projDir);
    } catch {
      continue;
    }
    for (const sess of sessions) {
      if (!sess.endsWith('.jsonl')) continue;
      const file = path.join(projDir, sess);
      const firstUser = await readFirstUserFromClaudeSession(file);
      if (!firstUser) continue;
      const sha8 = fingerprintFirstUser(firstUser);
      // First write wins. If two sessions in different projects start with
      // the same user prompt (e.g. "hi"), the first one we read keeps the
      // slot — at least the dashboard shows *some* CC ref rather than none.
      if (!out.has(sha8)) {
        out.set(sha8, {
          sessionId: sess.replace(/\.jsonl$/, ''),
          projectPath: decodeClaudeProjectDir(proj.name),
          firstUserPreview: firstUser.slice(0, 120),
        });
      }
    }
  }
  return out;
}
