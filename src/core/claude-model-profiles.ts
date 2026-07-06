/**
 * Per-model Claude (Anthropic) render-density profiles.
 *
 * Issue #6 (eval/opus-density/RESULTS.md, live run 2026-07-05): Opus 4.8
 * exact-string recall on rendered pages is density-dependent and monotonic —
 * 1/4 exact (3 confabulations) at the production 5×8 cell, 3/4 (1 confab) at
 * 7×10, 4/4 with 0 confabulations at 9×12, still 45% token savings. Fable 5
 * reads 5×8 at 100/100, so density is a per-model property, not a global one.
 *
 * This module gives each Claude model its own render geometry, mirroring
 * gpt-model-profiles.ts: a built-in prefix table, overridable at runtime via
 * the PXPIPE_CLAUDE_PROFILES env var (JSON map of model-id PREFIX -> partial
 * cell spec; longest matching prefix wins, checked BEFORE the built-in table).
 * Partial fields fall back to the built-in match, so one knob can be retuned
 * without a code change:
 *
 *   PXPIPE_CLAUDE_PROFILES='{"claude-opus-":{"cellWBonus":4,"cellHBonus":4}}'
 *   PXPIPE_CLAUDE_PROFILES='{"claude-sonnet-":{"cellHBonus":2}}'   # taller only
 *
 * The DEFAULT profile is BEHAVIOR-IDENTICAL to the previous hardcoded
 * constants (5×8 cell, 312 dense cols, 28080 chars/page, 90 lines/page,
 * 313 slab cols), so existing models' pagination, gate math, and cache keys
 * are unchanged. NOTE: a profile changes RENDER GEOMETRY ONLY — it does not
 * add any model to DEFAULT_MODEL_BASES; enabling a model for compression
 * remains the host's explicit opt-in.
 */

import { ATLAS_CELL_W, ATLAS_CELL_H } from './atlas.js';
import {
  DENSE_RENDER_STYLE,
  MAX_HEIGHT_PX,
  PAD_X,
  PAD_Y,
  type RenderStyle,
} from './render.js';

/** Anthropic long-edge bound: pages wider than this are server-side resampled,
 *  destroying glyphs. Same constant render.ts sizes its canvas against. */
const PAGE_W = 1568;
/** Slab canvas width budget (313 cols × 5 px + 8 px pad = 1573 px today). Kept
 *  as a px budget so wider cells derive fewer slab columns the same way. */
const SLAB_W = 1573;

/** Cell spec — the tunable part of a profile. Bonuses are extra px on the 5×8 atlas glyph. */
export interface ClaudeCellSpec {
  cellWBonus: number;
  cellHBonus: number;
  /** Use the AA grayscale atlas. Default true (matches DENSE_RENDER_STYLE). */
  aa?: boolean;
}

/** Fully derived render geometry for one model. All fields are consistent with
 *  each other by construction — pagination, gate estimates, and the renderer
 *  see the same numbers. */
export interface ClaudeModelProfile {
  /** The cell spec this profile was derived from (kept for env-merge). */
  readonly cell: ClaudeCellSpec;
  /** Style passed to the renderer for dense content (tool_results, history). */
  readonly style: RenderStyle;
  /** Rendered cell width in px (atlas 5 + cellWBonus). The transform gate's
   *  pixel-cost math must use THIS, not the global CELL_W, or wide-cell
   *  profiles get priced at 5×8 and the gate under-predicts ~2-3×. */
  readonly cellW: number;
  /** Rendered cell height in px (atlas 8 + cellHBonus). See cellW. */
  readonly cellH: number;
  /** Full-width dense columns: floor((1568 − 2·PAD_X) / cellW). 312 at 5×8. */
  readonly denseCols: number;
  /** Visual rows per page: floor((MAX_HEIGHT_PX − 2·PAD_Y) / cellH). 90 at 5×8. */
  readonly linesPerImage: number;
  /** Char budget per dense page: denseCols × linesPerImage. 28080 at 5×8. */
  readonly denseCharsPerImage: number;
  /** Static-slab wrap width: floor((1573 − 2·PAD_X) / cellW). 313 at 5×8. */
  readonly slabCols: number;
}

/** Derive a full profile from a cell spec. Single source of truth for the geometry
 *  math — the production 5×8 numbers (312/90/28080/313) fall out of this formula. */
