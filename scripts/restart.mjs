#!/usr/bin/env node
// Restart the local pxpipe proxy. Runs on Windows, macOS and Linux.
//
// What this does, in order:
//   1. Discover every running pxpipe proxy by scanning the process table for
//      a node process whose command line references `bin/cli.js`, and list
//      them. If multiple are running (orphans from a prior crashed session),
//      kill all of them — there's no "right" oldest in a graceful restart, we
//      want a clean slate.
//   2. Ask them to terminate. The proxy's SIGTERM handler flushes the JSONL
//      tracker and exits. Poll up to 5s for clean exit.
//   3. Anything still alive after 5s gets killed forcefully with a warning.
//   4. Rebuild unless --no-build is passed. Build errors abort the restart so
//      we never start a stale binary.
//   5. Check the target port is actually free; if not, name the process
//      holding it (with a hint for the user — common cause: another tool, or
//      step 3 didn't fully release).
//   6. Start a fresh proxy as a child with inherited stdio, and exit with the
//      child's status so Ctrl-C and exit codes behave like a plain `node
//      bin/cli.js`.
//
// Why Node and not shell: the previous scripts/restart.sh depended on bash,
// pgrep, lsof and ps, none of which exist on Windows. It also invoked `node`
// through PATH, which breaks under version managers (fnm/nvm) that only patch
// the interactive shell's PATH — the exact "exec: node: not found" failure
// this rewrite fixes. Here every external dependency is either replaced by a
// Node API (`net` for the port probe, `process.kill` for signalling) or has a
// per-platform implementation, and the interpreter is `process.execPath`, the
// absolute path of the node binary already running this script.
//
// Platform caveat: on Windows there is no true SIGTERM for an unrelated
// console process. We call `taskkill` without /F first, which is the closest
// graceful equivalent, then escalate to /F. In practice a console proxy always
// refuses the polite form, so on Windows the restart is effectively a hard
// kill. What that costs is small: FileTracker writes each event with
// fs.writeSync (see src/node.ts), so recorded events are already handed to the
// OS and survive — the shutdown handler only adds an fsync. What is lost is
// the orderly close of in-flight requests, so a streaming response running at
// that moment gets cut.
//
// Flags:
//   --no-build    Skip the rebuild step. Use when you know dist/ is fresh.
//
// Examples:
//   pnpm run restart
//   pnpm run restart -- --no-build
//   PORT=47899 pnpm run restart

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const IS_WINDOWS = process.platform === 'win32';
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_ENTRY = path.join(REPO_ROOT, 'bin', 'cli.js');
// Invoked directly rather than through `pnpm run build`: the package manager
// is not guaranteed to be on PATH in the environment that runs this script,
// and this is exactly what the `build` script in package.json expands to.
const BUILD_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build.mjs');

const DEFAULT_PORT = 47821;
const DEFAULT_HOST = '127.0.0.1';
const GRACE_MS = 5000;
const POLL_MS = 100;

/** Thrown for expected failures; `exitCode` becomes the process status. */
export class RestartError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'RestartError';
    this.exitCode = exitCode;
  }
}

// --- Flags ----------------------------------------------------------------
// --no-build only — pxpipe itself takes none.
export function parseArgs(argv) {
  let doBuild = true;
  for (const arg of argv) {
    if (arg === '--no-build') {
      doBuild = false;
      continue;
    }
    throw new RestartError(
      `unknown argument: ${arg}\n` +
        '[restart] this script only accepts --no-build (pxpipe takes no flags)',
      2,
    );
  }
  return { doBuild };
}

// --- Target endpoint ------------------------------------------------------
// Mirrors the defaults in src/node.ts so the port probe checks the address the
// proxy will actually bind.
export function resolveTarget(env = process.env) {
  const raw = env.PORT?.trim();
  let port = DEFAULT_PORT;
  if (raw) {
    port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new RestartError(`invalid PORT: ${raw} (expected an integer 1-65535)`, 2);
    }
  }
  return { port, host: env.HOST?.trim() || DEFAULT_HOST };
}

