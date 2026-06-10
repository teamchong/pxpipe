#!/usr/bin/env python3
# Gist-recall A/B runner. Both arms call claude CLI directly (proxy bypassed).
import json, os, subprocess, sys, glob
from concurrent.futures import ThreadPoolExecutor

WORK = os.path.abspath('work3')
MODEL = os.environ.get('MODEL', 'claude-fable-5')
CLAUDE = os.path.expanduser('~/.claude/local/claude')
probes = json.load(open(f'{WORK}/probes.json'))
env = {k: v for k, v in os.environ.items() if k != 'ANTHROPIC_BASE_URL'}

def ask(prompt):
    try:
        r = subprocess.run([CLAUDE, '-p', '--model', MODEL, prompt],
                           capture_output=True, text=True, timeout=240, env=env)
        return r.stdout.strip()
    except Exception as e:
        return f'<ERROR {e}>'

def one(job):
    arm, p = job
    sid, q = p['session'], p['q']
    suffix = (f"\n\nQuestion: {q}\nIf the transcript does not contain the answer, "
              f"reply exactly UNKNOWN. Reply with only the answer, nothing else.")
    if arm == 'text':
        prompt = (f"An earlier coding session transcript is saved at {WORK}/s{sid}.txt. "
                  f"Read that file (in chunks if needed, read all of it).") + suffix
    else:
        pngs = sorted(glob.glob(f'{WORK}/s{sid}_p*.png'))
        prompt = (f"An earlier coding session transcript is rendered as {len(pngs)} images: "
                  + ' '.join(pngs) + ". Read all of them in order; do not use any other tool "
                  "or write code, just read the images visually.") + suffix
    ans = ask(prompt)
    return dict(arm=arm, **p, answer=ans)

jobs = [(arm, p) for arm in ['text', 'image'] for p in probes]
print(f'{len(jobs)} calls, model {MODEL}', flush=True)
out = open(f'{WORK}/results.jsonl', 'w')
with ThreadPoolExecutor(max_workers=6) as ex:
    for i, res in enumerate(ex.map(one, jobs)):
        out.write(json.dumps(res) + '\n'); out.flush()
        ok = '?' 
        print(f"[{i+1}/{len(jobs)}] {res['arm']:5s} s{res['session']} {res['type']:12s} -> {res['answer'][:60]!r}", flush=True)
print('done')
