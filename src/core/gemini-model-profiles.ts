import {
  MAX_HEIGHT_PX as ANTHROPIC_MAX_HEIGHT_PX,
  ANTHROPIC_SLAB_COLS as ANTHROPIC_STRIP_COLS,
} from './render.js';
import type { GptModelProfile } from './gpt-model-profiles.js';

/** Dedicated profile for the validated Gemini 3.6 Flash model. The production
 *  1568×728 geometry measured 1,078 image tokens. */
export const GEMINI_3_6_FLASH_PROFILE: GptModelProfile = {
  vision: { regime: 'tile', base: 1078, perTile: 0 },
  stripCols: ANTHROPIC_STRIP_COLS,
  maxHeightPx: ANTHROPIC_MAX_HEIGHT_PX,
  minCompressTokens: 500,
  factSheetFormat: 'full',
  history: {
    maxImages: 32,
    keepTail: 6,
    keepRecentPairs: 6,
    minCollapseTokens: 2000,
    responsesMode: 'pairs',
    framing: 'full',
    factSheetScope: 'per-segment',
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

export function isGeminiModel(model: string | null | undefined): boolean {
  const id = (model ?? '').toLowerCase();
  return id === 'gemini-3.6-flash' || id === 'google/gemini-3.6-flash';
}

export function resolveGeminiProfile(): GptModelProfile {
  return GEMINI_3_6_FLASH_PROFILE;
}

export function geminiVisionTokens(model: string, w: number, h: number): number {
  if (!isGeminiModel(model) || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error(`Unsupported Gemini image-token estimate: ${model} ${w}x${h}`);
  }
  // Live usage measured this exact production canvas at 1,078 IMAGE tokens.
  // Other measured shapes ranged up to 1,113; Google's current Gemini 3 docs
  // publish an approximate 1,120-token default/high image budget. Use that
  // documented ceiling for partial pages and width-shrunk slabs.
  return w === 1568 && h === 728 ? 1078 : 1120;
}