// --- 1. Process discovery -------------------------------------------------
// Matches `node … bin/cli.js`, with either path separator so the same rule
// works against a POSIX `ps` line and a Windows command line. The character
// class before `bin` accepts a quote or plain space as well as a separator:
// the proxy is normally launched with a *relative* entry path, so the real
// Windows command line reads `"C:\…\node.exe" bin/cli.js` with no leading
// separator at all.
const PROXY_COMMAND_RE = /\bnode(\.exe)?\b.*[\s"'\\/]bin[\\/]cli\.js\b/i;

export function matchesProxyCommand(commandLine) {
  return typeof commandLine === 'string' && PROXY_COMMAND_RE.test(commandLine);
}

/** Parse `ps -A -o pid=,args=` output into {pid, command} records. */
export function parsePsOutput(stdout) {
  const rows = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\S.*)$/);
    if (match) rows.push({ pid: Number(match[1]), command: match[2].trim() });
  }
  return rows;
}

/**
 * Parse `Get-CimInstance Win32_Process | ConvertTo-Json` output. PowerShell
 * emits a bare object rather than a one-element array for a single match, and
 * nothing at all for no matches, so both shapes are normalised here.
 */
export function parseWindowsProcessJson(stdout) {
  const text = stdout.trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((row) => row && Number.isInteger(Number(row.ProcessId)))
    .map((row) => ({
      pid: Number(row.ProcessId),
      command: typeof row.CommandLine === 'string' ? row.CommandLine : '',
    }));
}

/** Run a PowerShell snippet, trying Windows PowerShell then PowerShell 7+. */
function runPowerShell(script) {
  for (const exe of ['powershell.exe', 'pwsh.exe']) {
    const res = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (!res.error && res.status === 0) return res.stdout ?? '';
  }
  return null;
}

export function listProcesses() {
  if (IS_WINDOWS) {
    const out = runPowerShell(
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" " +
        '| Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
    );
    return out === null ? [] : parseWindowsProcessJson(out);
  }
  const res = spawnSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8' });
  if (res.error || res.status !== 0) return [];
  return parsePsOutput(res.stdout ?? '');
}

/** PIDs of running proxies, lowest first. Never includes our own process. */
export function findProxyPids(processes = listProcesses()) {
  return processes
    .filter((proc) => proc.pid !== process.pid && matchesProxyCommand(proc.command))
    .map((proc) => proc.pid)
    .sort((a, b) => a - b);
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return err?.code === 'EPERM';
  }
}

// --- 2/3. Termination -----------------------------------------------------
/**
 * Ask a process to stop. Returns false when the polite request could not even
 * be delivered, which tells the caller to escalate immediately instead of
 * waiting out the grace period for a shutdown that will never start.
 */
export function terminate(pid, { force = false } = {}) {
  if (IS_WINDOWS) {
    // process.kill() on Windows maps every signal to TerminateProcess, which
    // would skip the tracker flush even for the "graceful" attempt. taskkill
    // without /F is the closest thing to a polite request.
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    const res = spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
    // Without /F, taskkill posts WM_CLOSE — and reports failure outright for a
    // console process with no window ("can only be terminated forcefully").
    // A non-zero status means the proxy was never actually asked.
    return !res.error && res.status === 0;
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // Already gone between discovery and signalling — nothing to do.
  }
  return true;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- 5. Port probe --------------------------------------------------------
/** True if we can bind host:port right now. */
export function checkPortFree(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err) => {
      resolve(err.code !== 'EADDRINUSE' && err.code !== 'EACCES');
    });
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen({ port, host, exclusive: true });
  });
}

