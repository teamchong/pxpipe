import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { codexProfileRoute, writeCodexTelemetry } from '../src/codex-telemetry.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }))));

describe('codex-switch telemetry integration', () => {
  it('routes a profile prefix while preserving query parameters', () => {
    expect(codexProfileRoute('/p/work_1/v1/responses', '?stream=true')).toEqual({
      alias: 'work_1', upstreamPath: '/v1/responses?stream=true',
    });
    expect(codexProfileRoute('/p/direct/v1/responses')).toBeUndefined();
    expect(codexProfileRoute('/p/INVALID/v1/responses')).toBeUndefined();
  });

  it('atomically writes only quota metadata and never invents unknown zeroes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pxpipe-telemetry-')); dirs.push(dir);
    const response = new Response('SECRET RESPONSE CONTENT', { status: 200, headers: {
      'x-ratelimit-remaining-requests': '17',
      'x-usage-window': '5h',
      authorization: 'Bearer SECRET',
      'x-unrelated': 'do-not-store',
    }});
    expect(await writeCodexTelemetry('work', response, dir)).toBe(true);
    const raw = await fs.readFile(path.join(dir, 'work.json'), 'utf8');
    const value = JSON.parse(raw);
    expect(value).toMatchObject({ schema_version: 1, alias: 'work', dimensions: {
      'x-ratelimit-remaining-requests': '17', 'x-usage-window': '5h',
    }});
    expect(raw).not.toContain('SECRET');
    expect(raw).not.toContain('unrelated');
    expect(value.dimensions.remaining).toBeUndefined();
    expect((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('records a bare 429 but skips responses with no quota signal', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pxpipe-telemetry-')); dirs.push(dir);
    expect(await writeCodexTelemetry('rate', new Response('nope', { status: 429 }), dir)).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'rate.json'), 'utf8')).dimensions).toEqual({ http_status: 429 });
    expect(await writeCodexTelemetry('quiet', new Response('ok'), dir)).toBe(false);
    await expect(fs.access(path.join(dir, 'quiet.json'))).rejects.toThrow();
  });
});
