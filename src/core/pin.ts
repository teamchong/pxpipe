/**
 * User-pinned instructions.
 *
 * The problem: CLAUDE.md arrives in message 0, and by the time a long tool loop
 * has run, position 0 reads as background rather than instruction. The harness
 * itself works around this for its own rules by re-emitting `<system-reminder>`
 * at the TAIL, where the model reads it last, immediately before generating.
 * A pin buys that slot for the user's rules.
 *
 * Syntax is one line, one pin, wherever the user can type:
 *
 *     @pxpipe pin be concise, no walls of text
 *     @pxpipe unpin
 *
 * The line is identical in a rules file (durable) and in a chat turn (session-only),
 * so a session pin that works is made permanent by pasting it into the file. What
 * differs is only WHERE it was found, which is enough to classify it:
 *
 *   - inside the leading `<system-reminder>` run of message 0  → 'file'
 *   - anywhere in the system prompt                            → 'file'
 *   - in a user's typed text                                   → 'session'
 *   - in any later `<system-reminder>` (inlined `@`-mention)   → 'session'
 *
 * Two file locations because harnesses disagree on where a rules file goes.
 * Claude Code inlines CLAUDE.md into message 0 behind a `<system-reminder>`
 * envelope; OpenCode puts AGENTS.md in the system prompt with no wrapper and no
 * label. Scanning only the first shape is what made #155 a no-op under OpenCode.
 * Both are a file the user can edit, so both earn the durable tier.
 *
 * State is re-derived from the transcript on every request — no store, no session
 * id (the Messages API has none), and rewinding the conversation rewinds the pins.
 * This works even though we strip the commands from the outbound copy: pxpipe only
 * rewrites the request going upstream, so the client's own transcript keeps
 * re-sending them verbatim every turn.
 */

import type { ContentBlock, ImageBlock, Message, SystemField, TextBlock } from './types.js';

/** One pin line. Longer than this is a document, not an instruction. */
const PIN_MAX_CHARS = 300;

/** Total pinned text emitted at the tail. A pin that dilutes itself is not a pin. */
const PIN_TOTAL_MAX_CHARS = 2000;

/**
 * `@pxpipe pin <text>` / `@pxpipe unpin`, anchored to a whole line so removal is a
 * whole-line delete — deterministic, with no leftover blank-line ambiguity. That
 * determinism is what lets us MOVE pins (strip from source, emit at tail) instead
 * of copying: the rewrite stays a pure function of the message, so the protected
 * prefix remains byte-stable turn to turn, exactly like demoteProtectedHeadText.
 */
const PIN_CMD_RE = /^@pxpipe[ \t]+(pin|unpin)\b(.*)$/;

/**
 * Parse one line as a pin command. Returns null when it isn't one.
 *
 * The surrounding whitespace is trimmed in JS rather than in the pattern. The
 * obvious `^[ \t]*...[ \t]*(.*?)[ \t]*$` is quadratic: on a line of many tabs
 * the leading, lazy, and trailing groups can all claim the same run, so the
 * engine retries every split before failing. Prompt text reaches this on every
 * line of every message, so it stays linear.
 */
function matchPinCmd(line: string): { verb: string; rest: string } | null {
  const m = PIN_CMD_RE.exec(line.trim());
  return m ? { verb: m[1]!, rest: m[2]!.trim() } : null;
}

/** Leading `<system-reminder>` run — the harness's CLAUDE.md envelope. */
const LEADING_REMINDER_RE = /^\s*<system-reminder>[\s\S]*?<\/system-reminder>/;

const REMINDER_OPEN = '<system-reminder>';
const REMINDER_CLOSE = '</system-reminder>';

/**
 * Drop every reminder, anywhere in a block. The harness appends its own notices
 * (e.g. "task tools haven't been used recently") to a turn the user typed, so a
 * turn is command-only by what the *user* wrote, not by what the harness added.
 *
 * Scanned rather than matched with `/<system-reminder>[\s\S]*?<\/…>/g`: under a
 * lazy body every unterminated open rescans to the end of the string, so a
 * message carrying many of them costs O(n²). An unterminated open ends the
 * scan; the rest of the block is text the user can see, so it stays.
 */
function stripReminders(text: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const open = text.indexOf(REMINDER_OPEN, at);
    if (open < 0) break;
    const close = text.indexOf(REMINDER_CLOSE, open + REMINDER_OPEN.length);
    if (close < 0) break;
    out += text.slice(at, open);
    at = close + REMINDER_CLOSE.length;
  }
  return out + text.slice(at);
}

/** Opening marker of a synthesized pin confirmation. We generate these, so the
 *  match is on bytes we control, not a heuristic that could eat a real reply. */