export function profileFromCell(cell: ClaudeCellSpec): ClaudeModelProfile {
  const cellW = Math.max(1, ATLAS_CELL_W + Math.floor(cell.cellWBonus));
  const cellH = Math.max(1, ATLAS_CELL_H + Math.floor(cell.cellHBonus));
  const denseCols = Math.max(1, Math.floor((PAGE_W - 2 * PAD_X) / cellW));
  const linesPerImage = Math.max(1, Math.floor((MAX_HEIGHT_PX - 2 * PAD_Y) / cellH));
  return {
    cell,
    style: { ...DENSE_RENDER_STYLE, cellWBonus: cell.cellWBonus, cellHBonus: cell.cellHBonus, aa: cell.aa ?? true },
    cellW,
    cellH,
    denseCols,
    linesPerImage,
    denseCharsPerImage: denseCols * linesPerImage,
    slabCols: Math.max(1, Math.floor((SLAB_W - 2 * PAD_X) / cellW)),
  };
}

/** Production default — 5×8, identical to the previous hardcoded constants. */
export const DEFAULT_CLAUDE_PROFILE: ClaudeModelProfile = profileFromCell({
  cellWBonus: 0,
  cellHBonus: 0,
  aa: true,
});

interface ProfileRule {
  test: (m: string) => boolean;
  cell: ClaudeCellSpec;
}

/**
 * Built-in rules, evaluated in order (first match wins).
 *
 * Opus → 9×12: the only variant that clears the issue-#6 acceptance bar
 * (4/4 exact, 0 confabulations, gist == text baseline, 45% savings —
 * eval/opus-density/RESULTS.md). DORMANT unless the host explicitly
 * allowlists an Opus model for compression: DEFAULT_MODEL_BASES does not
 * include Opus, and this module does not change that.
 */
const BUILTIN_RULES: ProfileRule[] = [
  { test: (m) => /^claude-opus-/.test(m), cell: { cellWBonus: 4, cellHBonus: 4, aa: true } },
];

// --- env override (PXPIPE_CLAUDE_PROFILES) ---------------------------------
// Parsed lazily and memoized on the raw env string so tests can mutate
// process.env and have it re-read, without re-parsing on every hot-path call.

let envRaw: string | null = null;
let envMap: Map<string, Partial<ClaudeCellSpec>> = new Map();

function intOr(v: unknown, fallback: number): number {
  return Number.isFinite(v) ? Math.floor(v as number) : fallback;
}

function readEnvMap(): Map<string, Partial<ClaudeCellSpec>> {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    'PXPIPE_CLAUDE_PROFILES'
  ];
  const key = raw ?? '';
  if (key === envRaw) return envMap;
  envRaw = key;
  envMap = new Map();
  if (!raw) return envMap;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [prefix, spec] of Object.entries(parsed as Record<string, unknown>)) {
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) continue;
        const s = spec as Record<string, unknown>;
        const partial: Partial<ClaudeCellSpec> = {};
        if (Number.isFinite(s['cellWBonus'])) partial.cellWBonus = Math.floor(s['cellWBonus'] as number);
        if (Number.isFinite(s['cellHBonus'])) partial.cellHBonus = Math.floor(s['cellHBonus'] as number);
        if (typeof s['aa'] === 'boolean') partial.aa = s['aa'];
        envMap.set(prefix, partial);
      }
    }
  } catch {
    // Malformed JSON -> ignore entirely (never let a bad env var break the proxy).
  }
  return envMap;
}

function builtinCell(m: string): ClaudeCellSpec {
  for (const rule of BUILTIN_RULES) if (rule.test(m)) return rule.cell;
  return DEFAULT_CLAUDE_PROFILE.cell;
}

/**
 * Resolve the render-density profile for a Claude model id. Env overrides
 * (longest matching prefix) win over the built-in table; partial env fields
 * fall back to the built-in match. Unknown/absent models get the production
 * 5×8 default.
 */
export function resolveClaudeProfile(model: string | null | undefined): ClaudeModelProfile {
  const m = (model ?? '').trim();
  if (!m) return DEFAULT_CLAUDE_PROFILE;
  const base = builtinCell(m);
  let bestPrefix = '';
  let bestSpec: Partial<ClaudeCellSpec> | undefined;
  for (const [prefix, spec] of readEnvMap()) {
    if (prefix && m.startsWith(prefix) && prefix.length > bestPrefix.length) {
      bestPrefix = prefix;
      bestSpec = spec;
    }
  }
  const cell: ClaudeCellSpec = {
    cellWBonus: intOr(bestSpec?.cellWBonus, base.cellWBonus),
    cellHBonus: intOr(bestSpec?.cellHBonus, base.cellHBonus),
    aa: bestSpec?.aa ?? base.aa ?? true,
  };
  if (cell.cellWBonus === 0 && cell.cellHBonus === 0 && (cell.aa ?? true) === true) return DEFAULT_CLAUDE_PROFILE;
  return profileFromCell(cell);
}
