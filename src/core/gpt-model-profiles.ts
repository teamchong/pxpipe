/**
 * Per-model GPT rendering + vision-cost profiles.
 *
 * One place to retune when a new model ships with different image tokenization,
 * a different downscale threshold (max safe portrait-strip width), or a different
 * max image height. Unknown models preserve the conservative legacy fallback;
 * named profiles may deliberately select different fonts and geometry.
 *
 * Retune without a code change via the PXPIPE_GPT_PROFILES env var (JSON map of
 * model-id PREFIX -> partial profile; longest matching prefix wins, checked
 * BEFORE the built-in table). Partial fields fall back to the built-in match, so
 * you can override just one knob:
 *
 *   PXPIPE_GPT_PROFILES='{"gpt-5.6-sol":{"vision":{"regime":"patch","multiplier":1,"patchCap":12000},"stripCols":120,"maxHeightPx":1900}}'
 *   PXPIPE_GPT_PROFILES='{"gpt-5.6-sol":{"style":{"grid":true,"gridCols":4}}}'
 */

/**
 * GPT strip height, DECOUPLED from render.ts's MAX_HEIGHT_PX (which is Anthropic's
 * 1568-edge / ~1.15 MP clamp). OpenAI's pre-tokenize resize is different: fit within
 * 2048×2048, then shortest side → 768. A 768-px-wide portrait strip up to 2048 px tall
 * survives un-resampled, so GPT keeps the taller page. Every built-in cost number below
 * (1190 / 1445 / 2372 / 1464 / 630 …) was calibrated at this height — do not re-link to
 * the Anthropic constant.
 */
import {
  MAX_HEIGHT_PX as ANTHROPIC_MAX_HEIGHT_PX,
  ANTHROPIC_SLAB_COLS as ANTHROPIC_STRIP_COLS,
  DEFAULT_RENDER_FONT,
  type RenderFont,
} from './render.js';

export const GPT_MAX_HEIGHT_PX = 1932;

/** Image-token cost model (mirrors OpenAI's mandatory pre-tokenize resize). */
export type GptVisionCost =
  | { regime: 'tile'; base: number; perTile: number }
  | { regime: 'patch'; multiplier: number; patchCap: number };

export interface GptRenderStyle {
  /** Rasterized font atlas. */
  font: RenderFont;
  /** Extra px beside the 5px glyph (cell width = 5 + this). */
  cellWBonus: number;
  /** Extra px above the 8px glyph (cell height = 8 + this). */
  cellHBonus: number;
  /** Grayscale AA atlas. Default true for production dense pages. */
  aa: boolean;
  /** Faint cell guides. */
  grid: boolean;
  /** Vertical guide cadence when grid is enabled. */
  gridCols: number;
  /** Per-glyph color cycle. */
  colorCycle: boolean;
  /** Horizontal scale for the hard-newline marker. */
  markerScale: number;
  /** Render hard-newline markers in red. */
  markerRed: boolean;
  /** Pre-invert ink dilate radius (px). 0 = off. Thickens glyphs at fixed cell pitch. */
  inkDilate: number;
}

export interface GptModelProfile {
  /** How OpenAI bills the rendered images as input tokens. */
  vision: GptVisionCost;
  /** Max portrait-strip width in columns. Combined with `style`, this must stay
   *  at or below the provider's no-resize pixel width. */
  stripCols: number;
  /** Max rendered image height in px. Threaded into the renderer so the gate's
   *  cost estimate and the actual page split agree. */
  maxHeightPx: number;
  /** Complete model-specific font, cell spacing, color, and marker style. */
  style: GptRenderStyle;
}

/** Default downscale-safe strip width (768px). Exported as the global cols default. */
export const DEFAULT_GPT_STRIP_COLS = 152;

const C = DEFAULT_GPT_STRIP_COLS;
const H = GPT_MAX_HEIGHT_PX;
const BASE_STYLE: GptRenderStyle = {
  font: DEFAULT_RENDER_FONT,
  cellWBonus: 0,
  cellHBonus: 0,
  aa: true,
  grid: false,
  gridCols: 0,
  colorCycle: false,
  markerScale: 1,
  markerRed: false,
  inkDilate: 0,
};

/**
 * Conservative fallback for unrecognized models: tile 85/170 over-states cost,
 * which biases the gate toward pass-through (safe). Matches gpt-4o/4.1/4.5.
 */
export const DEFAULT_GPT_PROFILE: GptModelProfile = {
  vision: { regime: 'tile', base: 85, perTile: 170 },
  stripCols: C,
  maxHeightPx: H,
  style: BASE_STYLE,
};

