import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

// End-to-end coverage of the real `pxpipe export --git` path (the bug PR-4 fixed
// was in collectSource's untracked branch, not in the readExportTextFile helper).
// Runs the actual CLI via tsx against a throwaway git repo and asserts the
// untracked-file filtering. Kept in its own file because it spawns a subprocess.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

function git(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

describe('pxpipe export --git (end-to-end)', () => {
  let repo: string;
  let outDir: string;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-git-e2e-'));
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-git-out-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 't@t.t']);
    git(repo, ['config', 'user.name', 't']);
    // Tracked baseline so `git diff HEAD` has a HEAD to diff against.
    fs.writeFileSync(path.join(repo, 'tracked.ts'), 'export const tracked = 1;\n');
    git(repo, ['add', 'tracked.ts']);
    git(repo, ['commit', '-q', '-m', 'base']);
    // Untracked files exercising the three untracked-path gates:
    fs.writeFileSync(path.join(repo, 'keep.ts'), 'export const keep = 42;\n'); // included
    fs.writeFileSync(path.join(repo, 'skip.md'), 'x'.repeat(5000)); // excluded by --include *.ts
    fs.writeFileSync(path.join(repo, 'huge.ts'), 'a'.repeat(1_000_001)); // oversized
    fs.writeFileSync(path.join(repo, 'bin.ts'), Buffer.from([0x41, 0x00, 0x42])); // binary
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('applies --include, the size cap, and the binary sniff to untracked files', () => {
    const run = spawnSync(
      tsxBin,
      ['src/node.ts', 'export', '--git', repo, '--include', '*.ts', '--out', outDir, '--json'],
      { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
    );
    expect(run.status, `stderr:\n${run.stderr}`).toBe(0);

    // Oversized + binary untracked files are skipped, with a warning each.
    expect(run.stderr).toContain('skipping oversized untracked file: huge.ts');
    expect(run.stderr).toContain('skipping binary untracked file: bin.ts');

    // The JSON report: only keep.ts's ~24 chars made it into the source (the
    // 5000-char skip.md was excluded by --include *.ts; huge.ts by size). If any
    // had leaked in, sourceChars would be in the thousands.
    const line = run.stdout.trim().split('\n').find((l) => l.trim().startsWith('{'));
    expect(line, `stdout:\n${run.stdout}`).toBeTruthy();
    const report = JSON.parse(line!) as { sourceChars: number };
    expect(report.sourceChars).toBeGreaterThan(0);
    expect(report.sourceChars).toBeLessThan(500);
  });
});
