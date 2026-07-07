import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

const README_PATH = 'README.md';
const OFFLINE_EXPORT_HEADING = '## Offline export (no proxy)';
const REQUIRED_OFFLINE_EXPORT_TEXT = [
  'pxpipe export',
  '--stdin',
  '--git',
  'page-*.png',
  'factsheet.txt',
  'prompt.txt',
  'Cursor',
  'without running the proxy',
] as const;

describe('README offline export documentation', () => {
  it('documents the proxy-free image export workflow', () => {
    const readme = fs.readFileSync(README_PATH, 'utf8');
    const sectionStart = readme.indexOf(OFFLINE_EXPORT_HEADING);

    expect(sectionStart).toBeGreaterThanOrEqual(0);

    const nextSectionStart = readme.indexOf('\n## ', sectionStart + OFFLINE_EXPORT_HEADING.length);
    const section =
      nextSectionStart === -1 ? readme.slice(sectionStart) : readme.slice(sectionStart, nextSectionStart);

    for (const requiredText of REQUIRED_OFFLINE_EXPORT_TEXT) {
      expect(section).toContain(requiredText);
    }
  });
});
