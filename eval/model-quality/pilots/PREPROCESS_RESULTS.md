# Request-local factsheet preparation

An offline replay compares the change with `ca95b4d`, using the same installed
dependencies and the public gist fixture in 96 completed custom-tool rounds.
The profile and incoming request are identical in both arms. Order alternates
between arms. Each arm runs seven times; reported medians exclude its first
replay. No model API is called, and the benchmark rejects attempts to use fetch.

| Local image cache | Baseline median | Prepared-factsheet median |
|---|---:|---:|
| warm/reused | 1,068.145 ms | 685.695 ms |
| cleared before every replay | 3,492.155 ms | 3,110.305 ms |

Every serialized outgoing request was **byte-identical** between arms, in both
cache conditions. These are proxy transformation timings, not model response
times or billed-cost measurements. They do not establish the broader cost and
real-task accuracy objective.

The production path automatically reuses parsed factsheets between profitability
checks and final emission. It caches preparation, not coverage-dependent final
strings. The cache is request-local and bounded to 64 entries and 1,048,576
source characters. During emission, misses cannot evict prepared gate entries
that later segments still need. Opaque excerpts and exact-spelling output remain
unchanged.

## Reproduce

Build the baseline revision separately, then build the candidate normally. From
the candidate checkout:

```sh
PXPIPE_GPT_PROFILES='' BENCH_ROUNDS=96 BENCH_BASELINE_DIST=/path/to/baseline/dist node eval/model-quality/local-preprocess-bench.mjs
PXPIPE_GPT_PROFILES='' BENCH_ROUNDS=96 BENCH_COLD_EACH=1 BENCH_BASELINE_DIST=/path/to/baseline/dist node eval/model-quality/local-preprocess-bench.mjs
```

[Measurements and source fingerprints](preprocess-summary.json).
