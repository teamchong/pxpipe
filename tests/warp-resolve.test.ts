import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isPathLike, isRunnable, whichSync } from '../src/warp/resolve.js';

// Windows lookup is pure path logic (PATH delimiter, PATHEXT), so it can be
// exercised on any host by passing the platform in explicitly.
describe('warp command resolution on win32', () => {
  let root: string;
  let bin: string;
  let shims: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'pxpipe-resolve-'));
    bin = join(root, 'bin');
    shims = join(root, 'shims');
    mkdirSync(bin);
    mkdirSync(shims);
    writeFileSync(join(bin, 'claude.exe'), '');
    writeFileSync(join(shims, 'codex.cmd'), '');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const env = (): NodeJS.ProcessEnv => ({
    PATH: [join(root, 'missing'), bin, shims].join(';'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
  });

  it('finds a bare name through PATHEXT on a ;-separated PATH', () => {
    // Regression: PATH was split on ':' and PATHEXT ignored, so `claude`
    // (claude.exe) was never found and warp fell back to a missing /bin/sh.
    expect(whichSync('claude', env(), 'win32')).toBe(true);
    expect(isRunnable('claude', env(), 'win32')).toBe(true);
  });

  it('accepts a name that already carries its extension', () => {
    expect(whichSync('claude.exe', env(), 'win32')).toBe(true);
  });

  it('reads the Path spelling Windows actually uses', () => {
    expect(whichSync('claude', { Path: bin }, 'win32')).toBe(true);
  });

  it('does not report .cmd shims, which spawn() cannot launch directly', () => {
    expect(whichSync('codex', env(), 'win32')).toBe(false);
  });

  it('treats backslash paths as paths', () => {
    const exe = join(bin, 'claude.exe');
    expect(isPathLike('C:\\tools\\claude.exe', 'win32')).toBe(true);
    expect(isPathLike('C:\\tools\\claude.exe', 'linux')).toBe(false);
    expect(isRunnable(exe, env(), 'win32')).toBe(true);
    expect(isRunnable('C:\\definitely\\not\\here.exe', env(), 'win32')).toBe(false);
  });

  it('keeps POSIX lookup on a :-separated PATH', () => {
    expect(whichSync('claude', { PATH: `${root}:/nonexistent` }, 'linux')).toBe(false);
  });
});