/** Prefix on every synthesized reply, and the whole test for recognizing one on
 *  the way back in. Shares the `@pxpipe` namespace with the commands so there is
 *  one token to learn and one to match, and unlike `·` it survives any encoding
 *  or copy/paste the transcript is put through. */
export const PIN_REPLY_MARK = '@pxpipe ';

/**
 * Which tier a pin lives in. `'file'`, not `'claude.md'`: the same tier holds
 * whatever the harness inlined, which is CLAUDE.md under Claude Code and
 * AGENTS.md under OpenCode. (Codex inlines AGENTS.md too, but it speaks the
 * Responses API, and foldPins has exactly one call site: the Messages path in
 * transform.ts. Pins are still a no-op there.)
 *
 * The tier is named for the origin because the origin is what answers the two
 * questions a user has: why `unpin` refuses, and what to edit instead.
 */
export type PinSource = 'file' | 'session';

/** Which command the live turn ended with — it decides what the reply lists. */
export type PinVerb = 'pin' | 'unpin';

export interface Pin {
  text: string;
  source: PinSource;
  /**
   * Absolute path of the file this line came from, when the harness named it in
   * the envelope. Carried per pin, not per tier, because one leading run can
   * inline several files and a header that says `CLAUDE.md` over a line that
   * came from `AGENTS.md` sends the user to edit the wrong file.
   */
  path?: string;
}

/**
 * Fold every pin command in the transcript, oldest to newest.
 *
 *   @pxpipe unpin 2        remove the pin listed as 2
 *   @pxpipe unpin use tabs remove by text (exact, else prefix)
 *   @pxpipe unpin all      clear every session pin
 *   @pxpipe unpin          NOT destructive — prints the list
 *
 * Bare `unpin` used to clear everything and then print what survived, which read
 * as a menu and destroyed the thing the user was still deciding about. Removal now
 * requires naming a target; the bare form is a query.
 *
 * Every form clears SESSION pins only. Clearing CLAUDE.md pins too would mean an
 * `unpin` typed forty turns ago silently disables the project's rules for the
 * rest of the session with nothing on screen to explain why; to drop a durable
 * pin you delete its line from the file, where the change is visible.
 */
export function foldPins(messages: Message[], system?: SystemField): Pin[] {
  const pins: Pin[] = [];
  // System first: it is serialized ahead of the messages, so folding in wire
  // order is what makes the emitted block read in the order the user wrote it.
  for (const entry of systemPinLines(system)) applyPinLine(pins, entry);
  messages.forEach((m, idx) => {
    if (m.role !== 'user') return;
    for (const entry of pinLines(m, idx)) applyPinLine(pins, entry);
  });
  return pins;
}

/** Fold one candidate line into the accumulated pin list. */
function applyPinLine(
  pins: Pin[],
  { line, source, path }: { line: string; source: PinSource; path?: string },
): void {
  const cmd = matchPinCmd(line);
  if (!cmd) return;
  if (cmd.verb === 'unpin') {
    applyUnpin(pins, cmd.rest);
    return;
  }
  const raw = cmd.rest;
  // Mark the cut. The source line is stripped from the outbound copy, so a
  // severed rule reads to the model as a whole one — "do X unless Y" becomes
  // "do X" — while the user's own transcript still shows the full text.
  const text = raw.length > PIN_MAX_CHARS
    ? `${raw.slice(0, PIN_MAX_CHARS)}… [pxpipe: pin truncated]`
    : raw;
  if (source === 'file') {
    // A file is a document, not a list of instructions. Its blank lines and
    // its repeated lines ARE the format: a fence closes with the same ```
    // that opened it, a table rule repeats, and an example that shows
    // `Before: <code sample>` shows the same `<code sample>` again under
    // `After:`. Deduping or dropping those leaves the user's own rules
    // rendered as something they did not write — an empty `After:`, a fence
    // that never closes. Only message 0's leading reminder and the system
    // prompt reach here (see pinLines / systemPinLines), and both are sent
    // once per request, so the document cannot accumulate across turns
    // without the dedup guard.
    const prev = pins[pins.length - 1];
    // Blank runs collapse to one, and a leading blank is dropped: they cost
    // budget that later lines need, and neither changes how the text reads.
    if (!text && (!prev || !prev.text)) return;
    pins.push({ text, source, path });
    return;
  }
  if (!text) return;
  if (pins.some((p) => p.text === text)) return;
  pins.push({ text, source });
}

