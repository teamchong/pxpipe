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
 * 1568-edge / ~1.15 MP clamp). Named profiles may override this where their image
 * sizing and font geometry differ.
 */
import { type RenderFont } from './render.js';
import { hasGeminiMeasuredProfile, resolveGeminiProfile } from './gemini-model-profiles.js';
import { isClaudeModel, resolveClaudeProfile } from './claude-model-profiles.js';
import { BASE_HISTORY, BASE_PRICING, BASE_STYLE } from './profile-base.js';

export const GPT_MAX_HEIGHT_PX = 1932;

/**
 * Image-token cost model. Every provider family is DATA here — there is no
 * `if (isClaude)` branch anywhere in the pricing path; `visionTokens()`
 * (vision-cost.ts) is the single interpreter of these regimes.
 *
 *  - `tile`    OpenAI legacy: 2048/768 downscale, then base + perTile per 512-px tile.
 *  - `patch`   OpenAI 32-px patches × multiplier. An omitted patchCap bills original dims.
 *  - `patch28` Anthropic 28-px patches after the tier downscale (see `visionTier`).
 *  - `mpix`    Pixel-priced families (Grok): megapixels × tokensPerMegapixel, min 1.
 *  - `flat`    One fixed charge per image (Gemini), with an optional measured
 *              exact-canvas override for the production page size.
 */
export type GptVisionCost =
  | { regime: 'tile'; base: number; perTile: number }
  | { regime: 'patch'; multiplier: number; patchCap?: number }
  | { regime: 'patch28' }
  | { regime: 'mpix'; tokensPerMegapixel: number }
  | { regime: 'flat'; tokens: number; exact?: { widthPx: number; heightPx: number; tokens: number } };

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

export interface GptHistoryProfile {
  /** Total history-image budget after the static slab. */
  maxImages: number;
  /** Recent ordinary conversation messages retained as native text. */
  keepTail: number;
  /** Recent completed call/output pairs retained as native protocol state. */
  keepRecentPairs: number;
  /** Local o200k floor before history profitability is evaluated. */
  minCollapseTokens: number;
  /** Responses items eligible for history images. */
  responsesMode: 'pairs' | 'mixed';
  /** Native text bracketing each history image group. */
  framing: 'full' | 'compact';
  /** Fact-sheet placement for discontiguous Responses history groups. */
  factSheetScope: 'per-segment' | 'combined';
}

