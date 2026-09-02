/**
 * `pxpipe warp -- <agent-command>`
 *
 * Runs the agent behind a CONNECT proxy that decrypts api.anthropic.com and
 * re-points only /v1/messages at the local pxpipe proxy. The agent never sees a
 * custom ANTHROPIC_BASE_URL, so the client-side "firstParty" checks that hide
 * /remote-control (and disable claude.ai connectors) still pass, while pxpipe
 * gets the one path it transforms.
 *
 * Compare the manual equivalent, which needs two extra tools and a CA trusted
 * process-wide:
 *
 *   mitmdump --map-remote '|^https://api\.anthropic\.com/v1/messages|http://127.0.0.1:47821/v1/messages'
 *   HTTPS_PROXY=http://127.0.0.1:8080 NODE_EXTRA_CA_CERTS=~/.mitmproxy/mitmproxy-ca-cert.pem claude
 */

import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CertificateAuthority } from './ca.js';
import { createWarpHandlers } from './connect.js';
import { parseRoute, routeDestination, type Route } from './route.js';

export interface WarpRuntimeOptions {
  /** Port the pxpipe proxy is already serving on: where matches are sent. */
  port: number;
  /**
   * Extra PATTERN=TARGET rules, in priority order ahead of the default
   * Anthropic rule. Agents that reach their provider over a base URL rather
   * than api.anthropic.com (codex, opencode) need one rule each.
   */
  routes?: readonly string[];
}

export interface WarpRuntime {
  /** Bind the child's proxy port, then spawn the child. */
  launch: (command: string[]) => void;
}

/**
 * Only the inference path is diverted. Everything else on the host — OAuth,
 * telemetry, the control plane — is re-originated untouched, which is what
 * keeps the agent's client-side gates satisfied.
 */
function defaultRoutes(port: number): Route[] {
  return [
    parseRoute(`api.anthropic.com/v1/messages*=http://127.0.0.1:${port}`),
    parseRoute(`daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent*=http://127.0.0.1:${port}`),
    parseRoute(`daily-cloudcode-pa.googleapis.com/v1internal:generateContent*=http://127.0.0.1:${port}`),
    parseRoute(`generativelanguage.googleapis.com/v1beta/models/*:streamGenerateContent*=http://127.0.0.1:${port}`),
    parseRoute(`generativelanguage.googleapis.com/v1beta/models/*:generateContent*=http://127.0.0.1:${port}`),
    parseRoute(`generativelanguage.googleapis.com/v1/models/*:streamGenerateContent*=http://127.0.0.1:${port}`),
    parseRoute(`generativelanguage.googleapis.com/v1/models/*:generateContent*=http://127.0.0.1:${port}`),
  ];
}

