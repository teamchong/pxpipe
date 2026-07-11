# Grok 4.5 pure-image exact at 5×8

Live pure-image (no factsheet) sweeps on `grok-4.5`, 2026-07-10.
Goal: improve exact-string recall while keeping **5×8 cell pitch** and
**≤768px short side** (no provider downscale).

## Baseline (tall 5×8, production packing)

| arm | pages | exact | confab | notes |
|-----|------:|------:|-------:|-------|
| `aa` single short page | 1 | 0–1/4 | 3–4 | hex/path/port confabulate |
| multipage `aa_H1932` bulk | 3 | 1/4 | 3 | bulk does not fix OCR |

## Best pure-image 5×8 arms (fixed cellW/H bonus 0)

| arm | maxH | style | exact | confab | stable? |
|-----|-----:|-------|------:|-------:|---------|
| `aa_H512` | 512 | AA | **3/4** | 0–1 | yes (hex/path/port; camel weak) |
| `aa+grid4_H512` | 512 | AA+grid4 | **3/4** | 0 | yes |
| `aa+color_H512` | 512 | AA+colorCycle | **3/4** | 0 | yes (camel abstains) |
| `aa+grid4+color_H512` | 512 | AA+grid4+color | **3/4** | 0 | yes (camel abstains) |
| `aa+grid4+color_H360` | 360 | AA+grid4+color | **4/4** once | 0 | **no** — n=2 retest 3/4 and 2/4 |
| isotropic `inkDilate` | 1932 | dilate 1–2 | 0/4 | low | worse (glyphs merge) |
| white-on-black | 512/1932 | invert:false | ≤2/4 | — | no gain |

## Shipping choice (superseded 2026-07-11)