/**
 * Resolve one `unpin` argument against the pins in effect at that point.
 *
 * Numbers address the SESSION list only — the same list pinReplyText numbers.
 * This is not cosmetic: an `@pxpipe unpin 2` stays in the transcript and is
 * re-folded on every later request, so if numbering also covered CLAUDE.md pins,
 * adding one line to that file would renumber the list underneath a command
 * already given, and it would silently start deleting a different pin.
 * Numbering only the removable entries makes the indices immune to file edits.
 */
function applyUnpin(pins: Pin[], arg: string): void {
  if (!arg) return; // bare `unpin` is a query; pinReplyText answers it
  if (arg === 'all') {
    for (let i = pins.length - 1; i >= 0; i--) {
      if (pins[i]!.source === 'session') pins.splice(i, 1);
    }
    return;
  }
  const session = pins.filter((p) => p.source === 'session');
  let target: Pin | undefined;
  if (/^\d+$/.test(arg)) {
    target = session[Number(arg) - 1];
  } else {
    // Text form: the user already knows the words, so accept a prefix rather
    // than demand the pin be retyped exactly.
    const lower = arg.toLowerCase();
    target = session.find((p) => p.text === arg)
      ?? session.find((p) => p.text.toLowerCase().startsWith(lower));
  }
  if (target) pins.splice(pins.indexOf(target), 1);
}

/**
 * Every line of a user message that may carry a command, tagged with where it
 * came from.
 *
 * Message 0's LEADING reminder run is the harness's file envelope, whatever it
 * chose to inline there: global CLAUDE.md, project CLAUDE.md, AGENTS.md. A file
 * backs those pins, so they are durable and `unpin` cannot reach them.
 *
 * A reminder block anywhere else is inlined `@`-mention content (the harness reads
 * the file and pastes it in) or a per-turn notice. No file tier backs those, so
 * they pin as `session` and `unpin` can drop them. That is deliberate: an inlined
 * document containing `@pxpipe pin ...` can pin itself, and the removable tier
 * plus the pin report is what makes that visible and reversible.
 */
function* pinLines(
  m: Message,
  idx: number,
): Generator<{ line: string; source: PinSource; path?: string }> {
  const blocks: ContentBlock[] = typeof m.content === 'string'
    ? [{ type: 'text', text: m.content }]
    : Array.isArray(m.content) ? m.content : [];
  let leadingRun = idx === 0;
  for (const blk of blocks) {
    if (!blk || typeof blk !== 'object' || (blk as { type?: string }).type !== 'text') {
      continue;
    }
    const text = (blk as TextBlock).text;
    if (typeof text !== 'string') continue;
    if (LEADING_REMINDER_RE.test(text)) {
      // A file backs the leading run, so it owns the durable tier. Everything
      // later is inlined mention content or a per-turn notice: pin it, but keep
      // it in the tier `unpin` can reach.
      const source: PinSource = leadingRun ? 'file' : 'session';
      // Per block, not per message: one leading run can inline several files,
      // and each pin has to remember which one to send the user back to.
      let consumed = 0;
      for (const block of reminderBlocks(text)) {
        consumed += block.length;
        const path = source === 'file' ? filePathOf(block) : undefined;
        for (const line of block.split('\n')) yield { line, source, path };
      }
      // The harness packs the envelope and the user's own typed prompt into the
      // SAME block. Stopping at the run would strip a pin typed in the first
      // turn (stripLines is unconditional) without ever folding it.
      const rest = text.slice(consumed);
      if (rest.trim()) {
        leadingRun = false;
        for (const line of rest.split('\n')) yield { line, source: 'session' };
      }
      continue;
    }
    leadingRun = false;
    for (const line of text.split('\n')) yield { line, source: 'session' };
  }
}

/**
 * Pin lines in the system prompt, where OpenCode puts AGENTS.md.
 *
 * No `<system-reminder>` gate here, unlike pinLines. That gate exists because a
 * user message is mostly the user talking and the envelope is what marks the part
 * that came from a file. The system prompt has no such ambiguity: the user does
 * not type into it, so every line in it was placed by the harness, and a pin
 * command found there came from a file the user edited. Requiring a wrapper that
 * only Claude Code emits is precisely what made this path dead under OpenCode.
 *
 * Everything is the `file` tier for the same reason: it comes back next request
 * whatever `unpin` does, so offering to remove it would be a lie.
 */
function* systemPinLines(
  sys: SystemField | undefined,
): Generator<{ line: string; source: PinSource; path?: string }> {
  if (sys == null) return;
  const blocks: Array<TextBlock | ImageBlock> = typeof sys === 'string'
    ? [{ type: 'text', text: sys }]
    : Array.isArray(sys) ? sys : [];
  for (const blk of blocks) {
    if (!blk || typeof blk !== 'object' || (blk as { type?: string }).type !== 'text') continue;
    const text = (blk as TextBlock).text;
    if (typeof text !== 'string') continue;
    // Codex labels its AGENTS.md block, OpenCode does not. Ask anyway: a label
    // costs one regex and buys the user the path to edit.
    const path = filePathOf(text);
    for (const line of text.split('\n')) yield { line, source: 'file', path };
  }
}

