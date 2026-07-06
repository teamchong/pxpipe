#!/usr/bin/env node
// Cross-platform start/stop/toggle for the local pxpipe proxy.
//
// Unlike scripts/restart.sh (bash + pgrep/lsof, POSIX-only, restart-only),
// this runs anywhere Node does — including Windows Git Bash / PowerShell — and
// tracks the process by a pidfile instead of scanning the process table.
//
// Usage:
//   node scripts/service.mjs [start|stop|restart|status|toggle]
//   (no argument defaults to `toggle`: start if down, stop if up)
//
// Honors PORT / HOST like the proxy itself. Logs go to ~/.pxpipe/pxpipe.log.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(repoRoot, 'dist', 'node.js');
const stateDir = path.join(homedir(), '.pxpipe');
const pidFile = path.join(stateDir, 'pxpipe.pid');
const logFile = path.join(stateDir, 'pxpipe.log');
const port = process.env.PORT || '47821';

function cleanPidFile() {
  rmSync(pidFile, { force: true });
}

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function readPidState() {
  if (!existsSync(pidFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pidFile, 'utf8'));
    if (
      parsed &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.entry === 'string' &&
      typeof parsed.repoRoot === 'string'
    ) {
      return parsed;
    }
  } catch {
    // Legacy/plain or corrupt pidfile. Do not trust it enough to signal a PID.
  }
  cleanPidFile();
  return null;
}

function processCommandLine(pid) {
  if (process.platform === 'win32') {
    const ps = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; ` +
          `if ($p -and $p.CommandLine) { ` +
          `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p.CommandLine)) ` +
          `}`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    return ps.status === 0 ? Buffer.from(ps.stdout.trim(), 'base64').toString('utf8') : '';
  }

  const procCmdline = `/proc/${pid}/cmdline`;
  if (existsSync(procCmdline)) {
    const raw = readFileSync(procCmdline, 'utf8').replace(/\0/g, ' ').trim();
    if (raw) return raw;
  }

  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return ps.status === 0 ? ps.stdout.trim() : '';
}

function commandMatchesEntry(command) {
  const normalize = (s) => {
    const out = s.replace(/\\/g, '/');
    return process.platform === 'win32' ? out.toLowerCase() : out;
  };
  return normalize(command).includes(normalize(entry));
}

// A pid is "alive" if signal 0 doesn't throw. Returns the pid or null.
function runningPid() {
  const state = readPidState();
  if (!state) return null;
  const { pid } = state;
  if (!samePath(state.entry, entry) || !samePath(state.repoRoot, repoRoot)) {
    cleanPidFile();
    return null;
  }
  try {
    process.kill(pid, 0);
  } catch {
    cleanPidFile(); // stale pidfile, clean it up
    return null;
  }
  if (!commandMatchesEntry(processCommandLine(pid))) {
    cleanPidFile();
    return null;
  }
  return pid;
}

function start() {
  const pid = runningPid();
  if (pid) {
    console.log(`[pxpipe] already running (pid ${pid}) → http://127.0.0.1:${port}/`);
    return;
  }
  if (!existsSync(entry)) {
    console.error(`[pxpipe] ${path.relative(repoRoot, entry)} missing — run \`pnpm run build\` first.`);
    process.exit(1);
  }
  mkdirSync(stateDir, { recursive: true });
  const out = openSync(logFile, 'a');
  const child = spawn(process.execPath, [entry], {
    cwd: repoRoot,
    env: process.env,
    detached: true, // survive this launcher exiting
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  writeFileSync(
    pidFile,
    JSON.stringify(
      {
        pid: child.pid,
        entry,
        repoRoot,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`[pxpipe] started (pid ${child.pid}) → http://127.0.0.1:${port}/`);
  console.log(`[pxpipe] logs: ${logFile}`);
}

function stop() {
  const pid = runningPid();
  if (!pid) {
    console.log('[pxpipe] not running');
    return;
  }
  try {
    process.kill(pid, 'SIGTERM'); // proxy flushes its tracker on SIGTERM
  } catch {
    /* already gone */
  }
  cleanPidFile();
  console.log(`[pxpipe] stopped (pid ${pid})`);
}

function status() {
  const pid = runningPid();
  if (pid) console.log(`[pxpipe] running (pid ${pid}) → http://127.0.0.1:${port}/`);
  else console.log('[pxpipe] stopped');
}

const cmd = (process.argv[2] || 'toggle').toLowerCase();
switch (cmd) {
  case 'start':
    start();
    break;
  case 'stop':
    stop();
    break;
  case 'restart':
    stop();
    start();
    break;
  case 'status':
    status();
    break;
  case 'toggle':
    if (runningPid()) stop();
    else start();
    break;
  default:
    console.error(`[pxpipe] unknown command: ${cmd}`);
    console.error('[pxpipe] usage: node scripts/service.mjs [start|stop|restart|status|toggle]');
    process.exit(2);
}
