# Codex integration

PXPipe can launch Codex through the existing persistent loopback listener without
rewriting Codex authentication files or replacing the native Responses API.

```bash
pxpipe codex
pxpipe codex --binary codex-ar
```

The launcher installs temporary Codex provider overrides for the child process:

- provider id: `pxpipe`;
- provider display name: `OpenAI`;
- wire API: `responses`;
- auth: Codex/OpenAI auth remains owned by the caller;
- base URL: `http://127.0.0.1:<PORT>/providers/codex/backend-api/codex`.

`CODEX_HOME` is not changed, so alternate wrappers/accounts keep their own
configuration and authentication state. While routing through PXPipe,
`OPENAI_BASE_URL` and inherited loopback proxy variables are removed from the
child because provider routing is expressed through Codex's model-provider
configuration instead. Explicit `--direct` mode and the automatic fallback used
when no persistent listener is available preserve the caller environment
unchanged.

The persistent Node listener owns an isolated `codex` provider route whose
Anthropic/default and OpenAI upstream bases both point to `https://chatgpt.com`.
The route does not inherit alternate gateway routing, gateway headers, API keys,
or Cloudflare provider credentials from the default listener. That lets normal
`/backend-api/codex/responses` requests use PXPipe's existing Responses
transform/accounting path while native endpoints such as `/responses/compact`
remain pass-through requests on the same authenticated origin.

PXPipe does not claim WebSocket Responses support here; the provider override
sets `supports_websockets=false`. Use the dedicated `pxpipe codex` launcher,
not the Anthropic-oriented Warp path.

If the persistent listener is unavailable, the launcher prints a warning and
starts Codex directly. `--direct` requests that behavior explicitly.

Model selection is read-only. Explicit Codex model arguments win, then the
selected profile model, then top-level `config.toml`. When no persistent model
can be resolved, PXPipe leaves model selection to the installed Codex CLI
instead of injecting a reference model.