/** The leading `<system-reminder>` run of a block, one entry per reminder. */
function reminderBlocks(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  for (;;) {
    const m = LEADING_REMINDER_RE.exec(rest);
    if (!m) break;
    out.push(m[0]);
    rest = rest.slice(m[0].length);
  }
  return out;
}

/**
 * The file a reminder block was read from, when it says so.
 *
 * Every harness that inlines a rules file labels it, because the model has to
 * know which file it is reading: Claude Code writes `Contents of <path> (...)`,
 * and Codex the same for AGENTS.md. Matching the label rather than a filename
 * list is what makes this work for a file we have never heard of; an unlabelled
 * block just falls back to the generic header.
 */
function filePathOf(block: string): string | undefined {
  return /^Contents of (.+?)(?: \(|:\s*$)/m.exec(block)?.[1]?.trim();
}

/** True when this message's only typed content is pin commands. */
function isCommandOnlyTurn(m: Message, live = false): boolean {
  if (m.role !== 'user') return false;
  const blocks: ContentBlock[] = typeof m.content === 'string'
    ? [{ type: 'text', text: m.content }]
    : Array.isArray(m.content) ? m.content : [];
  let sawCommand = false;
  for (const blk of blocks) {
    if (!blk || typeof blk !== 'object') return false;
    if ((blk as { type?: string }).type !== 'text') return false; // tool_result/image: real work
    const raw = (blk as TextBlock).text;
    if (typeof raw !== 'string') return false;
    // The CLAUDE.md envelope rides in the same block as the user's first typed
    // line, so `pin` as the opening line of a Claude Code session arrives behind
    // it. Answering that turn locally is safe: nothing is forwarded, and the
    // client resends message 0 intact on the next request. Rewriting it is not —
    // the outbound path would drop the whole block and take the project's
    // instructions with it, so only the live test tolerates the envelope.
    if (!live && LEADING_REMINDER_RE.test(raw)) return false;
    const text = stripReminders(raw);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      if (!matchPinCmd(line)) return false;
      sawCommand = true;
    }
  }
  return sawCommand;
}

/** True when a message is a pin confirmation this proxy synthesized. */
function isPinReply(m: Message | undefined): boolean {
  if (!m || m.role !== 'assistant') return false;
  const blocks = Array.isArray(m.content) ? m.content : [];
  if (typeof m.content === 'string') return m.content.startsWith(PIN_REPLY_MARK);
  if (blocks.length !== 1) return false;
  const blk = blocks[0]!;
  return (blk as { type?: string }).type === 'text'
    && typeof (blk as TextBlock).text === 'string'
    && (blk as TextBlock).text.startsWith(PIN_REPLY_MARK);
}

/**
 * Remove pin commands and their synthesized confirmations from the OUTBOUND copy.
 * The client keeps its own transcript, so nothing is lost: the next request still
 * arrives with every command intact and foldPins re-derives the same state.
 *
 * A command-only turn is dropped together with the confirmation that answered it —
 * never one alone, or the user/assistant roles stop alternating. A mixed turn keeps
 * its prose and loses only the command lines, so the model is not distracted by
 * configuration in the middle of a request it has to act on.
 */
export function stripPinCommands(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (isCommandOnlyTurn(m) && isPinReply(messages[i + 1])) {
      i++; // drop the pair
      continue;
    }
    if (m.role !== 'user') {
      out.push(m);
      continue;
    }
    const stripped = stripFromMessage(m);
    if (stripped === null) {
      // Commands and nothing else, with no confirmation to pair with. Keeping
      // the original would send `@pxpipe pin ...` to the model as if it were a
      // request; dropping it alone would break role alternation, so it goes
      // with the reply that answered it. As the final turn there is no reply
      // yet and proxy.ts answers locally, so leave it for that path.
      if (messages[i + 1]?.role === 'assistant') { i++; continue; }
      out.push(m);
      continue;
    }
    out.push(stripped ?? m);
  }
  return out;
}

/** Strip command lines from a user message, or undefined if nothing changed.
 *  Returns the original when stripping would leave the message with no content —
 *  an empty `content` is rejected by the API, and dropping a lone message would
 *  break role alternation. */