export interface GptModelProfile {
  /** How this model's provider bills the rendered images as input tokens. */
  vision: GptVisionCost;
  /** Cached-input list price ÷ uncached-input list price for this family.
   *  Savings reporting reads this instead of re-classifying the model id. */
  cacheReadRate: number;
  /** Output list price ÷ uncached-input list price for this family. */
  outputRate: number;
  /** Max portrait-strip width in columns. Combined with `style`, this must stay
   *  at or below the provider's no-resize pixel width. */
  stripCols: number;
  /** Max rendered image height in px. Threaded into the renderer so the gate's
   *  cost estimate and the actual page split agree. */
  maxHeightPx: number;
  /** Local o200k token floor before image profitability is evaluated.
   *  Undefined preserves the legacy character floor for non-o200k models. */
  minCompressTokens?: number;
  /** Anthropic image-resolution tier, consumed by `anthropicVisionProfile`.
   *  Undefined = standard; only Claude profiles set it (Anthropic is the only
   *  provider that tiers the pre-billing downscale by model). */
  visionTier?: 'high-res' | 'standard';
  /** Exact-token sheet wording beside rendered content. */
  factSheetFormat: 'full' | 'compact';
  /** Model-specific history coverage and native-text overhead. */
  history: GptHistoryProfile;
  /** Complete model-specific font, cell spacing, color, and marker style. */
  style: GptRenderStyle;
  /** Optional override of `stripCols` for COLLAPSED HISTORY only, leaving the
   *  slab and tool-result pages on `stripCols`. Undefined = use `stripCols`,
   *  i.e. behaviour is unchanged unless a profile opts in.
   *
   *  Exists because reading accuracy and rendering cost are not the same axis.
   *  Geometry is identical across a provider's models because the *billing* is,
   *  but verbatim recall is not: on one 26-value battery at this profile's
   *  312-col dense geometry, Fable 5 read 25/26 exactly while Opus 5 read 3/26
   *  with 10 silent substitutions. A deployment that must re-read exact values
   *  out of imaged history needs a lower density there — and only there, since
   *  the static slab holds no such values. */
  historyStripCols?: number;
  /** Optional override of `style` for collapsed history only. Same rationale as
   *  `historyStripCols`; set both together, since a larger font at unchanged
   *  columns overshoots the provider's no-resize width and is silently
   *  downscaled, which removes the legibility it was meant to buy. */
  historyStyle?: GptRenderStyle;
  /** Maximum serialized provider request produced by pxpipe. Undefined leaves
   *  legacy behavior unchanged. Checked in the transform (which falls back to
   *  the original body when imaging would overshoot) and enforced again on the
   *  final wire body by the proxy, which answers 413.
   *
   *  Set this ONLY for a limit the provider itself has shown us: published docs,
   *  or a 413 that demonstrably came from the provider. A 413 is NOT evidence on
   *  its own — an intermediate hop (local gateway daemon, corporate proxy, CDN)
   *  can impose its own body cap and answer with a provider-shaped
   *  `payload_too_large` naming ITS limit, for a request the provider never saw.
   *  Such a cap is also usually deployment config, not a model property, so it
   *  belongs in `PXPIPE_GPT_PROFILES`, not here.
   *
   *  A guessed cap makes pxpipe refuse to compress requests the provider would
   *  have accepted, which is the opposite of the point. No family currently
   *  carries one. Largest body each provider has answered 200 for in local
   *  telemetry, as a lower bound (cacheable prefix already on the wire, so the
   *  real body was bigger): Claude 11.2 MB, GPT 10.1 MB, Gemini 6.2 MB, Grok
   *  2.7 MB. No provider-originated size rejection has been observed for any. */
  maxSerializedRequestBytes?: number;
  /** Gate the static slab against the exact measured baseline (system text plus
   *  the tool-description tokens actually stripped) instead of the rendered
   *  text's own token count. Profiles that pin an exact static slab set this;
   *  it is a property of the profile, not of one model id. */
  exactStaticBaseline?: boolean;
}

/** Default downscale-safe strip width (768px). Exported as the global cols default. */
export const DEFAULT_GPT_STRIP_COLS = 152;

const C = DEFAULT_GPT_STRIP_COLS;
const H = GPT_MAX_HEIGHT_PX;

/** gpt-5 family list prices: cached input $0.125 / input $1.25 / output $10 per 1M. */
const GPT5_PRICING = { cacheReadRate: 0.1, outputRate: 8 };

/**
 * Conservative fallback for unrecognized models: tile 85/170 over-states cost,
 * which biases the gate toward pass-through (safe). Matches gpt-4o/4.1/4.5.
 */
export const DEFAULT_GPT_PROFILE: GptModelProfile = {
  vision: { regime: 'tile', base: 85, perTile: 170 },
  ...BASE_PRICING,
  stripCols: C,
  maxHeightPx: H,
  minCompressTokens: 500,
  factSheetFormat: 'full',
  history: BASE_HISTORY,
  style: BASE_STYLE,
};

