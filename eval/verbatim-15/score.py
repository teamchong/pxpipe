#!/usr/bin/env python3
"""Honest scorer for the verbatim hex-recall eval.

The original harness collapses every non-exact outcome into MISS. That hides the
distinction that actually matters for this benchmark:

  HIT     exact 12-hex match
  NEAR    returned 12 hex, <=2 glyph positions wrong  -> read the row, misread glyphs
  WRONG   returned 12 hex, >2 positions wrong         -> read the wrong row entirely
  ABSTAIN returned no hex at all                      -> declined to guess

A model that ABSTAINs when the render is illegible is behaving correctly. Scoring
it identically to one that confabulates a plausible-looking hex string is the bug
that made these numbers untrustworthy.
"""
import re
import sys
import glob
import os

LINE = re.compile(
    r"^(HIT|MISS)\s+trial=(\d+)\s+page=(\d+)\s+dur=(\d+)\s+gold=([0-9a-f]+)(?:\s+got=(\S+))?"
)


def hamming(a: str, b: str) -> int:
    if len(a) != len(b):
        return 99
    return sum(x != y for x, y in zip(a, b))


def classify(tag: str, gold: str, got: str | None):
    # The pre-run.py bash harness (run.sh/run_v2.sh) omitted got= on HIT lines,
    # writing only `HIT trial=2 page=0 dur=6150 gold=ade34f70fd73`. Treating a
    # missing got as an abstention silently converted every one of those genuine
    # hits into an ABSTAIN -- out_claude-fable-5 reported 0/15 exact when the log
    # actually records 6 hits. When the field is absent, trust the tag.
    if got is None:
        return ("HIT", 0) if tag == "HIT" else ("ABSTAIN", None)
    if got == "EMPTY":
        return "ABSTAIN", None
    if got == gold:
        return "HIT", 0
    d = hamming(gold, got)
    if d <= 2:
        return "NEAR", d
    return "WRONG", d


def score(path: str):
    rows = []
    with open(path) as fh:
        for raw in fh:
            m = LINE.match(raw.strip())
            if not m:
                continue
            tag, trial, page, dur, gold, got = m.groups()
            cat, d = classify(tag, gold, got)
            rows.append(
                dict(trial=int(trial), page=int(page), dur=int(dur),
                     gold=gold, got=got, cat=cat, dist=d)
            )
    return rows


def main(paths):
    print(f"{'model':22s} {'HIT':>4s} {'NEAR':>5s} {'WRONG':>6s} {'ABST':>5s} {'N':>4s}   exact%")
    print("-" * 68)
    allrows = {}
    for p in sorted(paths):
        model = os.path.basename(os.path.dirname(p)).replace("out_", "")
        rows = score(p)
        if not rows:
            continue
        allrows[model] = rows
        c = {k: sum(1 for r in rows if r["cat"] == k)
             for k in ("HIT", "NEAR", "WRONG", "ABSTAIN")}
        n = len(rows)
        pct = 100.0 * c["HIT"] / n if n else 0.0
        print(f"{model:22s} {c['HIT']:4d} {c['NEAR']:5d} {c['WRONG']:6d} "
              f"{c['ABSTAIN']:5d} {n:4d}   {pct:5.1f}%")

    for model, rows in allrows.items():
        near = [r for r in rows if r["cat"] == "NEAR"]
        if not near:
            continue
        print(f"\n-- {model}: near-miss glyph confusions (confabulated) --")
        for r in sorted(near, key=lambda r: r["trial"]):
            diffs = ", ".join(
                f"{g}->{o}" for g, o in zip(r["gold"], r["got"]) if g != o
            )
            print(f"   trial={r['trial']:2d} p{r['page']} {r['gold']} -> {r['got']}  ({diffs})")


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        here = os.path.dirname(os.path.abspath(__file__))
        args = glob.glob(os.path.join(here, "out_*", "results.log"))
    if not args:
        sys.exit("no results.log found; run run_v2.sh first")
    main(args)
