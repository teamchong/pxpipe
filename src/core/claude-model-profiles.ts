import {
  MAX_HEIGHT_PX as ANTHROPIC_MAX_HEIGHT_PX,
  ANTHROPIC_SLAB_COLS as ANTHROPIC_STRIP_COLS,
} from './render.js';
import { BASE_HISTORY, BASE_STYLE } from './profile-base.js';
import type { GptModelProfile, GptRenderStyle } from './gpt-model-profiles.js';

/**
 * Claude rendering + vision-cost profiles.
 *
 * Anthropic geometry (dense 312-col strips, 728 px height) and pixel billing
 * differ from GPT's 152-col / 1932 px profile: using the GPT defaults overstates
 * image cost and flips the slab gate to not_profitable, so an enabled Claude
 * model would stay text-only and the dashboard would leave As text / Saved
 * blank. resolveGptProfile therefore routes every Claude id here BEFORE the GPT
 * rule table, so no Claude model can land on a GPT or Gemini profile.
 */

/** Claude 4.7+. Billed by Anthropic's 28-px patch grid after the high-res
 *  tier downscale; `visionTier` below is the only knob that varies by release. */
export const CLAUDE_PROFILE: GptModelProfile = {
  vision: { regime: 'patch28' },
  // Anthropic list prices: cache read $0.10 / input $1.00; output $5.00 / input.
  cacheReadRate: 0.1,
  outputRate: 5,
  stripCols: ANTHROPIC_STRIP_COLS,
  maxHeightPx: ANTHROPIC_MAX_HEIGHT_PX,
  visionTier: 'high-res',
  factSheetFormat: 'full',
  // BASE_HISTORY.maxImages is a page count, and a page is not a fixed amount of
  // text: at GPT geometry (84 cols x 1954 px) a page holds ~660 chars, at
  // Anthropic geometry (312 cols x 728 px) it holds ~2750. The shared 32 was
  // tuned as a latency budget against the former, so on Claude it stopped being
  // a latency budget and became a coverage limit: live Opus traffic pinned at
  // 32 images on 70% of requests with collapsed text flatlined at ~97k chars
  // while untouched history kept growing past 250k.
  //
  // Re-derived against the same latency signal on Claude pages (first-byte p50
  // / p95, n=11k): 32 -> 5.2s/10.9s, 64 -> 8.3s/15.3s, 96 -> 11.4s/18.5s,
  // 128 -> 12.5s/27.0s. Upstream 502s stay ~0.2% through 96 images and jump to
  // 2.2-3.9% at 112+. 96 is the last point that is both cheap and clean.
  //
  // The same page-count-vs-geometry mismatch applies to the per-image framing.
  // BASE_HISTORY pairs `framing: 'full'` with `factSheetScope: 'per-segment'`,
  // which costs a 221-token intro + 25-token outro + a ~158-token fact sheet on
  // EVERY segment. At GPT's 32-page ceiling that is a rounding error; at 96
  // Claude pages it measured 425 tokens/image, 25.2k tokens/request, eating 57%
  // of the gross saving the higher cap unlocked. Compact framing (36 + 8) with a
  // single combined sheet carries the same attribution wording the transcript
  // needs and projects 2.8k tokens/request on the same traffic.
  //
  // responsesMode: BASE_HISTORY's 'pairs' planner only groups tool rounds that
  // are INDEX-CONTIGUOUS. Codex emits an assistant message between rounds, so
  // every round lands in its own run and every run renders its own image. Live
  // Claude-on-Responses traffic averaged 2,921 chars/image (10% of the 28,080
  // a page holds) at 2.4 turns/image, against 10,456 (37%) for gpt-5.6-sol on
  // the same endpoint — the only difference being that GPT already runs
  // 'mixed'. Replaying a 60-round transcript through both planners isolates it
  // to the interleaving, not the volume:
  //   pairs, no interleave  ->  1 segment,   6 images, 27,653 chars/image
  //   pairs, interleaved    -> 54 segments, 54 images,  3,073 chars/image
  //   mixed, interleaved    ->  2 segments,  8 images, 21,109 chars/image
  // 'mixed' treats safe textual messages as groupable instead of as barriers;
  // every non-message item stays a hard barrier, so protocol order and open
  // call/output state are preserved exactly as in 'pairs'.
  history: {
    ...BASE_HISTORY,
    maxImages: 96,
    framing: 'compact',
    factSheetScope: 'combined',
    responsesMode: 'mixed',
  },
  style: { ...BASE_STYLE },
  // No maxSerializedRequestBytes: no Anthropic request-size limit has ever been
  // sourced. The 768 KiB entry that used to sit here was a guess, and live
  // traffic contradicted it outright (thousands of clean 200s well above it).
};

