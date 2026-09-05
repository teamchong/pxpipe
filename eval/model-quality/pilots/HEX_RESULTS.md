# Matched hex pilot

`gpt-6-astra`, reasoning `low`, **N=2 per variant**. The first and last cases
from the shared hex corpus were used unchanged. All variants received the same
question and at most 768 output tokens. Detail variants used the same resolved
rendering profile and factsheet; only `imageDetail` differed. The native table
preserves every source field, value, row and association, with exact round-trip
assertions. It does not select fields using the question or expected answer.

| representation | correct | input tokens | output tokens | mean response time | estimated billed token-equivalents |
|---|---:|---:|---:|---:|---:|
| native source | 2/2 | 8,614 | 21 | 1.730s | 10,871 |
| images, `high` | 2/2 | 2,656 | 443 | 6.395s | 5,533.5 |
| images, `original` | 2/2 | 2,656 | 124 | 2.622s | 3,938.5 |
| compact native table | 2/2 | 6,380 | 21 | 2.114s | 8,078.5 |

Counts are totals across two completed responses; latency is their mean.
Token-equivalents use the configured cache-read/write and output-price ratios,
not a provider dollar invoice. Reasoning is already included in output.
Reported usage across the eight completed responses was **20,915 tokens**:
20,306 input and 609 output.

`original` used the same input tokens as `high`, but fewer output tokens:
about **29% less estimated billed cost** and **59% lower mean response time**
in this pilot. The native table reduced input tokens by **26%** versus native
source, but remained more expensive than either image variant here. Native
source was fastest. Accuracy was tied; this pilot does not establish improved
hex accuracy or predict whole-session dashboard savings. Its small sample and
execution order do not support a general latency guarantee.

GPT-6 now defaults to `original`. The full-sized `high` baseline remains separate;
`imageDetail` is now explicitly configurable through the shared model-profile
registry, so eval and normal requests use the same setting when overridden.
The JSONL codec remains an experimental representation, not a default transform.

- [Numeric summary](hex-summary.json)
- Dry run: `node eval/model-quality/hex-pilot.mjs`
- Explicit live run: `HEX_PILOT_LIVE=1 node eval/model-quality/hex-pilot.mjs`
- Codec and request-validation tests: `node --test eval/model-quality/compact-jsonl.test.mjs`

Raw pilot receipts remain local and git-ignored.
