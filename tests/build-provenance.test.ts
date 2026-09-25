import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _setMockBuildProvenance,
  detectGitRepository,
  getBuildProvenance,
  type BuildProvenance,
} from '../src/core/build-provenance.js';

describe('BuildProvenance', () => {
  let initialProvenance: BuildProvenance;

  beforeEach(() => {
    _setMockBuildProvenance(null);
    initialProvenance = getBuildProvenance();
  });

  afterEach(() => {
    _setMockBuildProvenance(null);
  });

  it('conforms to provenance schema v1', () => {
    expect(initialProvenance.schema_version).toBe(1);
    expect(typeof initialProvenance.repository).toBe('string');
    expect(typeof initialProvenance.source_sha).toBe('string');
    expect(typeof initialProvenance.source_ref).toBe('string');
    expect(typeof initialProvenance.dirty).toBe('boolean');
    expect(typeof initialProvenance.package_version).toBe('string');
    expect(typeof initialProvenance.node_executable).toBe('string');
    expect(typeof initialProvenance.node_version).toBe('string');
    expect(typeof initialProvenance.built_at_utc).toBe('string');
    expect(typeof initialProvenance.entry_sha256).toBe('string');
  });

  it('always exposes a 64-character hexadecimal entry hash', () => {
    expect(initialProvenance.entry_sha256).toMatch(/^[0-9a-f]{64}$/i);
  });

  it('freezes the provenance object', () => {
    expect(Object.isFrozen(initialProvenance)).toBe(true);
    expect(() => {
      // @ts-expect-error verify runtime immutability
      initialProvenance.source_sha = 'tampered';
    }).toThrow();
  });

  it('caches and reuses the same provenance object', () => {
    expect(getBuildProvenance()).toBe(initialProvenance);
  });

  it('supports explicit mock provenance injection', () => {
    const mock: BuildProvenance = {
      schema_version: 1,
      repository: 'test/repo',
      source_sha: '1111222233334444555566667777888899990000',
      source_ref: 'test-branch',
      dirty: false,
      package_version: '1.0.0',
      node_executable: 'test-node',
      node_version: 'v20.0.0',
      built_at_utc: '2026-01-01T00:00:00.000Z',
      entry_sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      runtime_node_executable: 'runtime-node',
      runtime_node_version: 'v20.0.1',
      runtime_pid: 1234,
      runtime_entry_sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      bundle_verified: true,
    };

    _setMockBuildProvenance(mock);
    const resolved = getBuildProvenance();

    expect(resolved).toMatchObject(mock);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it('reports runtime Node identity and verifies the built bundle when a build manifest is present', () => {
    expect(initialProvenance.runtime_node_executable).toBe(process.execPath);
    expect(initialProvenance.runtime_node_version).toBe(process.version);
    expect(initialProvenance.runtime_pid).toBe(process.pid);

    if (initialProvenance.source_sha !== 'unbuilt') {
      expect(initialProvenance.runtime_entry_sha256).toMatch(/^[0-9a-f]{64}$/i);
      expect(initialProvenance.runtime_entry_sha256).toBe(initialProvenance.entry_sha256);
      expect(initialProvenance.bundle_verified).toBe(true);
    } else {
      expect(initialProvenance.package_version).toBe('unbuilt');
      expect(initialProvenance.bundle_verified).toBe(false);
    }
  });

  it('never uses the stale 0.8.0 package version for the unbuilt fallback contract', () => {
    const fallback: BuildProvenance = {
      schema_version: 1,
      repository: 'Jouron93/pxpipe',
      source_sha: 'unbuilt',
      source_ref: 'dev',
      dirty: true,
      package_version: 'unbuilt',
      node_executable: process.execPath,
      node_version: process.version,
      built_at_utc: new Date(0).toISOString(),
      entry_sha256: '0000000000000000000000000000000000000000000000000000000000000000',
      runtime_node_executable: process.execPath,
      runtime_node_version: process.version,
      runtime_pid: process.pid,
      bundle_verified: false,
    };

    _setMockBuildProvenance(fallback);
    const resolved = getBuildProvenance();
    expect(resolved.source_sha).toBe('unbuilt');
    expect(resolved.package_version).toBe('unbuilt');
    expect(resolved.package_version).not.toBe('0.8.0');
  });

  describe('detectGitRepository', () => {
    it('prioritizes the tracking upstream remote over origin', () => {
      const mockGit = (args: string[]): string => {
        const cmd = args.join(' ');
        if (cmd === 'rev-parse --abbrev-ref --symbolic-full-name @{u}') {
          return 'fork/fix/main-provenance';
        }
        if (cmd === 'config --get remote.fork.url') {
          return 'https://github.com/Jouron93/pxpipe.git';
        }
        if (cmd === 'config --get remote.origin.url') {
          return 'https://github.com/teamchong/pxpipe.git';
        }
        throw new Error(`unexpected git command: ${cmd}`);
      };

      expect(detectGitRepository(mockGit)).toBe('Jouron93/pxpipe');
    });

    it('uses branch.<name>.remote when the branch has no tracking upstream', () => {
      const mockGit = (args: string[]): string => {
        const cmd = args.join(' ');
        if (cmd === 'rev-parse --abbrev-ref --symbolic-full-name @{u}') {
          throw new Error('no upstream');
        }
        if (cmd === 'rev-parse --abbrev-ref HEAD') return 'fix/main-provenance';
        if (cmd === 'config --get branch.fix/main-provenance.remote') return 'fork';
        if (cmd === 'config --get remote.fork.url') {
          return 'git@github.com:Jouron93/pxpipe.git';
        }
        throw new Error(`unexpected git command: ${cmd}`);
      };

      expect(detectGitRepository(mockGit)).toBe('Jouron93/pxpipe');
    });

    it('falls back to origin when there is no branch remote authority', () => {
      const mockGit = (args: string[]): string => {
        const cmd = args.join(' ');
        if (cmd === 'rev-parse --abbrev-ref --symbolic-full-name @{u}') {
          throw new Error('no upstream');
        }
        if (cmd === 'rev-parse --abbrev-ref HEAD') return 'HEAD';
        if (cmd === 'config --get remote.origin.url') {
          return 'https://github.com/teamchong/pxpipe.git';
        }
        throw new Error(`unexpected git command: ${cmd}`);
      };

      expect(detectGitRepository(mockGit)).toBe('teamchong/pxpipe');
    });

    it('falls back to fork when origin is unavailable', () => {
      const mockGit = (args: string[]): string => {
        const cmd = args.join(' ');
        if (cmd === 'rev-parse --abbrev-ref --symbolic-full-name @{u}') {
          throw new Error('no upstream');
        }
        if (cmd === 'rev-parse --abbrev-ref HEAD') return 'HEAD';
        if (cmd === 'config --get remote.origin.url') throw new Error('no origin');
        if (cmd === 'config --get remote.fork.url') {
          return 'ssh://git@github.com/Jouron93/pxpipe.git';
        }
        throw new Error(`unexpected git command: ${cmd}`);
      };

      expect(detectGitRepository(mockGit)).toBe('Jouron93/pxpipe');
    });
  });
});
