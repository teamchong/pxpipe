// Tests for scripts/restart.mjs.
//
// The previous version of these tests was a bash script that shimmed pgrep /
// lsof / kill / pnpm onto PATH — which meant it only ran where those binaries
// exist, i.e. not on Windows, the platform the script most needed covering.
// restart.mjs takes its side effects as injectable dependencies instead, so
// the sequencing below is exercised with plain fakes on every platform, and
// the two genuinely cross-platform primitives (the port probe and the process
// table scan) are tested against the real system.

import net from 'node:net';
import { describe, expect, it } from 'vitest';

import {
  checkPortFree,
  findProxyPids,
  listProcesses,
  matchesProxyCommand,
  parseArgs,
  parsePsOutput,
  parseWindowsProcessJson,
  resolveTarget,
  RestartError,
  runRestart,
} from '../scripts/restart.mjs';

/** Collects everything runRestart does, with nothing reaching the real system. */
function harness(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const deps = {
    argv: [],
    env: {},
    log: (msg: string) => calls.push(`log ${msg}`),
    logError: (msg: string) => calls.push(`err ${msg}`),
    findPids: () => [],
    alive: () => false,
    kill: (pid: number, opts: { force: boolean }) => {
      calls.push(`kill ${pid} ${opts.force ? 'force' : 'graceful'}`);
      return true;
    },
    build: () => {
      calls.push('build');
      return true;
    },
    portFree: () => Promise.resolve(true),
    portHolder: () => null,
    start: () => {
      calls.push('start');
      return 0;
    },
    wait: () => Promise.resolve(),
    ...overrides,
  };
  return { calls, run: () => runRestart(deps as never) };
}

describe('parseArgs', () => {
  it('defaults to building', () => {
    expect(parseArgs([])).toEqual({ doBuild: true });
  });

  it('accepts --no-build', () => {
    expect(parseArgs(['--no-build'])).toEqual({ doBuild: false });
  });

  it('rejects unknown arguments with exit code 2', () => {
    expect(() => parseArgs(['--port', '47899'])).toThrow(RestartError);
    try {
      parseArgs(['--port']);
    } catch (err) {
      expect((err as RestartError).exitCode).toBe(2);
    }
  });
});

describe('resolveTarget', () => {
  it('falls back to the defaults in src/node.ts', () => {
    expect(resolveTarget({})).toEqual({ port: 47821, host: '127.0.0.1' });
  });

  it('honours PORT and HOST', () => {
    expect(resolveTarget({ PORT: '47899', HOST: '0.0.0.0' })).toEqual({
      port: 47899,
      host: '0.0.0.0',
    });
  });

  it('rejects a non-numeric or out-of-range PORT', () => {
    // Also guards the PowerShell snippet in describePortHolder, which
    // interpolates the port into a command string.
    expect(() => resolveTarget({ PORT: 'not-a-port' })).toThrow(RestartError);
    expect(() => resolveTarget({ PORT: '70000' })).toThrow(RestartError);
    expect(() => resolveTarget({ PORT: '0' })).toThrow(RestartError);
  });
});

describe('process matching', () => {
  it('matches proxy command lines with either path separator', () => {
    expect(matchesProxyCommand('node /home/u/pxpipe/bin/cli.js')).toBe(true);
    expect(
      matchesProxyCommand('"C:\\Program Files\\nodejs\\node.exe" "D:\\pxpipe\\bin\\cli.js"'),
    ).toBe(true);
  });

  it('matches a relative entry path, which is how the proxy is actually launched', () => {
    // Observed on Windows: the proxy is spawned from the repo root, so its
    // command line carries no separator before `bin`.
    expect(matchesProxyCommand('"C:\\Program Files\\nodejs\\node.exe" bin/cli.js')).toBe(true);
    expect(matchesProxyCommand('node bin\\cli.js')).toBe(true);
  });

  it('ignores unrelated node processes, including this script', () => {
    expect(matchesProxyCommand('node scripts/restart.mjs')).toBe(false);
    expect(matchesProxyCommand('node scripts/build.mjs')).toBe(false);
    expect(matchesProxyCommand('python bin/cli.js')).toBe(false);
  });

  it('parses POSIX ps output', () => {
    const rows = parsePsOutput('  123 node /repo/bin/cli.js\n 4567 /usr/bin/vim notes.txt\n\n');
    expect(rows).toEqual([
      { pid: 123, command: 'node /repo/bin/cli.js' },
      { pid: 4567, command: '/usr/bin/vim notes.txt' },
    ]);
  });

  it('parses PowerShell JSON in both its array and bare-object shapes', () => {
    expect(parseWindowsProcessJson('')).toEqual([]);
    expect(parseWindowsProcessJson('{"ProcessId":12,"CommandLine":"node a.js"}')).toEqual([
      { pid: 12, command: 'node a.js' },
    ]);
    expect(
      parseWindowsProcessJson('[{"ProcessId":12,"CommandLine":null},{"ProcessId":13,"CommandLine":"x"}]'),
    ).toEqual([
      { pid: 12, command: '' },
      { pid: 13, command: 'x' },
    ]);
  });

  it('sorts PIDs and never returns our own process', () => {
    const pids = findProxyPids([
      { pid: 900, command: 'node /repo/bin/cli.js' },
      { pid: process.pid, command: 'node /repo/bin/cli.js' },
      { pid: 100, command: 'node /repo/bin/cli.js' },
      { pid: 200, command: 'node /repo/scripts/build.mjs' },
    ]);
    expect(pids).toEqual([100, 900]);
  });

  it('reads the real process table without throwing', () => {
    // Cross-platform smoke test: `ps` on POSIX, PowerShell on Windows. This
    // node process is running the test, so at least one node entry must exist
    // — an empty result means the platform branch is broken.
    const rows = listProcesses();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => Number.isInteger(r.pid))).toBe(true);
  });
});

