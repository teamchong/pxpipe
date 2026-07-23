# Gemini 3.6 Flash Vision & Profile Research

This document collects empirical research on image tokenization, dimension caps, aspect ratios, RGB channel multiplexing, and reading quality for `google/gemini-3.6-flash`.

---

## 1. Image Tokenization & Pricing Behavior

### Empirical Measurements across Dimensions

Unlike Anthropic (which scales vision tokens dynamically with pixel dimensions via 28px patches) or OpenAI (which scales via 512×512 tiles at 170 tokens/tile), **Gemini 3.6 Flash uses a fixed ~1,034 – 1,113 vision tokens per image regardless of pixel resolution or aspect ratio**:

| preset name | dimensions (W×H) | aspect ratio | image tokens billed |
|---|---:|---:|---:|
| tiny square | 100×100 | 1.00 | **1,089** |
| small square | 256×256 | 1.00 | **1,089** |
| medium square | 512×512 | 1.00 | **1,089** |
| standard square | 1024×1024 | 1.00 | **1,089** |
| large square | 2048×2048 | 1.00 | **1,089** |
| Claude widescreen | 1568×728 | 2.15 | **1,078** |
| Sol tall portrait | 768×1932 | 0.40 | **1,113** |
| Grok short portrait | 768×512 | 1.50 | **1,080** |
| HD 1080p | 1920×1080 | 1.78 | **1,100** |
| Ultra-wide 4:1 | 2048×512 | 4.00 | **1,056** |
| Ultra-tall 1:4 | 512×2048 | 0.25 | **1,056** |
| Extreme-wide 8:1 | 4096×512 | 8.00 | **1,034** |

### Key Takeaway on Vision Cost
The measurements show nearly flat image-token usage across these dimensions (1,034-1,113 tokens), but they do not establish Google's internal resampling architecture.
Because image token cost was nearly flat in this sweep, larger legible canvases can pack more characters per measured vision token.

---

## 2. Geometry & Legibility Research

Testing 12-character verbatim hex recall off dense rendering pages across four aspect ratio and layout profiles:

| geometry profile | width × height | columns | accuracy |
|---|---:|---:|---:|
| 312-col 1568×728 (Claude widescreen) | 1568×728 | 312 | **5/5 (100%)** |
| 152-col 768×1932 (GPT/Sol tall portrait) | 768×1932 | 152 | **5/5 (100%)** |
| 152-col 768×512 (Grok short portrait) | 768×512 | 152 | **5/5 (100%)** |
| 200-col 1024×1024 (1:1 square) | 1024×1024 | 200 | **5/5 (100%)** |

---

## 3. RGB Channel Separation Diagnostic

Testing 3-channel RGB overprint multiplexing (where three independent text streams share one physical line in RED, GREEN, and BLUE channels):

| arm | exact lines recovered |
|---|---:|
| extracted red channel (color) | **12/12 (100%)** |
| extracted red channel (white) | **12/12 (100%)** |
| extracted green channel (color) | **12/12 (100%)** |
| extracted green channel (white) | **12/12 (100%)** |
| extracted blue channel (color) | **12/12 (100%)** |
| extracted blue channel (white) | **12/12 (100%)** |
| combined RGB (all 3 streams overlaid) | **0/12** |
| combined RGB (focused on red) | **0/12** |
| combined RGB (focused on green) | **1/12** |

### Conclusion on RGB Multiplexing
- Individual color channels and single-channel monochrome renders are **100% healthy (12/12 on every channel)**.
- Physical character collisions on combined RGB overprints corrupt ViT patch embeddings prior to model attention. Overlaid RGB multiplexing is **rejected for production**.

---

## 4. Dedicated Gemini Model Profile

`src/core/gemini-model-profiles.ts` defines Gemini's dedicated profile:

```typescript
  {
    test: (m) => /gemini/i.test(m),
    profile: {
      vision: { regime: 'tile', base: 1078, perTile: 0 },
      stripCols: ANTHROPIC_STRIP_COLS, // 312 columns
      maxHeightPx: ANTHROPIC_MAX_HEIGHT_PX, // 728 px
      minCompressTokens: 500,
      factSheetFormat: 'full',
      history: { ...BASE_HISTORY, maxImages: 32 },
      style: {
        ...BASE_STYLE,
        font: 'spleen-5x8',
        aa: true,
      },
    },
  }
```

`geminiVisionTokens` in `src/core/gemini-model-profiles.ts` records the measured production-geometry value:

```typescript
export function geminiVisionTokens(_model: string, _w: number, _h: number): number {
  return 1078;
}
```

---

## 5. Quality Benchmark Summary (Dedicated Gemini Profile)

Evaluated on `google/gemini-3.6-flash` at the shipped 312-column, 728px profile:

| test | N | Gemini 3.6 Flash | notes |
|---|---:|---:|---|
| novel arithmetic | 100 | **100/100 (100%)** | pure image 100/100 |
| gist recall A/B | 98 | **98/98 (100%)** | all 22 sessions completed |
| state tracking | 18 | **18/18 (100%)** | subset of gist corpus |
| never-stated probes | 16 | **0/16 confabulated** | 0 false positives |
| verbatim 12-char hex | 15 | **14/15 (93%)** | dense render |

Receipts:
- `eval/gemini-profile/dimension-research-results.json`
- `eval/gemini-profile/novel-arithmetic-results.json`
- `eval/gemini-profile/gist-recall-results.json`
- `eval/gemini-profile/verbatim-hex-results.json`

---

## 6. Multi-Column Packing Rejected

Gemini bills approximately 1,078 tokens per image at the production geometry, so a
layout must reduce image count to save tokens. The shipped single-column page already
uses the full 1,568 px width at 312 characters per row. Splitting that width into
multiple columns loses capacity to gutters and cannot add horizontal pixels.

Measured on the same 829,999-character reflowed key/value corpus:

| layout | geometry | images | Gemini image tokens |
|---|---:|---:|---:|
| single column | 312 chars, 1568 px | **30** | **32,340** |
| two columns | 2 × 152 chars, 1548 px | 31 | 33,418 |
| three columns | 3 × 98 chars, 1518 px | 32 | 34,496 |

Multi-column packing is strictly worse before accounting for its additional reading-order
risk. It is therefore removed rather than retained as an unused option. Single-column
312-character pages remain the only production rendering path.
