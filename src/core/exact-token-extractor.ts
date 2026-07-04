/**
 * Deterministic extractor for exactness-sensitive fragments in a context block.
 *
 * The whole point of pxpipe's image lane is lossy compression; anything the model
 * must read *byte-exact* (paths, hashes, commands, secrets, stack anchors) has to
 * survive as text. This module finds those fragments with plain regex + a Shannon-
 * entropy fallback for unknown-shape secrets. No model calls — the classifier that
 * consumes this must stay deterministic and testable (handoff constraint).
 *
 * Design choices worth knowing:
 * - Secrets are masked at extraction time. A raw secret NEVER leaves this module
 *   (no log, no snapshot, no rescue strip can print one). See maskSecret.
 * - `unknown_identifier` from the handoff type is deliberately NOT emitted: a
 *   deterministic regex can't tell a must-stay-exact identifier from a prose noun,
 *   so emitting it either fires on everything or is dead weight. Left as future work.
 * - Overlapping matches are resolved by precedence (secret > command > url > path …)
 *   then earliest-start, so `pnpm i && pnpm test` is one command, not fragments.
 */

export type ExactTokenKind =
  | 'path'
  | 'hash'
  | 'uuid'
  | 'secret_like'
  | 'command'
  | 'url'
  | 'line_number'
  | 'error_code'
  | 'json_key'
  | 'version'
  | 'number'
  | 'unknown_identifier';

export interface ExactToken {
  kind: ExactTokenKind;
  /** For `secret_like`, this is MASKED — the raw value never leaves this module. */
  value: string;
  start: number;
  end: number;
  confidence: number;
}

/** Lower number = higher precedence when spans overlap. Command claims whole lines
 *  (so paths/urls inside a command line stay part of the verbatim command). */
const PRECEDENCE: Record<ExactTokenKind, number> = {
  secret_like: 0,
  command: 1,
  url: 2,
  path: 3,
  uuid: 4,
  hash: 5,
  version: 6,
  line_number: 7,
  json_key: 8,
  error_code: 9,
  number: 10,
  unknown_identifier: 11,
};

/** Mask a secret so it can be surfaced (kind/position) without leaking the value.
 *  Keeps a short prefix so `sk-ant-…` is still recognizable; body → `…`. */
export function maskSecret(raw: string): string {
  const s = String(raw);
  if (s.length <= 8) return '***';
  // Preserve a recognizable provider prefix up to the first delimiter, mask the rest.
  const m = /^([A-Za-z]{1,10}[-_])/.exec(s);
  const head = m ? m[1]! : s.slice(0, 4);
  return `${head}…${s.slice(-2)} [${s.length}ch]`;
}

/** Shannon entropy in bits/char — high on random tokens, low on prose/hex words. */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

interface RawMatch {
  kind: ExactTokenKind;
  value: string;
  start: number;
  end: number;
  confidence: number;
  /** Overlap-resolution priority override (lower wins). Defaults to PRECEDENCE[kind].
   *  Entropy-fallback secrets set this high so a real path/hash/url claims the span
   *  first — only a blob no structured kind explains is kept as a secret. */
  prio?: number;
}

/** Push every match of `re` (must be global) as `kind`. `value` defaults to match[0]. */
function collect(
  out: RawMatch[],
  text: string,
  re: RegExp,
  kind: ExactTokenKind,
  confidence: number,
  group = 0,
): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = m[group] ?? m[0];
    if (!value) {
      if (m.index === re.lastIndex) re.lastIndex++;
      continue;
    }
    // start is match start; when using a capture group, offset to the group.
    const start = group === 0 ? m.index : m.index + m[0].indexOf(value);
    out.push({ kind, value, start, end: start + value.length, confidence });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
}

// --- Secret detection ------------------------------------------------------
// Known-prefix patterns (high confidence) PLUS a shape+entropy fallback so an
// unknown-format secret doesn't slip through and get silently imaged — that
// silent-image-of-a-secret is the exact failure mode the router exists to stop.

