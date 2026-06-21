# Changelog

All notable changes to pxpipe are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) (pre-1.0: minor = features /
behavioral changes, patch = fixes).

## 0.5.0 — 2026-06-20

Cache-stable history-collapse imaging for both providers, with GPT-5.6 promoted
to the default imaged scope. Old conversation history collapses into rendered
PNG sections so the model reads a compact image instead of re-billed text, while
prompt caching and tool-call behavior are preserved.

### Added
- **GPT history collapse (`openai-history.ts`).** Append-only, o200k
  token-length sectioning. Sections seal only at a tool-closed boundary (the
  open call-id set is empty), so a `function_call` and its
  `function_call_output` never split across the collapse cut.
- **GPT + Anthropic dashboard rendering.** Per-family model toggles, persisted
  metrics, thumbnail-expired session UI, and reflow/newline handling.

### Changed
- **Default imaged scope is now `claude-fable-5` + `gpt-5.6`.** GPT-5.6 is
  promoted from opt-in (0.4.0) to on by default. `gpt-5.5` and `claude-opus-4-8`
  stay opt-in: they degrade reading dense imaged history (gist drift), so
  silently imaging them by default is wrong. Promotion is gated on an OCR/recall
  threshold.
- **Anthropic cache contract (`history.ts`).** Append-only per-chunk rendering;
  `cache_control` markers are preserved/moved, never added; chunk boundaries
  align with caller marker seams for byte-stable prefix caching.
- **GPT image budget (`openai.ts`).** `detail:'original'` for gpt-5.x, flagship
  vision-multiplier fix, and a patch cap; schema-strip preserves real
  descriptions.
- **Savings accounting (`openai-savings.ts`).** Now computed on a
  `cached_tokens` + vision-token basis.

### Fixed
- **OpenAI 400 on long Responses-API sessions.** `"No tool call found for
  function call output with call_id ..."` no longer occurs — the tool-closed
  sectioning boundary keeps each `function_call`/`function_call_output` pair
  intact across the collapse cut.

## 0.4.0 — 2026-06-19

New library surface for harness authors, opt-in GPT-5.x / Responses API support,
and a round of dashboard-honesty and cache-correctness fixes.

### Added
- **Library API (`pxpipe/transform`):** `transformAnthropicMessages` now accepts
  `keepSharp` (pin specific blocks as text so the caller controls what stays
  legible) and `emitRecoverable` (a provenance-recovery channel surfaced on
  `info.recoverable`). New exported types `KeepSharpBlock`, `RecoverableBlock`.
- **Edge / Workers-safe packaging.** `process.env` access is `typeof`-guarded;
  `@napi-rs/canvas` moved to `devDependencies` (the atlas is baked at build time),
  so the runtime is pure-JS and runs on Node and Cloudflare Workers unchanged.
- **GPT-5.x family + Responses API (opt-in, off by default).** `isPxpipeSupportedGptModel`
  gates the `gpt-5`/`5.5`/`5.6`/`-mini`/`-nano` family; a 768 px portrait-strip
  render profile avoids OpenAI's mandatory shortest-side-768 downscale; an OpenAI
  vision-token cost model replaces the Anthropic 750 px/token math for the GPT
  path; `transformOpenAIResponses` compresses `/v1/responses` (Codex). Still gated
  off until the day-one OCR-fidelity eval on a released GPT-5.x model.

### Fixed
- **Cache anchor relocation.** The single cache breakpoint moved from the static
  slab onto the **last history image** (which sits after the slab in prefix order),
  so slab + history cache as one stable prefix — created once, then read at 0.1×.
  Previously the ~141k-token history image re-created at the 1.25× rate on warm
  turns, turning a real compression win into a net loss. Marker count is
  unchanged: pxpipe still never *adds* a breakpoint, only relocates the caller's.
- **Dashboard honesty.** The Details headline and the session hero now use
  cache-weighted tokens (matching the Saved column) instead of dividing the raw
  `count_tokens` baseline by sent tokens — which over-claimed "fewer tokens" even
  on requests that were a net loss after caching.
- **Restart restore.** Replayed rows now reconstruct the Saved delta and the
  Details breakdown from the persisted JSONL; image thumbnails are honestly marked
  expired rather than left blank.
- **CI:** regenerated `pnpm-lock.yaml` after the canvas dependency move
  (`--frozen-lockfile` had been rejecting every push).
- **Node:** clean exit on Ctrl+C during in-flight streams and idle keep-alive.

### Changed
- **Dashboard redesign:** light flame theme, plain-language hero, and per-request
  image-vs-text transparency (which context became an image, which stayed text).
