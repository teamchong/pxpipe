/**
 * The README's stated zero-config model scope must be the one the code applies.
 *
 * These two drifted apart once already. Opus 5 was removed from the runtime
 * default after a measured recall regression, and the README kept listing it, so
 * a reader who set nothing believed Opus 5 traffic was being imaged when it was
 * passing through untouched. A wrong default in the docs is not a typo: it
 * decides which model a user thinks the published fidelity numbers apply to.
 *
 * Asserting against the exported list rather than restating it keeps the next
 * scope change from being a documentation problem.
 *
 * Run just this file:  pnpm vitest run tests/readme-model-default.test.ts
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODEL_BASES } from '../src/core/applicability.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

describe('README model scope', () => {
  it('states exactly one zero-config default', () => {
    const matches = readme.match(/default `PXPIPE_MODELS=([^`]+)`/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('states the same default the runtime applies', () => {
    const match = readme.match(/default `PXPIPE_MODELS=([^`]+)`/);
    expect(match).not.toBeNull();
    const documented = (match?.[1] ?? '').split(',').map((m) => m.trim()).filter(Boolean);
    expect(documented).toEqual([...DEFAULT_MODEL_BASES]);
  });

  it('does not present an opt-in model as part of the default', () => {
    const match = readme.match(/default `PXPIPE_MODELS=([^`]+)`/);
    const documented = (match?.[1] ?? '').split(',').map((m) => m.trim());
    // Opus 5 is a supported profile but an explicit opt-in, and the difference is
    // the whole point of the recall caveat published next to it.
    expect(documented).not.toContain('claude-opus-5');
  });
});