const SECRET_PREFIX =
  /\b(?:sk-ant-[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9]{10,}|gh[posu]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._-]{12,}/g;
// KEY=value where the key name smells secret. Captures the whole assignment.
const SECRET_ASSIGN =
  /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*("[^"]+"|'[^']+'|\S+)/gi;

function collectSecrets(out: RawMatch[], text: string): void {
  const spans: Array<[number, number]> = [];
  const add = (start: number, end: number, value: string, confidence: number, prio?: number) => {
    spans.push([start, end]);
    out.push({ kind: 'secret_like', value: maskSecret(value), start, end, confidence, prio });
  };
  for (const re of [SECRET_PREFIX, BEARER]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) add(m.index, m.index + m[0].length, m[0], 0.97);
  }
  SECRET_ASSIGN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SECRET_ASSIGN.exec(text)) !== null) add(m.index, m.index + m[0].length, m[0], 0.9);

  // Entropy fallback: long high-entropy tokens not already claimed above. Conservative
  // false positives are acceptable (handoff: "prefer conservative FP over silent
  // corruption"); a flagged non-secret just stays as text, which is harmless.
  const overlaps = (s: number, e: number) => spans.some(([a, b]) => s < b && e > a);
  // No '/' in the class: a slash-bearing string is a path, not a secret — let the
  // path extractor own it (and the low prio below yields the span if they tie).
  const TOKENISH = /[A-Za-z0-9+_=-]{24,}/g;
  TOKENISH.lastIndex = 0;
  let t: RegExpExecArray | null;
  while ((t = TOKENISH.exec(text)) !== null) {
    const v = t[0];
    const start = t.index;
    const end = start + v.length;
    if (overlaps(start, end)) continue;
    // Require real character mixing + entropy so we don't flag a 40-char English word
    // or a flat hash (a hash is exact but not a *secret* — it routes via `hash`).
    const hasUpper = /[A-Z]/.test(v);
    const hasLower = /[a-z]/.test(v);
    const hasDigit = /[0-9]/.test(v);
    const classes = Number(hasUpper) + Number(hasLower) + Number(hasDigit);
    // prio 9: below every structured kind, so a hash/path/url/version that also
    // matches this span wins; a blob nothing else explains stays flagged.
    if (classes >= 2 && shannonEntropy(v) >= 3.6) {
      add(start, end, v, 0.55, 9);
    }
  }
}

// --- Commands (line-level) -------------------------------------------------
const RUNNER =
  /(?:npm|pnpm|yarn|npx|node|deno|bun|tsx|vitest|jest|git|py|python[23]?|pip[23]?|bash|sh|zsh|curl|wget|docker|docker-compose|make|cargo|go|rustc|claude|kubectl|terraform)/
    .source;
// Optional ENV=val prefixes, then a runner, to end of line.
const COMMAND_LINE = new RegExp(
  `(?:^|\\n)[ \\t]*((?:[A-Z_][A-Z0-9_]*=\\S+[ \\t]+)*(?:${RUNNER})\\b[^\\n]*)`,
  'g',
);

// --- Other kinds -----------------------------------------------------------
const URL = /\b(?:https?:\/\/|ftp:\/\/)[^\s)>\]"'`]+/g;
const LOCALHOST = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{2,5})?(?:\/[^\s)>\]"'`]*)?/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const WIN_PATH = /\b[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\?)+/g;
// Unix-ish path: optional ./ ../, then at least one dir segment + a final segment.
const UNIX_PATH = /(?<![\w./-])(?:\.{1,2}\/)?(?:[\w.@-]+\/)+[\w.@-]+/g;
// Git hash: 7–40 hex OR 64 hex, requiring ≥1 a–f letter so a plain 7-digit number
// isn't mistaken for a short hash. Full sha1(40)/sha256(64) still match.
const HASH = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b|\b[0-9a-f]{64}\b/gi;
const SEMVER = /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.]+)?\b/g;
// `path:line:col`, `:42:13`, or `line 42` — the anchors that make a stack trace navigable.
const LINE_NUMBER = /(?<=[:\s])\d+:\d+\b|\bline\s+\d+\b/gi;
// Uppercase config / env-var keys, and quoted JSON keys.
const JSON_KEY = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:|(?<![\w-])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?![\w-])/g;
// Node/errno-style error codes + `Error:`-anchored lines.
const ERROR_CODE = /\bE[A-Z]{2,}\b|\berrno\s+-?\d+\b|\b[A-Z][a-zA-Z]*Error\b/g;

