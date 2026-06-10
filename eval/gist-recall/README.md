# Gist-recall A/B: does the model lose information when history is imaged?

Date: 2026-06-10. Model under test: `claude-fable-5` via claude CLI (proxy
bypassed in both arms so nothing interferes with the comparison). Render
settings: the proxy's production constants (`DENSE_CONTENT_COLS=180`,
`DENSE_CONTENT_CHARS_PER_IMAGE=5000`, bare 5x8 cell).

## Question

pxpipe's cost story is settled ($100 of uncompressed traffic costs ~$28
through the proxy, caching held equal on both sides). The open question was
quality: when old session history is delivered as rendered PNGs instead of
text, does the model misremember decisions, values, paths, names, state?

## Design (pre-registered before any model call)

Synthetic-but-realistic session transcripts; filler is real source from this
repo wrapped as `tool_result` blocks, the same shape as live Claude Code
traffic. Facts are injected at controlled depths with randomized values
(seeded RNG) so nothing is memorizable from training data. Both arms read via
the Read tool; the only difference is modality: `.txt` vs production-density
PNGs. The model must answer or reply exactly UNKNOWN. Deterministic string
grading, no LLM grader.

Three escalating tiers:

| Tier | Size | Hardness | Probes |
|---|---|---|---|
| 1 | 10 sessions x 15k chars (4 pages) | facts amid code filler | 5 fact types + 1 unanswerable each |
| 2 | 6 sessions x 45k chars (10 pages) | active distractors: rejected package praised elsewhere, competing ms values, near-miss path (symptom vs root-cause file), author vs reviewer names, flag ON in staging / OFF in prod | 5 + 1 unanswerable each |
| 3 | 6 sessions x 45k chars (10 pages) | state tracking: one constant mutated 3x across the session | final value, first value, change count |

Fact types: decision, numeric, path, name, negation. Unanswerable probes
measure the failure mode that matters most for agents: silent confabulation
(answering confidently about a fact that was never stated).

## Results

| Tier | Probes per arm | text correct | image correct | image wrong-answers | confabulation (text / image) |
|---|---|---|---|---|---|
| 1 | 50 + 10 unanswerable | 50/50 | 50/50 | 0 | 0/10 / 0/10 |
| 2 (distractors) | 30 + 6 unanswerable | 30/30 | 30/30 | 0 | 0/6 / 0/6 |
| 3 (state tracking) | 18 | 18/18 | 18/18 | 0 | n/a |
| total | 114 + 16 | 98/98 | 98/98 | 0 | 0/16 both arms |

228 model calls total. Zero misses, zero confabulations, in either arm, at
any tier. The image arm correctly resolved every distractor: final decision
over earlier suggestion, retry budget vs cache TTL, root-cause file vs
symptom file, reviewer vs author, prod state vs staging state, and
final-after-three-changes values.

## Honest reading

1. **Ceiling effect.** Both arms at 100% means this test did not find the
   boundary; it establishes that the boundary is not at gist/state tier up to
   45k chars with distractors. We escalated hardness twice and failed to
   produce a single image-arm error.
2. **The known boundary still stands.** Verbatim recall of 12-char hex from
   dense renders measured 3/4 (`eval/needle-haystack/`). Exact strings are
   not safe to image; that is why the proxy keeps verbatim-risk blocks and
   the live tail as text. Nothing here changes that rule.
3. **Synthetic transcripts.** Facts were stated in prose turns amid code
   filler. Real sessions can bury facts inside tool outputs in stranger ways.
   Single seed, modest N (98 answerable probes/arm), one model, one day.
4. **What this does support:** the production design (gist tier imaged,
   verbatim tier text) shows no measurable quality loss on recall of
   decisions, values, paths, names, negations, or mutated state, at the exact
   density the proxy ships.

## Reproduce

```bash
python3 gen.py  && node render.mjs  && python3 run.py  && python3 grade.py   # tier 1
python3 gen2.py && node render2.mjs && python3 run2.py && python3 grade2.py  # tier 2
python3 gen3.py && node render3.mjs && python3 run3.py && python3 grade3.py  # tier 3
```

Needs the claude CLI on a plan with fable-5 access and a built `dist/`
(`pnpm run build`). Raw model answers are in `work*/results.jsonl`.