const GPT56_SOL_PROFILE: GptModelProfile = {
  // GPT-5.6 original detail bills the submitted 32px patches without a patch cap.
  vision: { regime: 'patch', multiplier: 1 },
  ...GPT5_PRICING,
  // Sol pins an exact static slab, so the gate compares against the measured
  // baseline rather than re-tokenizing the rendered text.
  exactStaticBaseline: true,
  // Match the native 14px reader profile. Sol remains opt-in: its two-fixture
  // pilot retained gist/guard and had no unsupported inventions, but one exact
  // identifier was truncated.
  stripCols: 84,
  // 1954px permits 149 rows at an actual 1945px, filling 61 patch rows.
  maxHeightPx: 1954,
  minCompressTokens: 500,
  factSheetFormat: 'full',
  history: {
    ...BASE_HISTORY,
    maxImages: 64,
    // The latest user request is protected independently by the Responses
    // planner. Keep only one additional recent message/pair native so closed,
    // unreferenced history does not dominate long stateless requests.
    keepTail: 1,
    keepRecentPairs: 1,
    minCollapseTokens: 1000,
    responsesMode: 'mixed',
    framing: 'compact',
    factSheetScope: 'combined',
  },
  style: {
    ...BASE_STYLE,
    font: 'jetbrains-mono-14',
    cellWBonus: 0,
    cellHBonus: 0,
  },
};

interface ProfileRule {
  test: (m: string) => boolean;
  profile: GptModelProfile;
}

/** True for the patch-billed mini/nano family (incl. o4-mini). */
const isMiniNanoPatch = (m: string): boolean =>
  /^(?:gpt-5(?:\.\d+)?|gpt-4\.1)-(?:mini|nano)/.test(m) || /^o4-mini/.test(m);

/** Grok ids pxpipe has a measured profile for. */
const isGrokModel = (m: string): boolean => /^grok-/.test(m);

/** Shared GPT geometry for the small patch-billed models; only the patch
 *  multiplier and the family list prices differ between the rules below. */
const miniNanoProfile = (
  multiplier: number,
  pricing: { cacheReadRate: number; outputRate: number },
): GptModelProfile => ({
  vision: { regime: 'patch', multiplier, patchCap: 1536 },
  ...pricing,
  stripCols: C,
  maxHeightPx: H,
  minCompressTokens: 500,
  factSheetFormat: 'full',
  history: BASE_HISTORY,
  style: BASE_STYLE,
});

/**
 * Built-in profiles, evaluated in order (first match wins). Precedence and
 * numbers reproduce the previous hardcoded `resolveVisionCost` EXACTLY:
 *   mini/nano -> patch (nano 2.46 / mini 1.62, cap 1536), BEFORE 5.x flagship.
 */