/** Pre-4.7 Claude: same render geometry, standard image-resolution tier. */
export const CLAUDE_LEGACY_PROFILE: GptModelProfile = {
  ...CLAUDE_PROFILE,
  visionTier: 'standard',
  style: { ...BASE_STYLE },
};

/**
 * Legible collapsed-history geometry, DEFAULT for every Claude model except
 * Fable. Measured (PR #170, 26-value exact-recall battery, ground truth
 * withheld): at the dense 312-col spleen-5x8 geometry Fable 5 read 25/26
 * exactly while Opus 5 read 3/26 with 10 SILENTLY wrong; at 172 cols
 * jetbrains-mono-14 Opus read 100/100. 172 cols at this font still fits
 * 1568x728, so nothing is downscaled. Cost on live transcript: dense is 5.28x
 * cheaper than text, legible 1.47x — still a saving, so misread-prone models
 * get legibility by default rather than behind a flag. Uses unified 14px
 * JetBrains Mono @ 172 cols across all page types (slabs, tools, and history).
 */
export const CLAUDE_HISTORY_STRIP_COLS = 172;
const CLAUDE_HISTORY_STYLE: GptRenderStyle = {
  ...BASE_STYLE,
  font: 'jetbrains-mono-14',
};

export const CLAUDE_LEGIBLE_PROFILE: GptModelProfile = {
  ...CLAUDE_PROFILE,
  stripCols: CLAUDE_HISTORY_STRIP_COLS,
  style: { ...CLAUDE_HISTORY_STYLE },
  historyStripCols: CLAUDE_HISTORY_STRIP_COLS,
  historyStyle: { ...CLAUDE_HISTORY_STYLE },
};

export const CLAUDE_LEGACY_LEGIBLE_PROFILE: GptModelProfile = {
  ...CLAUDE_LEGACY_PROFILE,
  stripCols: CLAUDE_HISTORY_STRIP_COLS,
  style: { ...CLAUDE_HISTORY_STYLE },
  historyStripCols: CLAUDE_HISTORY_STRIP_COLS,
  historyStyle: { ...CLAUDE_HISTORY_STYLE },
};

/** Fable is the only Claude family measured accurate at dense geometry, so it
 *  alone keeps the 5.28x dense rendering for history. */
export function isFableClaude(model: string): boolean {
  return model.toLowerCase().includes('fable');
}

/** Every id that must be priced and rendered as Claude. */
export function isClaudeModel(model: string | null | undefined): boolean {
  const m = (model ?? '').toLowerCase();
  // `includes`, not `startsWith`: gateway ids carry a vendor prefix
  // (`anthropic/claude-opus-5`, `us.anthropic.claude-3-5-sonnet-v1:0`).
  return m.includes('claude') || m.includes('anthropic');
}

/**
 * True for Claude releases older than 4.7. Anthropic's vision docs tier the
 * pre-billing downscale by VERSION, not by model family or an enumerated list:
 *
 *   | High-resolution | Claude 4.7 and later models | 2576 px | 4784 |
 *   | Standard        | All other models            | 1568 px | 1568 |
 *
 * Reads the first version number in the id, tolerating both id orderings
 * (`claude-opus-4-8` -> 4.8, `claude-3-5-sonnet` -> 3.5) and trailing date
 * stamps. An unrecognised Claude id is treated as new: an unreleased model is
 * far likelier to be 4.7+, and high-res is the safe guess for the gate because
 * it over-estimates cost, whereas standard under-estimates it by assuming a
 * downscale the server will not perform.
 */
export function isPre47Claude(m: string): boolean {
  const v = /claude-(?:[a-z]+-)?(\d+)(?:-(\d+))?/.exec(m);
  if (!v) return false;
  const [major, minor] = [Number(v[1]), Number(v[2] ?? '0')];
  return major < 4 || (major === 4 && minor < 7);
}

/** Pick the Claude profile for an id. Billing geometry is identical across
 *  opus/sonnet/haiku/fable; HISTORY geometry is not, because verbatim recall
 *  at dense geometry is a per-model property (see CLAUDE_LEGIBLE_PROFILE).
 *  Fable keeps dense history; every other Claude id gets legible history by
 *  default. Unmeasured families (sonnet/haiku) get legible too: a misread is
 *  silent, an extra 0.68x-of-text render cost is not. */
export function resolveClaudeProfile(m: string): GptModelProfile {
  if (isFableClaude(m)) {
    return isPre47Claude(m) ? CLAUDE_LEGACY_PROFILE : CLAUDE_PROFILE;
  }
  return isPre47Claude(m) ? CLAUDE_LEGACY_LEGIBLE_PROFILE : CLAUDE_LEGIBLE_PROFILE;
}