export function createWarpRuntime(options: WarpRuntimeOptions): WarpRuntime {
  const { port } = options;
  // Explicit rules first: an operator route for a specific host:port must win
  // over anything built in.
  const routes = [
    ...(options.routes ?? []).map((spec) => parseRoute(spec)),
    ...defaultRoutes(port),
  ];
  const ca = CertificateAuthority.loadOrCreate(join(homedir(), '.pxpipe'));

  const handlers = createWarpHandlers({
    routes,
    ca,
    // The child inherits this terminal and Claude Code draws a full-screen TUI
    // over it, so anything written after the child starts corrupts the display.
    // Keep the line when stdout is redirected (piping, CI, debugging); stay
    // silent when a human is looking at the agent. events.jsonl records the
    // request either way.
    onDivert: (host, path, target) => {
      if (!process.stdout.isTTY) console.error(`[pxpipe] warp: ${host}${path} → ${target}`);
    },
  });

  // warp's own listener, and the only reason a port is involved at all: the
  // child is configured through HTTPS_PROXY, which can only name a host:port.
  // The kernel picks it, nothing else needs to know it, so there is nothing to
  // collide with a pxpipe already running.
  const proxy = createServer(handlers.handleAbsoluteForm);
  proxy.on('connect', handlers.handleConnect);

  /**
   * Does the user's interactive shell consider this word an alias? Both zsh
   * ("cc is an alias for ...") and bash ("cc is aliased to ...") answer through
   * `type`, and only an interactive shell has sourced the rc file that defines
   * one. Costs a single shell start at launch.
   */
  const shellAliasTarget = (name: string, shell: string, env: NodeJS.ProcessEnv): string | null => {
    if (name.includes('/')) return null;
    const probe = spawnSync(shell, ['-ic', `type -- ${name}`], { encoding: 'utf8', env });
    const match = /\bis (?:an alias for|aliased to)\s+(.+)$/m.exec(probe.stdout ?? '');
    if (!match) return null;
    // bash wraps the expansion in `backtick quote'; zsh leaves it bare.
    return match[1]!.trim().replace(/^`/, '').replace(/'$/, '');
  };

  /** Minimal `which`: is this bare name an executable on PATH? */
  const whichSync = (name: string, env: NodeJS.ProcessEnv): boolean => {
    if (name.includes('/')) return false; // a path, already handled by existsSync
    for (const dir of (env.PATH ?? '').split(':')) {
      if (!dir) continue;
      try {
        accessSync(join(dir, name), constants.X_OK);
        return true;
      } catch {
        // not here, keep looking
      }
    }
    return false;
  };

  /** Can this word actually be executed: a path that exists, or a name on PATH. */
  const isRunnable = (word: string, env: NodeJS.ProcessEnv): boolean =>
    word.includes('/') ? existsSync(word) : whichSync(word, env);

  /** POSIX single-quote: safe for anything except a single quote itself. */
  const shellQuote = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;

  /**
   * Run the child, falling back to the user's interactive shell when the
   * command is not an executable on PATH.
   *
   * spawn() is execvp, which only knows files. An alias like `cc` exists solely
   * inside an interactive zsh, and `sh -c` will not find it either: aliases come
   * from ~/.zshrc, which only an *interactive* shell sources. So the fallback is
   * `$SHELL -ic`, which loads the rc file and expands the alias — including any
   * env assignments baked into it, which no PATH lookup could have carried.
   *
   * Direct spawn stays the fast path: the shell is only involved when execvp
   * would have failed outright.
   */
  const spawnResolved = (command: string[], env: NodeJS.ProcessEnv) => {
    const direct = { stdio: 'inherit', env } as const;
    const shell = env.SHELL || '/bin/sh';
    // An alias can shadow a real binary: `cc` is Apple clang on PATH and a
    // Claude Code alias in the user's zsh, so PATH alone would silently run
    // the wrong program. Ask the interactive shell what the word means first.
    const alias = shellAliasTarget(command[0]!, shell, env);
    // But a stale alias must not shadow a working binary either. An alias
    // pointing at an uninstalled path (`claude` -> /opt/homebrew/bin/claude
    // after a move to a node-managed install) would otherwise fail the launch
    // outright, with a real claude sitting on PATH. An env-assignment prefix
    // (`FOO=1 claude`) is unverifiable, so it is taken at its word.
    const aliasWord = alias?.split(/\s+/)[0] ?? '';
    const aliasUsable = alias !== null && (aliasWord.includes('=') || isRunnable(aliasWord, env));
    if (alias !== null && !aliasUsable) {
      console.error(`[pxpipe] warp: ignoring stale alias ${command[0]} → ${aliasWord} (not executable)`);
    }
    if (!aliasUsable && isRunnable(command[0]!, env)) {
      return spawn(command[0]!, command.slice(1), direct);
    }
    console.error(`[pxpipe] warp: resolving ${command[0]} via interactive shell fallback`);
    // The command word is deliberately left unquoted: a shell only expands
    // aliases on unquoted words, so quoting it would defeat the entire point of
    // this fallback. Arguments are still quoted — they are data, never aliases.
    const script = [command[0]!, ...command.slice(1).map(shellQuote)].join(' ');
    return spawn(shell, ['-ic', script], direct);
  };

  const spawnChild = (command: string[], proxyUrl: string): void => {
    const env = { ...process.env };
    // The agent must believe it is talking to api.anthropic.com. Both of these
    // would defeat that, and either may be left over in the user's shell from a
    // previous non-warp session.
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_UNIX_SOCKET;
    env.HTTP_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.https_proxy = proxyUrl;
    // Trust is scoped to this child; nothing is added to the system keychain.
    // Which variable actually works depends on the agent's runtime, and the
    // answer is not stable: the macOS `claude` is a native Mach-O binary, not a
    // Node script, so the Node-only variable alone would silently fail to make
    // it trust us. Set every convention — they are inert for runtimes that
    // ignore them, and one of them is the one that counts.
    // NODE_EXTRA_CA_CERTS appends to Node's built-in roots, so the CA-only
    // file is right there. The other three REPLACE the trust store: handing
    // them a 1-cert file strips the public roots from every other HTTPS client
    // in the session (gcloud, gws, pip all fail verification — #245). They get
    // the bundle: our CA followed by the system roots.
    env.NODE_EXTRA_CA_CERTS = ca.certPath; // Node, and Bun-compiled binaries
    env.SSL_CERT_FILE = ca.bundlePath; // OpenSSL: curl, Rust, Go with cgo
    env.CURL_CA_BUNDLE = ca.bundlePath; // libcurl
    env.REQUESTS_CA_BUNDLE = ca.bundlePath; // Python requests / httpx

    const child = spawnResolved(command, env);
    // The child's proxy and CA point at this process. If warp dies for any
    // reason the child is reparented to init and keeps running against a closed
    // port, so every request fails and the agent looks hung instead of exiting.
    // Take it with us on every exit path, including a crash.
    let childLive = true;
    child.on('exit', () => {
      childLive = false;
    });
    process.on('exit', () => {
      if (childLive) child.kill('SIGTERM');
    });
    // A connection dying is not a warp failure. The upstream resets, the proxy
    // gets restarted, a keep-alive socket goes away between requests — all of
    // that arrives here as an errno on a socket nobody was listening to at that
    // instant. Exiting on it would take the agent down with us (see the exit
    // handler above) and lose a whole run to one dropped TCP connection. Log
    // and keep serving; the request that owned the socket fails on its own and
    // the agent retries. Anything without an errno is a real bug in our code,
    // and staying up for that would leave the agent talking to a proxy in an
    // unknown state, so those still exit.
    const NET_ERRNO = new Set([
      'ECONNRESET',
      'ECONNREFUSED',
      'ECONNABORTED',
      'EPIPE',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ENETDOWN',
      'ENOTCONN',
      'EAI_AGAIN',
      'ERR_STREAM_DESTROYED',
      'ERR_STREAM_WRITE_AFTER_END',
      'ERR_SOCKET_CONNECTION_TIMEOUT',
    ]);
    const die = (err: unknown): void => {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (typeof code === 'string' && NET_ERRNO.has(code)) {
        console.error(`[pxpipe] warp: connection error ${code} (continuing)`);
        return;
      }
      console.error(`[pxpipe] warp: ${err instanceof Error ? err.stack : String(err)}`);
      process.exit(1);
    };
    process.on('uncaughtException', die);
    process.on('unhandledRejection', die);
    child.on('error', (err) => {
      console.error(`[pxpipe] warp: cannot run ${command[0]}: ${err.message}`);
      process.exit(127);
    });
    // SIGHUP and SIGQUIT matter as much as the interactive two: closing the
    // terminal sends SIGHUP, and without forwarding it the agent survives with
    // its proxy pointed at a port that is about to close.
    const forwarded = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;
    child.on('exit', (code, signal) => {
      // Reproduce the child's own exit status so warp is transparent to callers.
      // Re-raising means routing the signal back through our own handlers, so
      // drop them first: Ctrl-C kills the child with SIGINT, and without this
      // the re-raise just re-enters the forwarder, kills an already-dead child
      // and leaves warp running forever.
      if (signal) {
        for (const s of forwarded) process.removeAllListeners(s);
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 0);
    });
    for (const signal of forwarded) {
      process.on(signal, () => child.kill(signal));
    }
  };

  const launch = (command: string[]): void => {
    if (command.length === 0) {
      console.error('[pxpipe] warp: nothing to run — usage: pxpipe warp -- <command> [args...]');
      process.exit(2);
    }
    // Startup banner goes to stderr: stdout belongs to the child, so a caller
    // piping the agent's output gets the agent's bytes and nothing of ours.
    for (const route of routes) {
      console.error(`[pxpipe] warp route → ${route.pattern} → ${routeDestination(route)}`);
    }
    console.error(`[pxpipe] warp CA → ${ca.certPath}`);
    if (ca.systemRootsPath) {
      console.error(`[pxpipe] warp CA bundle → ${ca.bundlePath} (+ system roots from ${ca.systemRootsPath})`);
    } else {
      console.error(
        `[pxpipe] warp CA bundle → ${ca.bundlePath} (no system root bundle found; ` +
          `non-pxpipe HTTPS in the child may fail verification — set SSL_CERT_FILE to your OS bundle before warp)`,
      );
    }
    console.error(`[pxpipe] warp exec → ${command.join(' ')}`);

    proxy.on('error', (err) => {
      console.error(`[pxpipe] warp: proxy listener failed: ${err.message}`);
      process.exit(1);
    });
    proxy.listen(0, '127.0.0.1', () => {
      const address = proxy.address();
      const proxyUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      console.error(`[pxpipe] warp proxy → ${proxyUrl} (child only)`);
      spawnChild(command, proxyUrl);
    });
  };

  return { launch };
}