function stripFromMessage(m: Message): Message | null | undefined {
  if (typeof m.content === 'string') {
    const text = stripLines(m.content);
    if (text === m.content) return undefined;
    return text.trim() ? { ...m, content: text } : null;
  }
  if (!Array.isArray(m.content)) return undefined;
  let changed = false;
  const blocks: ContentBlock[] = [];
  for (const blk of m.content) {
    if (blk && typeof blk === 'object' && (blk as { type?: string }).type === 'text') {
      const tb = blk as TextBlock;
      if (typeof tb.text === 'string') {
        const text = stripLines(tb.text);
        if (text !== tb.text) {
          changed = true;
          if (!text.trim()) {
            // `{text: ''}` is rejected by the API, so the block cannot stay. Its
            // cache_control can't just go with it — dropping a breakpoint moves
            // the cache boundary — so hand it to the block in front.
            const prev = blocks[blocks.length - 1] as TextBlock | undefined;
            if (tb.cache_control !== undefined && prev) {
              blocks[blocks.length - 1] = { ...prev, cache_control: tb.cache_control };
            } else if (tb.cache_control !== undefined) {
              blocks.push(blk); // nothing in front to hold it: leave as sent
            }
            continue;
          }
          blocks.push({ ...tb, text });
          continue;
        }
      }
    }
    blocks.push(blk);
  }
  if (!changed) return undefined;
  if (blocks.length === 0) return null;
  return { ...m, content: blocks };
}

/**
 * Remove pin commands from the system prompt. Returns `undefined` when nothing
 * changed, so the caller can leave the original object identity alone.
 *
 * Same move as stripFromMessage, including the `cache_control` handoff: system
 * blocks carry the breakpoint that ends the cacheable prefix (extractSystemText
 * keys on it), so a block emptied by stripping must pass its marker forward
 * rather than take the boundary with it.
 *
 * Stripping here does rewrite bytes inside the cached prefix. That is the cost
 * the message path already pays for CLAUDE.md: one cache create on the turn the
 * strip first applies, then a stable prefix, because the rewrite is a pure
 * function of the input and the client keeps re-sending the same source lines.
 */
export function stripPinCommandsFromSystem(
  sys: SystemField | undefined,
): SystemField | undefined {
  if (sys == null) return undefined;
  if (typeof sys === 'string') {
    const text = stripLines(sys);
    return text === sys ? undefined : text;
  }
  if (!Array.isArray(sys)) return undefined;
  let changed = false;
  const out: Array<TextBlock | ImageBlock> = [];
  for (const blk of sys) {
    if (blk && typeof blk === 'object' && (blk as { type?: string }).type === 'text') {
      const tb = blk as TextBlock;
      if (typeof tb.text === 'string') {
        const text = stripLines(tb.text);
        if (text !== tb.text) {
          changed = true;
          if (!text.trim()) {
            const prev = out[out.length - 1] as TextBlock | undefined;
            if (tb.cache_control !== undefined && prev && prev.type === 'text') {
              out[out.length - 1] = { ...prev, cache_control: tb.cache_control };
            } else if (tb.cache_control !== undefined) {
              out.push(blk); // nothing in front to hold it: leave as sent
            }
            continue;
          }
          out.push({ ...tb, text });
          continue;
        }
      }
    }
    out.push(blk);
  }
  return changed ? out : undefined;
}

function stripLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !matchPinCmd(line))
    .join('\n');
}

/**
 * The block appended at the tail. Sits after every existing `cache_control`
 * breakpoint, so its bytes are re-read each turn by construction and it can never
 * cost a cache miss — which is also why formatting drift in the user's source
 * lines is free here, and why we normalize purely for tidy telemetry.
 */
export function pinBlockText(pins: Pin[]): string {
  if (pins.length === 0) return '';
  let budget = PIN_TOTAL_MAX_CHARS;
  const lines: string[] = [];
  for (const p of pins) {
    // Skip, don't stop: one long file excerpt early in a big CLAUDE.md would
    // otherwise swallow every session pin the user typed this turn.
    if (budget - p.text.length < 0) continue;
    budget -= p.text.length;
    // Session pins are a list the user dictated one line at a time, so a bullet
    // is what they meant. A file excerpt is markdown the user already formatted;
    // bulleting it turns their `##` headings, table rows and fenced blocks into
    // list items, i.e. we would be reformatting the very text we claim is "the
    // user's own words".
    lines.push(p.source === 'file' ? p.text : `- ${p.text}`);
  }
  if (lines.length === 0) return '';
  return [
    '<system-reminder>',
    '[pxpipe pin] The user pinned these instructions and pxpipe relocated them here,',
    'last in the request, because rules stated far above get read as background. They',
    "are the user's own words and they govern this reply; on conflict they win.",
    ...lines,
    '</system-reminder>',
  ].join('\n');
}

