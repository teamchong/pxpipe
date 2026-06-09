# reading-fidelity eval — does the model actually *read* pxpipe's image?

Solve a math problem given as **text** vs. as a **pxpipe-rendered PNG**
(its real `renderTextToPngs`), exact-match the final number. The image arm gets
*only* the image, so it must read it. `claude-opus-4-8`.

## The honest number: novel random-number problems (N=100)

GSM8K is in training data, so a model can recall a memorized answer even when it
*misreads* the image — which inflates the image arm. So the real test uses
**fresh random-number problems** (`gen_novel.py`) that cannot be memorized.
Arithmetic is trivial (the text arm scores 100%), numbers are large and random,
so any wrong answer is a **misread**.

| arm | accuracy |
|---|---|
| baseline (text) | **100%** |
| pxpipe (image) | **93%** |
| delta | **−7pp** (real reading tax) |

Misses are genuine misreads (`10200`→`9400`, `7873`→`7793`) or unreadable. So the
model *does* read pxpipe's render on short content — but at a real ~7% cost.

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
python3 gen_novel.py                    # writes /tmp/novel.jsonl
node render_cfg.mjs /tmp/novel.jsonl ./novel_imgs 100 0
GSM_DATA=/tmp/novel.jsonl GSM_IMGS=./novel_imgs N=100 OFF=0 python3 bench.py

# --- GSM8K (contaminated, for comparison) ---
node render_all.mjs 100 100             # writes ./imgs
N=100 OFF=100 python3 bench.py
```

Needs the `claude` CLI on a MAX plan. See [`/FINDINGS.md`](../../FINDINGS.md).
