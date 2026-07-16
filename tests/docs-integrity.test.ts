import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Guard against docs drift: markdown links (and their #fragments) that rot when
// files move, get renamed, or lose a heading. Dependency-light: pure fs + regex,
// runs inside the existing `pnpm test` / CI. Covers inline links, image links,
// reference-style links, and simple HTML href/src across the tracked docs.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** README + top docs + every docs/** and eval/**\/README.md markdown file. */
function markdownFiles(): string[] {
  const out = ['README.md', 'CHANGELOG.md', 'FINDINGS.md'];
  const walk = (rel: string, opts: { onlyReadme?: boolean } = {}): void => {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) return;
    for (const name of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = path.join(rel, name.name);
      if (name.isDirectory()) {
        if (name.name === 'node_modules' || name.name.startsWith('.')) continue;
        walk(childRel, opts);
      } else if (name.name.endsWith('.md')) {
        // eval/ holds huge run logs; only its READMEs are prose worth link-checking.
        if (opts.onlyReadme && name.name !== 'README.md') continue;
        // Forward slashes so assertions and anchorsByFile keys match on Windows.
        out.push(childRel.replace(/\\/g, '/'));
      }
    }
  };
  walk('docs');
  walk('eval', { onlyReadme: true });
  return [...new Set(out)].filter((f) => fs.existsSync(path.join(repoRoot, f)));
}

/** GitHub-style heading anchor slug. */
function slugify(heading: string): string {
  return heading
    .trim()
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // link text only
    .replace(/[*_~]/g, '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Set of heading anchors defined in a markdown file (skips fenced code). */
function headingAnchors(md: string): Set<string> {
  const anchors = new Set<string>();
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) anchors.add(slugify(m[1]!));
  }
  return anchors;
}

interface Link {
  readonly target: string; // path portion (may be empty for same-page #frag)
  readonly fragment: string | null;
  readonly raw: string;
}

const EXTERNAL = /^(https?:|mailto:|data:|tel:|ftp:)/i;

/** Extract every local link target from a markdown file: inline `](x)` / images,
 *  reference definitions `[ref]: x`, and simple HTML `href=`/`src=`. */
function localLinks(md: string): Link[] {
  const links: Link[] = [];
  const push = (rawTarget: string): void => {
    let t = rawTarget.trim();
    if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1);
    t = t.split(/\s+/)[0]!; // drop an optional "title"
    if (!t || EXTERNAL.test(t)) return;
    const hash = t.indexOf('#');
    const target = hash >= 0 ? t.slice(0, hash) : t;
    const fragment = hash >= 0 ? t.slice(hash + 1) : null;
    links.push({ target: target.split('?')[0]!, fragment, raw: rawTarget });
  };
  for (const m of md.matchAll(/\]\(([^)]+)\)/g)) push(m[1]!); // inline + image
  for (const m of md.matchAll(/^\s*\[[^\]]+\]:\s*(\S.*)$/gm)) push(m[1]!); // reference defs
  for (const m of md.matchAll(/(?:href|src)\s*=\s*"([^"]+)"/gi)) push(m[1]!); // simple HTML
  return links;
}

describe('docs integrity', () => {
  const files = markdownFiles();
  const anchorsByFile = new Map<string, Set<string>>();
  for (const f of files) anchorsByFile.set(f, headingAnchors(fs.readFileSync(path.join(repoRoot, f), 'utf8')));

  it('scans README, CHANGELOG, FINDINGS, docs/**, and eval/**/README.md', () => {
    expect(files).toContain('README.md');
    expect(files).toContain('docs/RENDER_SIZING.md');
    expect(files.length).toBeGreaterThan(5);
  });

  it('every relative link/image/href points to a file that exists', () => {
    const dead: string[] = [];
    for (const rel of files) {
      const dir = path.dirname(path.join(repoRoot, rel));
      for (const link of localLinks(fs.readFileSync(path.join(repoRoot, rel), 'utf8'))) {
        if (!link.target) continue; // same-page #fragment, checked below
        if (!fs.existsSync(path.resolve(dir, link.target))) dead.push(`${rel} → ${link.raw}`);
      }
    }
    expect(dead, `dead relative links:\n${dead.join('\n')}`).toEqual([]);
  });

  it('every #fragment resolves to a heading in the target markdown file', () => {
    const dead: string[] = [];
    for (const rel of files) {
      const dir = path.dirname(path.join(repoRoot, rel));
      for (const link of localLinks(fs.readFileSync(path.join(repoRoot, rel), 'utf8'))) {
        if (!link.fragment) continue;
        // Resolve which file the fragment lives in (same file if target empty).
        const targetRel = link.target
          ? path.relative(repoRoot, path.resolve(dir, link.target)).replace(/\\/g, '/')
          : rel;
        if (!targetRel.endsWith('.md')) continue; // only markdown has heading anchors
        const anchors = anchorsByFile.get(targetRel);
        if (anchors === undefined) continue; // target outside the scanned set
        if (!anchors.has(link.fragment.toLowerCase())) dead.push(`${rel} → #${link.fragment}`);
      }
    }
    expect(dead, `broken heading anchors:\n${dead.join('\n')}`).toEqual([]);
  });
});
