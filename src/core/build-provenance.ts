import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface BuildProvenance {
  schema_version: 1;
  repository: string;
  source_sha: string;
  source_ref: string;
  dirty: boolean;
  package_version: string;
  node_executable: string;
  node_version: string;
  built_at_utc: string;
  entry_sha256: string;
  runtime_node_executable?: string;
  runtime_node_version?: string;
  runtime_pid?: number;
  runtime_entry_sha256?: string;
  bundle_verified?: boolean;
}

let cachedProvenance: BuildProvenance | null = null;

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function isManifest(value: unknown): value is BuildProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const parsed = value as Record<string, unknown>;
  return (
    parsed.schema_version === 1 &&
    typeof parsed.repository === 'string' &&
    typeof parsed.source_sha === 'string' &&
    typeof parsed.source_ref === 'string' &&
    typeof parsed.dirty === 'boolean' &&
    typeof parsed.package_version === 'string' &&
    typeof parsed.node_executable === 'string' &&
    typeof parsed.node_version === 'string' &&
    typeof parsed.built_at_utc === 'string' &&
    isSha256(parsed.entry_sha256)
  );
}

function sha256File(filePath: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
  } catch {
    return undefined;
  }
}

function manifestCandidates(): string[] {
  const candidates: string[] = [];

  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    // Bundled production runtime: import.meta.url points at dist/node.js.
    candidates.push(path.join(currentDir, 'build-provenance.json'));
    // Source/test runtime: import.meta.url points at src/core/build-provenance.ts
    // (or its compiled equivalent), so ../../dist resolves the build output.
    candidates.push(path.resolve(currentDir, '..', '..', 'dist', 'build-provenance.json'));
  } catch {
    // Synthetic module environments may not expose a usable import.meta.url.
  }

  // Final development fallback for callers launched from the repository root.
  candidates.push(path.resolve(process.cwd(), 'dist', 'build-provenance.json'));

  return [...new Set(candidates)];
}

/**
 * Load immutable build provenance and bind it to the runtime currently
 * executing. The manifest fields describe the build. The runtime_* fields and
 * bundle_verified describe this process and the node.js bytes beside the
 * manifest. Once resolved, the object is frozen and cached for the lifetime of
 * the process so later disk mutation cannot rewrite the process identity.
 */
export function getBuildProvenance(): BuildProvenance {
  if (cachedProvenance) return cachedProvenance;

  for (const candidate of manifestCandidates()) {
    try {
      if (!existsSync(candidate)) continue;
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as unknown;
      if (!isManifest(parsed)) continue;

      const bundlePath = path.join(path.dirname(candidate), 'node.js');
      const runtimeEntrySha256 = existsSync(bundlePath) ? sha256File(bundlePath) : undefined;
      const bundleVerified =
        runtimeEntrySha256 !== undefined &&
        runtimeEntrySha256.toLowerCase() === parsed.entry_sha256.toLowerCase();

      cachedProvenance = Object.freeze({
        ...parsed,
        runtime_node_executable: process.execPath,
        runtime_node_version: process.version,
        runtime_pid: process.pid,
        runtime_entry_sha256: runtimeEntrySha256,
        bundle_verified: bundleVerified,
      });
      return cachedProvenance;
    } catch {
      // Try the next candidate. Invalid/unreadable manifests never become a
      // verified runtime identity.
    }
  }

  cachedProvenance = Object.freeze({
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
  });
  return cachedProvenance;
}

/** Testing helper to inject or clear the process-local cached provenance. */
export function _setMockBuildProvenance(p: BuildProvenance | null): void {
  cachedProvenance = p ? Object.freeze({ ...p }) : null;
}

function repositoryFromRemoteUrl(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return '';
  const match = trimmed.match(/[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  return match?.[1] ?? trimmed;
}

/**
 * Detect the repository represented by the active branch's authority.
 * Priority: tracking upstream remote -> branch.<name>.remote -> origin -> fork.
 */
export function detectGitRepository(
  runGitCmd: (args: string[]) => string,
): string {
  let remoteName = '';

  try {
    const upstreamRef = runGitCmd([
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{u}',
    ]).trim();
    if (upstreamRef.includes('/')) {
      remoteName = upstreamRef.split('/')[0] ?? '';
    }
  } catch {
    // No tracking upstream is valid for local integration branches.
  }

  if (!remoteName) {
    try {
      const branchName = runGitCmd(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
      if (branchName && branchName !== 'HEAD') {
        remoteName = runGitCmd(['config', '--get', `branch.${branchName}.remote`]).trim();
      }
    } catch {
      // Detached HEAD or no branch-specific remote.
    }
  }

  let remoteUrl = '';
  if (remoteName) {
    try {
      remoteUrl = runGitCmd(['config', '--get', `remote.${remoteName}.url`]).trim();
    } catch {
      // Fall through to origin/fork.
    }
  }

  if (!remoteUrl) {
    try {
      remoteUrl = runGitCmd(['config', '--get', 'remote.origin.url']).trim();
    } catch {
      // Fall through to fork.
    }
  }

  if (!remoteUrl) {
    try {
      remoteUrl = runGitCmd(['config', '--get', 'remote.fork.url']).trim();
    } catch {
      // No usable remote configured.
    }
  }

  return repositoryFromRemoteUrl(remoteUrl) || 'Jouron93/pxpipe';
}