/** Best-effort description of whoever holds the port; null if we can't tell. */
export function describePortHolder(port) {
  // `port` is validated as an integer by resolveTarget() before reaching the
  // PowerShell string below.
  if (IS_WINDOWS) {
    const out = runPowerShell(
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue ` +
        '| ForEach-Object { $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; ' +
        '"PID $($_.OwningProcess) $($proc.ProcessName)" }',
    );
    return out?.trim() || null;
  }
  const res = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  if (res.error || res.status !== 0) return null;
  return res.stdout?.trim() || null;
}

// --- 4. Build -------------------------------------------------------------
export function runBuild() {
  const res = spawnSync(process.execPath, [BUILD_SCRIPT], { cwd: REPO_ROOT, stdio: 'inherit' });
  return !res.error && res.status === 0;
}

// --- 6. Start -------------------------------------------------------------
export function startProxy() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_ENTRY], { cwd: REPO_ROOT, stdio: 'inherit' });

    // Ctrl-C reaches the child directly through the shared console/process
    // group. Ignore it here so this wrapper outlives the child long enough for
    // the child's own handler to flush and report an exit status.
    const ignore = () => {};
    process.on('SIGINT', ignore);
    process.on('SIGTERM', ignore);
    const cleanup = () => {
      process.off('SIGINT', ignore);
      process.off('SIGTERM', ignore);
    };

    child.on('error', (err) => {
      cleanup();
      console.error(`[restart] ERROR: failed to start proxy: ${err.message}`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      cleanup();
      if (signal) resolve(128 + (os.constants.signals[signal] ?? 0));
      else resolve(code ?? 0);
    });
  });
}

// --- Orchestration --------------------------------------------------------
// Dependencies are injectable so the sequencing can be tested without touching
// the real process table, port or build.
export async function runRestart({
  argv = [],
  env = process.env,
  log = (msg) => console.log(msg),
  logError = (msg) => console.error(msg),
  findPids = findProxyPids,
  alive = isAlive,
  kill = terminate,
  build = runBuild,
  portFree = checkPortFree,
  portHolder = describePortHolder,
  start = startProxy,
  wait = sleep,
} = {}) {
  let doBuild;
  let port;
  let host;
  try {
    ({ doBuild } = parseArgs(argv));
    ({ port, host } = resolveTarget(env));
  } catch (err) {
    if (!(err instanceof RestartError)) throw err;
    logError(`[restart] ${err.message}`);
    return err.exitCode;
  }

  // --- 1. Discover running proxies ---
  const pids = findPids();
  if (pids.length > 0) {
    log(`[restart] found running pxpipe proxy PID(s): ${pids.join(' ')}`);

    // --- 2. Ask all of them to terminate ---
    const asked = [];
    const unreachable = [];
    for (const pid of pids) {
      if (!alive(pid)) continue;
      log(`[restart] asking ${pid} to shut down (drains in-flight requests, fsyncs the tracker)`);
      (kill(pid, { force: false }) ? asked : unreachable).push(pid);
    }

    // Poll up to GRACE_MS for graceful exit. Only processes that accepted the
    // request are worth waiting for.
    let stubborn = asked.filter(alive);
    for (let waited = 0; waited < GRACE_MS && stubborn.length > 0; waited += POLL_MS) {
      await wait(POLL_MS);
      stubborn = stubborn.filter(alive);
    }

    // --- 3. Escalate only if still alive ---
    const mustForce = [...unreachable.filter(alive), ...stubborn].sort((a, b) => a - b);
    if (mustForce.length > 0) {
      logError(
        '[restart] WARNING: killing forcefully, in-flight requests are cut: ' +
          mustForce.join(' '),
      );
      for (const pid of mustForce) kill(pid, { force: true });
      await wait(300);
    }
  } else {
    log('[restart] no running proxy found');
  }

  // --- 4. Rebuild (skippable) ---
  if (doBuild) {
    log('[restart] rebuilding…');
    if (!build()) {
      logError('[restart] ERROR: build failed. Not starting a stale binary.');
      return 1;
    }
  } else {
    log('[restart] --no-build: skipping rebuild (assuming dist/ is fresh)');
  }

  // --- 5. Sanity-check the target port is free ---
  if (!(await portFree(port, host))) {
    const holder = portHolder(port);
    logError(`[restart] ERROR: port ${port} on ${host} is still in use.`);
    if (holder) logError(`    ${holder.split('\n').join('\n    ')}`);
    logError("  Hint: if that's a pxpipe proxy our shutdown should have cleared,");
    logError('  it may have been started outside this repo. Free the port and rerun.');
    return 1;
  }

  // --- 6. Start fresh in the foreground ---
  log(`[restart] starting fresh proxy on ${host}:${port} (Ctrl-C to stop)`);
  return start();
}

// Only run when executed directly, so tests can import the helpers above.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await runRestart({ argv: process.argv.slice(2) });
}
