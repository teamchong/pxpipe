# Shared profile-aligned model quality suite

**One source corpus and scoring protocol for every model. Each model uses its
own normal resolved rendering profile, not one universal font.** This is
`profile-quality-v2`; historical table results are not interchangeable with it.

## Run

```sh
node scripts/build.mjs

# Offline first: render all fixtures and estimate only calls not already saved.
QUALITY_MODEL=gpt-6-astra node eval/model-quality/run.mjs

# Paid, using the configured DIRECT provider/gateway credentials:
QUALITY_MODEL=gpt-6-astra QUALITY_LIVE=1 node eval/model-quality/run.mjs

# Verify completeness, profile freshness, and receipt provenance before publishing:
QUALITY_MODEL=gpt-6-astra node eval/model-quality/summarize.mjs

# Export a public, allowlisted receipt manifest locally (no upload/API calls):
QUALITY_MODEL=gpt-6-astra node eval/model-quality/publish.mjs

# Offline contract tests (no provider calls):
node --test eval/model-quality/profile.test.mjs
```

Change only `QUALITY_MODEL` to evaluate another model. Claude, Gemini, Grok,
Qwen, GLM, Kimi, and other Responses models use their existing transport clients;
rendering and scoring are shared. Direct endpoints must be configured for the
selected client; the pxpipe port is rejected. Kimi requires an explicit direct
`KIMI_QUALITY_BASE_URL`. No model's paid suite is triggered by testing another.

The Sol/Grok/Gemini/Qwen/GLM `novel-arithmetic.mjs`, `gist-recall.mjs`, and
`verbatim-hex.mjs` entrypoints now delegate here. Their legacy model/live env
names still work, but outputs go to the versioned suite's per-model folder,
**not** over historical receipts. The GPT-6 entrypoint delegates here too.
Custom-density/RGB research scripts remain separate and must not populate the
profile-aligned README table.

## Rendering contract

- Resolve through **`resolveGptProfile(actualModel)`**, the same registry normal
  requests use. Honor its model/version-specific font, width, height, AA,
  factsheet format, and runtime-supported profile overrides. Use its normal
  fallback if no dedicated profile exists. No duplicate eval profile table.
- Select history-specific style/width where defined for history fixtures.
  Apply profile-controlled history reflow and the normal reflow default.
- Use the runtime's exported **`openAIImageDetail`** decision, rather than
  hardcoding `original`. GPT-6 currently uses **`high`** in normal requests.
- Use the runtime's **`prepareImagedRenderText`** for content and
  **`historyFactSheet`** for history, including native-opaque overflow when the
  profile requests it. Ordinary content uses `factSheetText` with the resolved
  format. Do not omit the factsheet just to make hex a pure-image stress test.
- Generate fresh PNGs from source on every preflight. Record source, rendered
  source, PNG, profile and factsheet hashes; full recipe and page dimensions.
- Refuse stale `dist/` before making paid calls. Refuse resumed results with a
  changed profile, task payload or inference configuration. The summarizer
  refuses missing/legacy rendering provenance and a changed runtime profile.

This evaluates **profile-rendered content**, not the whole live proxy. It does
not exercise applicability/profitability gates, history selection, pinned tails,
cache boundaries, tool-call framing, image-count caps, or client-specific
request overrides. In particular, a small arithmetic problem may remain native
in ordinary traffic. Those behaviors have separate regression tests. We do not
call this a full end-to-end agent evaluation.

## Identical N and fixtures

| suite | N | requests |
|---|---:|---:|
| novel arithmetic | 100 | 100 native + 100 profile-rendered |
| gist | 98 | 22 batched session requests |
| state | 18 | subset of gist, no extra requests |
| never-stated guards | 16 | shared gist requests; confabulations, lower is better |
| dense hex association | 15 | 15 profile-rendered requests |

Arithmetic and gist reuse the existing seeded sources/prompts/rubric. There is
no extra pure-image arithmetic arm. Hex v2 uses **five reproducible source JSON
logs, 89 records each, three random targets per log**. IDs and durations are
unique. Targets are neither marked nor always first. Every model receives the
same records, question and strict one-ID scorer; only its normal rendering
profile and corresponding native factsheet differ. Old 908×328 cached PNGs and
the old Gemini target-at-first-line corpus are no longer used by these entrypoints.
The hex source/recipe and scorer changed, so v2 scores cannot be compared to old
hex scores as if only the model changed.

## Cost and receipts

At most 237 requests for a fresh complete suite, three concurrent workers. One
error stops scheduling new calls; in-flight calls finish and receipts are
saved atomically. There are no automatic retries or sweeps. Output caps are
1024 for arithmetic/hex, 2048 for gist. Inference settings are recorded separately
from rendering: GPT-6 defaults to reasoning low, Grok to high, others follow the
existing client defaults; these are not claims of identical inference settings
across providers.

`results/<model>/results.json` retains raw answers, actual usage, source/profile
provenance and scores **locally only**; raw receipts and preflight snapshots are
git-ignored. `summary.json` separates new versus reused usage and
counts each gist request once. `QUALITY_REUSE_FILE` can import successful old
receipts only for the same model/reasoning and byte-identical content payloads
with compatible output caps. Image-detail, factsheet or PNG differences prevent
reuse. Archived scores are never silently relabeled as v2.

Before a public PR, `publish.mjs` validates the local results and exports
`receipt-manifest.json` with only numeric scores/usage, public fixture IDs and
verification hashes. It excludes raw prompts/answers, endpoints, headers,
environment data, full configuration snapshots and local paths. Never force-add
the ignored raw receipts. Review model identifiers and all remaining public
metadata before publishing. Prompt templates and generated synthetic fixtures
in source code are not captured user/system prompts.

Historical receipts are left in their original directories. Other models need
a new paid v2 run before appearing in the profile-aligned comparison table;
offline profile checks are not paid quality scores.
