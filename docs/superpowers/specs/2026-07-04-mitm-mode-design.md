# pxpipe `mitm` mode — transparent Fable compression for Claude Desktop

**Date:** 2026-07-04
**Status:** Approved — implementing (branch `feat/mitm-mode`)
**Target:** upstream feature in `teamchong/pxpipe` (branch `feat/mitm-mode`)

## Problem

pxpipe intercepts by *swapping the base URL* (`ANTHROPIC_BASE_URL=http://127.0.0.1:47821`).
That works for the terminal `claude` CLI, but **Claude Desktop's embedded
claude-code cannot be routed this way**: Desktop injects
`ANTHROPIC_BASE_URL=https://api.anthropic.com` into the child process it spawns,
and Claude Code's `settings.json` `env` block only fills *unset* variables — it
cannot override one Desktop has already set. Users who work exclusively in
Desktop get no compression today.

## Key insight (measured, not assumed)

Desktop pins `ANTHROPIC_BASE_URL`, but leaves `HTTPS_PROXY`, `HTTP_PROXY`, and
`NODE_EXTRA_CA_CERTS` **unset**. Claude Code's `settings.json` `env` block *does*
apply to Desktop's claude-code for vars Desktop doesn't set (verified:
`ENABLE_TOOL_SEARCH` from that block reaches Desktop sessions). So we can inject
a proxy + trusted CA that Desktop's Node runtime will honor — without touching
the base URL.

### De-risk spike (2026-07-04) — the fatal risk is dead

Ran Desktop's exact env (`HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS`) against a
throwaway `mitmproxy` and drove the standalone CLI through it:

- **HTTPS_PROXY honored** — claude routed all HTTPS through the proxy.
- **No cert-pinning on `api.anthropic.com`** — mitmproxy decrypted the real
  inference call `POST https://api.anthropic.com/v1/messages?beta=true` (plus
  `bootstrap`, `oauth/account/settings`, `v1/mcp_servers`), all in plaintext.
- **OAuth survives the hop** — `claude -p` returned a real `200`.
- **Design constraint found for free:** routing *everything* through MITM broke
  a non-Node client — `api.github.com` failed with `unknown ca` (git/native
  TLS uses the system trust store, not `NODE_EXTRA_CA_CERTS`). Therefore the
  proxy **must MITM only `api.anthropic.com` and raw-tunnel every other host.**

## Goals

- Transparent ~60–70% Fable input-token reduction inside Claude Desktop, with
  no change to how the user uses Desktop.
- Reuse pxpipe's entire compression engine (transform, gate, cache-alignment,
  events, dashboard, kill switch) — the only new surface is the interception
  front-end.
- Survive Desktop / claude-code version updates (config + local proxy, never
  binary patching).
- Global scope: the same injection routes both Desktop **and** the terminal CLI
  through the MITM proxy.

## Non-goals

- Compressing anything that doesn't reach `api.anthropic.com/v1/messages`
  (system prompt/tool docs are static + prompt-cached anyway).
- Intercepting non-Anthropic traffic (explicitly tunneled untouched).
- Windows support in v1 (macOS/Linux; openssl assumed present).
- Changing the compression behavior itself (identical to base-URL mode).

## Architecture

pxpipe's core is already runtime-agnostic: `createProxy(config)` returns
`handle: (Request) => Promise<Response>`, and `src/node.ts` bridges a raw HTTP
socket to it via `toWebRequest → handle → writeWebResponse`. MITM mode swaps
*only* the front door — the socket source — and reuses everything behind it.

```
Desktop claude-code (Fable)
  │  HTTPS_PROXY → CONNECT <host>:443
  ▼
pxpipe mitm listener (127.0.0.1:47821)
  ├─ host !== api.anthropic.com ──► net.connect + raw pipe  (git/npm/mcp untouched)
  └─ host === api.anthropic.com:
        reply "200 Connection Established"
        wrap client socket in tls.TLSSocket  (our api.anthropic.com leaf,
                                               ALPN forced to http/1.1)
        http.Server.emit('connection', tlsSocket)   ← SAME handler as node.ts
           │  (dashboard routes, then handle(webReq))
           ▼
        handle() → transformAnthropicMessages (Fable-only, gated) → forward to
        real https://api.anthropic.com → stream response back (never modified)
```

The request the decrypted `http.Server` sees has `Host: api.anthropic.com` and
`url = /v1/messages?beta=true`; `handle()` forwards to `config.upstream`
(`https://api.anthropic.com`, unchanged) using that path. Transform touches the
**request only**; the streamed SSE response is piped through untouched, exactly
as today.

## Components

### 1. CA manager (`src/core/mitm-ca.ts`, new — small)
- On first run, generate a local root CA (key + self-signed cert) and an
  `api.anthropic.com` leaf (SAN `DNS:api.anthropic.com`) signed by it. Store
  under `~/.pxpipe/mitm/` at `0600`; CA valid ~1 year, leaf regenerated as
  needed.
- Generation shells out to `openssl` (already present; MITM mode is inherently
  Node/local-only, so no new runtime dependency — consistent with pxpipe's
  "pure-JS runtime, canvas is build-time only" ethos). Fallback: `node-forge`
  only if openssl is absent.
- Expose the CA cert path (for `NODE_EXTRA_CA_CERTS` injection) and the leaf
  cert+key (for the TLS server).

