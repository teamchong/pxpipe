import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { readExportTextFile, looksLikeBinary, MAX_FILE_BYTES } from '../src/export-collect.js';

// readExportTextFile is the single gate now shared by every `pxpipe export`
// collection mode (directory walk, single-file target, and --git untracked).
// Before this, the --git untracked path applied none of these checks — it
// ignored --include/--exclude and read files of any size fully into memory.
describe('readExportTextFile — shared export file gate', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-collect-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const write = (name: string, content: string | Buffer): string => {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, content);
    return p;
  };

  it('reads an included text file as utf8', () => {
    const p = write('a.ts', 'export const x = 1;\n');
    const r = readExportTextFile(p, 'a.ts', [], []);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.content).toBe('export const x = 1;\n');
  });

  it('respects --include: a .md is excluded when include is *.ts, the .ts sibling passes', () => {
    const md = write('b.md', '# readme\n');
    const ts = write('a.ts', 'const a = 1;\n');
    expect(readExportTextFile(md, 'b.md', ['*.ts'], []).kind).toBe('excluded');
    expect(readExportTextFile(ts, 'a.ts', ['*.ts'], []).kind).toBe('ok');
  });

  it('respects --exclude', () => {
    const p = write('secret.ts', 'const s = 1;\n');
    expect(readExportTextFile(p, 'secret.ts', [], ['secret.*']).kind).toBe('excluded');
  });

  it('skips an oversized file instead of reading it into memory', () => {
    const p = write('big.ts', 'a'.repeat(MAX_FILE_BYTES + 1));
    expect(readExportTextFile(p, 'big.ts', [], []).kind).toBe('oversized');
  });

  it('accepts a file exactly at the size limit', () => {
    const p = write('edge.ts', 'a'.repeat(MAX_FILE_BYTES));
    expect(readExportTextFile(p, 'edge.ts', [], []).kind).toBe('ok');
  });

  it('skips a binary file (null byte in first 512 bytes)', () => {
    const p = write('bin.dat', Buffer.from([0x41, 0x00, 0x42]));
    expect(readExportTextFile(p, 'bin.dat', [], []).kind).toBe('binary');
  });

  it('reports a missing/inaccessible file', () => {
    expect(readExportTextFile(path.join(tmpDir, 'nope.ts'), 'nope.ts', [], []).kind).toBe('inaccessible');
  });

  it('applies the include/exclude filter before touching the filesystem', () => {
    // A path that does not exist but is filtered out reports 'excluded', not
    // 'inaccessible' — the glob gate short-circuits before any stat.
    expect(readExportTextFile(path.join(tmpDir, 'ghost.md'), 'ghost.md', ['*.ts'], []).kind).toBe('excluded');
  });

  it('looksLikeBinary flags a null byte but passes plain text', () => {
    expect(looksLikeBinary(Buffer.from('plain text'))).toBe(false);
    expect(looksLikeBinary(Buffer.from([0x00]))).toBe(true);
  });
});