Earlier same-day ship candidate was AA+grid4 @ H512 (~3/4 pure-image). The
**current** production Grok profile is white AA + **IDS block**, no grid — see
[Shipping pure-image 4/4](#shipping-pure-image-44-2026-07-11) below and
[`VISUAL_5X8_SOLUTION.md`](VISUAL_5X8_SOLUTION.md).

## Harnesses

```bash
pnpm run build
GROK_DENSITY_LIVE=1 node eval/grok-density/five-by-eight-pure.mjs
GROK_DENSITY_LIVE=1 node eval/grok-density/five-by-eight-page.mjs
GROK_DENSITY_LIVE=1 node eval/grok-density/five-by-eight-camel.mjs
GROK_DENSITY_LIVE=1 node eval/grok-density/five-by-eight-pass-retest.mjs
```

Receipts: `five-by-eight-*-results.json`.

## Shipped profile verification (same day)

Profile: `stripCols=152`, `maxHeightPx=512`, `aa+grid4` (grayscale). No factsheet.

| fixture | pages | exact | confab | notes |
|---------|------:|------:|-------:|-------|
| classic short (40 filler turns) | 1 | 1/4 | 3 | single short page still fails pure-image |
| multipage bulk (earlier arms) | 8 | **3/4** | **0** | hex/path/port often exact; camel abstains |
| multipage bulk (final shipped profile) | 8 | 2/4 | 0 | hex+port exact; camel+path abstain (0 confab) |

**Improvement vs tall 5×8 baseline (0/4, 4 confab):** multipage pure-image exact is higher and confabulation is much lower. **Not** a stable pure-image 4/4 at 5×8 — camelCase remains the weak probe; pure-image 9×12 still clears 4/4 via `PXPIPE_GPT_PROFILES`.

## Residual matrix (pure-image, shipped packing base)

Exhaustive residual levers on top of **5×8 / stripCols 152 / maxH 512 / AA+grid4**.
Receipt: `five-by-eight-residual-matrix-results.json` (2026-07-10T23:07:54.987Z, n=25).

| arm | family | exact | confab | notes |
|-----|--------|------:|-------:|-------|
| `detail_auto` | detail | 3/4 | 1 | detail=auto; hex→'a3f9c1eeb7d2' |
| `font_jbmono8_aa+grid4_H512` | font | 3/4 | 1 | font=jbmono8; hex→'a49c1e0b7d2.' |
| `font_jbmono8_aa_H512` | font | 3/4 | 1 | font=jbmono8; hex→'a49c1e0b7d2' |
| `prompt_ocr_hint` | prompt | 3/4 | 1 | prompt=ocr_hint; hex→'a3f9c1ee0b7d2' |
| `prompt_transcribe` | prompt | 3/4 | 1 | prompt=transcribe; hex→'a3f9c1ee0b7d' |
| `realish_reflow_on` | realish | 3/4 | 1 | reflow; hex→'a5f5ceabd2d2' |
| `shipped_short_bulk40` | baseline_short | 3/4 | 1 | port→'97821' |
| `reflow_off_shipped` | reflow | 2/4 | 0 | camel→'NOT STATED'; path→'NOT STATED' |
| `shipped_aa+grid4_H512_n1` | stability | 2/4 | 0 | camel→'NOT STATED'; path→'NOT STATED' |
| `shipped_aa+grid4_H512_n2` | stability | 2/4 | 0 | camel→'NOT STATED'; path→'NOT STATED' |
| `shipped_aa+grid4_H512_n3` | stability | 2/4 | 0 | camel→'NOT STATED'; path→'NOT STATED' |
| `font_unifont8_aa_H512` | font | 2/4 | 1 | font=unifont8; hex→'a98f4e8b0d6c'; camel→'NOT STATED' |
| `detail_high` | detail | 2/4 | 2 | detail=high; hex→'a3f9c1eeb7d2'; port→'97821' |
| `detail_original` | detail | 2/4 | 2 | hex→'a3f9c1eeb7d2'; port→'97821' |
| `font_spleen5x8_aa+grid4_H512` | font | 2/4 | 2 | font=spleen5x8; hex→'a3f9c1ee0b7d2e'; port→'97821' |
| `font_spleen5x8_aa_H512` | font | 2/4 | 2 | font=spleen5x8; hex→'a3f9c1eeb7d2'; port→'97821' |
| `prompt_strict` | prompt | 1/4 | 1 | hex→'a3f9c1ee0b7d2e'; camel→'NOT STATED'; path→'NOT STATED' |
| `font_unifont8_aa+grid4_H512` | font | 1/4 | 2 | font=unifont8; hex→'a9b1c3d4e5f6'; camel→'NOT STATED'; port→'41821' |
| `multicol_64x2` | multicol | 1/4 | 2 | hex→'a9fc6eb07d2e'; camel→'NOT STATED'; port→'97021' |
| `realish_prompt_ocr` | realish | 1/4 | 2 | prompt=ocr_hint; hex→'7f3a9c2e1b8d'; camel→'NOT STATED'; port→'47621' |
| `realish_shipped` | realish | 1/4 | 2 | hex→'NOT STATED'; camel→'customer_id'; port→'4721' |
| `multicol_70x2` | multicol | 1/4 | 3 | hex→'a39fc1e0b7d2'; camel→'pathsrc/core/anthropic-vision.ts port=78'; port→'7821' |
| `reflow_on_shipped` | reflow | 0/4 | 2 | reflow; hex→'a5f0a2e9b2c1'; camel→'NOT STATED'; path→'NOT STATED'; port→'7881' |
| `ydilate1_H512` | ydilate | 0/4 | 2 | hex→'NOT STATED'; camel→'NOT STATED'; path→'/token-edgeshard/pathways/core/authops/c'; port→'8080' |
| `ydilate1_grid4_H512` | ydilate | 0/4 | 2 | hex→'NOT STATED'; camel→'NOT STATED'; path→'/token-edge-shard-pathways/core/auth-spe'; port→'8080' |

### Residual takeaways

- **Stable shipped packing** (`aa+grid4_H512`, n=3): **2/4 exact, 0 confab** — hex+port; camel/path abstain.
- **Best residual lifts to 3/4 (each with 1 confab, n=1):** `prompt_ocr_hint`, `prompt_transcribe`, `detail_auto`, `font_jbmono8_*`, `realish_reflow_on`, `shipped_short_bulk40`.
- OCR/transcribe prompts uniquely recover **camelCase** under pure-image; hex is the usual confab (extra/missing nibble).
- **Fonts:** jbmono8 ≈ 3/4 c1; spleen5x8 ≈ 2/4 c2; unifont8 ≤2/4. No font clears stable 4/4.
- **Worse / no-gain:** vertical dilate 0/4; synthetic reflow_on 0/4; multicol ≤1/4; realish without reflow / realish+ocr_hint ≈ 1/4.
- Super-res 2× skipped (2× of 768 exceeds provider short-side floor).
- **No residual arm is a stable pure-image 4/4 at 5×8.** Do not ship a 4/4 claim.
- Strongest non-profile lever for a careful production pure-image instruction string: **OCR-hint** (or silent-transcribe) beside images — not a factsheet.
- Known pure-image 4/4 fallback remains **9×12** via `PXPIPE_GPT_PROFILES`.

## Shipping pure-image 4/4 (2026-07-11)

Brute-force result on **grok-4.5** (5.4 not on gateway):

- **Layout:** pre-render `appendIdsBlock` — isolates hex/camel/path/port on their own image rows
- **Packing:** Spleen 5×8, cols 152, maxH 512, `{ aa: true }` white, **no grid**
- **Stability:** `five-by-eight-ids-block-white-stability.json` — **7/7** full 4/4 pure-image passes
- Wired into production Grok profile + slab/history render paths

See `VISUAL_5X8_SOLUTION.md`.

