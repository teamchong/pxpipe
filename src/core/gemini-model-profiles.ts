import {
  MAX_HEIGHT_PX as ANTHROPIC_MAX_HEIGHT_PX,
  ANTHROPIC_SLAB_COLS as ANTHROPIC_STRIP_COLS,
} from './render.js';
import { BASE_PRICING } from './profile-base.js';
import { visionTokens } from './vision-cost.js';
import type { GptModelProfile } from './gpt-model-profiles.js';

/** Legacy Gemini 3.x Flash profile (1568×728, 312×90 at 5×8 = 49×22 = 1,078 ViT patches). */
export const GEMINI_LEGACY_PROFILE: GptModelProfile = {
  // Flat per-image charge. Live usage measured the exact production canvas at
  // 1,078 IMAGE tokens; other measured shapes ranged up to 1,113 and Google's
  // Gemini 3 docs publish an approximate 1,120-token default/high image budget,
  // so that documented ceiling prices partial pages and width-shrunk slabs.
  vision: { regime: 'flat', tokens: 1120, exact: { widthPx: 1568, heightPx: 728, tokens: 1078 } },
  ...BASE_PRICING,
  cacheReadRate: 0.25,
  stripCols: ANTHROPIC_STRIP_COLS,
  maxHeightPx: ANTHROPIC_MAX_HEIGHT_PX,
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

export const GEMINI_3_6_FLASH_PROFILE: GptModelProfile = GEMINI_LEGACY_PROFILE;

/** Dedicated Gemini 4+ profile. Shares the validated 1568×728 (49×22 patch)
 *  canvas geometry while raising the history page ceiling from the legacy 32-page
 *  cap to 96 pages (matching CLAUDE_PROFILE) and using 'mixed' responses grouping
 *  so long multi-hundred-turn agent sessions stay collapsed past 32 pages. */
export const GEMINI_PROFILE: GptModelProfile = {
  ...GEMINI_LEGACY_PROFILE,
  history: {
    ...GEMINI_LEGACY_PROFILE.history,
    maxImages: 96,
    responsesMode: 'mixed',
  },
  style: { ...GEMINI_LEGACY_PROFILE.style },
};

const GEMINI_MEASURED_PROFILES: Readonly<Record<string, GptModelProfile>> = {
  'gemini-3.6-flash': GEMINI_LEGACY_PROFILE,
  'gemini-3.7-flash': GEMINI_LEGACY_PROFILE,
  'gemini-3.8-flash': GEMINI_LEGACY_PROFILE,
  'gemini-3.8-flash-high': GEMINI_LEGACY_PROFILE,
  'gemini-3.8-flash-medium': GEMINI_LEGACY_PROFILE,
  'gemini-3.8-flash-low': GEMINI_LEGACY_PROFILE,
  'gemini-3.1-flash': GEMINI_LEGACY_PROFILE,
  'gemini-3.1-flash-lite': GEMINI_LEGACY_PROFILE,
  'gemini-4': GEMINI_PROFILE,
  'gemini-4-flash': GEMINI_PROFILE,
  'gemini-4-pro': GEMINI_PROFILE,
  'gemini-4-argon': GEMINI_PROFILE,
  'gemini-4-argon-high': GEMINI_PROFILE,
  'gemini-4-argon-medium': GEMINI_PROFILE,
  'gemini-4-argon-low': GEMINI_PROFILE,
};
function normalizeGeminiId(model: string | null | undefined): string {
  const id = (model ?? '').toLowerCase();
  const slash = id.lastIndexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}

export function isGeminiModel(model: string | null | undefined): boolean {
  const id = normalizeGeminiId(model);
  return id.startsWith('gemini-') || id === 'gemini';
}

/** True for Gemini models with a validated or forward-compatible profile.
 *  Supports 3.8+, 3.9+, 4+, 5+, Pro, and registered 3.6/3.7/3.1 flash models. */
export function hasGeminiMeasuredProfile(model: string | null | undefined): boolean {
  const id = normalizeGeminiId(model);
  if (!id) return false;
  if (id in GEMINI_MEASURED_PROFILES) return true;
  if (id === 'gemini-pro' || id === 'gemini-flash' || id === 'gemini') return true;
  const m = id.match(/^gemini-(\d+)(?:\.(\d+))?/);
  if (!m) return false;
  const major = parseInt(m[1]!, 10);
  const minor = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  if (major === 3) {
    return minor >= 8;
  }
  return major > 3;
}

export function resolveGeminiProfile(model?: string | null): GptModelProfile {
  if (model) {
    const id = normalizeGeminiId(model);
    const prof = GEMINI_MEASURED_PROFILES[id];
    if (prof) return prof;
    if (id.startsWith('gemini-3.') || id === 'gemini-3') return GEMINI_LEGACY_PROFILE;
  }
  return GEMINI_PROFILE;
}

/** Gemini image tokens for any supported Gemini model using the validated
 *  flat-regime tile geometry (1,078 image tokens for 1568x728). */
export function geminiVisionTokens(model: string, w: number, h: number): number {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error(`Invalid Gemini image dimensions: ${w}x${h}`);
  }
  if (!hasGeminiMeasuredProfile(model)) {
    throw new Error(`Unsupported Gemini model for image tokens: ${model}`);
  }
  const prof = resolveGeminiProfile(model);
  return visionTokens(prof, w, h);
}