const GPT56_SOL_PROFILE: GptModelProfile = {
  vision: { regime: 'patch', multiplier: 1, patchCap: 10000 },
  stripCols: 126,
  maxHeightPx: H,
  // Separate atlas selected by model id. Cell remains within OpenAI's 768px
  // short-side floor (126 cols x 6px + padding = 764px).
  style: { ...BASE_STYLE, font: 'jetbrains-mono-10' },
};

interface ProfileRule {
  test: (m: string) => boolean;
  profile: GptModelProfile;
}

/** True for the patch-billed mini/nano family (incl. o4-mini). */
const isMiniNanoPatch = (m: string): boolean =>
  /^(?:gpt-5(?:\.\d+)?|gpt-4\.1)-(?:mini|nano)/.test(m) || /^o4-mini/.test(m);

/**
 * Built-in profiles, evaluated in order (first match wins). Precedence and
 * numbers reproduce the previous hardcoded `resolveVisionCost` EXACTLY:
 *   mini/nano -> patch (nano 2.46 / mini 1.62, cap 1536), BEFORE 5.x flagship.
 */
const BUILTIN_RULES: ProfileRule[] = [
  // nano patch models: ceil(patches * 2.46), cap 1536
  {
    test: (m) => isMiniNanoPatch(m) && /nano/.test(m),
    profile: { vision: { regime: 'patch', multiplier: 2.46, patchCap: 1536 }, stripCols: C, maxHeightPx: H, style: BASE_STYLE },
  },
  // mini / o4-mini patch models: ceil(patches * 1.62), cap 1536
  {
    test: (m) => isMiniNanoPatch(m) && !/nano/.test(m),
    profile: { vision: { regime: 'patch', multiplier: 1.62, patchCap: 1536 }, stripCols: C, maxHeightPx: H, style: BASE_STYLE },
  },
  // Exact Sol variant observed on production traffic. Do not match bare 5.6 or
  // sibling variants (for example gpt-5.6-terra): model-specific visual tuning
  // must not leak across variants merely because they share a version number.
  {
    test: (m) => m === 'gpt-5.6-sol' || m.startsWith('gpt-5.6-sol-'),
    profile: GPT56_SOL_PROFILE,
  },
  // 5.x flagship (gpt-5.4/5.5/…, no -mini/-nano): patch, multiplier 1, detail:original cap
  {
    test: (m) => /^gpt-5\.\d/.test(m),
    profile: { vision: { regime: 'patch', multiplier: 1, patchCap: 10000 }, stripCols: C, maxHeightPx: H, style: BASE_STYLE },
  },
  // gpt-5 / gpt-5-chat-latest: tile 70/140
  {
    test: (m) => /^gpt-5/.test(m),
    profile: { vision: { regime: 'tile', base: 70, perTile: 140 }, stripCols: C, maxHeightPx: H, style: BASE_STYLE },
  },
  // o1 / o3 reasoning: tile 75/150
  {
    test: (m) => /^o[13]/.test(m),
    profile: { vision: { regime: 'tile', base: 75, perTile: 150 }, stripCols: C, maxHeightPx: H, style: BASE_STYLE },
  },

  // Claude on the Responses path (Codex-style clients). Selection is by model
  // id, not endpoint: several families share /v1/responses. Anthropic geometry
  // (dense 312-col strips, 728 px height) and pixel billing differ from GPT's
  // 152-col / 1932 px profile. Using the GPT defaults overstates image cost and
  // flips the slab gate to not_profitable, so an enabled Claude model stays
  // text-only and the dashboard leaves As text / Saved blank.
  {
    test: (m) => m.startsWith('claude') || m.includes('anthropic'),
    profile: {
      // Vision struct unused: visionTokensForModel prices Claude by pixels.
      vision: { regime: 'tile', base: 85, perTile: 170 },
      stripCols: ANTHROPIC_STRIP_COLS,
      maxHeightPx: ANTHROPIC_MAX_HEIGHT_PX,
      style: { ...BASE_STYLE },
    },
  },

  // Grok (Responses path). Opt-in only (not Fable-level pure-image). Profile:
  // Best stable pure-image recipe from brute force: stock Spleen 5×8, white AA,
  // no grid, maxHeight 512, width 152 (768 short-side floor), plus an in-image
  // IDS block is applied on every model path (appendIdsBlock); Grok still
  // needs white AA + short pages. White+ids_block: 7/7 full 4/4 on grok-4.5
  // pure-image (no factsheet).
  // paperGray 240 without grid confabulates ports; grid alone does not fix hex.
  // Fact-sheet remains optional defense in depth.
  {
    test: (m) => /^grok-/.test(m),
    profile: {
      // Vision struct unused: visionTokensForModel prices Grok by pixels.
      vision: { regime: 'tile', base: 85, perTile: 170 },
      // 152 cols × 5px + pad = 768px short-side floor.
      stripCols: C,
      maxHeightPx: 512,
      style: {
        ...BASE_STYLE,
        aa: true,
        grid: false,
        gridCols: 0,
      },
    },
  },
];