const BUILTIN_RULES: ProfileRule[] = [
  // nano patch models: ceil(patches * 2.46), cap 1536
  {
    test: (m) => isMiniNanoPatch(m) && /nano/.test(m) && /^gpt-5/.test(m),
    profile: miniNanoProfile(2.46, GPT5_PRICING),
  },
  // gpt-4.1-nano: same tokenization, older (less aggressive) cache discount.
  {
    test: (m) => isMiniNanoPatch(m) && /nano/.test(m),
    profile: miniNanoProfile(2.46, BASE_PRICING),
  },
  // mini / o4-mini patch models: ceil(patches * 1.62), cap 1536
  {
    test: (m) => isMiniNanoPatch(m) && /^gpt-5/.test(m),
    profile: miniNanoProfile(1.62, GPT5_PRICING),
  },
  // gpt-4.1-mini / o4-mini: same tokenization, older cache discount.
  {
    test: isMiniNanoPatch,
    profile: miniNanoProfile(1.62, BASE_PRICING),
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
    profile: { vision: { regime: 'patch', multiplier: 1, patchCap: 10000 }, ...GPT5_PRICING, stripCols: C, maxHeightPx: H, minCompressTokens: 500, factSheetFormat: 'full', history: BASE_HISTORY, style: BASE_STYLE },
  },
  // gpt-5 / gpt-5-chat-latest: tile 70/140
  {
    test: (m) => /^gpt-5/.test(m),
    profile: { vision: { regime: 'tile', base: 70, perTile: 140 }, ...GPT5_PRICING, stripCols: C, maxHeightPx: H, minCompressTokens: 500, factSheetFormat: 'full', history: BASE_HISTORY, style: BASE_STYLE },
  },
  // o1 / o3 reasoning: tile 75/150
  {
    test: (m) => /^o[13]/.test(m),
    profile: { vision: { regime: 'tile', base: 75, perTile: 150 }, ...BASE_PRICING, stripCols: C, maxHeightPx: H, minCompressTokens: 500, factSheetFormat: 'full', history: BASE_HISTORY, style: BASE_STYLE },
  },

  // Grok remains opt-in. Native 14px / 84 cols / maxH 512 is the densest best
  // rung from the JB Mono 8–16px blind sweep (eval/grok-density/native-sweep).
  {
    test: isGrokModel,
    profile: {
      // Measured 2026-07-09 on grok-4.5: image-token delta ≈ 1000 per megapixel
      // across several page sizes (768x336 → 268, 764x980 → 748, etc.).
      vision: { regime: 'mpix', tokensPerMegapixel: 1000 },
      // xAI model pricing metadata: cachedPromptTokenPrice/promptTextTokenPrice
      // = 5000/20000; completionTextTokenPrice/promptTextTokenPrice = 60000/20000.
      cacheReadRate: 0.25,
      outputRate: 3,
      // Native 14px was the densest best rung on the Grok JB Mono 8–16px blind
      // sweep (4/8 exact, 4 confab, 48% savings). 84 × 9px + pad = 764px ≤ 768.
      // No rung was fully clean; 14px tied 15/16px on exact and beat smaller cells.
      stripCols: 84,
      maxHeightPx: 512,
      minCompressTokens: 500,
      factSheetFormat: 'full',
      history: { ...BASE_HISTORY, maxImages: 24 },
      style: {
        ...BASE_STYLE,
        font: 'jetbrains-mono-14',
        aa: true,
        grid: false,
        gridCols: 0,
      },
    },
  },
];

/**
 * Families whose profile test is NARROWER than the ids that name them, with the
 * test each one owns. Claude and GPT need no entry: every id that mentions them
 * resolves to one of their profiles.
 */
const FAMILY_ID_GUARDS: ReadonlyArray<{ mentions: RegExp; matches: (m: string) => boolean }> = [
  { mentions: /gemini/, matches: hasGeminiMeasuredProfile },
  { mentions: /grok/, matches: isGrokModel },
];

/** True when the operator declared this id in PXPIPE_GPT_PROFILES. The guards
 *  above catch implicit fallback to another provider's formula; an explicit
 *  declaration supplies geometry and vision cost, so it clears them. */
function hasDeclaredProfile(m: string): boolean {
  const env = envProfiles();
  if (env.size === 0) return false;
  const ids = candidateIds(m);
  for (const k of env.keys()) if (ids.some((id) => id.startsWith(k))) return true;
  return false;
}

/**
 * True when an id NAMES a known provider family but does not match that
 * family's profile test — for example `gemini-3.6-pro`, when 3.6 Flash is the
 * only Gemini geometry pxpipe has measured. Such an id would fall through to
 * DEFAULT_GPT_PROFILE and be gated with OpenAI's tile math, i.e. priced with
 * the wrong provider's formula, so applicability refuses it instead of
 * compressing against numbers that do not apply to it.
 *
 * (DEFAULT_GPT_PROFILE is a legitimate *OpenAI* fallback — gpt-4o and friends
 * are deliberately gated with its conservative tile cost — so resolving to the
 * default is only a problem when the id is not an OpenAI id at all.)
 */
export function isMisresolvedModelId(model: string | null | undefined): boolean {
  const m = (model ?? '').toLowerCase();
  if (hasDeclaredProfile(m)) return false;
  // Must cover every spelling resolveGptProfile() tries, or guard and resolver
  // disagree: `openrouter/gemini-3.6-flash` resolves to the measured Gemini
  // profile via its unqualified id, so it must not be refused here.
  const ids = candidateIds(m);
  return FAMILY_ID_GUARDS.some(
    (g) => ids.some((id) => g.mentions.test(id)) && !ids.some((id) => g.matches(id)),
  );
}

