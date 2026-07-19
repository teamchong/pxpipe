#!/usr/bin/env node
// Restart the local pxpipe proxy — cross-platform (Windows / macOS / Linux).
//
// Replaces the old scripts/restart.sh: bash on Windows (git-bash spawned by
// pnpm) doesn't inherit node on PATH and chokes on CRLF checkouts, so the
// restart logic now runs on the same Node that runs pnpm (process.execPath).
//
// What this does, in order:
//   1. Discover every running pxpipe proxy (command line matching bin/cli.js)
//      via `pgrep` on POSIX or Win32_Process on Windows. If multiple are
//      running (orphans from a prior crashed session), kill all of them —
//      there's no "right" oldest in a graceful restart, we want a clean slate.
//   2. Send SIGTERM. The proxy's SIGTERM handler flushes the JSONL tracker
//      and exits. Poll up to 5s for clean exit.
//      NOTE: on Windows, process.kill(pid, 'SIGTERM') is a hard terminate
//      (no signal handlers run) — tracker flush relies on the proxy's
//      periodic flush there.
//   3. Anything still alive after 5s gets SIGKILL with a warning.
//   4. Rebuild (`pnpm run build`) unless --no-build is passed. Build errors
//      abort the restart so we never start a stale binary.
//   5. Check the target port is actually free by binding it briefly —
//      cross-platform, no lsof needed.
//   6. Start a fresh proxy (`node bin/cli.js`) in the foreground with
//      inherited stdio; Ctrl-C is forwarded to the child.
//
// Flags:
//   --no-build    Skip the rebuild step. Use when you know dist/ is fresh.
//
// Examples:
//   pnpm run restart
//   pnpm run restart -- --no-build
//   PORT=47899 pnpm run restart

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const IS_WIN = process.platform === 'win32';
const log = (msg) => console.log(`[restart] ${msg}`);
const fail = (msg, code = 1) => {
  console.error(`[restart] ${msg}`);
  process.exit(code);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Parse our own flags. --no-build only — pxpipe takes none. -------------
// pnpm forwards a literal "--" when invoked as `pnpm run restart -- …`; skip it.
let doBuild = true;
for (const arg of process.argv.slice(2)) {
  if (arg === '--') continue;
  if (arg === '--no-build') {
    doBuild = false;
    continue;
  }
  console.error(`[restart] unknown argument: ${arg}`);
  fail('this script only accepts --no-build (pxpipe takes no flags)', 2);
}

// --- Figure out which port the new proxy will bind. PORT env var or 47821.
const TARGET_PORT = Number(process.env.PORT || 47821);

// --- 1. Discover running proxies -------------------------------------------
function discoverPids() {
  if (IS_WIN) {
    // Win32_Process gives us full command lines; match node processes
    // running bin/cli.js (either slash direction).
    const ps = [
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\"",
      "Where-Object { $_.CommandLine -match 'bin[\\\\/]cli\\.js' }",
      'ForEach-Object { $_.ProcessId }',
    ].join(' | ');
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8',
      });
      return out.split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    } catch {
      return [];
    }
  }
  // POSIX. `[c]li.js` keeps pgrep from matching itself.
  try {
    const out = execFileSync('pgrep', ['-f', 'node.*bin/[c]li\\.js'], { encoding: 'utf8' });
    return out.split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return []; // pgrep exits 1 on no match
  }
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const pids = discoverPids()
  .filter((pid) => pid !== process.pid)
  .sort((a, b) => a - b);

if (pids.length > 0) {
  log(`found running pxpipe proxy PID(s): ${pids.join(' ')}`);

  // --- 2. SIGTERM all of them (hard terminate on Windows, see header) ---
  for (const pid of pids) {
    if (!isAlive(pid)) continue;
    log(`SIGTERM ${pid} (graceful — tracker flushes on shutdown)`);
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }

  // Poll up to 5s for graceful exit.
  for (let i = 0; i < 50; i++) {
    if (!pids.some(isAlive)) break;
    await sleep(100);
  }

  // --- 3. Escalate to SIGKILL only if still alive ---
  const still = pids.filter(isAlive);
  if (still.length > 0) {
    log(`WARNING: PID(s) still alive after 5s, escalating to SIGKILL: ${still.join(' ')}`);
    for (const pid of still) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    await sleep(300);
  }
} else {
  log('no running proxy found');
}

// --- 4. Rebuild (skippable) -------------------------------------------------
if (doBuild) {
  log('rebuilding…');
  // The build script is plain Node — run it directly, no pnpm/PATH needed.
  const res = spawnSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
  if (res.status !== 0) fail('ERROR: build failed. Not starting a stale binary.');
} else {
  log('--no-build: skipping rebuild (assuming dist/ is fresh)');
}

// --- 5. Sanity-check the target port is free --------------------------------
// Bind it briefly instead of shelling out to lsof/netstat: works everywhere.
await new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[restart] ERROR: port ${TARGET_PORT} is still in use.`);
      console.error('  Hint: if that\'s a pxpipe proxy our SIGTERM should have cleared,');
      console.error('  it may have been started outside this repo. Free the port and rerun.');
      console.error(
        IS_WIN
          ? `  To find the holder: netstat -ano | findstr :${TARGET_PORT}`
          : `  To find the holder: lsof -nP -iTCP:${TARGET_PORT} -sTCP:LISTEN`,
      );
      process.exit(1);
    }
    resolve(); // unexpected probe error — let the proxy surface the real one
  });
  probe.once('listening', () => probe.close(resolve));
  probe.listen(TARGET_PORT, '127.0.0.1');
});

// --- 6. Start fresh in the foreground with inherited stdio. -----------------
// process.execPath = the node running this script — no PATH lookup, works
// even when pnpm spawns us without node on PATH (the git-bash failure mode).
log(`starting fresh proxy on :${TARGET_PORT} (Ctrl-C to stop)`);
const child = spawn(process.execPath, ['bin/cli.js'], { stdio: 'inherit' });

// Forward termination to the child so Ctrl-C / kill behave like `exec` did.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      /* child already gone */
    }
  });
}
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