### 2. Selective MITM front-end (`src/core/mitm.ts`, new — the core work)
- `net.Server` on `host:port`; handle the `connect` event (HTTP CONNECT).
- `host === 'api.anthropic.com'` → 200, wrap socket in `tls.TLSSocket`
  (`{ key, cert, ALPNProtocols: ['http/1.1'] }`), hand to the shared
  `http.Server` via `emit('connection', ...)`.
- any other host → `net.connect(port, host)` + bidirectional `pipe` (raw
  tunnel, no interception, no cert needed for those hosts).
- Also accept plain (non-CONNECT) requests to the port so the dashboard at
  `http://127.0.0.1:47821/` keeps working unchanged.

### 3. Server-setup reuse (`src/node.ts`, refactor)
- Extract the tracker + dashboard + `ProxyConfig` + `createServer` request
  handler from `main()` into a shared `startProxyServer(opts)` so both the
  default base-URL mode and the new MITM mode use the identical handler,
  events pipeline, and dashboard. MITM mode calls it to get the request
  handler, then front-ends it with the CONNECT listener.

### 4. CLI + installer (`bin/cli.js` / `src/node.ts`, follows the `export`
   subcommand pattern)
- `pxpipe mitm` — run the proxy in MITM mode (generates CA on first run; prints
  the CA path and the exact `settings.json` `env` block + launchd snippet to
  add).
- `pxpipe mitm install` — idempotent: back up and patch `~/.claude/settings.json`
  `env` with `HTTPS_PROXY`, `HTTP_PROXY`, `NODE_EXTRA_CA_CERTS`; install a
  launchd agent (mirrors the user's existing `com.akhilesh.pxpipe.plist`,
  `KeepAlive`).
- `pxpipe mitm uninstall` — revert settings.json from backup, remove the agent.
- `pxpipe mitm doctor` — check proxy up, CA present + injected, port bound.

### 5. Activation (config, global scope)
`~/.claude/settings.json` `env`:
```json
{ "env": {
    "HTTPS_PROXY": "http://127.0.0.1:47821",
    "HTTP_PROXY": "http://127.0.0.1:47821",
    "NODE_EXTRA_CA_CERTS": "/Users/<you>/.pxpipe/mitm/ca.crt"
} }
```
Desktop leaves these unset, so they apply to both Desktop and CLI sessions.

## Security model

- Loopback only (`127.0.0.1`), same as the existing proxy.
- Our CA signs **one** host (`api.anthropic.com`); no other traffic is
  decrypted, so a compromise of our CA can only impersonate that one host to
  *this* machine's Node clients.
- MITM decrypts the request, so the OAuth bearer token is visible to the proxy
  in plaintext. It is forwarded as-is and stored nowhere. Document this
  explicitly; it is the inherent cost of request-body compression.
- `install` writes the CA into `NODE_EXTRA_CA_CERTS` (Node trust) only — it does
  **not** add the CA to the system keychain, limiting blast radius.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| claude-code negotiates HTTP/2 to Anthropic | Force `ALPNProtocols: ['http/1.1']` on our TLS server → client downgrades. undici defaults to h1.1 anyway. |
| Streaming (SSE) responses | Response is piped through untouched; transform only ever touches the request (unchanged from base-URL mode). |
| Non-Node clients break (git → github) | MITM **only** `api.anthropic.com`; raw-tunnel all other hosts (the spike lesson). |
| Proxy down → Desktop can't reach the API | launchd `KeepAlive`; `pxpipe mitm doctor`; one-command `uninstall`. |
| Desktop/claude-code updates | Injection is Claude Code config + a local proxy — independent of Desktop internals; no binary patching. |
| Upstream cert rotation | We validate the *real* upstream cert with Node's default trust; no pinning on our side. |

## Testing

- **Integration (the gate):** automate the spike — start `pxpipe mitm` on a
  test port with a temp CA, run `claude -p` (standalone CLI) through it with
  `HTTPS_PROXY`+`NODE_EXTRA_CA_CERTS`, assert (a) `200`, (b) a compressed
  `/v1/messages` event in the events log, (c) a non-anthropic host still
  tunnels (a raw `https` GET to a second host succeeds — proves selective
  interception).
- **Unit:** CA/leaf generation (valid chain, correct SAN); CONNECT routing
  (api.anthropic.com → MITM, other → tunnel); reuse pxpipe's existing transform
  unit tests unchanged.
- **Fidelity:** reuse pxpipe's eval harness / dashboard — a Fable Desktop
  session shows compressed events and correct answers.

## Rollout

1. Ship `pxpipe mitm` + `install`/`uninstall`/`doctor`.
2. User runs `pxpipe mitm install`, fully restarts Desktop, verifies the
   dashboard shows compressed Fable events.
3. Document the OAuth-decryption tradeoff and the uninstall path in the README.

## Resolved decisions

- **Cert generation:** shell out to `openssl` (already present; no new runtime
  dependency, consistent with pxpipe's pure-JS-runtime ethos). `node-forge`
  fallback only if openssl is absent.
- **CLI/Desktop coexistence:** global injection, a **single MITM proxy** for
  both Desktop and CLI. The old base-URL `com.akhilesh.pxpipe` agent is retired
  by `pxpipe mitm install` (documented; reversible via `uninstall`).
- **Activation surface:** `pxpipe mitm` subcommand (matches the existing
  `export` subcommand), not an env flag.
- **Requirement:** must work across **all** Claude Desktop app chats (global
  scope, confirmed by the user).