function resolveBuiltin(m: string): GptModelProfile {
  for (const rule of BUILTIN_RULES) if (rule.test(m)) return rule.profile;
  return DEFAULT_GPT_PROFILE;
}

// --- env override (PXPIPE_GPT_PROFILES) -----------------------------------
// Parsed lazily and memoized on the raw env string so tests can mutate
// process.env and have it re-read, without re-parsing on every hot-path call.

let envRaw: string | null = null;
let envMap: Map<string, GptModelProfile> = new Map();

function isValidVision(v: unknown): v is GptVisionCost {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.regime === 'tile') return Number.isFinite(o.base) && Number.isFinite(o.perTile);
  if (o.regime === 'patch') return Number.isFinite(o.multiplier) && Number.isFinite(o.patchCap);
  return false;
}

function posInt(v: unknown, fallback: number): number {
  return Number.isFinite(v) && (v as number) > 0 ? Math.floor(v as number) : fallback;
}

function nonNegativeInt(v: unknown, fallback: number): number {
  return Number.isFinite(v) && (v as number) >= 0 ? Math.floor(v as number) : fallback;
}

function renderFont(v: unknown, fallback: RenderFont): RenderFont {
  return v === 'spleen-5x8' || v === 'jetbrains-mono-10' ? v : fallback;
}

function parseEnvProfiles(raw: string): Map<string, GptModelProfile> {
  const out = new Map<string, GptModelProfile>();
  if (!raw) return out;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return out; // malformed env never throws — fall back to built-ins
  }
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const key = k.toLowerCase();
    // An exact override key may be a prefix of the real model id. Resolve the
    // known family explicitly so `{"gpt-5.6-sol":{...}}` inherits Sol's font
    // and geometry even when a suffixed runtime id is expected.
    const base = key === 'gpt-5.6-sol' ? GPT56_SOL_PROFILE : resolveBuiltin(key);
    const p = v as Partial<GptModelProfile>;
    const styleIn = (p as { style?: GptRenderStyle }).style;
    const baseStyle = base.style;
    const style: GptRenderStyle = {
      font: renderFont(styleIn?.font, baseStyle.font),
      cellWBonus: nonNegativeInt(styleIn?.cellWBonus, baseStyle.cellWBonus),
      cellHBonus: nonNegativeInt(styleIn?.cellHBonus, baseStyle.cellHBonus),
      aa: styleIn && typeof styleIn.aa === 'boolean' ? styleIn.aa : baseStyle.aa,
      grid: styleIn && typeof styleIn.grid === 'boolean' ? styleIn.grid : baseStyle.grid,
      gridCols: nonNegativeInt(styleIn?.gridCols, baseStyle.gridCols),
      colorCycle: styleIn && typeof styleIn.colorCycle === 'boolean'
        ? styleIn.colorCycle
        : baseStyle.colorCycle,
      markerScale: posInt(styleIn?.markerScale, baseStyle.markerScale),
      markerRed: styleIn && typeof styleIn.markerRed === 'boolean'
        ? styleIn.markerRed
        : baseStyle.markerRed,
      inkDilate: nonNegativeInt(styleIn?.inkDilate, baseStyle.inkDilate),
    };
    out.set(key, {
      vision: isValidVision(p.vision) ? p.vision : base.vision,
      stripCols: posInt(p.stripCols, base.stripCols),
      maxHeightPx: posInt(p.maxHeightPx, base.maxHeightPx),
      style,
    });
  }
  return out;
}

function envProfiles(): Map<string, GptModelProfile> {
  const raw = (typeof process !== 'undefined' && process.env && process.env.PXPIPE_GPT_PROFILES) || '';
  if (raw !== envRaw) {
    envRaw = raw;
    envMap = parseEnvProfiles(raw);
  }
  return envMap;
}

export function resolveGptProfile(model: string | null | undefined): GptModelProfile {
  // Match applicability.ts: bracketed transport variants (for example [1m])
  // do not define a different visual reader profile.
  const m = (model ?? '').toLowerCase().replace(/\[[^\]]*\]/g, '');
  const env = envProfiles();
  if (env.size > 0) {
    let best: GptModelProfile | undefined;
    let bestLen = -1;
    for (const [k, p] of env) {
      if (m.startsWith(k) && k.length > bestLen) {
        best = p;
        bestLen = k.length;
      }
    }
    if (best) return best;
  }
  return resolveBuiltin(m);
}