/**
 * True when appendPinBlock has somewhere to land.
 *
 * Pins are MOVED, not copied, so the strip and the append are one operation: an
 * assistant prefill as the final message (nothing may follow it) or a final user
 * turn with content we cannot push onto means the block has no home, and
 * stripping anyway would delete the user's rules from the request entirely.
 */
export function canAppendPinBlock(messages: Message[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return false;
  return typeof last.content === 'string' || Array.isArray(last.content);
}

/** Append the pin block to the final user message. Returns chars added. */
export function appendPinBlock(messages: Message[], pins: Pin[]): number {
  const text = pinBlockText(pins);
  if (!text) return 0;
  const last = messages[messages.length - 1];
  // An assistant prefill must remain the final message, and nothing may follow it.
  if (!last || last.role !== 'user') return 0;
  if (typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content }];
  }
  if (!Array.isArray(last.content)) return 0;
  last.content.push({ type: 'text', text });
  return text.length;
}

/**
 * The confirmation shown when a bare pin command is answered locally.
 *
 * Always the COMPLETE list, never a delta: the question a user has after typing a
 * pin is "what is in effect now", and a delta makes them replay the session in
 * their head to find out. The source header is the part that matters: it says
 * which lines survive a restart and which `unpin` will clear.
 */
/**
 * File pins grouped under the file they came from, in first-seen order.
 *
 * Grouped rather than tagged per line: against a real rules file the tag repeats
 * down the whole list and buries the text it means to annotate. A block the
 * harness did not label still gets a header, because the alternative is a run of
 * lines with no answer to "where do I edit this".
 */
function fileHeaders(pins: Pin[]): Array<{ path: string; pins: Pin[] }> {
  const out: Array<{ path: string; pins: Pin[] }> = [];
  for (const p of pins) {
    if (p.source !== 'file') continue;
    const path = p.path ?? 'system instructions';
    const last = out[out.length - 1];
    if (last && last.path === path) last.pins.push(p);
    else out.push({ path, pins: [p] });
  }
  return out;
}

export function pinReplyText(pins: Pin[], verb: PinVerb = 'pin'): string {
  if (verb === 'unpin') {
    // `unpin` is a removal prompt, so it lists removal targets. Showing the file
    // lines here offers the user things this command cannot act on, and with a
    // file of any size the few numbered entries are buried under dozens of
    // unactionable ones. `pin` still lists everything in effect.
    const session = pins.filter((p) => p.source === 'session');
    if (session.length === 0) {
      const where = fileHeaders(pins);
      const fromFile = pins.length > 0
        ? `\n  ${pins.length} pinned ${pins.length === 1 ? 'line' : 'lines'} come from ${where.length === 1 ? where[0]!.path : `${where.length} files`}   (edit the file to change these)`
        : '';
      return `${PIN_REPLY_MARK}nothing to unpin${fromFile}`;
    }
    const lines = [`session   (@pxpipe unpin <n>, or unpin all)`, ''];
    session.forEach((p, i) => lines.push(`${i + 1}. ${p.text}`));
    return `${PIN_REPLY_MARK}${session.length} removable\n${lines.join('\n')}`;
  }
  if (pins.length === 0) {
    return `${PIN_REPLY_MARK}nothing pinned\n  @pxpipe pin <instruction>`;
  }
  // Grouped under a source header rather than tagging each line: against a real
  // CLAUDE.md the tag repeats down the whole list and buries the text it means to
  // annotate. Only session pins are numbered, because only they can be removed by
  // one, so the numbering doubles as the marker for what `unpin N` will act on.
  const out: string[] = [];
  const session = pins.filter((p) => p.source === 'session');
  for (const group of fileHeaders(pins)) {
    out.push('', `${group.path}   (edit the file to change these)`, '');
    // Column 0, never indented: the pinned text is the user's markdown, and a
    // four-space indent turns the whole block into one code span, which is how
    // a rules file full of headings, tables and fences stops rendering at all.
    for (const p of group.pins) out.push(p.text);
  }
  if (session.length > 0) {
    out.push('', `session   (@pxpipe unpin <n>, or unpin all)`, '');
    session.forEach((p, i) => out.push(`${i + 1}. ${p.text}`));
  }
  return `${PIN_REPLY_MARK}${pins.length} pinned\n${out.slice(1).join('\n')}`;
}

/**
 * True when the live turn is nothing but pin commands, so the proxy can answer it
 * without spending an upstream call. Deliberately narrow: a turn carrying any real
 * prose, or a tool_result (a tool loop that must not be hijacked mid-flight), is
 * forwarded normally with the command lines merely stripped.
 */
