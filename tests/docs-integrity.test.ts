import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Guard against docs drift: README/docs relative links that rot when files move
// or get renamed (the class of bug a static audit catches once, then forgets).
// Dependency-light: pure fs + regex, runs inside the existing `pnpm test` / CI.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** README.md plus every top-level docs/*.md. */
function markdownFiles(): string[] {
  const files = ['README.md'];
  for (const name of fs.readdirSync(path.join(repoRoot, 'docs'))) {
    if (name.endsWith('.md')) files.push(path.join('docs', name));
  }
  return files;
}

/** Relative link/image targets in a markdown string — `[text](target)` and
 *  `![alt](target)`. Skips external (http/mailto/data) and in-page anchors, and
 *  strips any `#fragment`, `?query`, angle brackets, or trailing "title". */
function relativeLinkTargets(md: string): string[] {
  const out: string[] = [];
  const re = /\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    let link = m[1]!.trim();
    if (link.startsWith('<') && link.includes('>')) link = link.slice(1, link.indexOf('>'));
    link = link.split(/\s+/)[0]!; // drop an optional `"title"`
    if (/^(https?:|mailto:|data:|#)/.test(link)) continue;
    link = link.split('#')[0]!.split('?')[0]!;
    if (link) out.push(link);
  }
  return out;
}

describe('docs integrity', () => {
  it('every relative link in README.md and docs/*.md points to an existing file', () => {
    const dead: string[] = [];
    for (const rel of markdownFiles()) {
      const abs = path.join(repoRoot, rel);
      const md = fs.readFileSync(abs, 'utf8');
      for (const link of relativeLinkTargets(md)) {
        if (!fs.existsSync(path.resolve(path.dirname(abs), link))) {
          dead.push(`${rel} → ${link}`);
        }
      }
    }
    expect(dead, `dead relative links found:\n${dead.join('\n')}`).toEqual([]);
  });
});
