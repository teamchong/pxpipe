#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  buildCodexCommandArgs,
  buildCodexEnvironment,
  parseCodexInvocation,
  resolveCodexPersistentProxy,
} from './core/codex.js';
import { resolveCodexModelSelection } from './core/codex-model.js';

const REFERENCE_MODEL = 'gpt-5.6-sol';

function readCodexConfig(env: NodeJS.ProcessEnv): string | undefined {
  const root = env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  try { return readFileSync(join(root, 'config.toml'), 'utf8'); }
  catch { return undefined; }
}

function launch(binary: string, args: string[], env: NodeJS.ProcessEnv): void {
  const child = spawn(binary, args, { stdio: 'inherit', env });
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) {
    const handler = (): void => { child.kill(signal); };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const cleanup = (): void => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  child.on('error', (error) => {
    cleanup();
    console.error(`[pxpipe] codex: cannot run ${binary}: ${error.message}`);
    process.exitCode = 127;
  });
  child.on('exit', (code, signal) => {
    cleanup();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 0;
  });
}

async function main(): Promise<void> {
  let invocation;
  try {
    invocation = parseCodexInvocation(process.argv.slice(2));
  } catch (error) {
    console.error(`[pxpipe] codex: ${(error as Error).message}`);
    process.exitCode = 2;
    return;
  }

  const directEnv = buildCodexEnvironment(process.env, 'direct');
  if (invocation.direct) {
    launch(invocation.binary, invocation.args, directEnv);
    return;
  }

  const proxy = await resolveCodexPersistentProxy(process.env);
  if (!proxy) {
    console.warn('[pxpipe] codex: persistent listener unavailable; launching Codex direct');
    launch(invocation.binary, invocation.args, directEnv);
    return;
  }

  const childEnv = buildCodexEnvironment(process.env, 'proxied');

  const selection = resolveCodexModelSelection(
    invocation.args,
    readCodexConfig(process.env),
    REFERENCE_MODEL,
  );
  // Do not inject the diagnostic reference fallback into Codex. If no user
  // model can be resolved, leave model selection to the installed Codex CLI.
  const resolvedModel = selection.source === 'reference' ? undefined : selection.model;
  const args = buildCodexCommandArgs(proxy.baseUrl, invocation.args, resolvedModel);
  console.error(`[pxpipe] codex → 127.0.0.1:${proxy.port} (native Responses route)`);
  launch(invocation.binary, args, childEnv);
}

void main();