export function isPinOnlyRequest(messages: Message[] | undefined): boolean {
  const live = liveTurn(messages);
  return !!live && isCommandOnlyTurn(live, true);
}

/**
 * The turn the request is actually asking about. Claude Code appends a
 * system-role message (its agent-type catalogue) *after* the user's turn, so
 * the literal last element is client metadata, not work — every cc pin command
 * went upstream unanswered because of it. Only `system` is skipped: a trailing
 * tool_result or assistant prefill is real work and must stay on the normal
 * path, which is what keeps a mid-tool-loop turn from being hijacked.
 */
function liveTurn(messages: Message[] | undefined): Message | undefined {
  const list = messages ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m && (m as { role?: string }).role === 'system') continue;
    return m;
  }
  return undefined;
}

/**
 * The verb the live turn ended with. Last one wins: a turn is answered once, so
 * `pin x` followed by `unpin` is a removal prompt, not a listing.
 */
function liveVerb(m: Message | undefined): PinVerb {
  let verb: PinVerb = 'pin';
  if (!m) return verb;
  const blocks: ContentBlock[] = typeof m.content === 'string'
    ? [{ type: 'text', text: m.content }]
    : Array.isArray(m.content) ? m.content : [];
  for (const blk of blocks) {
    const text = (blk as TextBlock)?.text;
    if (typeof text !== 'string') continue;
    for (const line of text.split('\n')) {
      const cmd = matchPinCmd(line);
      if (cmd) verb = cmd.verb as PinVerb;
    }
  }
  return verb;
}

/**
 * Answer a bare pin turn locally, or undefined to forward normally.
 *
 * Fails open on anything unexpected — a malformed body is the upstream's problem
 * to report, not ours to swallow, and a parse quirk must never cost the user a
 * turn that had real work in it.
 */
export function pinCommandResponse(
  bodyIn: Uint8Array,
): { body: string; contentType: string } | undefined {
  let req: { messages?: Message[]; model?: string; stream?: boolean };
  try {
    req = JSON.parse(new TextDecoder().decode(bodyIn));
  } catch {
    return undefined;
  }
  if (!Array.isArray(req.messages) || !isPinOnlyRequest(req.messages)) return undefined;
  return synthesizeReply(
    pinReplyText(foldPins(req.messages), liveVerb(liveTurn(req.messages))),
    typeof req.model === 'string' ? req.model : 'pxpipe',
    req.stream === true,
  );
}

/** A local `/v1/messages` response carrying `text`, matching the client's
 *  streaming preference. Zero usage: nothing was billed, and reporting otherwise
 *  would corrupt the dashboard's token accounting. */
export function synthesizeReply(
  text: string,
  model: string,
  stream: boolean,
): { body: string; contentType: string } {
  const id = `msg_pxpipe_pin_${Date.now().toString(36)}`;
  const usage = { input_tokens: 0, output_tokens: 0 };
  if (!stream) {
    return {
      contentType: 'application/json',
      body: JSON.stringify({
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage,
      }),
    };
  }
  const ev = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return {
    contentType: 'text/event-stream',
    body:
      ev('message_start', {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage,
        },
      }) +
      ev('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      ev('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 0 },
      }) +
      ev('message_stop', { type: 'message_stop' }),
  };
}

/** Which OpenAI wire schema the reply has to imitate. */
export type OpenAIPinWire = 'chat' | 'responses';

interface OpenAIItem {
  type?: string;
  role?: string;
  content?: unknown;
}

/** Text parts of one OpenAI message. `input_text`/`output_text` are the
 *  Responses spellings of Chat Completions' `text`; images and file parts carry
 *  no pin commands, so they drop out. */
function openAITextBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const raw of content) {
    const part = raw as { type?: string; text?: unknown };
    if (!part || typeof part.text !== 'string') continue;
    if (part.type === undefined || part.type === 'text'
      || part.type === 'input_text' || part.type === 'output_text') {
      out.push({ type: 'text', text: part.text });
    }
  }
  return out;
}

/**
 * Rewrite an OpenAI request into the Messages shape the pin folder understands.
 * `instructions` and system/developer turns become the system field, which is
 * where file-sourced pins live on this wire.
 */
