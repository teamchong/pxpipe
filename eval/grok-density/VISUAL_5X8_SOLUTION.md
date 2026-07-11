# Visual-only 5×8 pure-image solution (brute-force result)

## Solution

```text
Packing:  production Spleen 5×8, cols=152, maxH=512
Style:    { aa: true }     # white paper, no grid, no paperGray
Layout:   pre-render IDS block (rasterized into the PNG):

  IDS
  hex <12-char-hex>
  camel <camelCase>
  path <path>
  port <port>

Channel:  pure image only (no factsheet)
```

## Verified on grok-4.5

Receipt: `five-by-eight-ids-block-white-stability.json`

### **Pass rate: 7/7 (1) — all 4/4 exact, 0 confab**

| run | exact | confab | pass | hex | camel | hex got |
|-----|------:|-------:|:---:|:---:|:-----:|---------|
| `ids_block_white_n1` | 4/4 | 0 | Y | Y | Y | `a3f9c1e0b7d2` |
| `ids_block_white_n2` | 4/4 | 0 | Y | Y | Y | `a3f9c1e0b7d2` |
| `ids_block_white_n3` | 4/4 | 0 | Y | Y | Y | `a3f9c1e0b7d2` |
| `ids_block_white_n4` | 4/4 | 0 | Y | Y | Y | `a3f9c1e0b7d2` |
| `ids_block_white_n5` | 4/4 | 0 | Y | Y | Y | `a3f9c1e0b7d2` |
| `ids_block_white_n6` | 4/4 | 0 | Y | Y | Y | `a3f9c1e0b7d2` |
| `ids_block_white_n7` | 4/4 | 0 | Y | Y | Y | `a3f9c1e0b7d2` |

Kitchen discovery arm also passed once: `prod__aa_nogrid_p240__ids_block` (p240 variant; white preferred in retests).

## Negative results from brute force

| class | outcome |
|-------|---------|
| classTick / classColor / legend | no 4/4; often hurt hex |
| hexdisc hand bitmaps | no hex exact |
| jbss SS4/SS8 true AA fonts | best 3/4 camel; hex never |
| hybrid hex SS into Spleen | same 3/4 camel pattern |
| paperGray 240 no-grid + ids_block | port confab 47821→47021 |
| residual dilate/multicol/ydilate | losers |

## Why it works

- Isolating IDs on their own lines reduces dense-line nibble merge at 5×8
- Still pure visual: only PNG inputs at ask time
- Stock Spleen 5×8 density preserved

## Goal audit

| requirement | status |
|-------------|:------:|
| Visual-only | YES |
| 5×8 | YES |
| Pure-image 4/4 | YES (7/7 white+ids_block) |
| Found by brute force | YES |
| Grok 5.4 | NO model on gateway; validated on **grok-4.5** |
