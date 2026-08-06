import { describe, expect, it } from 'vitest';
import { extractEnvFields, transformRequest } from '../src/core/transform.js';
import { minifyForRender } from '../src/core/render.js';

// Characterization + ReDoS regression tests for the two regex sites reported by
// code scanning (js/polynomial-redos): the <env> span in extractEnvFields and
// the static-tag sniffer in splitStaticDynamic. Both parse untrusted request
// text, so runtime has to stay near-linear in input size while the parsed
// results stay unchanged.

// Generous wall-clock budget so the suite stays stable on loaded hosts. The
// pre-fix code needed over 20s on the 640KB case, so the signal is not marginal.
const BUDGET_MS = 2000;

function elapsed(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

const WELL_FORMED_ENV = [
  '<env>',
  'Working directory: /tmp/proj',
  'Is directory a git repo: Yes',
  'Platform: darwin',
  'OS Version: Darwin 24.0.0',
  "Today's date: 2026-05-18",
  '</env>',
].join('\n');

describe('extractEnvFields behaviour is preserved', () => {
  it('extracts every field from a well-formed block', () => {
    const out = extractEnvFields(WELL_FORMED_ENV);
    expect(out.cwd).toBe('/tmp/proj');
    expect(out.isGitRepo).toBe(true);
    expect(out.platform).toBe('darwin');
    expect(out.osVersion).toBe('Darwin 24.0.0');
    expect(out.today).toBe('2026-05-18');
  });

  it('reads a No git-repo line as false', () => {
    const out = extractEnvFields(WELL_FORMED_ENV.replace('git repo: Yes', 'git repo: No'));
    expect(out.isGitRepo).toBe(false);
  });

  it('returns an empty object for empty input', () => {
    expect(extractEnvFields('')).toEqual({});
  });

  it('reads no env fields when the closing tag is missing', () => {
    const out = extractEnvFields('<env>\nWorking directory: /tmp/proj\n');
    expect(out.cwd).toBeUndefined();
  });

  it('picks up branch outside <env>', () => {
    expect(extractEnvFields('On branch feature/x').gitBranch).toBe('feature/x');
    expect(extractEnvFields('Branch: main').gitBranch).toBe('main');
    expect(extractEnvFields('Current branch: dev').gitBranch).toBe('dev');
  });

  it('keeps the first <env> block when several are present', () => {
    const two = '<env>\nPlatform: darwin\n</env>\n<env>\nPlatform: linux\n</env>';
    expect(extractEnvFields(two).platform).toBe('darwin');
  });

  it('matches the env tag case-insensitively', () => {
    expect(extractEnvFields('<ENV>\nPlatform: win32\n</ENV>').platform).toBe('win32');
  });

  it('keeps fields that sit on the first line of the block', () => {
    expect(extractEnvFields('<env>Platform: darwin\n</env>').platform).toBe('darwin');
  });
});

describe('extractEnvFields stays fast on hostile input', () => {
  // Worst case for an unbounded lazy span: the opening tag is present and the
  // closing tag never arrives, so the engine must scan the whole tail.
  it('handles a large unterminated <env> block within budget', () => {
    const hostile = '<env>' + 'a'.repeat(640_000);
    expect(elapsed(() => extractEnvFields(hostile))).toBeLessThan(BUDGET_MS);
  });

  it('handles many unterminated <env> openings within budget', () => {
    const hostile = '<env>'.repeat(50_000);
    expect(elapsed(() => extractEnvFields(hostile))).toBeLessThan(BUDGET_MS);
  });

  it('handles near-miss field lines within budget', () => {
    const hostile = '<env>' + '\n' + ' '.repeat(320_000) + 'x' + '</env>';
    expect(elapsed(() => extractEnvFields(hostile))).toBeLessThan(BUDGET_MS);
  });

  it('handles near-miss branch lines within budget', () => {
    const hostile = '\n' + ' '.repeat(320_000) + 'x';
    expect(elapsed(() => extractEnvFields(hostile))).toBeLessThan(BUDGET_MS);
  });

  it('scales sub-quadratically with input size', () => {
    const small = elapsed(() => extractEnvFields('<env>' + 'a'.repeat(80_000)));
    const large = elapsed(() => extractEnvFields('<env>' + 'a'.repeat(640_000)));
    // 8x the input. Quadratic would be roughly 64x; the slack absorbs timing
    // noise while still failing loudly on a genuine blowup.
    expect(large).toBeLessThan(Math.max(small, 1) * 24);
  });
});

describe('static tag sniffer behaviour is preserved', () => {
  async function unknownTagsFor(extra: string): Promise<string[]> {
    // Dense slab keeps the compression gate green so the sniffer runs.
    const slab = 'claude.md ground truth. '.repeat(2200);
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: slab + '\n' + extra,
      }),
    );
    const { info } = await transformRequest(body);
    return info.unknownStaticTags ?? [];
  }

  it('surfaces an unknown tag-shaped block in the static slab', async () => {
    expect(await unknownTagsFor('<brandNewTag>whatever</brandNewTag>')).toContain('brandNewTag');
  });

  it('does not report known static tags', async () => {
    expect(await unknownTagsFor('<types>some types</types>')).not.toContain('types');
  });

  it('does not report a tag whose closing tag is absent', async () => {
    expect(await unknownTagsFor('<danglingTag>no closer here')).not.toContain('danglingTag');
  });

  it('reports a tag carrying attributes', async () => {
    expect(await unknownTagsFor('<withAttrs id="1">body</withAttrs>')).toContain('withAttrs');
  });

  it('reports several distinct unknown tags', async () => {
    const tags = await unknownTagsFor('<alphaTag>a</alphaTag>\n<betaTag>b</betaTag>');
    expect(tags).toContain('alphaTag');
    expect(tags).toContain('betaTag');
  });

  it('stays within budget on unterminated tag openings', async () => {
    // '<A ' repeated: every opening starts an attribute run that finds no '>'.
    // Quadratic against a regex opening scan, linear against an index scan.
    // A regex scan needs ~18s here; an index scan needs well under a
    // millisecond, so the budget separates the two by a wide margin.
    const hostile = '<A '.repeat(80_000);
    const t0 = performance.now();
    await unknownTagsFor(hostile);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  it('treats an exotic whitespace separator as a tag opening', async () => {
    // \u00a0 satisfies /\s/, so the previous regex accepted it after the name.
    expect(await unknownTagsFor('<oddSpaceTag\u00a0x="1">body</oddSpaceTag>')).toContain(
      'oddSpaceTag',
    );
  });

  it('stays within budget on a hostile static slab', async () => {
    // Many unclosed tag openings: the pathological shape for the sniffer.
    const hostile = '<aTag>'.repeat(20_000);
    const t0 = performance.now();
    await unknownTagsFor(hostile);
    expect(performance.now() - t0).toBeLessThan(10_000);
  });
});

