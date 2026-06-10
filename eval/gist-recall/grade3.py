#!/usr/bin/env python3
import json, re, collections
res = [json.loads(l) for l in open('work3/results.jsonl')]
def norm(s): return re.sub(r'\s+', ' ', s.strip().lower())
def correct(p):
    a, g, t = norm(p['answer']), norm(p['gold']), p['type']
    if t == 'unanswerable': return a == 'unknown'
    if t == 'numeric':
        nums = re.findall(r'\d+', a); return g in nums
    if t == 'negation': return 'off' in a and 'enabled' not in a
    return g in a
tab = collections.defaultdict(lambda: dict(n=0, ok=0, unk=0, wrong=0))
conf = collections.defaultdict(lambda: dict(n=0, confab=0))
rows = []
for p in res:
    arm = p['arm']
    if p['type'] == 'unanswerable':
        conf[arm]['n'] += 1
        if not correct(p): conf[arm]['confab'] += 1; rows.append(p)
    else:
        tab[arm]['n'] += 1
        if correct(p): tab[arm]['ok'] += 1
        elif norm(p['answer']) == 'unknown': tab[arm]['unk'] += 1; rows.append(p)
        else: tab[arm]['wrong'] += 1; rows.append(p)
for arm in ['text', 'image']:
    t, c = tab[arm], conf[arm]
    print(f"{arm:5s} answerable: {t['ok']}/{t['n']} correct ({100*t['ok']/t['n']:.0f}%) | "
          f"said-UNKNOWN: {t['unk']} | wrong-answer: {t['wrong']} || "
          f"confabulated on unanswerable: {c['confab']}/{c['n']}")
print("\n--- every miss ---")
for p in rows:
    print(f"{p['arm']:5s} s{p['session']} {p['type']:12s} gold={p['gold']!r} got={p['answer'][:70]!r}")
