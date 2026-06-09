# FINDINGS — pixelpipe (text→PNG token compression)

**Status:** ⚠️ **VERDICT REVERSED — see correction below.** Originally ruled "dead"; live measurement shows pixelpipe is a working *lossy gist-compressor* saving ~68% on real (dense) Claude Code traffic, with a known verbatim-recall gap.
**Date:** 2026-05-28 (original) · 2026-05-29 (correction) · 2026-06-09 (Fable 5 update)
**Models tested:** `claude-opus-4-5` (original run), `claude-opus-4-8` (re-test after a model bump), `claude-fable-5` (2026-06-09)
**Model scope (current):** Fable 5 only, enforced in library + proxy (Opus disabled 2026-06-09 — see update below).
**Harness:** `eval/needle-haystack/` (receipts preserved from `/tmp/needle_eval`)

---

## Update (2026-06-09) — Fable 5: read tax gone, scope narrowed to fable-only

Fable 5 launched today; ran the clean evals against it the same day and
narrowed the production gate from Opus 4.7+ to `claude-fable-5` only.

**1. Reading (novel arithmetic, N=100, `eval/gsm8k/` harness, same images):**

| arm | opus-4-8 | fable-5 |
|---|---:|---:|
| text baseline | 100/100 | 100/100 |
| pixelpipe image | 93/100 | **100/100** |

The ~7% Opus read tax — the main per-read cost of imaging — is gone on Fable.

**2. Image billing parity (tokenizer check).** Same 1573×488 dense-JSON page
(est. 1,023 tokens by w·h/750), measured per-API-call through the CLI:
fable-5 ~1,104 tokens, opus-4-8 ~1,162 (deltas include tool_result overhead).
Fable ships the Opus 4.7-line tokenizer, so the compression ratio carries over
unchanged. The 5.x-tokenizer-might-change fear that kept the gate at 4.x is
resolved by measurement.

**3. Verbatim recall improves but is NOT fixed.** 12-char hex ids from a dense
JSON render (n=4 needles, single ~5.8k-char page — smaller and easier than the
original 0/15 haystack, not apples-to-apples): **3/4 exact**. The miss is the
documented failure mode, a single-glyph silent misread (`125f9e6e1c77` →
`125f9e6a1c77`); one passing trial also misread an adjacent field
(`cc33ae67` → `cc33a867`). The verbatim-risk guard remains required.

**4. Economics.** Fable is $10/$50 per MTok (2× Opus 4.8). Token-for-token
savings are identical (same tokenizer), so every saved token is worth 2× the
dollars — pixelpipe is more valuable on Fable in absolute terms.

**Decision:** support Fable 5 only. Opus 4.7/4.8 disabled — with a tax-free
reader available, shipping a known 7% misread rate is the wrong default.
Mythos 5 (`claude-mythos-5`) is the same base model but Project Glasswing
restricted; unmeasured, not enabled.

---

## Verdict (corrected 2026-05-29) — lossy gist-compressor, not dead

The "Dead" verdict below rested on three stacked mistakes. Naming them, because the body of this document is left **intact as the record** rather than rewritten:

