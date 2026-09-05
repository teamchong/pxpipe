# GPT-6 RGB screening results

Run: 2026-09-05T08:11:01.924Z; model: `gpt-6-astra`; reasoning: `low`.
Seed: `628ddac9559dd4705368e25fcb646ec5`. Public scores and usage: [summary.json](summary.json). Raw responses remain local and untracked.

| Arm | Exact lines | Input tokens | Output tokens | Of output: reasoning |
|---|---:|---:|---:|---:|
| text | 72/72 | 1,284 | 1,044 | 0 |
| mono | 62/72 | 1,140 | 2,557 | 1,378 |
| rg | 0/72 | 792 | 7,078 | 5,994 |
| rgb | 0/72 | 621 | 2,902 | 2,783 |

Totals span three fixtures per arm (12 completed API calls). All reported cache reads/writes were zero.

## Decision

**Do not enable the tested two- or three-channel overprint layout in production.**
Both overlapping layouts recovered zero exact lines across all three fresh fixtures.
The three-channel arm explicitly reported inability to separate the streams in all three replies.
The two-channel arm returned 24 lines each time, but none matched exactly.

Two-channel input usage fell 30.5% versus monochrome; three-channel fell 45.5%.
Those savings do not compensate for the accuracy failure. Two-channel output usage
was also substantially higher, mainly from reasoning. Input-token savings alone are not total-cost savings.

Monochrome scored 62/72 rather than perfectly. This matched-font diagnostic used
JetBrains Mono 12 with its default shaping, not the production 5×8 renderer.
The result rejects this tested layout; it is not proof that every RGB encoding or reasoning setting fails.

## Verification

- Syntax checks passed for the probe and eval client.
- Offline renderer/scorer assertions passed.
- Eval-client checks confirmed default `none`, explicit `low`, and no reasoning field for Grok.
- One initial API request was rejected because GPT-6 does not support reasoning `none`;
  it was excluded, and the complete run used `low` consistently.
- Production files/settings were not changed by this experiment.
