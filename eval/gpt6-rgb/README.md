# GPT-6 RGB-overprint screening

Eval only: no production renderer/profile changes or proxy restart.

```sh
# Render fixtures and exercise renderer/scorer checks, without API calls:
node eval/gpt6-rgb/probe.mjs

# Twelve direct Responses calls. Uses existing OPENAI_BASE_URL / OPENAI_API_KEY.
RGB_LIVE=1 node eval/gpt6-rgb/probe.mjs
```

Optional `RGB_MODEL` selects the model (default `gpt-6-astra`). `RGB_SEED`
replays the recorded fixture seed. Artifacts and incremental receipts go in
`runs/<timestamp>-live/`; failed requests stop the run rather than spending on
remaining arms. Old receipts are never overwritten.

## Design

- Three independently generated fixtures, 24 numbered lines each. Each has six
  random identifiers, six numbers, six enable/disable instructions, and six code
  lines. Expected answers appear only in the tested text/image, not the prompt.
- Four arms per fixture: native text, white-on-black monochrome, red/green
  two-channel overlap, and red/green/blue three-channel overlap. All arms receive
  identical source lines and the same transcription prompt.
- All images use JetBrains Mono 12, 13px row pitch, and 768px width. Consecutive
  lines occupy one physical row in red, green, blue order. Monochrome uses the
  same font/spacing with one logical line per physical row. Color planes are
  combined directly, not alpha-blended; clipping is checked.
- `detail: original`, reasoning `low`, maximum 4,000 output tokens, 90s timeout.
  GPT-6 rejected the older eval client's default reasoning `none`; the client
  now accepts an explicit override while retaining its previous default.
- Arm execution order rotates across fixtures. Reported usage comes directly
  from Responses and includes the full request, not just image tokens. Reasoning
  tokens are a subset of output tokens, not an extra additive bucket.
- Strict scoring requires the entire line, including its identifier, numeric
  value, operator, punctuation, and position, to match. Refusals or malformed
  JSON do not get credit. This is **exact-line recall**, not character accuracy.

## Scope

This is a small matched-font channel-separation screen, not a benchmark of the
production 5×8 renderer, long-context quality, semantic task accuracy, or every
possible color encoding. The font's default shaping (including code ligatures)
is shared across image arms. Monochrome errors must not be attributed solely to
RGB separation. Passing this screen would still require a larger benchmark;
failing it is reason not to enable this overprint layout in production.

Raw `results.json` files and image artifacts are local-only and ignored by git. Only aggregate scores/usage are published in `summary.json`.