describe('checkPortFree', () => {
  it('reports a free port as free and a bound one as taken', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;

    expect(await checkPortFree(port, '127.0.0.1')).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await checkPortFree(port, '127.0.0.1')).toBe(true);
  });
});

describe('runRestart', () => {
  it('builds and starts when no proxy is running', async () => {
    const { calls, run } = harness();
    expect(await run()).toBe(0);
    expect(calls).toContain('log [restart] no running proxy found');
    expect(calls).toContain('build');
    expect(calls).toContain('start');
    expect(calls.some((c) => c.startsWith('kill'))).toBe(false);
  });

  it('skips the build with --no-build', async () => {
    const { calls, run } = harness({ argv: ['--no-build'] });
    expect(await run()).toBe(0);
    expect(calls).not.toContain('build');
    expect(calls).toContain('start');
  });

  it('rejects unknown arguments without starting anything', async () => {
    const { calls, run } = harness({ argv: ['--no-build', '--port', '47899'] });
    expect(await run()).toBe(2);
    expect(calls).not.toContain('start');
    expect(calls).not.toContain('build');
  });

  it('aborts on build failure rather than starting a stale binary', async () => {
    const { calls, run } = harness({ build: () => false });
    expect(await run()).toBe(1);
    expect(calls).not.toContain('start');
  });

  it('aborts when the port is still held', async () => {
    const { calls, run } = harness({
      portFree: () => Promise.resolve(false),
      portHolder: () => 'PID 4242 some-other-tool',
    });
    expect(await run()).toBe(1);
    expect(calls).not.toContain('start');
    expect(calls.some((c) => c.includes('4242'))).toBe(true);
  });

  it('terminates gracefully and does not escalate when the proxy exits', async () => {
    const dead = new Set<number>();
    const { calls, run } = harness({
      findPids: () => [11, 22],
      alive: (pid: number) => !dead.has(pid),
      kill: (pid: number, opts: { force: boolean }) => {
        calls.push(`kill ${pid} ${opts.force ? 'force' : 'graceful'}`);
        if (!opts.force) dead.add(pid);
        return true;
      },
    });
    expect(await run()).toBe(0);
    expect(calls).toContain('kill 11 graceful');
    expect(calls).toContain('kill 22 graceful');
    expect(calls.some((c) => c.endsWith('force'))).toBe(false);
    expect(calls).toContain('start');
  });

  it('escalates to a forceful kill when the proxy ignores the request', async () => {
    const dead = new Set<number>();
    const { calls, run } = harness({
      findPids: () => [33],
      alive: (pid: number) => !dead.has(pid),
      kill: (pid: number, opts: { force: boolean }) => {
        calls.push(`kill ${pid} ${opts.force ? 'force' : 'graceful'}`);
        if (opts.force) dead.add(pid);
        return true;
      },
    });
    expect(await run()).toBe(0);
    expect(calls).toContain('kill 33 graceful');
    expect(calls).toContain('kill 33 force');
    expect(calls.some((c) => c.startsWith('err') && c.includes('33'))).toBe(true);
    expect(calls).toContain('start');
  });

  it('escalates without waiting when the graceful request cannot be delivered', async () => {
    // Windows console processes reject taskkill's WM_CLOSE. Waiting out the
    // full grace period for a shutdown that was never requested would add five
    // dead seconds to every restart on that platform.
    const dead = new Set<number>();
    let waits = 0;
    const { calls, run } = harness({
      findPids: () => [44],
      alive: (pid: number) => !dead.has(pid),
      kill: (pid: number, opts: { force: boolean }) => {
        calls.push(`kill ${pid} ${opts.force ? 'force' : 'graceful'}`);
        if (!opts.force) return false; // request refused
        dead.add(pid);
        return true;
      },
      wait: () => {
        waits += 1;
        return Promise.resolve();
      },
    });
    expect(await run()).toBe(0);
    expect(calls).toContain('kill 44 force');
    // Only the single settle-wait after the forceful kill, no grace polling.
    expect(waits).toBe(1);
    expect(calls).toContain('start');
  });

  it('propagates the proxy exit code', async () => {
    const { run } = harness({ start: () => 42 });
    expect(await run()).toBe(42);
  });
});
