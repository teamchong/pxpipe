import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const DIRECT_EXTS = new Set(['.com', '.exe']);

/** Does this word name a file path rather than a bare command? */
export const isPathLike = (word: string, platform: NodeJS.Platform = process.platform): boolean =>
  word.includes('/') || (platform === 'win32' && word.includes('\\'));

/**
 * Minimal `which`: is this bare name an executable on PATH?
 *
 * Windows splits PATH on `;` (a drive letter already contains `:`), and a bare
 * `claude` only exists on disk as `claude.exe`, so PATHEXT has to be tried too.
 */
export const whichSync = (
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean => {
  if (isPathLike(name, platform)) return false; // a path, handled by existsSync
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  // Windows env is case-insensitive, but a copied object is not.
  const pathVar = win ? (env.PATH ?? env.Path ?? '') : (env.PATH ?? '');
  // Only what spawn() can launch without a shell: libuv runs .com/.exe, while
  // .cmd/.bat (npm shims) need cmd.exe and would fail a direct spawn.
  const exts = win
    ? (env.PATHEXT ?? DEFAULT_PATHEXT)
        .split(';')
        .filter((ext) => DIRECT_EXTS.has(ext.toLowerCase()))
    : [];
  const hasExt = win && exts.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()));
  const candidates = win && !hasExt ? exts.map((ext) => name + ext) : [name];

  for (const dir of pathVar.split(p.delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      try {
        accessSync(p.join(dir, candidate), win ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        // not here, keep looking
      }
    }
  }
  return false;
};

/** Can this word actually be executed: a path that exists, or a name on PATH. */
export const isRunnable = (
  word: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean => (isPathLike(word, platform) ? existsSync(word) : whichSync(word, env, platform));