function resolveBuiltin(m: string): GptModelProfile {
  // Claude first, and by whole-id match rather than a rule in the table below:
  // Anthropic geometry and pixel billing differ from GPT's, so a Claude model
  // that fell through to a GPT rule (or to DEFAULT_GPT_PROFILE) would have its
  // image cost overstated, flipping the slab gate to not_profitable and leaving
  // it text-only.
  if (isClaudeModel(m)) return resolveClaudeProfile(m);
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
  if (o.regime === 'patch') {
    return Number.isFinite(o.multiplier) &&
      (o.patchCap === undefined || (Number.isFinite(o.patchCap) && (o.patchCap as number) > 0));
  }
  if (o.regime === 'patch28') return true;
  if (o.regime === 'mpix') {
    return Number.isFinite(o.tokensPerMegapixel) && (o.tokensPerMegapixel as number) > 0;
  }
  if (o.regime === 'flat') {
    if (!Number.isFinite(o.tokens) || (o.tokens as number) <= 0) return false;
    if (o.exact === undefined) return true;
    const e = o.exact as Record<string, unknown>;
    return !!e && typeof e === 'object' &&
      Number.isFinite(e.widthPx) && (e.widthPx as number) > 0 &&
      Number.isFinite(e.heightPx) && (e.heightPx as number) > 0 &&
      Number.isFinite(e.tokens) && (e.tokens as number) > 0;
  }
  return false;
}

/** Price ratios must be positive and finite; anything else keeps the built-in. */
function rate(v: unknown, fallback: number): number {
  return Number.isFinite(v) && (v as number) > 0 ? (v as number) : fallback;
}

function posInt(v: unknown, fallback: number): number {
  return Number.isFinite(v) && (v as number) > 0 ? Math.floor(v as number) : fallback;
}

function nonNegativeInt(v: unknown, fallback: number): number {
  return Number.isFinite(v) && (v as number) >= 0 ? Math.floor(v as number) : fallback;
}

function renderFont(v: unknown, fallback: RenderFont): RenderFont {
  return v === 'spleen-5x8' || v === 'jetbrains-mono-10' || v === 'jetbrains-mono-12' || v === 'jetbrains-mono-14'
    ? v
    : fallback;
}

function factSheetFormat(v: unknown, fallback: GptModelProfile['factSheetFormat']): GptModelProfile['factSheetFormat'] {
  return v === 'full' || v === 'compact' ? v : fallback;
}

function responsesMode(v: unknown, fallback: GptHistoryProfile['responsesMode']): GptHistoryProfile['responsesMode'] {
  return v === 'pairs' || v === 'mixed' ? v : fallback;
}

function historyFraming(v: unknown, fallback: GptHistoryProfile['framing']): GptHistoryProfile['framing'] {
  return v === 'full' || v === 'compact' ? v : fallback;
}

