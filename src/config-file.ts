/**
 * Shared on-disk config file helpers (Node-only).
 *
 * The file backs `PXPIPE_MODELS` defaults at startup (see node.ts
 * `applyConfigFileDefaults`) and is also the persistence target for the
 * dashboard's model-scope toggle, so a chip flip in the UI survives a
 * process restart instead of resetting to the env/built-in default.
 *
 * Location: `$PXPIPE_CONFIG`, or `~/.pxpipe/config.json` by default — the
 * same `~/.pxpipe` directory used for `events.jsonl` (see sessions.ts).
 * Shape is a loosely-typed JSON object; today the only key read/written is
 * `models` (string[] | string). Unknown keys already in the file are
 * preserved on write.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export const DEFAULT_CONFIG_FILE = path.join(os.homedir(), '.pxpipe', 'config.json');

/** `$PXPIPE_CONFIG` wins over the default path, matching every other
 *  PXPIPE_* env override in this project. */
export function resolveConfigFilePath(): string {
  return process.env.PXPIPE_CONFIG ?? DEFAULT_CONFIG_FILE;
}

function readConfigFileRaw(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to {} — a write should not clobber a file we can't
    // parse without at least trying to keep going; caller only overwrites
    // the `models` key below, so worst case we drop unrelated keys from an
    // already-broken file rather than crash the request that triggered it.
  }
  return {};
}

/** Persist the current model-scope selection to the config file's `models`
 *  key, preserving any other keys already present. Best-effort: a write
 *  failure (e.g. read-only home dir, no permissions) is swallowed with a
 *  console warning so a UI toggle never fails the request that triggered
 *  it — the runtime scope change still applies in-memory either way. */
export function persistModelsToConfigFile(bases: string[]): void {
  const file = resolveConfigFilePath();
  try {
    const cfg = readConfigFileRaw(file);
    cfg.models = bases;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  } catch (e) {
    console.warn(`[pxpipe] failed to persist models to ${file}: ${(e as Error).message}`);
  }
}
