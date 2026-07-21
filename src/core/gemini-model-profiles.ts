import {
  MAX_HEIGHT_PX as ANTHROPIC_MAX_HEIGHT_PX,
  ANTHROPIC_SLAB_COLS as ANTHROPIC_STRIP_COLS,
} from './render.js';
import type { GptModelProfile } from './gpt-model-profiles.js';

/** Dedicated profile for Gemini 3.6 Flash and Gemini family models.
 *  Gemini 3.6 Flash prices images at a fixed ~1,089 tokens per image (33×33 patch grid)
 *  regardless of pixel dimensions. 312-col widescreen pages (1568×728) maximize
 *  character capacity per fixed vision token. */
export const GEMINI_3_6_FLASH_PROFILE: GptModelProfile = {
  vision: { regime: 'tile', base: 1089, perTile: 0 },
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
  return /gemini/i.test((model ?? '').toLowerCase());
}

export function resolveGeminiProfile(model: string | null | undefined): GptModelProfile {
  return GEMINI_3_6_FLASH_PROFILE;
}

export function geminiVisionTokens(_model: string, _w: number, _h: number): number {
  return 1089;
}
