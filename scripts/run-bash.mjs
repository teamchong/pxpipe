// Cross-platform launcher for our bash scripts (restart.sh, restart.test.sh).
//
// Why this exists: on Windows, `bash scripts/restart.sh` resolves `bash`
// through the plain PATH lookup that `pnpm`/`cmd.exe` performs, and machines
// with WSL installed put `C:\Windows\System32\bash.exe` (the WSL launcher)
// ahead of Git Bash's `bash.exe` in PATH. WSL is a separate Linux VM with its
// own filesystem — Windows' Node.js install isn't on its PATH — so scripts
// that end in `exec node ...` fail with "node: not found" even though Node
// works fine everywhere else. Git Bash, unlike WSL, shares the Windows PATH
// (translated to POSIX form), so it can see the real `node`.
//
// This wrapper finds the actual Git Bash executable and invokes it directly,
// sidestepping PATH ordering entirely. On non-Windows platforms it just runs
// `bash` as normal.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';

const [, , scriptPath, ...scriptArgs] = process.argv;
if (!scriptPath) {
  console.error('usage: node scripts/run-bash.mjs <script.sh> [args...]');
  process.exit(2);
}

function resolveWindowsBash() {
  if (process.env.PXPIPE_BASH && existsSync(process.env.PXPIPE_BASH)) {
    return process.env.PXPIPE_BASH;
  }

  // Ask Git itself where it's installed, then derive bash.exe from that —
  // works regardless of where the user installed Git for Windows.
  const gitExecPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (gitExecPath.status === 0 && gitExecPath.stdout.trim()) {
    // .../Git/mingw64/libexec/git-core -> .../Git/bin/bash.exe
    const root = gitExecPath.stdout.trim().replace(/[\\/](mingw64|mingw32)[\\/]libexec[\\/]git-core[\\/]?$/, '');
    const candidate = `${root}/bin/bash.exe`;
    if (existsSync(candidate)) return candidate;
  }

  // Fall back to scanning PATH, skipping WSL's launcher stubs (System32 and
  // the WindowsApps app-execution alias) so we never pick those by accident.
  const pathDirs = (process.env.PATH ?? '').split(delimiter);
  for (const dir of pathDirs) {
    if (/system32|windowsapps/i.test(dir)) continue;
    const candidate = `${dir}\\bash.exe`;
    if (existsSync(candidate)) return candidate;
  }

  // Last resort: the default Git for Windows install locations.
  for (const candidate of [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ]) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

const bashPath = process.platform === 'win32' ? resolveWindowsBash() : 'bash';
if (!bashPath) {
  console.error(
    '[run-bash] could not find Git Bash. Install Git for Windows, or set ' +
      'PXPIPE_BASH to the full path of bash.exe.',
  );
  process.exit(1);
}

const child = spawn(bashPath, [scriptPath, ...scriptArgs], { stdio: 'inherit' });
// Relay Ctrl-C / termination to the child rather than exiting out from under it.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
child.on('error', (err) => {
  console.error(`[run-bash] failed to launch ${bashPath}: ${err.message}`);
  process.exit(1);
});
