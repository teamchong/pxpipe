import { BASE_PRICING } from './profile-base.js';
import { visionTokens } from './vision-cost.js';
import type { GptModelProfile } from './gpt-model-profiles.js';

/**
 * Dedicated profile for Gemini models (Google AI Studio).
 * - Canvas width: 1536px (382 columns with 4px cell width).
 * - Max canvas height: 1536px (2x2 tile grid = 1,081 tokens).
 */
export const GEMINI_3_6_FLASH_PROFILE: GptModelProfile = {
  // Flat per-image charge. Live usage measured the exact production canvas at
  // 1,078-1,081 image tokens; other measured shapes ranged up to 1,113 and Google's
  // Gemini docs publish an approximate 1,120-token default/high image budget,
  // so that documented ceiling prices partial pages and width-shrunk slabs.
  vision: {
    regime: 'flat',
    tokens: 1120,
    exact: { widthPx: 1536, heightPx: 1536, tokens: 1081 },
  },
  ...BASE_PRICING,
  cacheReadRate: 0.25,
  stripCols: 306, // 306 cols * 5px + 6px padding = 1536px
  maxHeightPx: 1536, // Standard 2x2 grid max height
  minCompressTokens: 500,
  factSheetFormat: 'compact',
  history: {
    maxImages: 32,
    keepTail: 4,
    keepRecentPairs: 4,
    minCollapseTokens: 2000,
    responsesMode: 'pairs',
    framing: 'compact',
    factSheetScope: 'combined',
  },
  style: {
    font: 'spleen-5x8',
    cellWBonus: 0,
    cellHBonus: 0,
    aa: true,
    grid: false,
    gridCols: 0,
    colorCycle: false,
    markerScale: 1,
    markerRed: false,
    inkDilate: 0,
  },
};

/** Dedicated profile for Gemini 3.7 Flash. Reuses the measured 3.6 Flash
 *  image geometry (1568×728 @ 1,078 tokens) and shared pricing structure. */
export const GEMINI_3_7_FLASH_PROFILE: GptModelProfile = {
  ...GEMINI_3_6_FLASH_PROFILE,
  vision: { ...GEMINI_3_6_FLASH_PROFILE.vision },
  history: { ...GEMINI_3_6_FLASH_PROFILE.history },
  style: { ...GEMINI_3_6_FLASH_PROFILE.style },
};

export const GEMINI_2_0_FLASH_PROFILE: GptModelProfile = {
  ...GEMINI_3_6_FLASH_PROFILE,
  vision: { ...GEMINI_3_6_FLASH_PROFILE.vision },
  history: { ...GEMINI_3_6_FLASH_PROFILE.history },
  style: { ...GEMINI_3_6_FLASH_PROFILE.style },
};

export const GEMINI_1_5_FLASH_PROFILE: GptModelProfile = {
  ...GEMINI_3_6_FLASH_PROFILE,
  vision: { ...GEMINI_3_6_FLASH_PROFILE.vision },
  history: { ...GEMINI_3_6_FLASH_PROFILE.history },
  style: { ...GEMINI_3_6_FLASH_PROFILE.style },
};

export const GEMINI_1_5_PRO_PROFILE: GptModelProfile = {
  ...GEMINI_3_6_FLASH_PROFILE,
  vision: { ...GEMINI_3_6_FLASH_PROFILE.vision },
  history: { ...GEMINI_3_6_FLASH_PROFILE.history },
  style: { ...GEMINI_3_6_FLASH_PROFILE.style },
};

const GEMINI_MEASURED_PROFILES: Readonly<Record<string, GptModelProfile>> = {
  'gemini-3.6-flash': GEMINI_3_6_FLASH_PROFILE,
  'gemini-3.7-flash': GEMINI_3_7_FLASH_PROFILE,
  'gemini-2.0-flash': GEMINI_2_0_FLASH_PROFILE,
  'gemini-1.5-flash': GEMINI_1_5_FLASH_PROFILE,
  'gemini-1.5-pro': GEMINI_1_5_PRO_PROFILE,
};

function normalizeGeminiId(model: string | null | undefined): string {
  const id = (model ?? '').toLowerCase();
  const slash = id.lastIndexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}

export function isGeminiModel(model: string | null | undefined): boolean {
  return normalizeGeminiId(model).startsWith('gemini-');
}

/** True only for Gemini model IDs with an explicit measured profile. */
export function hasGeminiMeasuredProfile(model: string | null | undefined): boolean {
  return normalizeGeminiId(model) in GEMINI_MEASURED_PROFILES;
}

export function resolveGeminiProfile(model?: string | null): GptModelProfile {
  if (model) {
    const prof = GEMINI_MEASURED_PROFILES[normalizeGeminiId(model)];
    if (prof) return prof;
  }
  return GEMINI_3_6_FLASH_PROFILE;
}

/** Gemini image tokens, with an explicit guard: this path is only reachable for
 *  ids pxpipe has actually measured. The numbers themselves live in the profile
 *  (`GEMINI_MEASURED_PROFILES`) and are applied by `visionTokens`. */
export function geminiVisionTokens(model: string, w: number, h: number): number {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error(`Invalid Gemini image dimensions: ${w}x${h}`);
  }
  const prof = GEMINI_MEASURED_PROFILES[normalizeGeminiId(model)];
  if (!prof) {
    throw new Error(`Unsupported Gemini model for image tokens: ${model}`);
  }
  return visionTokens(prof, w, h);
}
