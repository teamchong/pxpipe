# pxpipe QW01–QW10 hermetic cross-client evaluation

This deterministic corpus performs no side effects and contains no credentials.
`run.mjs` invokes the real built public transforms for OpenAI Responses and
Anthropic Messages. It runs A0, A1, B01–B10 and B-all three times for both
clients, plus the QW06 1200/1350/1500 threshold sweep.

```powershell
npx pnpm@10.21.0 run build
node eval/qw-crosscli-2026-07-10/run.mjs
```

The JSONL records native tool-schema fingerprints and structural validation,
tokenizer counts, PNG bytes/pixels/dimensions, source/output bytes, exact
identifier and negation checks, runtime, and side-effect status. Provider usage,
cache and cost fields are explicitly `not observable (offline transform)`.

A failed exact-text check is meaningful: text that exists only in a generated
PNG cannot be proven exact by this runner without OCR/model execution. The
runner never promotes source-fixture presence into an output fidelity PASS.

Outputs are under `results/`; `repetitions.jsonl` is the authoritative raw log.
