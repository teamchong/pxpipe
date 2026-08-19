# Gateway visual quality suite

This suite evaluates Gemini image models exposed by the local Cloudflare AI Gateway.

Confirmed model IDs:

- `gemini-3.7-flash` via Google AI Studio

There is no `gemini-4.7` in the gateway catalog. The similarly named
`workers-ai/@cf/zai-org/glm-4.7-flash` is GLM, not Gemini. Although its catalog
advertises attachments, its live endpoint rejects image input as non-multimodal.

DeepSeek v4 is available as `workers-ai/@cf/deepseek-ai/deepseek-v4-flash` and
`workers-ai/@cf/deepseek-ai/deepseek-v4-pro`, but both are declared text-only.
The client rejects them instead of recording invalid image-reading scores.

Build first, then run the same three quality checks used for Gemini 3.6:

```bash
pnpm run build

MODEL=gemini-3.7-flash LIVE=1 node eval/gemini-profile/novel-arithmetic.mjs
MODEL=gemini-3.7-flash LIVE=1 node eval/gemini-profile/gist-recall.mjs
MODEL=gemini-3.7-flash LIVE=1 node eval/gemini-profile/verbatim-hex.mjs

```

Each run writes a model-qualified result file and does not overwrite the existing Gemini 3.6 receipts.
