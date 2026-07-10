# pxpipe QW01–QW10 cross-CLI experiment — 2026-07-10

## Result

The real offline transform matrix and live Codex/Claude regression runs are complete. The accepted production candidate is **B-all = QW01 + QW02 + QW03 + QW05**. Results are reproducible with `run.mjs` and `summarize-live.mjs`.

## Accepted 10 × 2 matrix

| QW | Codex CLI | Claude Code | Decision |
|---|---|---|---|
| QW01 telemetry | PASS | PASS | Accepted for both protocols |
| QW02 exact gate | PASS | N/A | OpenAI-only; Claude 3/3 regression |
| QW03 tool-schema delta | PASS | N/A | OpenAI-only; Claude 3/3 regression |
| QW04 source fact-sheet | FAIL | FAIL | Not accepted |
| QW05 adaptive history | PASS | N/A | OpenAI-only; Claude 3/3 regression |
| QW06 history threshold | FAIL | FAIL | Sweep not accepted |
| QW07 cache prefix | FAIL | N/A | OpenAI-only; not accepted |
| QW08 framing | FAIL | FAIL | Not accepted |
| QW09 model profile | FAIL | N/A | OpenAI-only; not accepted |
| QW10 patch grid | FAIL | N/A | OpenAI-only; not accepted |

## Evidence

- `results/repetitions.jsonl`: 96 real public-transform runs, including three repetitions and the QW06 1200/1350/1500 sweep.
- `results/live-summary.json` and `.csv`: per-arm/client success, exact SHA/UUID/negation, provider input/cache token distributions and p50/p95/min/max where observable.
- Native tool contracts: 96/96 structurally valid in the offline transform matrix.
- Offline exact-string flags are intentionally false when the source exists only
  in PNG; QW03 is accepted from stronger live B03 evidence (3/3 exact SHA, UUID
  and critical negation) plus 96/96 native schema-contract validation.
- Live regression outputs are retained verbatim by arm and client. HTTP 4xx records are excluded from summaries; 4xx bodies are not included.
- B-all composition is limited to QW01/QW02/QW03/QW05.

## Savings formulas (Codex client usage, median of 3)

- Raw A0 → A1: `16611 → 9158`, **44.867858647883935%** savings, `(A0-A1)/A0`.
- Raw A0 → B-all: `16611 → 9158`, **44.867858647883935%** savings.
- Incremental A1 → B-all: `9158 → 9158`, **0%**.
- Cache tokens are reported separately and are never added to raw savings.
- QW06 B02 → B06: **no accepted improvement**.

## Measurement limits

Provider cost and OCR CER/WER were not observable and are not estimated. Claude client token usage is absent where the CLI did not emit it. A PNG-only exact string is not promoted to an offline fidelity pass without model/OCR evidence. Raw provider and cache measurements are reported only where present in successful proxy telemetry. Proxy rows are split by protocol (`openai-responses` versus `anthropic-messages`), never assigned to both clients. Isolated B arms with no explicit proxy capture remain client-usage-only rather than inheriting pooled A1 telemetry; B-all uses `live-candidate.jsonl`.

Final B-all OpenAI telemetry reconstructs raw accounting without a cache credit:
full native JSON text measured 17,479–18,413 tokens before rewrite and
7,592–7,919 after rewrite, while the separate image cost was 1,944–2,112
tokens. Claude rows use the explicit `provider_count_tokens` scope and leave
provider-inseparable fields null rather than relabeling mixed usage.
