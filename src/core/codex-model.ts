/** Narrow, read-only Codex model-selection helpers. */

export type CodexModelSource = 'cli' | 'profile' | 'config' | 'reference';

export interface CodexModelSelection {
  model: string;
  source: CodexModelSource;
  profile?: string;
}

interface ParsedCodexConfig {
  model?: string;
  profile?: string;
  profileModels: Map<string, string>;
}

function stripTomlComment(raw: string): string {
  let quote: 'single' | 'double' | null = null;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quote === 'double') {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') quote = null;
      continue;
    }
    if (quote === 'single') {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"') quote = 'double';
    else if (ch === "'") quote = 'single';
    else if (ch === '#') return raw.slice(0, i);
  }
  return raw;
}

function unquoteTomlScalar(raw: string): string | undefined {
  const value = stripTomlComment(raw).trim();
  if (!value) return undefined;
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : undefined;
    } catch { return undefined; }
  }
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    if (end < 0) return undefined;
    return value.slice(1, end).trim() || undefined;
  }
  return value.split(/\s+/)[0]?.trim() || undefined;
}

function assignmentValue(raw: string, key: string): string | undefined {
  const eq = raw.indexOf('=');
  if (eq < 0 || raw.slice(0, eq).trim() !== key) return undefined;
  return unquoteTomlScalar(raw.slice(eq + 1));
}

function configOverride(args: readonly string[], key: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '-c' || arg === '--config') {
      const next = args[i + 1];
      if (next !== undefined) {
        const value = assignmentValue(next, key);
        if (value !== undefined) return value;
        i += 1;
      }
    } else if (arg.startsWith('-c=')) {
      const value = assignmentValue(arg.slice(3), key);
      if (value !== undefined) return value;
    } else if (arg.startsWith('--config=')) {
      const value = assignmentValue(arg.slice('--config='.length), key);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

export function codexModelFromArgs(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '-m' || arg === '--model') {
      const next = args[i + 1]?.trim();
      if (next) return next;
    } else if (arg.startsWith('--model=')) {
      const value = arg.slice('--model='.length).trim();
      if (value) return value;
    }
  }
  return configOverride(args, 'model');
}

export function codexProfileFromArgs(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '-p' || arg === '--profile') {
      const next = args[i + 1]?.trim();
      if (next) return next;
    } else if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length).trim();
      if (value) return value;
    }
  }
  return configOverride(args, 'profile');
}

function parseCodexConfig(text: string | undefined): ParsedCodexConfig {
  const parsed: ParsedCodexConfig = { profileModels: new Map() };
  if (!text) return parsed;
  let profileSection: string | null = null;
  let inOtherSection = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      const profile = /^profiles\.([A-Za-z0-9_.-]+)$/.exec(section[1]!.trim());
      profileSection = profile?.[1] ?? null;
      inOtherSection = profileSection === null;
      continue;
    }
    const model = assignmentValue(line, 'model');
    if (model !== undefined) {
      if (profileSection !== null) parsed.profileModels.set(profileSection, model);
      else if (!inOtherSection) parsed.model = model;
      continue;
    }
    if (!inOtherSection && profileSection === null) {
      const profile = assignmentValue(line, 'profile');
      if (profile !== undefined) parsed.profile = profile;
    }
  }
  return parsed;
}

export function resolveCodexModelSelection(
  args: readonly string[],
  configText: string | undefined,
  referenceModel: string,
): CodexModelSelection {
  const explicit = codexModelFromArgs(args);
  if (explicit) return { model: explicit, source: 'cli' };
  const config = parseCodexConfig(configText);
  const profile = codexProfileFromArgs(args) ?? config.profile;
  if (profile) {
    const model = config.profileModels.get(profile);
    if (model) return { model, source: 'profile', profile };
  }
  if (config.model) return { model: config.model, source: 'config' };
  return { model: referenceModel, source: 'reference', ...(profile ? { profile } : {}) };
}
