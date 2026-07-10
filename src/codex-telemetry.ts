/** Minimal, metadata-only telemetry bridge for codex-switch. Node host only. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const SAFE_HEADER_RE = /^(?:x-)?(?:rate[-_]?limit|usage)(?:[-_].*)?$/i;

export interface CodexProfileRoute {
  alias: string;
  upstreamPath: string;
}

/** Parse /p/<alias>/... and return the path which the upstream already expects. */
export function codexProfileRoute(pathname: string, search = ''): CodexProfileRoute | undefined {
  const match = /^\/p\/([^/]+)(\/.*)$/.exec(pathname);
  if (!match) return undefined;
  let alias: string;
  try { alias = decodeURIComponent(match[1]!); } catch { return undefined; }
  if (alias === 'direct' || !ALIAS_RE.test(alias)) return undefined;
  return { alias, upstreamPath: match[2]! + search };
}

export function telemetryDimensions(response: Response): Record<string, string | number> | undefined {
  const dimensions: Record<string, string | number> = {};
  response.headers.forEach((value, name) => {
    if (SAFE_HEADER_RE.test(name)) dimensions[name.toLowerCase()] = value;
  });
  if (response.status === 429) dimensions.http_status = 429;
  return Object.keys(dimensions).length > 0 ? dimensions : undefined;
}

/** Wholesale atomic snapshot. Absence stays unknown; no missing value is synthesized as zero. */
export async function writeCodexTelemetry(
  alias: string,
  response: Response,
  dir = process.env.CODEX_SWITCH_TELEMETRY_DIR
    || path.join(os.homedir(), '.codex-switch', 'telemetry'),
): Promise<boolean> {
  if (alias === 'direct' || !ALIAS_RE.test(alias)) return false;
  const dimensions = telemetryDimensions(response);
  if (!dimensions) return false;
  const snapshot = {
    schema_version: 1,
    alias,
    updated_at: new Date().toISOString(),
    dimensions,
  };
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${alias}.json`);
  const tmp = path.join(dir, `.${alias}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(snapshot) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmp, target);
    return true;
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
  }
}