function normalizeOpenAIRequest(
  req: { messages?: unknown; input?: unknown; instructions?: unknown },
): { messages: Message[]; system?: SystemField } | undefined {
  const items = Array.isArray(req.input) ? req.input
    : Array.isArray(req.messages) ? req.messages
    : typeof req.input === 'string' ? [{ role: 'user', content: req.input }]
    : undefined;
  if (!items) return undefined;
  const system: Array<TextBlock | ImageBlock> = [];
  if (typeof req.instructions === 'string' && req.instructions) {
    system.push({ type: 'text', text: req.instructions });
  }
  const messages: Message[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') return undefined;
    const item = raw as OpenAIItem;
    // reasoning / function_call / function_call_output are not messages. They
    // still occupy a slot: a tool result in the last position must not let an
    // older pin command look like the live turn and replay its answer.
    if (item.type !== undefined && item.type !== 'message') {
      messages.push({ role: 'assistant', content: [] });
      continue;
    }
    const blocks = openAITextBlocks(item.content);
    if (item.role === 'system' || item.role === 'developer') {
      for (const blk of blocks) system.push(blk as TextBlock);
      continue;
    }
    messages.push({ role: item.role === 'user' ? 'user' : 'assistant', content: blocks });
  }
  return { messages, system: system.length > 0 ? system : undefined };
}

/** `pinCommandResponse` for the OpenAI routes. Codex talks Responses and other
 *  clients talk Chat Completions, so the same command has to be answered in
 *  whichever schema the caller used. */
export function pinCommandResponseOpenAI(
  bodyIn: Uint8Array,
  wire: OpenAIPinWire,
): { body: string; contentType: string } | undefined {
  let req: {
    messages?: unknown;
    input?: unknown;
    instructions?: unknown;
    model?: string;
    stream?: boolean;
  };
  try {
    req = JSON.parse(new TextDecoder().decode(bodyIn));
  } catch {
    return undefined;
  }
  const norm = normalizeOpenAIRequest(req);
  if (!norm || !isPinOnlyRequest(norm.messages)) return undefined;
  const text = pinReplyText(
    foldPins(norm.messages, norm.system),
    liveVerb(norm.messages[norm.messages.length - 1]),
  );
  const model = typeof req.model === 'string' ? req.model : 'pxpipe';
  return wire === 'responses'
    ? synthesizeResponsesReply(text, model, req.stream === true)
    : synthesizeChatReply(text, model, req.stream === true);
}

/** Local `/v1/chat/completions` reply carrying `text`. Zero usage: nothing was
 *  billed, and reporting otherwise would corrupt the dashboard's accounting. */
export function synthesizeChatReply(
  text: string,
  model: string,
  stream: boolean,
): { body: string; contentType: string } {
  const id = `chatcmpl_pxpipe_pin_${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  if (!stream) {
    return {
      contentType: 'application/json',
      body: JSON.stringify({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
          logprobs: null,
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    };
  }
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return {
    contentType: 'text/event-stream',
    body: chunk({ role: 'assistant', content: '' }, null)
      + chunk({ content: text }, null)
      + chunk({}, 'stop')
      + 'data: [DONE]\n\n',
  };
}

/** Local `/v1/responses` reply carrying `text`, in the event order the Responses
 *  API emits: clients read the final item from `response.completed`, but Codex
 *  renders the streamed deltas, so both have to be present. */
export function synthesizeResponsesReply(
  text: string,
  model: string,
  stream: boolean,
): { body: string; contentType: string } {
  const stamp = Date.now().toString(36);
  const id = `resp_pxpipe_pin_${stamp}`;
  const itemId = `msg_pxpipe_pin_${stamp}`;
  const created_at = Math.floor(Date.now() / 1000);
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const item = {
    id: itemId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const response = (status: string, output: unknown[]) => ({
    id,
    object: 'response',
    created_at,
    status,
    model,
    output,
    error: null,
    incomplete_details: null,
    usage: status === 'completed' ? usage : null,
  });
  if (!stream) {
    return {
      contentType: 'application/json',
      body: JSON.stringify(response('completed', [item])),
    };
  }
  let seq = 0;
  const ev = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`;
  const part = (t: string) => ({ type: 'output_text', text: t, annotations: [] });
  return {
    contentType: 'text/event-stream',
    body:
      ev('response.created', { response: response('in_progress', []) })
      + ev('response.in_progress', { response: response('in_progress', []) })
      + ev('response.output_item.added', {
        output_index: 0,
        item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      })
      + ev('response.content_part.added', {
        item_id: itemId, output_index: 0, content_index: 0, part: part(''),
      })
      + ev('response.output_text.delta', {
        item_id: itemId, output_index: 0, content_index: 0, delta: text,
      })
      + ev('response.output_text.done', {
        item_id: itemId, output_index: 0, content_index: 0, text,
      })
      + ev('response.content_part.done', {
        item_id: itemId, output_index: 0, content_index: 0, part: part(text),
      })
      + ev('response.output_item.done', { output_index: 0, item })
      + ev('response.completed', { response: response('completed', [item]) }),
  };
}
