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

## Cache-first history optimization

The dedicated Codex route can apply a stricter Responses-history admission
policy than generic OpenAI-compatible traffic. The purpose is not to transform
more often; it is to avoid replacing a valuable warm prompt prefix for a small
raw text/image win.

The optimizer follows these rules:

1. Completed `function_call` and `custom_tool_call` rounds are paired with their
   matching outputs by `call_id`. Open, orphaned, malformed and referenced
   protocol state remains native and acts as a boundary.
2. Eligible cold history is divided into deterministic sealed sections. The
   newest incomplete section stays native so appending one more turn does not
   rewrite all previously emitted images.
3. A complete history plan must clear absolute, relative and per-image net
   saving floors after image cost and PXPipe's native framing/fact-sheet text.
4. After process start, the first eligible turn stays native so provider usage
   can establish whether the existing Codex prefix is already warm.
5. A warm native prefix is preserved. A cold/low-cache prefix may transition to
   images when the materiality gate passes.
6. Once a compressed prefix is warm, later transforms may only append sections
   when every previously emitted synthetic Responses segment remains an exact
   hash prefix. A mutation falls back to native history for that turn.
7. Provider-reported `input_tokens` and `cached_tokens` are the cache signal.
   Both counters must be explicitly present and internally valid before they can
   change adaptive state; missing or malformed cache telemetry is treated as
   unknown rather than as a cold-cache observation. Cache state is scoped by a
   short SHA-256 fingerprint of Codex's `thread-id`; the raw thread identifier is
   not retained. This is intentionally narrower than Codex's provider prompt-cache
   namespace: root and subagent requests may share a session-level cache lineage
   while still owning different history trajectories. The in-memory observer
   therefore never transfers adaptive admission state between distinct threads.
   It stores only bounded token counts and short hashes of synthetic segments; it
   stores no prompt, tool input or tool output text.
8. Native `/responses/compact` is never transformed by this policy. A successful
   native compaction invalidates the previous per-thread cache observation because
   Codex keeps the thread identity while replacing its history. The next eligible
   regular request therefore performs a fresh native observation before creating
   another image epoch.

The cache-first policy is enabled only on the dedicated `codex` provider route.
Generic OpenAI-compatible callers retain their existing history behavior.
