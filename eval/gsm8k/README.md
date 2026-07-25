# reading-fidelity eval — does the model actually *read* pxpipe's image?

Solve a math problem given as **text** vs. as a **pxpipe-rendered PNG**
(its real `renderTextToPngs`), exact-match the final number. The image arm gets
*only* the image, so it must read it. Each model reads renders produced under
**its own** profile, so the arms below are per-model and not pixel-identical.

## The honest number: novel random-number problems (N=100)

GSM8K is in training data, so a model can recall a memorized answer even when it
*misreads* the image — which inflates the image arm. So the real test uses
**fresh random-number problems** (`gen_novel.py`) that cannot be memorized.
Arithmetic is trivial (the text arm scores 100%), numbers are large and random,
so any wrong answer is a **misread**.

### `claude-opus-4-8` (historical profile)

| arm | accuracy |
|---|---|
| baseline (text) | **100%** |
| pxpipe (image) | **93%** |
| delta | **−7pp** (real reading tax) |

Misses are genuine misreads (`10200`→`9400`, `7873`→`7793`) or unreadable. So the
model *does* read pxpipe's render on short content — but at a real ~7% cost.

### `claude-opus-5` (current profile)

Same seeded dataset (`gen_novel.py`, seed `20260531`, committed as `novel.jsonl`),
but reading renders produced under opus-5's **current** profile
(`novel_imgs_claude-opus-5/`), via direct `claude -p --allowedTools Read` with no
`cci.py` in the path.

| arm | accuracy |
|---|---|
| pxpipe (image) | **100/100** |
| missing `ANSWER:` marker | 0/100 |

Zero misreads on this arm — the −7pp reading tax seen on the opus-4-8 profile does
not reproduce here. Caveats, stated plainly:

- **The text baseline was not re-measured for opus-5.** The arithmetic is trivial
  by construction (the opus-4-8 text arm scored 100%), so the image arm is treated
  as the reading measurement, but the delta is inferred, not measured.
- This is a *short-content* render. It says nothing about dense recall — see
  [`../verbatim-15/`](../verbatim-15/), where the same model scores 2/15.

Receipts: [`bench_direct_img.py`](bench_direct_img.py) (exact harness run),
[`results_claude-opus-5_novel.json`](results_claude-opus-5_novel.json) (all 100
pred/gold pairs), [`novel.jsonl`](novel.jsonl) (dataset).

## GSM8K (standard suite — contaminated, shown for comparison)

| arm | accuracy |
|---|---|
| baseline (text) | 97% |
| pxpipe (image) | 96% |

GSM8K *looks* near-lossless (−1pp) but that's memory inflating the image arm by
~3pp vs. the clean novel number. Don't trust it alone.

Contrast both with [`../needle-haystack/`](../needle-haystack/): verbatim recall
from a **dense** render is **0/15**. Short readable → ~93%; dense exact-recall → 0%.

## Run

```bash
# dataset (GSM8K)
curl -s https://raw.githubusercontent.com/openai/grade-school-math/master/grade_school_math/data/test.jsonl -o /tmp/gsm8k_test.jsonl
pnpm run build                          # render_*.mjs import ../../dist

# --- novel reading test (the honest number) ---
python3 gen_novel.py                    # writes /tmp/novel.jsonl (seed 20260531)
node render_cfg.mjs /tmp/novel.jsonl ./novel_imgs 100 0
GSM_DATA=/tmp/novel.jsonl GSM_IMGS=./novel_imgs N=100 OFF=0 python3 bench.py

# --- same test, claude-opus-5 profile renders, direct `claude -p` ---
node render_cfg.mjs ./novel.jsonl ./novel_imgs_claude-opus-5 100 0
python3 bench_direct_img.py             # writes /tmp/real_arith.json

# --- GSM8K (contaminated, for comparison) ---
node render_all.mjs 100 100             # writes ./imgs
N=100 OFF=100 python3 bench.py
```

Needs the `claude` CLI on a MAX plan. See [`/FINDINGS.md`](../../FINDINGS.md).
