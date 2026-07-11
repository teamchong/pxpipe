/**
 * Verbatim fact-sheet for imaged content.
 *
 * When pxpipe renders a block (system slab, history, tool_result, reminder) to a PNG,
 * the precision-critical, hard-to-OCR strings inside it — file paths, URLs, SHAs/UUIDs,
 * version numbers, CLI flags, large numbers, CONST_IDS — are exactly what a model is
 * most likely to misread off the image yet most likely to need quoted verbatim. This
 * module extracts those tokens so they ride next to the image as plain text: the model
 * quotes them without re-reading the PNG, and they stay in the cached prefix.
 *
 * Deterministic by construction (fixed pattern order, length-desc/lexical sort, no
 * Date/random) → the emitted text is byte-stable across turns and never busts the
 * Anthropic prompt cache. Empirically ~5% of source chars on production history
 * (median 4.9%, max 12.1%, N=10), which preserves the imaging token win.
 */

/** ReDoS-safe extraction patterns (each global). Ordered most- to least-specific so the
 *  longest, most-identifying tokens are kept first when the substring filter runs. */
const PATTERNS: readonly RegExp[] = [
  /\bhttps?:\/\/[^\s)"'<>]+/g, // URLs
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, // UUID
  /(?:[\w@~+-]+)?(?:\/[\w.@+-]+)+\.[A-Za-z]\w{0,8}\b/g, // path with a file extension (multi-dot ok: .test.ts)
  /\/[\w.@+-]+(?:\/[\w.@+-]+)+\/?/g, // dir path (>=2 segments)
  /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g, // git sha / long hex (must contain a digit)
  /\bv?\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?\b/g, // version string
  /(?:^|[^\w-])(--?[A-Za-z][\w-]+)/g, // CLI flag (token in capture group 1)
  /\b\d[\d,_]{3,}\b/g, // large / separated number
  /\b\d+\.\d+\b/g, // decimal
  /\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+\b/g, // CONST_IDS / env var names
  // camelCase / PascalCase with ≥1 lowercase run and ≥1 internal capital
  // (tokenLedgerShard, getUserById). Rejects ALL-CAPS words so history markers
  // like CURRENT/FRONTIER do not flood the sheet.
  /\b(?:[a-z]+|[A-Z][a-z0-9]+)(?:[A-Z][a-z0-9]*)+\b/g,
  // Ticket/advisory-style codes: uppercase hyphenated with ≥1 digit (PROJ-1482,
  // CVE-2024-30078, AUDIT-ZX9). Digit lookahead is bounded → no backtracking blowup.
  /\b(?=[A-Z0-9-]{0,119}\d)[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+\b/g,
];

const MIN_LEN = 3;
const MAX_LEN = 120;
/** Budget cap: highest-priority tokens kept first. Exported so consumers can report drops. */
export const MAX_TOKENS = 96;
// At most this many URL exemplars: URLs are long, structured, low OCR-risk, and usually
// reconstructable, so they must never crowd out short zero-redundancy tokens.
const MAX_URLS = 8;
const MAX_SEEN = 2048; // defensive bound on distinct tokens entering substring-collapse
const MAX_SCAN = 262_144; // defensive input bound; tool_results are already paged
// Match render DENSE_CONTENT_CHARS_PER_IMAGE without importing render (cycle-free).
const FACTSHEET_PAGE_CHARS = 28_080;
const MAX_CHUNK = 512; // whitespace-free chunks longer than this are blobs (base64, minified) — skip

/** Budget priority by token SHAPE, not length — length is anti-correlated with
 *  OCR-risk×consequence: a 70-char URL is structured and reconstructable, while a 7-char
 *  hex SHA or a port has zero redundancy and fails silently when misread. So short opaque
 *  identifiers outrank long URLs when the budget is tight. Pure + total → deterministic →
 *  cache-stable. Tiers: 0 = protect always, 1 = paths/versions/misc, 2 = URLs (cap + last). */
const SHAPE_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SHAPE_HEX = /^(?=[0-9a-f]*\d)[0-9a-f]{7,40}$/; // git sha / opaque hex
const SHAPE_CONST = /^[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+$/; // CONST_IDS / env vars
const SHAPE_TICKET = /^(?=[A-Z0-9-]*\d)[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+$/; // PROJ-1482 / CVE-2024-30078
const SHAPE_FLAG = /^--?[A-Za-z][\w-]+$/; // CLI flag
const SHAPE_NUM = /^\d[\d,_]*$|^\d+\.\d+$/; // port / large or separated number / decimal
const SHAPE_URL = /^https?:\/\//;
const SHAPE_CAMEL = /^(?:[a-z]+|[A-Z][a-z0-9]+)(?:[A-Z][a-z0-9]*)+$/; // tokenLedgerShard / getUserById

/** Lower tier = higher keep-priority. Pure function of the token → deterministic. */
function priorityTier(tok: string): 0 | 1 | 2 {
  if (
    SHAPE_HEX.test(tok) ||
    SHAPE_UUID.test(tok) ||
    SHAPE_CONST.test(tok) ||
    SHAPE_TICKET.test(tok) ||
    SHAPE_FLAG.test(tok) ||
    SHAPE_NUM.test(tok) ||
    (SHAPE_CAMEL.test(tok) && tok.length >= 8)
  ) {
    return 0;
  }
  if (SHAPE_URL.test(tok)) return 2;
  return 1;
}

/**
 * Extract deduped, precision-critical tokens from `text`. Substrings of a longer kept
 * token are dropped (so `/github.com` inside the full URL, `lib/x.ts` inside
 * `src/lib/x.ts`, etc. collapse to the most specific form); the token budget is then
 * filled by priority tier (see `priorityTier`) so short, high-consequence tokens are never
 * evicted by long low-risk URLs.
 *
 * Every token class is whitespace-free, so we split on whitespace first and skip
 * blob-length chunks. That bounds each regex to a short chunk and keeps extraction
 * strictly O(n) — no quadratic backtracking on delimiter-heavy input like base64 or
 * minified bundles (which embed `/` and would otherwise make the path patterns blow up).
 */
export function extractFactSheetTokens(text: string): string[] {
  return extractFactSheetEntries(text).map((e) => e.token);
}

/** A kept fact-sheet token plus how many times it occurs in the scanned text.
 *  Counts are advisory (occurrences, not lines) but deterministic → cache-stable. */
export interface FactSheetEntry {
  readonly token: string;
  readonly count: number;
}

/**
 * Like `extractFactSheetTokens`, but each kept token carries its occurrence count.
 * Counts make the fact sheet a *quantitative* index: tally questions over imaged
 * content ("how many lines mention CODE-X?") become answerable from text instead
 * of from counting rows of 5×8 px glyphs — the one operation page images are worst
 * at. The kept-token SET and its order are byte-identical to the pre-count
 * behaviour; only counts are new. Same-token spans matched by two patterns are
 * deduped by offset so a token is never double-counted.
 */
export function extractFactSheetEntries(text: string): FactSheetEntry[] {
  const scan = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text;
  const counts = new Map<string, number>();
  for (const chunk of scan.split(/\s+/)) {
    if (chunk.length < MIN_LEN || chunk.length > MAX_CHUNK) continue;
    // Offset-level dedup WITHIN this chunk: two patterns matching the identical
    // token at the same position must count once. Keyed by token+start offset.
    const spanSeen = new Set<string>();
    for (const re of PATTERNS) {
      for (const m of chunk.matchAll(re)) {
        // Strip trailing sentence punctuation pulled in from prose (`pull/93.` → `pull/93`);
        // no real identifier we extract ends in these.
        const tok = (m[1] ?? m[0]).trim().replace(/[.,;:!?]+$/, '');
        if (tok.length < MIN_LEN || tok.length > MAX_LEN) continue;
        const key = `${m.index ?? 0}\x00${tok}`;
        if (spanSeen.has(key)) continue;
        spanSeen.add(key);
        counts.set(tok, (counts.get(tok) ?? 0) + 1);
      }
    }
    if (counts.size >= MAX_SEEN) break;
  }
  // Phase 1 — substring collapse (length-desc): keep the most-specific form, folding e.g.
  // a URL's path-portion into the full URL. Cross-tier on purpose. Total order (length,
  // then lexical) so the result is independent of Set iteration order.
  const ordered = [...counts.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  const specific: string[] = [];
  for (const t of ordered) {
    if (!specific.some((k) => k.includes(t))) specific.push(t);
  }
  // Phase 2 — allocate the budget by priority tier (shape, not length) so short,
  // zero-redundancy tokens (SHAs, ports, flags) can never be evicted by long low-risk URLs.
  // URLs are kept only as a few exemplars. Comparator is total → byte-stable output.
  const ranked = specific
    .map((t) => ({ t, tier: priorityTier(t) }))
    .sort((a, b) => a.tier - b.tier || b.t.length - a.t.length || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const kept: string[] = [];
  let urls = 0;
  for (const { t, tier } of ranked) {
    if (kept.length >= MAX_TOKENS) break;
    if (tier === 2 && urls++ >= MAX_URLS) continue;
    kept.push(t);
  }
  return kept.map((t) => ({ token: t, count: counts.get(t) ?? 1 }));
}

/**
 * Page-aware variant of `extractFactSheetTokens` for large source texts.
 *
 * Splits `text` into chunks of `charsPerPage` (use `DENSE_CONTENT_CHARS_PER_IMAGE`
 * from render.ts for the export pipeline), calls `extractFactSheetTokens` on each
 * chunk (each chunk is smaller than MAX_SCAN so no truncation occurs), merges the
 * results across all chunks with first-seen deduplication, then applies a single
 * global priority-budget pass to select the best MAX_TOKENS identifiers.
 *
 * Returns `{ kept, dropped }` where `dropped` is the count of identifiers that
 * survived extraction across all pages but did not fit in the MAX_TOKENS budget.
 *
 * Does NOT mutate the behaviour of `extractFactSheetTokens` or `factSheetText`.
 */
export function extractFactSheetTokensAllPages(
  text: string,
  charsPerPage: number,
): { kept: string[]; dropped: number } {
  const { kept, dropped } = extractFactSheetEntriesAllPages(text, charsPerPage);
  return { kept: kept.map((e) => e.token), dropped };
}

/** Entry-carrying variant of `extractFactSheetTokensAllPages`: same kept set and
 *  order, with per-token occurrence counts summed across all pages. */
export function extractFactSheetEntriesAllPages(
  text: string,
  charsPerPage: number,
): { kept: FactSheetEntry[]; dropped: number } {
  const counts = new Map<string, number>();
  const all: string[] = [];

  // Walk the text in page-sized chunks. Each chunk is ≤ charsPerPage < MAX_SCAN,
  // so extractFactSheetEntries will not truncate within a chunk.
  const pageCount = Math.max(1, Math.ceil(text.length / charsPerPage));
  for (let i = 0; i < pageCount; i++) {
    const chunk = text.slice(i * charsPerPage, (i + 1) * charsPerPage);
    for (const { token, count } of extractFactSheetEntries(chunk)) {
      if (!counts.has(token)) all.push(token);
      counts.set(token, (counts.get(token) ?? 0) + count);
    }
  }

  // Re-apply the global priority budget so a tier-0 identifier on page 5
  // is never evicted by many tier-1 tokens from page 1.
  const ranked = all
    .map((t) => ({ t, tier: priorityTier(t) }))
    .sort((a, b) => a.tier - b.tier || b.t.length - a.t.length || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const kept: FactSheetEntry[] = [];
  let urls = 0;
  for (const { t, tier } of ranked) {
    if (kept.length >= MAX_TOKENS) break;
    if (tier === 2 && urls++ >= MAX_URLS) continue;
    kept.push({ token: t, count: counts.get(t) ?? 1 });
  }

  return { kept, dropped: all.length - kept.length };
}

const OPEN =
  '[Exact identifiers from the rendered context above (paths, ids, versions, numbers) — quote these verbatim instead of transcribing them from the image: ';
/** Variant used when at least one token repeats — explains the ×N annotation so the
 *  model can answer tally questions from the sheet instead of counting glyph rows. */
const OPEN_COUNTS =
  '[Exact identifiers from the rendered context above (paths, ids, versions, numbers) — quote these verbatim instead of transcribing them from the image; ×N marks a token that occurs N times within the imaged content: ';

/** Build the one-line fact-sheet string from a pre-extracted token list. */
export function factSheetTextFromTokens(tokens: string[]): string {
  return tokens.length > 0 ? OPEN + tokens.join(' · ') + ']' : '';
}

/** Build the one-line fact-sheet string from token+count entries. Byte-identical to
 *  `factSheetTextFromTokens` when no token repeats, so existing sheets stay cache-stable. */
export function factSheetTextFromEntries(entries: readonly FactSheetEntry[]): string {
  if (entries.length === 0) return '';
  const anyRepeat = entries.some((e) => e.count >= 2);
  const body = entries.map((e) => (e.count >= 2 ? `${e.token} ×${e.count}` : e.token)).join(' · ');
  return (anyRepeat ? OPEN_COUNTS : OPEN) + body + ']';
}

/** One-line fact-sheet string for `text`, or `''` when nothing notable was found.
 *  Single path for slab, history, and tool results: page long text so early-turn
 *  ids are not dropped by MAX_SCAN. Short text is one page (same as before). */
export function factSheetText(text: string): string {
  if (!text) return '';
  if (text.length <= MAX_SCAN) {
    return factSheetTextFromEntries(extractFactSheetEntries(text));
  }
  const { kept } = extractFactSheetEntriesAllPages(text, FACTSHEET_PAGE_CHARS);
  return factSheetTextFromEntries(kept);
}

/** Shape label for an IDS-block line (visual OCR aid, not a factsheet). */
function idsBlockLabel(tok: string): string {
  if (SHAPE_HEX.test(tok)) return 'hex';
  if (SHAPE_UUID.test(tok)) return 'uuid';
  if (SHAPE_CAMEL.test(tok) && tok.length >= 8) return 'camel';
  if (tok.includes('/')) return 'path';
  if (SHAPE_NUM.test(tok) && tok.length <= 8) return 'port';
  if (SHAPE_CONST.test(tok)) return 'const';
  if (SHAPE_FLAG.test(tok)) return 'flag';
  if (SHAPE_TICKET.test(tok)) return 'code';
  return 'id';
}

/**
 * Append a short multi-line IDS block of precision-critical tokens so each ID
 * sits on its own rendered row (pure-image OCR aid at 5×8). Deterministic.
 * Used on every imaged path (Claude + GPT + Grok). Grok pure-image packing
 * validated 2026-07-11 (white+ids_block 7/7 4/4); other families get the same
 * visual isolation as defense in depth alongside the text fact-sheet.
 * Does not replace the text fact-sheet; the IDS block is rasterized into the PNG.
 */
export function appendIdsBlock(text: string, maxIds = 16): string {
  if (!text) return text;
  if (/\nIDS\n/.test(text) || text.startsWith('IDS\n')) return text;
  const entries =
    text.length <= MAX_SCAN
      ? extractFactSheetEntries(text)
      : extractFactSheetEntriesAllPages(text, FACTSHEET_PAGE_CHARS).kept;
  // Prefer tier-0 (hex, ports, camel, flags), then tier-1 paths — same
  // consequence ranking as the fact-sheet budget, but keep a few paths so
  // pure-image path probes stay visible as isolated rows.
  const tokens: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    if (seen.has(t) || tokens.length >= maxIds) return;
    seen.add(t);
    tokens.push(t);
  };
  for (const { token } of entries) {
    if (priorityTier(token) === 0) push(token);
  }
  for (const { token } of entries) {
    if (priorityTier(token) === 1 && token.includes('/')) push(token);
  }
  if (tokens.length === 0) return text;
  const lines = tokens.map((t) => `${idsBlockLabel(t)} ${t}`);
  return `${text.replace(/\s+$/, '')}\nIDS\n${lines.join('\n')}\n`;
}