1. **Wrong cost model.** The economics were computed on English prose (~3.5 chars/token), where images lose. Real Claude Code traffic is token-*dense* — JSON, code, tool output, hashes at ~1 char/token (this repo's own `MEMORY.md` recorded a 1.17 char/token median and warned against the prose default; I pasted that warning in as a caveat and then used prose anyway). On a live, multi-session run the proxy measured **856k → 277k input tokens (~68% fewer)**, at **3.1 chars per image-token vs ~1.0 as text** — images win ~3× on the real workload.

2. **Generalized the worst case to the whole product.** The 0/15 needle eval is the single hardest thing you can ask a lossy gist compressor: exact recovery of a random 12-char hex. That is not pixelpipe's job — its job is letting the model skim bulk history by gist. The worst-case sub-task failing was a real finding; calling the *product* dead from it was not.

3. **Never checked it was actually running.** The investigation theorized "if you sent this to Opus…" while a successful, transparent A/B was running underneath the whole time (`ANTHROPIC_BASE_URL=127.0.0.1:47821`; event log showing `compressed:true, 152 images/request`). I asserted the interactive session bypassed the proxy without looking. It didn't.

**What still stands (unchanged, and the important caveat):** verbatim retrieval is **0/15** on both model generations, and the failure mode is **silent confabulation** — imaged content returns a plausible *wrong* value, not an error. Therefore:

* pixelpipe is a **lossy, recency-graded gist tier**: recent turns stay text, older bulk history becomes images. Safe to navigate by gist; **unsafe as the sole copy of anything needed byte-exact** (IDs, hashes, secrets, exact numbers).
* the one **open item** before this is production-ready is a **verbatim-risk guard** in the gate — never image blocks carrying unique IDs / hashes / exact values. Not yet built.

**Corrected one-liner:** the encoder limit kills *verbatim*; it does **not** kill the product. On dense traffic pixelpipe is a real ~68% gist compressor with one fixable silent-confabulation gap — measured live, apples-to-apples, on Opus 4.8. Everything below this line is the original (superseded) "dead" writeup, preserved.

---

## Original TL;DR (superseded 2026-05-29 — see verdict above)

pixelpipe rewrites Claude Code tool-result text into compact PNGs before they reach
the model, betting that vision tokens for a dense image are cheaper than the same
content delivered as transcript text. **The tokens are cheaper. The model cannot
read the content back.** That is the whole story.

| metric | text (OFF) | PNG (ON) | delta |
|---|---|---|---|
| **verbatim** retrieval — recover a 12-char hex string | 15/15 (100%) | **0/15 (0%)** | **−100pp** |
| **semantic** retrieval — recover a fact stated in the doc | 15/15 (100%) | 4–6/15 (27–40%) | −60 to −73pp |

Verbatim is a hard **zero** across 30 ON-trials on two model generations. The
semantic 27–40% is **not** statistically distinguishable from prior-guessing on
round numbers (two-proportion test across the model bump: z≈0.76, **p≈0.45**), and
its failure mode is **silent confabulation** — which is worse than an error,
because the caller can't tell.

pixelpipe is theater. The image *is* sent and the model *acknowledges seeing it*,
but it cannot extract either verbatim strings or specific facts from it. The token
"savings" come from Opus quietly throwing the content away.

---

## The thesis under test

> Anthropic bills vision tokens for an image by pixel area, not by character count.
> A 1568×1276 PNG costs ~2,668 image tokens **no matter how much text is printed on
> it.** So if you render a wall of tool-output text into one PNG, you pay a fixed
> ~2,668 tokens instead of the (larger) per-character text-token bill — a
> transparent, lossless-enough compressor sitting between Claude Code and the API.

Two load-bearing words: **transparent** and **lossless-enough**. The eval was built
to falsify exactly those.

---

## Methodology

A needle-in-haystack eval. We embed a unique fact **only** inside content that gets
rendered to PNG (never in the text tail), then ask Opus to retrieve it. If
retrieval ≈ text baseline → Opus reads the image. If retrieval ≈ zero → the image
is decorative and the savings are fake.

**Design: 2×2, N=15 per cell.**

- **Axis 1 — compression:** OFF (plain text baseline) vs ON (PNG path), toggled live
  via the dashboard kill switch (`POST /api/compression`).
- **Axis 2 — retrieval type:**
  - **verbatim** — a random 12-char hex needle (`VARIABLE x IS ASSIGNED THE VALUE
    <hex>`), asked back exactly. This is the OCR-hard case.
  - **semantic** — a specific fact stated in the rendered tool-reference doc (e.g.
    "what is the default timeout for `net.fetch`?"). This is pixelpipe's *actual*
    sales pitch: "comprehension over bulky docs."

**Controlled:** identical needle/haystack across ON and OFF; image is 1568×1276
(~2,668 image tokens, Anthropic's `w·h/750`); rendered text is plainly legible to a
human; needle is plain monospace, not buried in a chart or rotated. Calls go through
the real proxy via `claude -p --model "$MODEL" --append-system-prompt`, no session
persistence, exact-match scoring.

---

## Results

### Phase 1 — Original eval (`claude-opus-4-5`, N=15×4)

```
verbatim / off   15/15   100.0%
verbatim / on     0/15     0.0%
semantic / off   15/15   100.0%
semantic / on     4/15    26.7%
```

### Phase 2 — Model-bump re-test (`claude-opus-4-8`, N=15×4)

The one variable we do **not** control is Anthropic's vision encoder. A model bump
is the only legitimate way to move it, so we re-ran the whole grid on `4-8`.

| cell | opus-4-5 | opus-4-8 |
|---|---|---|
| verbatim / off | 15/15 | 15/15 |
| **verbatim / on** | **0/15 (0%)** | **0/15 (0%)** |
| semantic / off | 15/15 | 15/15 |
| **semantic / on** | **4/15 (27%)** | **6/15 (40%)** |

The 27%→40% headline is a trap. Two-proportion test, 4/15 vs 6/15: pooled
p̂≈0.33, **z≈0.76, p≈0.45** — squarely inside the noise band. And the ON failures
are confabulations of *guessable* numbers (see Appendix B): `60000→30000`,
`10000→1000`, `32→1`, `8→10`. The model is reading a feature map, not the page;
the "hits" are dominated by round numbers a strong prior would guess without any
image at all. Verbatim stayed at a hard zero across both versions.

> The model bump came back negative. That is the cleanest possible epitaph: we let
> the encoder change and the thesis still failed.

### Phase 3 — Crux: can the encoder read hex *at all*?

Before writing the tombstone we isolated **encoder incapability** from a
**rendering/density** problem by feeding Opus custom images directly (same vision
path, bypassing pixelpipe's specific renderer; `eval/needle-haystack/crux.py`).

| tier | rendering | result |
|---|---|---|
| billboard | one hex, 120pt, centered, mostly whitespace | **8/8 (100%)** |
| clean | 30pt, real newlines, light surrounding text | **8/8 (100%)** |

**The encoder is not fundamentally hex-blind.** When glyphs are large and isolated
it nails them. So the 0/15 was never an encoder wall — it is a
**density / resolution-per-character** problem. pixelpipe's ~8pt wall-to-wall
filler was simply below the glyph-resolution floor.

### Phase 4 — Density sweep: where does it break, and is the readable zone economical?

We swept font size **down** from "clean" at fixed pixelpipe dimensions
(`eval/needle-haystack/sweep.py`, ~2,668 image tokens throughout):

| font | retrieval | chars/image | failure mode |
|---|---|---|---|
| billboard 120pt | 8/8 (100%) | ~150 | — |
| clean 30pt | 8/8 (100%) | ~1,300 | — |
| **22pt** | **6/6 (100%)** | **~4,360** | — |
| **16pt** | **1/6 (17%)** | **~8,491** | **near-miss corruption** (`aef4b2c334ab → aef4b2c334eb`) |
| 12pt | fails / times out | ~15k | unreadable |

The 16pt failure mode is the smoking gun: one character off, not a blank. That is
textbook OCR-at-the-resolution-limit. **This was never an encoder incapability —
it's pixels-per-glyph.** Bigger cells genuinely fix readability… which is exactly
what makes it unfixable. See next section.

---

## Root cause

Opus's vision path is **not** an OCR engine. It builds a semantic/spatial summary of
the image — "there's a code block here, it has hex-looking tokens, it's about cache
config" — and the language model then reasons over *that summary*, not over the
pixels. The summary is **lossy by design**: specific character sequences and
specific numeric values fall through the cracks because they aren't semantically
distinctive. `30000` and `60000` pool to the same feature; a random hex string has
no handle to grab at all.

This also explains why round numbers survived (4/15 → there's a prior to fall back
on) while hex died (0/15 → no prior) and Opus still *can't quote* what it says it
sees.

---

## The economic vise (the core finding)

This is the part that makes the project unrescuable, independent of the encoder.

- **Image cost is fixed by pixel area**, not by character count. 1568×1276 →
  ~2,668 image tokens whether the page holds 150 chars or 15,000.
- **Text cost scales with content:** `text_tokens ≈ chars / cpt`.
- **Break-even** (image cheaper than text) requires `chars > 2668 × cpt`.

Define `compression = text_tokens / image_tokens` (>1 means the image wins).

| density | cpt | chars needed to break even | chars that fit & stay readable | verdict |
|---|---|---|---|---|
| English prose | ~3.5 | ~9,340 | ~4,360 @ 22pt (100% read) | **0.47× — image costs 2× the text** |
| (push font down to fit more) | ~3.5 | — | ~8,491 @ 16pt → **17% read, corrupting** | readable zone already lost |

**The two requirements — "readable" AND "token-cheaper" — are physically
anti-correlated on a fixed-token canvas.** To break even at prose density you must
shrink the font into the zone where retrieval has already collapsed. There is no
font size where the page both reads reliably and saves money. The readable zone
loses money; the money-saving zone can't be read.

> One honest line: the encoder limit kills verbatim; the economic vise kills the
> rest. Fixing one doesn't bring back the other.

---

## The one open question (honest caveat — not yet closed)

The sweep above used **English-prose filler** (~3.5 chars/token). Real Claude Code
traffic — JSON, tool output, code — is far denser: **~1.17 chars/token** (your own
production finding, N=354, median 1.17; see `MEMORY.md`). At that density the same
~4,360-char 22pt image represents ~3,700 **text-tokens**, i.e. **compression ≈
1.40×** — and 22pt read at **100%** in the sweep.

So there is exactly one band left unfalsified: **dense, structured content (not
prose) at 22pt.** That is the only configuration where readable AND cheaper might
coexist. It is narrow (one font size, one content class, ~1.4× best case before
latency tax) and it does **not** revive verbatim retrieval — but intellectual
honesty requires flagging it rather than burying it.

**To close it:** re-run `sweep.py` with realistic dense filler (real `run.sh`-style
tool-doc / JSON / code instead of "quick brown fox" prose) at 22pt, measuring both
retrieval **and** real compression against a 1.17-cpt baseline. ~15 min. Until then
the verdict is "dead for prose and for verbatim; one narrow prose-vs-dense band
outstanding for semantic."

---

## What this proves / doesn't prove

**Proven:**
- pixelpipe **as built** does not work. Verbatim retrieval is zero across two model
  versions; prose-density compression loses money in the readable zone.
- The failure is architectural (encoder is a summarizer, not an OCR; image cost is a
  fixed token canvas), not a tuning parameter. Font size, resolution, and "try
  Sonnet" do not address it.

**Not proven:**
- "VLMs fundamentally can't read rendered text." They can, when it's big and sparse
  (8/8 billboard). A different renderer (OCR-friendly typography) could recover some
  *semantic* ground — at the cost of more image tokens, making the economics worse.
- That the one narrow dense-content @ 22pt band is dead (see open question).

**Latency footnote:** the ON path ran ~3× slower than OFF (~8–25s vs ~3–6s). You pay
more wall-clock to get worse answers.

---

## Reusable infrastructure (don't delete)

The thesis is dead; the scaffolding is good and worth keeping:

- the proxy (`src/node.ts`, `src/core/proxy.ts`) and its per-block **break-even
  gate** (`src/node.ts:394`) — a clean place to sit between Claude Code and the API.
- the dashboard + live kill switch (`src/dashboard.ts`, `POST /api/compression`).
- the structured event log and token-accounting (`src/stats.ts`).
- the eval harness (`eval/needle-haystack/`).

**Note on the gate:** the shipped break-even gate is *necessary but not sufficient.*
It correctly checks "are the image tokens fewer?" — it does **not** check "do the
bytes survive?" That second question is the one this eval answered, and the answer
is no. Any future "render to save tokens" idea has to clear *both* bars.

---

## Decision & recommended next steps

1. **Flip the default to off.** Set `compress` to default-false in
   `src/core/transform.ts` (or leave the dashboard kill switch in the OFF state) so a
   running proxy can't silently corrupt live Claude Code sessions.
2. **Tag and stop.** `git tag rip-v0 && git push --tags`, then walk. Keep the repo
   as scaffolding, not as a shipping feature.
3. **(Optional) Close the open band** — run the dense-filler sweep above before
   declaring the semantic question fully dead.
4. Update `README.md` "Status" to point at this postmortem (it currently advertises
   the feature as enabled for Opus 4.6/4.7).

> The week wasn't wasted: we now know a concrete thing about how VLMs read rendered
> text that most people asserting the opposite on Twitter don't. The infra is
> reusable. The thesis is not.

---

## Appendix A — Receipts / how to reproduce

Preserved under `eval/needle-haystack/` (copied from the volatile `/tmp/needle_eval`):

| file | what it is |
|---|---|
| `run3.sh` | the 2×2 N=15 harness (verbatim+semantic × ON/OFF), `MODEL=claude-opus-4-8` |
| `results2.tsv` | raw per-trial output of the `4-8` run (Phase 2) |
| `crux.py` | direct-to-Opus billboard/clean encoder test (Phase 3) |
| `sweep.py` | fixed-dimension font-size density sweep (Phase 4) |

Run: start the pixelpipe proxy (`127.0.0.1:47821`), then
`cd eval/needle-haystack && ./run3.sh`. Requires a `claude` CLI on a MAX plan
(no API key needed) and PIL + a monospace TTF for the Python tiers.

**Caveat:** the original `4-5` run (Phase 1) shared the same output file and was
overwritten by the `4-8` re-run, so only its summary survives (above), not its raw
rows. The `4-8` raw rows are in `results2.tsv` and Appendix B.

## Appendix B — Raw `opus-4-8` data (Phase 2)

**verbatim / ON:** 15/15 returned **empty** — not garbled, not a near-miss. The
encoder never resolved character-level glyphs at pixelpipe's density; it saw "a
block of code-like texture" and gave up.

**semantic / ON — the confabulations** (expected → got; the dangerous part is these
are confident, not errors):

| expected | got | |
|---|---|---|
| 30000 | 30000 | ✓ |
| 10 | 20 | ✗ |
| 2000 | 2000 | ✓ |
| 2000 | 2000 | ✓ |
| 256 | 256 | ✓ |
| 64 | *(empty)* | ✗ |
| 10 | *(empty)* | ✗ |
| 30 | 30 | ✓ |
| 600000 | 600000 | ✓ |
| 32 | 1 | ✗ |
| 8 | 10 | ✗ |
| 60 | *(empty)* | ✗ |
| 5000 | *(empty)* | ✗ |
| 10000 | 1000 | ✗ |
| 60000 | 30000 | ✗ |

6/15 hits — and every hit is a round number a prior would guess
(`30000, 2000, 256, 30, 600000`). The misses corrupt toward other plausible round
numbers or go blank. That is confabulation over a lossy feature map, not reading.
