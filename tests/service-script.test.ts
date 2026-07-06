import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serviceScript = path.join(repoRoot, 'scripts', 'service.mjs');

function homeEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };
}

describe('service script', () => {
  it('does not treat an arbitrary live pidfile as a managed pxpipe process', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-service-home-'));
    try {
      const stateDir = path.join(home, '.pxpipe');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'pxpipe.pid'), String(process.pid));

      const run = spawnSync(process.execPath, [serviceScript, 'status'], {
        cwd: repoRoot,
        env: homeEnv(home),
        encoding: 'utf8',
      });

      expect(run.status, `stderr:\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('[pxpipe] stopped');
      expect(run.stdout).not.toContain('running');
      expect(fs.existsSync(path.join(stateDir, 'pxpipe.pid'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('package service scripts', () => {
  it('includes the service launcher in the published package files', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      files: string[];
    };
    const serviceRefs = Object.values(pkg.scripts).filter((script) => script.includes('scripts/service.mjs'));

    expect(serviceRefs.length).toBeGreaterThan(0);
    expect(pkg.files).toContain('scripts/service.mjs');
  });
});
