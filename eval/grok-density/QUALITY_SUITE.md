# Grok quality suite

Grok is evaluated through the OpenAI-compatible Responses endpoint used by
Codex. Fable and Opus use the Claude harnesses.

```bash
export OPENAI_BASE_URL=http://127.0.0.1:<GATEWAY_PORT>/v1
export OPENAI_API_KEY=…
export SOL_QUALITY_MODEL=grok-4.5
export SOL_QUALITY_LIVE=1

pnpm run build
N=100 node eval/sol-profile/novel-arithmetic.mjs
node eval/sol-profile/gist-recall.mjs
node eval/sol-profile/verbatim-hex.mjs
```

The harnesses post directly to the provider and reject pxpipe's local port, so
the measured images are not transformed again. They use the model's resolved
production profile: Spleen 5×8, IDS rows, and the adjacent factsheet where the
production path supplies one.