describe('minifyForRender stays fast on hostile input', () => {
  // A single very long line of spaces that does not end in one: the trailing
  // whitespace strip has to reject at every position in the run.
  it('handles one huge run of trailing spaces within budget', () => {
    const hostile = ' '.repeat(400_000) + 'x';
    expect(elapsed(() => minifyForRender(hostile))).toBeLessThan(BUDGET_MS);
  });

  it('handles a huge run of tabs within budget', () => {
    const hostile = '\t'.repeat(400_000) + 'x';
    expect(elapsed(() => minifyForRender(hostile))).toBeLessThan(BUDGET_MS);
  });

  it('scales sub-quadratically with line length', () => {
    const small = elapsed(() => minifyForRender(' '.repeat(50_000) + 'x'));
    const large = elapsed(() => minifyForRender(' '.repeat(400_000) + 'x'));
    expect(large).toBeLessThan(Math.max(small, 1) * 24);
  });

  it('still strips trailing whitespace and collapses blank runs', () => {
    expect(minifyForRender('a  \nb\t\nc')).toBe('a\nb\nc');
    expect(minifyForRender('a\n\n\n\n\n\nb')).toBe('a\n\n\nb');
    expect(minifyForRender('  indent kept  ')).toBe('  indent kept');
    expect(minifyForRender('mid  line  spaces')).toBe('mid  line  spaces');
  });
});
