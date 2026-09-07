import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { CertificateAuthority } from '../src/warp/ca.js';
import { createWarpHandlers } from '../src/warp/connect.js';
import { parseRoute } from '../src/warp/route.js';

describe('CONNECT proxy and warp integration', () => {
  it('diverts matching HTTPS requests to the local handler and establishes CONNECT tunnel', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pxpipe-test-ca-'));
    const ca = CertificateAuthority.loadOrCreate(tmpDir);
    let divertCount = 0;

    const testServer = createServer();
    const port = await new Promise<number>((resolve) => {
      testServer.listen(0, '127.0.0.1', () => {
        const addr = testServer.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    const routes = [parseRoute(`api.anthropic.com/v1/messages*=http://127.0.0.1:${port}`)];
    const warpHandlers = createWarpHandlers({
      routes,
      ca,
      onDivert: () => {
        divertCount++;
      },
    });

    testServer.on('request', (req, res) => {
      if (req.url && (req.url.startsWith('http://') || req.url.startsWith('https://'))) {
        warpHandlers.handleAbsoluteForm(req, res);
        return;
      }
      if (req.url?.startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, diverted: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    testServer.on('connect', warpHandlers.handleConnect);

    try {
      const curl = spawn('curl', [
        '-x',
        `http://127.0.0.1:${port}`,
        '--cacert',
        ca.certPath,
        '-s',
        'https://api.anthropic.com/v1/messages',
      ]);

      let stdout = '';
      curl.stdout.on('data', (d) => (stdout += d));
      const code = await new Promise<number>((resolve) => {
        curl.on('close', (c) => resolve(c ?? 0));
      });

      expect(code).toBe(0);
      expect(stdout).toContain('"diverted":true');
      expect(divertCount).toBeGreaterThanOrEqual(1);
    } finally {
      await new Promise<void>((resolve) => testServer.close(() => resolve()));
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
