/**
 * Tests for per-model Claude render-density profiles (issue #6).
 *
 * Coverage:
 *   - `profileFromCell`: geometry derivation — the production 5×8 numbers
 *     (312/90/28080/313) fall out of the formula and stay pinned to the
 *     legacy DENSE_CONTENT_* constants; the Opus 9×12 numbers; clamping.
 *   - `resolveClaudeProfile`: built-in table (Opus prefix), default identity
 *     for unknown/absent models, prefix anchoring.
 *   - PXPIPE_CLAUDE_PROFILES env override: partial merge with the built-in
 *     match, longest-prefix-wins, malformed JSON never throws, non-numeric
 *     fields ignored, memoization re-reads on env change, aa plumbing,
 *     zero-bonus override collapses to the DEFAULT identity.
 *   - Regression: `textToImageBlocks` single-col dense path renders at the
 *     PROFILE's geometry (canvas width, row pitch, page count) — not the
 *     hardcoded 5×8 constants it used before this branch.
 *   - Dormancy: profiles must not enable Opus for compression —
 *     DEFAULT_MODEL_BASES stays Opus-free.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CLAUDE_PROFILE,
  profileFromCell,
  resolveClaudeProfile,
} from '../src/core/claude-model-profiles.js';
import {
  DENSE_CONTENT_CHARS_PER_IMAGE,
  DENSE_CONTENT_COLS,
  PAD_X,
  PAD_Y,
} from '../src/core/render.js';
import { LINES_PER_IMAGE, textToImageBlocks, truncateForBudget } from '../src/core/transform.js';
import { getAllowedModelBases } from '../src/core/applicability.js';

const OPUS_MODEL = 'claude-opus-4-8-20260301';
const FABLE_MODEL = 'claude-fable-5-20260101';

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv['PXPIPE_CLAUDE_PROFILES'] = process.env['PXPIPE_CLAUDE_PROFILES'];
  savedEnv['PXPIPE_MODELS'] = process.env['PXPIPE_MODELS'];
  delete process.env['PXPIPE_CLAUDE_PROFILES'];
  delete process.env['PXPIPE_MODELS'];
});
afterEach(() => {
  for (const k of ['PXPIPE_CLAUDE_PROFILES', 'PXPIPE_MODELS']) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('profileFromCell', () => {
  it('default 5×8 cell derives exactly the legacy DENSE_CONTENT_* constants', () => {
    const p = profileFromCell({ cellWBonus: 0, cellHBonus: 0, aa: true });
    expect(p.cellW).toBe(5);
    expect(p.cellH).toBe(8);
    expect(p.denseCols).toBe(DENSE_CONTENT_COLS); // 312
    expect(p.linesPerImage).toBe(LINES_PER_IMAGE); // 90
    expect(p.denseCharsPerImage).toBe(DENSE_CONTENT_CHARS_PER_IMAGE); // 28080
    expect(p.slabCols).toBe(313);
  });

  it('Opus 9×12 cell derives the issue-#6 acceptance geometry', () => {
    const p = profileFromCell({ cellWBonus: 4, cellHBonus: 4, aa: true });
    expect(p.cellW).toBe(9);
    expect(p.cellH).toBe(12);
    expect(p.denseCols).toBe(173); // floor((1568 − 8) / 9)
    expect(p.linesPerImage).toBe(60); // floor((728 − 8) / 12)
    expect(p.denseCharsPerImage).toBe(173 * 60);
    expect(p.slabCols).toBe(173); // floor((1573 − 8) / 9)
  });

  it('clamps degenerate cells to ≥1 col/row and cellW ≥ 1', () => {
    const huge = profileFromCell({ cellWBonus: 100000, cellHBonus: 100000 });
    expect(huge.denseCols).toBe(1);
    expect(huge.linesPerImage).toBe(1);
    expect(huge.slabCols).toBe(1);
    const neg = profileFromCell({ cellWBonus: -100, cellHBonus: -100 });
    expect(neg.cellW).toBeGreaterThanOrEqual(1);
    expect(neg.cellH).toBeGreaterThanOrEqual(1);
  });

  it('carries the cell spec into the render style (bonuses + aa)', () => {
    const p = profileFromCell({ cellWBonus: 4, cellHBonus: 4, aa: false });
    expect(p.style.cellWBonus).toBe(4);
    expect(p.style.cellHBonus).toBe(4);
    expect(p.style.aa).toBe(false);
    // aa defaults to true when unset (matches DENSE_RENDER_STYLE).
    expect(profileFromCell({ cellWBonus: 0, cellHBonus: 0 }).style.aa).toBe(true);
  });
});

describe('resolveClaudeProfile — built-in table', () => {
  it('returns the DEFAULT identity for absent/unknown models', () => {
    expect(resolveClaudeProfile(null)).toBe(DEFAULT_CLAUDE_PROFILE);
    expect(resolveClaudeProfile(undefined)).toBe(DEFAULT_CLAUDE_PROFILE);
    expect(resolveClaudeProfile('')).toBe(DEFAULT_CLAUDE_PROFILE);
    expect(resolveClaudeProfile('   ')).toBe(DEFAULT_CLAUDE_PROFILE);
    expect(resolveClaudeProfile(FABLE_MODEL)).toBe(DEFAULT_CLAUDE_PROFILE);
    expect(resolveClaudeProfile('gpt-5.6')).toBe(DEFAULT_CLAUDE_PROFILE);
  });

  it('claude-opus-* gets the built-in 9×12 profile', () => {
    const p = resolveClaudeProfile(OPUS_MODEL);
    expect(p.cellW).toBe(9);
    expect(p.cellH).toBe(12);
    expect(p.denseCols).toBe(173);
  });

  it('prefix match is anchored at the start of the model id', () => {
    expect(resolveClaudeProfile('my-claude-opus-4-8')).toBe(DEFAULT_CLAUDE_PROFILE);
  });
});

describe('resolveClaudeProfile — PXPIPE_CLAUDE_PROFILES env override', () => {
  it('retunes a model family without a code change', () => {
    process.env['PXPIPE_CLAUDE_PROFILES'] = '{"claude-sonnet-":{"cellHBonus":2}}';
    const p = resolveClaudeProfile('claude-sonnet-5-20260210');
    expect(p.cellW).toBe(5);
    expect(p.cellH).toBe(10);
    expect(p.denseCols).toBe(DENSE_CONTENT_COLS); // width untouched
    expect(p.linesPerImage).toBe(72); // floor(720 / 10)
    // Unrelated families untouched.
    expect(resolveClaudeProfile(FABLE_MODEL)).toBe(DEFAULT_CLAUDE_PROFILE);
    expect(resolveClaudeProfile(OPUS_MODEL).cellW).toBe(9);
  });

  it('partial env fields fall back to the BUILT-IN match, not the default', () => {
    process.env['PXPIPE_CLAUDE_PROFILES'] = '{"claude-opus-":{"cellWBonus":6}}';
    const p = resolveClaudeProfile(OPUS_MODEL);
    expect(p.cellW).toBe(11); // env
    expect(p.cellH).toBe(12); // built-in Opus 8+4, NOT default 8
  });

  it('longest matching prefix wins', () => {
    process.env['PXPIPE_CLAUDE_PROFILES'] =
      '{"claude-":{"cellHBonus":1},"claude-opus-":{"cellHBonus":3}}';
    expect(resolveClaudeProfile(OPUS_MODEL).cellH).toBe(11); // 8+3, longest prefix
    expect(resolveClaudeProfile(FABLE_MODEL).cellH).toBe(9); // 8+1, short prefix
    // Opus width bonus still comes from the built-in match.
    expect(resolveClaudeProfile(OPUS_MODEL).cellW).toBe(9);
  });

  it('malformed JSON is ignored entirely — built-ins still apply', () => {
    process.env['PXPIPE_CLAUDE_PROFILES'] = 'not json{{{';
    expect(resolveClaudeProfile(OPUS_MODEL).cellW).toBe(9);
    expect(resolveClaudeProfile(FABLE_MODEL)).toBe(DEFAULT_CLAUDE_PROFILE);
  });

  it('non-object specs and non-numeric fields are ignored', () => {
    process.env['PXPIPE_CLAUDE_PROFILES'] = '{"claude-opus-":42}';
    expect(resolveClaudeProfile(OPUS_MODEL).cellW).toBe(9); // built-in survives
    // String "9" must NOT be coerced (would give cellW 14).
    process.env['PXPIPE_CLAUDE_PROFILES'] = '{"claude-opus-":{"cellWBonus":"9"}}';
    expect(resolveClaudeProfile(OPUS_MODEL).cellW).toBe(9);
  });

  it('re-reads when the env var changes (memoized on raw string)', () => {
    process.env['PXPIPE_CLAUDE_PROFILES'] = '{"claude-fable-":{"cellHBonus":2}}';
    expect(resolveClaudeProfile(FABLE_MODEL).cellH).toBe(10);
    process.env['PXPIPE_CLAUDE_PROFILES'] = '{"claude-fable-":{"cellHBonus":4}}';
    expect(resolveClaudeProfile(FABLE_MODEL).cellH).toBe(12);
    delete process.env['PXPIPE_CLAUDE_PROFILES'];
    expect(resolveClaudeProfile(FABLE_MODEL)).toBe(DEFAULT_CLAUDE_PROFILE);
  });

  it('aa:false plumbs into the style and blocks the DEFAULT-identity shortcut', () => {
    process.env['PXPIPE_CLAUDE_PROFILES'] = '{"claude-fable-":{"aa":false}}';
    const p = resolveClaudeProfile(FABLE_MODEL);
    expect(p).not.toBe(DEFAULT_CLAUDE_PROFILE);
    expect(p.style.aa).toBe(false);
    expect(p.denseCols).toBe(DENSE_CONTENT_COLS); // geometry unchanged
  });

  it('override that resolves to the stock 5×8 collapses to the DEFAULT identity (cache-key stability)', () => {
    process.env['PXPIPE_CLAUDE_PROFILES'] = '{"claude-opus-":{"cellWBonus":0,"cellHBonus":0}}';
    expect(resolveClaudeProfile(OPUS_MODEL)).toBe(DEFAULT_CLAUDE_PROFILE);
  });
});

describe('regression: dense render path uses PROFILE geometry, not hardcoded 5×8', () => {
  // Lines wider than any profile's denseCols → every page fills full width,
  // so canvas width is a direct readout of cols × cellW + 2·PAD_X.
  const text = Array.from({ length: 130 }, () => 'x'.repeat(400)).join('\n');

  it('default profile renders the legacy canvas (312 cols × 5 px)', async () => {
    const r = await textToImageBlocks(text, 200, 1, true);
    expect(r.dims.length).toBeGreaterThan(0);
    expect(r.dims[0]!.width).toBe(2 * PAD_X + DENSE_CONTENT_COLS * 5); // 1568
    // Row pitch 8 px: every page height is PAD + n×8.
    for (const d of r.dims) expect((d.height - 2 * PAD_Y) % 8).toBe(0);
  });

  it('wide-cell profile renders wider cells → narrower cols, taller rows, more pages', async () => {
    const opus = resolveClaudeProfile(OPUS_MODEL);
    const def = await textToImageBlocks(text, 200, 1, true);
    const wide = await textToImageBlocks(text, 200, 1, true, opus);
    expect(wide.dims[0]!.width).toBe(2 * PAD_X + 173 * 9); // 1565, not 1568
    for (const d of wide.dims) expect((d.height - 2 * PAD_Y) % 12).toBe(0); // 12 px pitch
    // Fewer chars/page ⇒ strictly more pages for the same text.
    expect(wide.blocks.length).toBeGreaterThan(def.blocks.length);
  });

  it('truncateForBudget honors the profile page budget (gate/render agreement)', () => {
    const opus = resolveClaudeProfile(OPUS_MODEL);
    // ~3 default pages of content; cap at 2 images.
    const long = Array.from({ length: 280 }, (_, i) => `line ${i} ` + 'y'.repeat(300)).join('\n');
    const def = truncateForBudget(long, 2, DENSE_CONTENT_COLS, 1, DENSE_CONTENT_CHARS_PER_IMAGE);
    const wide = truncateForBudget(long, 2, opus.denseCols, 1, opus.denseCharsPerImage);
    expect(wide.truncated).toBe(true);
    // Opus pages hold ~2.7× fewer chars — the 2-image budget must cut deeper.
    expect(wide.omittedChars).toBeGreaterThan(def.omittedChars);
    expect(wide.text.length).toBeLessThan(def.text.length);
  });
});

describe('dormancy: profiles do not enable models for compression', () => {
  it('DEFAULT_MODEL_BASES stays Opus-free (opt-in remains explicit)', () => {
    const bases = getAllowedModelBases();
    expect(bases.some((b) => b.startsWith('claude-opus'))).toBe(false);
    // The Opus profile exists anyway — geometry and applicability are independent axes.
    expect(resolveClaudeProfile(OPUS_MODEL).cellW).toBe(9);
  });
});
