import type { GptHistoryOptions } from './openai-history.js';
import type { KeepSharpBlock, TransformOptions } from './transform.js';

export type CompressionProfileName =
  | 'coding-safe'
  | 'balanced'
  | 'aggressive'
  | 'passthrough';

export interface CompressionProfile {
  readonly name: CompressionProfileName;
  readonly description: string;
  readonly transform: Readonly<TransformOptions>;
}

const CODE_FENCE = /```(?:[A-Za-z0-9_+-]+)?\s*[\s\S]*?```/;
const DIFF = /(?:^|\n)(?:diff --git |@@\s+-\d|\+\+\+\s+\S|---\s+\S)/m;
const STACK = /(?:^|\n)\s*(?:at\s+\S+\s*\(|Traceback \(most recent call last\)|Caused by:|panic:)/m;
const COMPILER = /(?:^|\n).*(?:error TS\d+|warning TS\d+|error\[[A-Z]\d+\]|fatal error:|undefined reference|SyntaxError:|TypeError:|AssertionError:)/m;
const TEST_OUTPUT = /(?:^|\n).*(?:FAIL(?:ED)?\b|PASS\b|Tests?:\s+\d+|test result:|\d+\s+failed|\d+\s+passed)/mi;
const PATH_WITH_LINE = /(?:^|\s)(?:\.?\.?\/|\/)[^\s:]+:\d+(?::\d+)?\b/;
const SOURCE_SHAPE = /(?:^|\n)\s*(?:import\s|export\s|const\s|let\s|var\s|function\s|class\s|interface\s|type\s|def\s|async\s+def\s|fn\s|package\s|#include\s|public\s+|private\s+|protected\s+)/m;
const STRUCTURED_STATE = /^\s*[\[{][\s\S]*[\]}]\s*$/;
const EXACT_MACHINE_TOKEN = /(?:\b[0-9a-f]{7,40}\b|\b[A-Z][A-Z0-9_]{2,}\b|--[A-Za-z][\w-]*|\b[A-Za-z_][A-Za-z0-9_]*\([^\n]{0,120}\))/;

/**
 * Conservative classifier for live coding-agent output. A false positive only
 * leaves more text native; a false negative can turn exact code/state into a
 * lossy modality.
 */
export function shouldKeepToolResultSharp(block: KeepSharpBlock): boolean {
  const text = block.text;
  if (!text) return false;
  const sample = text.length > 96_000
    ? `${text.slice(0, 64_000)}\n${text.slice(-32_000)}`
    : text;
  return CODE_FENCE.test(sample)
    || DIFF.test(sample)
    || STACK.test(sample)
    || COMPILER.test(sample)
    || TEST_OUTPUT.test(sample)
    || PATH_WITH_LINE.test(sample)
    || SOURCE_SHAPE.test(sample)
    || STRUCTURED_STATE.test(sample.trim())
    || EXACT_MACHINE_TOKEN.test(sample);
}

const HISTORY_ONLY_STATIC_FLOOR = Number.MAX_SAFE_INTEGER;

const PROFILES: Record<CompressionProfileName, CompressionProfile> = {
  'coding-safe': {
    name: 'coding-safe',
    description: 'keep authority and live tool state native; collapse only old closed history',
    transform: {
      compress: true,
      compressTools: false,
      compressToolResults: false,
      minCompressChars: HISTORY_ONLY_STATIC_FLOOR,
      collapseHistory: true,
      historyAmortizationHorizon: 4,
      reflow: true,
      gptHistory: {
        keepTail: 12,
        keepRecentPairs: 12,
        minCollapsePrefix: 16,
        minCollapseTokens: 4_000,
      },
      keepSharp: shouldKeepToolResultSharp,
    },
  },
  balanced: {
    name: 'balanced',
    description: 'same live-state boundary with a shorter protected history tail',
    transform: {
      compress: true,
      compressTools: false,
      compressToolResults: false,
      minCompressChars: HISTORY_ONLY_STATIC_FLOOR,
      collapseHistory: true,
      historyAmortizationHorizon: 3,
      reflow: true,
      gptHistory: {
        keepTail: 8,
        keepRecentPairs: 8,
        minCollapsePrefix: 12,
        minCollapseTokens: 3_000,
      },
      keepSharp: shouldKeepToolResultSharp,
    },
  },
  // Preserve upstream's current behavior unless a profile is explicitly chosen.
  aggressive: {
    name: 'aggressive',
    description: 'existing transform policy',
    transform: {},
  },
  passthrough: {
    name: 'passthrough',
    description: 'route only; disable context transforms',
    transform: { compress: false },
  },
};

export function resolveCompressionProfile(raw?: string): CompressionProfile {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value || value === 'aggressive' || value === 'legacy') return PROFILES.aggressive;
  if (value === 'safe' || value === 'coding' || value === 'coding-safe') return PROFILES['coding-safe'];
  if (value === 'balanced') return PROFILES.balanced;
  if (value === 'off' || value === 'disabled' || value === 'passthrough') return PROFILES.passthrough;
  throw new Error(`invalid PXPIPE_PROFILE '${raw}'; expected coding-safe, balanced, aggressive or passthrough`);
}

function maxDefined(base: number | undefined, caller: number | undefined): number | undefined {
  if (base === undefined) return caller;
  if (caller === undefined) return base;
  return Math.max(base, caller);
}

function tightenHistoryOptions(
  base: Partial<GptHistoryOptions> | undefined,
  caller: Partial<GptHistoryOptions> | undefined,
): Partial<GptHistoryOptions> | undefined {
  if (!base && !caller) return undefined;
  const merged: Partial<GptHistoryOptions> = { ...base, ...caller };
  const keepTail = maxDefined(base?.keepTail, caller?.keepTail);
  const keepRecentPairs = maxDefined(base?.keepRecentPairs, caller?.keepRecentPairs);
  const minCollapsePrefix = maxDefined(base?.minCollapsePrefix, caller?.minCollapsePrefix);
  const minCollapseTokens = maxDefined(base?.minCollapseTokens, caller?.minCollapseTokens);
  if (keepTail !== undefined) merged.keepTail = keepTail;
  if (keepRecentPairs !== undefined) merged.keepRecentPairs = keepRecentPairs;
  if (minCollapsePrefix !== undefined) merged.minCollapsePrefix = minCollapsePrefix;
  if (minCollapseTokens !== undefined) merged.minCollapseTokens = minCollapseTokens;
  return merged;
}

/**
 * Caller overrides may tighten a profile, but safe profiles retain their semantic
 * boundary: static authority/tool schemas and live tool results cannot be turned
 * back on for imaging, protected-history floors cannot be lowered, and the
 * built-in keep-sharp classifier cannot be disabled.
 */
export function mergeCompressionProfileOptions(
  profile: CompressionProfile,
  overrides: TransformOptions = {},
): TransformOptions {
  const baseKeep = profile.transform.keepSharp;
  const callerKeep = overrides.keepSharp;
  const keepSharp = baseKeep && callerKeep
    ? (block: KeepSharpBlock) => {
        let base = false;
        let caller = false;
        try { base = baseKeep(block) === true; } catch { /* defensive */ }
        try { caller = callerKeep(block) === true; } catch { /* defensive */ }
        return base || caller;
      }
    : callerKeep ?? baseKeep;

  const merged: TransformOptions = {
    ...profile.transform,
    ...overrides,
    ...(keepSharp ? { keepSharp } : {}),
  };

  if (profile.name === 'passthrough') {
    return { ...merged, compress: false };
  }
  if (profile.name === 'aggressive') return merged;

  const minCompressChars = maxDefined(
    profile.transform.minCompressChars,
    overrides.minCompressChars,
  );
  const historyAmortizationHorizon = maxDefined(
    profile.transform.historyAmortizationHorizon,
    overrides.historyAmortizationHorizon,
  );
  const gptHistory = tightenHistoryOptions(profile.transform.gptHistory, overrides.gptHistory);

  return {
    ...merged,
    compress: overrides.compress === false ? false : profile.transform.compress,
    compressTools: false,
    compressToolResults: false,
    ...(minCompressChars !== undefined ? { minCompressChars } : {}),
    collapseHistory: overrides.collapseHistory === false ? false : profile.transform.collapseHistory,
    ...(historyAmortizationHorizon !== undefined ? { historyAmortizationHorizon } : {}),
    ...(gptHistory ? { gptHistory } : {}),
  };
}
