# Using other models with Claude Code

pxpipe supports **Claude Code only** to keep the maintenance burden small.
Routing Claude Code to other models is experimental. Kimi K3 on Cloudflare is
the only non-Anthropic model currently tested end to end.

Claude models use Anthropic by default. Two optional routes can run together:

- `OPENAI_MODELS` routes exact model IDs to OpenAI Responses.
- `CLOUDFLARE_MODELS` routes exact model IDs to Cloudflare's OpenAI-compatible endpoint.

Any OpenAI-compatible provider, including [Novita](https://novita.ai/), can be
routed the same way `OPENAI_MODELS` already routes to OpenAI itself — set
`OPENAI_UPSTREAM` to that provider's base URL and list its model IDs. This is
untested end to end (see the caveat above); it follows the same
`OPENAI_UPSTREAM` + `OPENAI_MODELS` mechanism already documented below, not a
new code path.

If a model appears in both lists, precedence is:

```text
CLOUDFLARE_MODELS > OPENAI_MODELS > default routing
```

## Setup

```bash
OPENAI_UPSTREAM=https://api.openai.com \
OPENAI_API_KEY=your-openai-key \
OPENAI_MODELS=gpt-5.6-sol \
CLOUDFLARE_ACCOUNT_ID=your-account-id \
CLOUDFLARE_API_TOKEN=your-cloudflare-token \
CLOUDFLARE_MODELS=moonshotai/kimi-k3 \
npx pxpipe-proxy
```

This routes:

- `gpt-5.6-sol` to OpenAI Responses
- `moonshotai/kimi-k3` to Cloudflare
- every unlisted model ID to the default Anthropic route

The Cloudflare variables derive this OpenAI-compatible endpoint:

```text
https://api.cloudflare.com/client/v4/accounts/<account-id>/ai/v1
```

### Novita (OpenAI-compatible)

Novita exposes an OpenAI-compatible endpoint, so it goes through the same
`OPENAI_UPSTREAM` / `OPENAI_MODELS` route as OpenAI itself — no separate flag:

```bash
OPENAI_UPSTREAM=https://api.novita.ai/openai \
OPENAI_API_KEY=your-novita-key \
OPENAI_MODELS=deepseek/deepseek-v3.2 \
npx pxpipe-proxy
```

Swap `OPENAI_MODELS` for any [Novita model ID](https://novita.ai/models). This
was verified against Novita's `/openai/v1/responses` and
`/openai/v1/chat/completions` endpoints (both reject with an auth error rather
than 404, confirming the routes exist); the actual model reply was not
exercised end to end, so treat the routing as reachable but unverified, same
disclaimer as everything past Kimi K3 above.

## Connect Claude Code

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:47821 \
ANTHROPIC_AUTH_TOKEN=local-pxpipe \
claude --model claude-moonshotai/kimi-k3
```

pxpipe advertises Cloudflare model IDs with a `claude-` prefix because Claude
Code requires a Claude-shaped ID. The prefix is only an alias and is removed
before forwarding. Models can also be selected through Claude Code's `/model`
menu.

Verify discovery with:

```bash
curl http://127.0.0.1:47821/v1/models
```

Keep real provider credentials on the pxpipe process, not in Claude Code.
`PXPIPE_MODELS` is separate: it controls image compression, not routing.