/**
 * Extract exactness-sensitive tokens from `text`, de-overlapped by precedence.
 * Deterministic and side-effect free. Secrets in the result are masked.
 */
export function extractExactTokens(text: string): ExactToken[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const raw: RawMatch[] = [];

  collectSecrets(raw, text);
  collect(raw, text, COMMAND_LINE, 'command', 0.85, 1);
  collect(raw, text, URL, 'url', 0.9);
  collect(raw, text, LOCALHOST, 'url', 0.8);
  collect(raw, text, UUID, 'uuid', 0.98);
  collect(raw, text, WIN_PATH, 'path', 0.9);
  collect(raw, text, UNIX_PATH, 'path', 0.75);
  collect(raw, text, HASH, 'hash', 0.7);
  collect(raw, text, SEMVER, 'version', 0.7);
  collect(raw, text, LINE_NUMBER, 'line_number', 0.8);
  collect(raw, text, JSON_KEY, 'json_key', 0.6, 1);
  collect(raw, text, ERROR_CODE, 'error_code', 0.7);

  // De-overlap: sort by start, then precedence, then longer-first; sweep keeping
  // any match that doesn't overlap an already-kept span.
  const prioOf = (r: RawMatch) => r.prio ?? PRECEDENCE[r.kind];
  raw.sort((a, b) =>
    a.start - b.start ||
    prioOf(a) - prioOf(b) ||
    (b.end - b.start) - (a.end - a.start),
  );
  const kept: ExactToken[] = [];
  const claimed: Array<[number, number]> = [];
  const overlaps = (s: number, e: number) => claimed.some(([a, b]) => s < b && e > a);
  for (const r of raw) {
    if (overlaps(r.start, r.end)) continue;
    claimed.push([r.start, r.end]);
    kept.push({ kind: r.kind, value: r.value, start: r.start, end: r.end, confidence: r.confidence });
  }
  kept.sort((a, b) => a.start - b.start);
  return kept;
}

/** True if any extracted token is a secret. Cheap gate for the `critical` risk path. */
export function hasSecret(tokens: readonly ExactToken[]): boolean {
  return tokens.some((t) => t.kind === 'secret_like');
}

/** Replacement token written over a secret's span. Fixed + value-free: two different
 *  secrets redact to the same string, so nothing about the value (not even length or
 *  prefix) survives into the redacted text. */
export const SECRET_REDACTION = '[redacted-secret]';

/**
 * Replace every secret span in `text` with `SECRET_REDACTION`, leaving all other
 * content untouched. Enables the redaction lane: mask the secret *value* so the block
 * can still be imaged (savings preserved) without rendering a live secret into pixels.
 * Splices from the end so earlier spans' offsets stay valid. Deterministic; the raw
 * secret never appears in the output.
 */
export function redactSecrets(text: string): { redacted: string; count: number } {
  if (typeof text !== 'string' || text.length === 0) return { redacted: text, count: 0 };
  const secrets = extractExactTokens(text)
    .filter((t) => t.kind === 'secret_like')
    .sort((a, b) => b.start - a.start); // end → start so splices don't shift later spans
  if (secrets.length === 0) return { redacted: text, count: 0 };
  let out = text;
  for (const s of secrets) out = out.slice(0, s.start) + SECRET_REDACTION + out.slice(s.end);
  return { redacted: out, count: secrets.length };
}