- **Docs:** lead with token reduction rather than dollar savings (pricing is a
  side-effect of tokens saved); added `HISTORY_CACHE_MODEL.md`; large comment
  cleanup across the core (~1,640 lines trimmed) with deep math moved to docs.
- **Deps:** patched 6 advisories (vite, undici, esbuild).

## 0.3.1 — 2026-06-17

### Changed
- **Demo:** the side-by-side A/B clip moved to Google Drive (the committed copy
  was too low-res to read). The README keeps the preview thumbnail and links out
  to the video; the 8.9 MB video binary is no longer in the package/repo tree.

## 0.3.0 — 2026-06-17

Render-sizing overhaul, dashboard transparency, honest savings accounting, and a
multi-agent code review with five confirmed fixes. Reviewed at extra-high recall
(10 finder angles → verify → sweep).

### Changed
- **Render page ceiling raised to ~1932×1932.** Fable 5 / Opus 4.8 accept images
  up to 2576 px long edge / 4784 visual tokens, but a request with >20 images
  (pxpipe always sends many) is held to the stricter ≤2000 px/side rule — so the
  real ceiling is ~1932×1932 (1928×1928 = 69×69 = 4761 tokens). `MAX_HEIGHT_PX`
  1568→1932; dense tool/history pages now `DENSE_CONTENT_COLS=384` /
  `DENSE_CONTENT_CHARS_PER_IMAGE=92160` (1928×1928 full page) — fewer image
  blocks at the same OCR-validated 5×8 cell. The static slab is unchanged
  (313 cols / 1573×1280). Pages never trip a server-side downscale. Note: the
  larger per-page density uses the validated 5×8 cell and stays within
  Anthropic's pixel/token limits, but OCR legibility at this page size has not
  been independently re-eval'd (revert = the four render constants).
- **Opus is OFF by default.** Production scope defaults to **Fable-5 only**;
  Opus 4.8/4.7 are opt-in (they read imaged content at a measurable tax — see
  FINDINGS.md). Opt in via `PXPIPE_MODELS` or the dashboard chips.
- **Honest savings accounting.** Per-turn/session savings are the real
  `baseline_eff − actual_eff` with **no ≥0 floor** — a net-losing turn (e.g. a
  cache_create-heavy image rewrite) now reports the real loss instead of a
  fabricated 0. (Dashboard renders negatives explicitly.)

### Added
- **Dashboard "how your context works" panel** — per-request token flow
  (as-text → real) + the exact-char breakdown of what became images + a gallery
  of every rendered page, reached via a **"view"** link on each recent-requests
  row.
- **Flexible "compress models" chips** — the toggle set is the union of a model
  catalog (Fable 5, Opus 4.8/4.7, Sonnet 4.6, Haiku 4.5), the `PXPIPE_MODELS`
  env scope, and the currently-active scope, so any env-enabled model stays
  toggleable (off ↔ on). Runtime-only override of the compress scope.
- **Demos** — `demo/cost-ab/` (cost A/B on a real coding task) and
  `demo/effective-context/` (recall-at-scale needle test), each with a model
  arg: defaults to Fable, `a.sh opus` to override. Plus `eval/ab/` token-savings
  scripts.

### Fixed (from the code review)
- **Tool_result over-truncation (regression):** the paging/break-even gate and
  `truncateForBudget` predicted against the slab geometry (313 cols / 159 rows)
  while the dense renderer emits 384 cols / 240 rows — so large tool_results
  were truncated far earlier than the 10-image cap required, silently dropping
  output that would have rendered. The gate, paging budget, and image-count
  estimate now price the same page the renderer produces.
- **Garbled session headline:** a net-losing session showed "-7% fewer tokens";
  now phrased honestly as "N% more tokens".
- **Context-map "view" mis-resolution:** `contextHistory` capped at 30 while the
  recent table showed 50 rows, so older rows' "view" links silently showed the
  *latest* request's breakdown. Caps aligned; an evicted/unrecorded request now
  shows an explicit "no longer available" message instead of wrong data.
- **Multi-col token cap:** the multi-col width ceiling now respects the 4784
  visual-token limit at full page height (was bounded only by the 2000 px side
  limit, which could produce a 4968-token page that the API rejects).
- **Doc/code contradictions:** `baseline.ts` and caller comments no longer claim
  a ≥0 clamp the code intentionally doesn't apply.

### Docs
- Rewrote `docs/RENDER_SIZING.md` and updated `docs/TRANSFORM_INFO.md`,
  `README.md`, and in-code comments for the new ceiling and limits.