function factSheetScope(v: unknown, fallback: GptHistoryProfile['factSheetScope']): GptHistoryProfile['factSheetScope'] {
  return v === 'per-segment' || v === 'combined' ? v : fallback;
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
    const historyIn = (p as { history?: Partial<GptHistoryProfile> }).history;
    const baseStyle = base.style;
    const baseHistory = base.history;
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
    const history: GptHistoryProfile = {
      maxImages: posInt(historyIn?.maxImages, baseHistory.maxImages),
      keepTail: nonNegativeInt(historyIn?.keepTail, baseHistory.keepTail),
      keepRecentPairs: nonNegativeInt(historyIn?.keepRecentPairs, baseHistory.keepRecentPairs),
      minCollapseTokens: nonNegativeInt(historyIn?.minCollapseTokens, baseHistory.minCollapseTokens),
      responsesMode: responsesMode(historyIn?.responsesMode, baseHistory.responsesMode),
      framing: historyFraming(historyIn?.framing, baseHistory.framing),
      factSheetScope: factSheetScope(historyIn?.factSheetScope, baseHistory.factSheetScope),
    };
    // History geometry: only materialised when the override actually asks for
    // it, so a profile that says nothing about history keeps `undefined` and
    // transform.ts falls through to the dense geometry unchanged.
    const historyStyleIn = (p as { historyStyle?: GptRenderStyle }).historyStyle;
    const historyStyle: GptRenderStyle | undefined = historyStyleIn === undefined
      ? base.historyStyle
      : { ...style, font: renderFont(historyStyleIn.font, style.font) };
    const historyStripCols = p.historyStripCols === undefined
      ? base.historyStripCols
      : posInt(p.historyStripCols, base.historyStripCols ?? base.stripCols);

    out.set(key, {
      vision: isValidVision(p.vision) ? p.vision : base.vision,
      cacheReadRate: rate(p.cacheReadRate, base.cacheReadRate),
      outputRate: rate(p.outputRate, base.outputRate),
      stripCols: posInt(p.stripCols, base.stripCols),
      maxHeightPx: posInt(p.maxHeightPx, base.maxHeightPx),
      visionTier: p.visionTier === 'high-res' || p.visionTier === 'standard' ? p.visionTier : base.visionTier,
      minCompressTokens: p.minCompressTokens === undefined
        ? base.minCompressTokens
        : nonNegativeInt(p.minCompressTokens, base.minCompressTokens ?? 0),
      factSheetFormat: factSheetFormat(p.factSheetFormat, base.factSheetFormat),
      history,
      style,
      historyStripCols,
      historyStyle,
      maxSerializedRequestBytes: p.maxSerializedRequestBytes === undefined
        ? base.maxSerializedRequestBytes
        : posInt(p.maxSerializedRequestBytes, base.maxSerializedRequestBytes ?? 0) || undefined,
      exactStaticBaseline: typeof p.exactStaticBaseline === 'boolean'
        ? p.exactStaticBaseline
        : base.exactStaticBaseline,
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

/** Vendor segments select an upstream, not a geometry, so both spellings of an
 *  id must resolve to one profile — otherwise `moonshotai/kimi-k3` skips its measured
 *  entry and lands on DEFAULT_GPT_PROFILE's OpenAI tile math. Mirrors
 *  unqualifiedModelId() in applicability.ts. */
function candidateIds(m: string): string[] {
  const slash = m.lastIndexOf('/');
  return slash >= 0 ? [m, m.slice(slash + 1)] : [m];
}

export function resolveGptProfile(model: string | null | undefined): GptModelProfile {
  // Match applicability.ts: bracketed transport variants (for example [1m])
  // do not define a different visual reader profile.
  const m = (model ?? '').toLowerCase().replace(/\[[^\]]*\]/g, '');
  const ids = candidateIds(m);
  const geminiId = ids.find(hasGeminiMeasuredProfile);
  if (geminiId) return resolveGeminiProfile(geminiId);
  const env = envProfiles();
  if (env.size > 0) {
    let best: GptModelProfile | undefined;
    let bestLen = -1;
    for (const [k, p] of env) {
      // Longest matching key wins. Equal-length keys fall to env insertion
      // order, not candidate order — the outer loop is over keys.
      for (const id of ids) {
        if (id.startsWith(k) && k.length > bestLen) {
          best = p;
          bestLen = k.length;
        }
      }
    }
    if (best) return best;
  }
  const qualified = ids.length > 1 ? resolveBuiltin(ids[0]!) : undefined;
  if (qualified && qualified !== DEFAULT_GPT_PROFILE) return qualified;
  return resolveBuiltin(ids[ids.length - 1]!);
}
