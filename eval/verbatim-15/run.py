#!/usr/bin/env python3
"""Verbatim hex-recall harness (N=15, 3 needles x 5 dense-JSON pages).

Supersedes run_v2.sh / run.sh. Three reasons the bash versions are retired:

  1. They shelled out to `claude -p`. This repo standardised on eval/lib/cci.py
     ("drop-in replacement for `claude -p`") and every other eval uses it --
     gist-recall, swe-bench, swe-bench-pro, needle-haystack, gsm8k. The bash
     runners were the only things in eval/ bypassing it.

  2. They fanned out with `xargs -P 3`. xargs detaches: when its launching
     shell is killed it reparents to init (ppid=1) and keeps spawning trials,
     surviving every kill aimed at the shell. One such orphan ran unsupervised
     for ~6 min against the wrong model. ThreadPoolExecutor is in-process --
     the workers cannot outlive this script.

  3. They inherited ANTHROPIC_BASE_URL, so trials went through the pxpipe
     proxy, which imaged each sub-session's whole context. The model then read
     a re-render of the page rather than the page, and every model scored ~0/15.
     The bypass on line 11 of gist-recall/run.py is the established guard.

The probe prompt is byte-identical to run.sh's so scores stay comparable.
"""
import json, os, re, subprocess, sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

DIR = os.path.dirname(os.path.abspath(__file__))
CCI = os.path.join(DIR, '..', 'lib', 'cci.py')
MODEL = os.environ.get('MODEL', 'claude-opus-5')
PAR = int(os.environ.get('PAR', '3'))
OUT = os.environ.get('OUT', os.path.join(DIR, f'out_{MODEL}'))

# Bypass the proxy: an imaged re-render of the page is not the page.
env = {k: v for k, v in os.environ.items() if k != 'ANTHROPIC_BASE_URL'}

# A solo trial measured 177.6s -- the model spends minutes pulling a 12-hex id
# out of a dense JSON page rendered as a PNG. The retired 210/240 pair left
# 32s of headroom, and under PAR=3 contention trials cross it: cci self-exits,
# the truncated capture yields no hex, and it scores as a MISS that is
# indistinguishable from a genuine one. That is how a slow-but-correct model
# gets reported as broken. A timeout can only ever manufacture a false MISS,
# never a false HIT, so raising it strictly improves fidelity -- the probe
# prompt is untouched, so scores stay comparable to earlier runs.
HARD = int(os.environ.get('TRIAL_TIMEOUT', '660'))          # subprocess hard kill
env['CCI_TIMEOUT'] = os.environ.get('CCI_TIMEOUT', str(HARD - 60))  # self-exit first

golds = json.load(open(os.path.join(DIR, 'golds.json')))
K = int(os.environ.get('K', '1'))           # samples per trial
LIMIT = int(os.environ.get('LIMIT', '0'))   # first N trials only (smoke tests)
if LIMIT:
    golds = golds[:LIMIT]
os.makedirs(OUT, exist_ok=True)
RAW = os.path.join(OUT, 'raw')              # every response kept verbatim
os.makedirs(RAW, exist_ok=True)


def _txt(v):
    if isinstance(v, bytes):
        return v.decode('utf-8', 'replace')
    return v or ''


def ask(prompt):
    """Return (status, stdout, stderr).

    A timeout and a refusal used to be indistinguishable: both fell through to
    the regex, missed, and logged as EMPTY. out_opus5_run1 is 6/6 EMPTY and
    then nothing -- a timeout cascade scored as a reading failure. Statuses are
    kept apart so that cannot recur, and stderr is no longer thrown away.
    """
    try:
        r = subprocess.run(
            [sys.executable, CCI, '--model', MODEL, '--allowedTools', 'Read', prompt],
            capture_output=True, text=True, timeout=HARD, env=env)
        return 'OK', _txt(r.stdout), _txt(r.stderr)
    except subprocess.TimeoutExpired as e:
        return 'TIMEOUT', _txt(e.stdout), _txt(e.stderr)
    except Exception as e:
        return 'ERROR', '', f'{type(e).__name__}: {e}'


# The old rule was re.search(r'[0-9a-f]{12}', re.sub(r'\s+', '', raw)): it
# stripped every newline in the response first, so two unrelated short hex runs
# on separate lines could fuse into a spurious 12-char "answer", and it then
# took the FIRST match anywhere -- often the model narrating a line it looked at
# before settling on one. Anchor to token boundaries, keep every candidate for
# audit, and prefer the last (models state the answer at the end). The legacy
# value is recorded alongside so old scores stay comparable.
HEX = re.compile(r'(?<![0-9a-f])[0-9a-f]{12}(?![0-9a-f])')


def extract(raw):
    """Return (candidates, legacy_value).

    Anchored matches on the raw text first: that rejects a 12-char window cut
    out of a longer hex run, and rejects hex accidentally spelled by prose --
    "trace 0123456789abcdef" yields ace012345678 under the old rule, which is
    how a discursive answer became a recorded "misread". Only if the response
    holds no clean candidate do we retry on whitespace-collapsed text, so an id
    that wrapped across a line is still recovered, still anchored.
    """
    cands = HEX.findall(raw)
    if not cands:
        cands = HEX.findall(re.sub(r'\s+', '', raw))
    m = re.search(r'[0-9a-f]{12}', re.sub(r'\s+', '', raw))
    return cands, (m.group(0) if m else 'EMPTY')


def one(job):
    i, g, rep = job
    page, dur, gold = g['page'], g['dur'], g['gold']
    # byte-identical to run.sh's probe
    prompt = (f"Read the image at {DIR}/page{page}.png. Find the JSON line whose "
              f"dur_ms is exactly {dur} and report ONLY its 'id' field value "
              f"(12 hex chars), nothing else. Read it visually from the image; "
              f"do not use code.")
    status, raw, err = ask(prompt)

    with open(os.path.join(RAW, f't{i:02d}_r{rep}.txt'), 'w') as f:
        f.write(f'=== status={status} model={MODEL} gold={gold} '
                f'page={page} dur={dur}\n=== stdout ===\n{raw}\n'
                f'=== stderr ===\n{err}\n')

    cands, legacy = extract(raw)
    if status in ('TIMEOUT', 'ERROR'):
        got = status
    elif not raw.strip():
        got = 'NO_OUTPUT'
    elif not cands:
        got = 'NO_MATCH'
    else:
        got = cands[-1]
    return dict(trial=i, rep=rep, page=page, dur=dur, gold=gold, got=got,
                hit=(got == gold), status=status, legacy=legacy,
                legacy_hit=(legacy == gold), n_cands=len(cands),
                cands=cands[:8], raw_chars=len(raw))


jobs = [(i, g, rep) for rep in range(K) for i, g in enumerate(golds)]
print(f'{len(golds)} trials x K={K} = {len(jobs)} calls, '
      f'model {MODEL}, par {PAR}', flush=True)

results = []
with open(os.path.join(OUT, 'results.jsonl'), 'w') as out:
    with ThreadPoolExecutor(max_workers=PAR) as ex:
        for r in ex.map(one, jobs):
            results.append(r)
            out.write(json.dumps(r) + '\n')
            out.flush()
            tag = 'HIT ' if r['hit'] else 'MISS'
            print(f"{tag} trial={r['trial']} rep={r['rep']} page={r['page']} "
                  f"dur={r['dur']} gold={r['gold']} got={r['got']}", flush=True)

hits = sum(1 for r in results if r['hit'])
legacy_hits = sum(1 for r in results if r['legacy_hit'])

by_trial = {}
for r in results:
    by_trial.setdefault(r['trial'], []).append(r)

# A miss is only evidence about reading if the model actually answered.
modes = Counter(r['got'] if r['got'] in ('TIMEOUT', 'ERROR', 'NO_OUTPUT', 'NO_MATCH')
                else 'WRONG_VALUE'
                for r in results if not r['hit'])

with open(os.path.join(OUT, 'results.log'), 'w') as f:
    for r in sorted(results, key=lambda r: (r['trial'], r['rep'])):
        tag = 'HIT ' if r['hit'] else 'MISS'
        f.write(f"{tag} trial={r['trial']} rep={r['rep']} page={r['page']} "
                f"dur={r['dur']} gold={r['gold']} got={r['got']} "
                f"status={r['status']} cands={r['n_cands']}\n")
    f.write('\n')
    # Per-trial rate is the unit that matters: two runs of these same 15 trials
    # scored 1/15 and 2/15 while disagreeing about WHICH trials hit. A render
    # change is only real if it moves this by more than that spread.
    for t in sorted(by_trial):
        rs = sorted(by_trial[t], key=lambda r: r['rep'])
        f.write(f"TRIAL {t:>2} hits={sum(1 for x in rs if x['hit'])}/{len(rs)} "
                f"gold={rs[0]['gold']} got={[x['got'] for x in rs]}\n")
    f.write(f"\nFAILMODES {dict(modes)}\n")
    f.write(f"SCORE model={MODEL} hits={hits} total={len(results)} "
            f"trials={len(golds)} k={K}\n")
    f.write(f"LEGACY_SCORE hits={legacy_hits} total={len(results)} "
            f"(old first-match-after-whitespace-strip rule)\n")

print(f'\nFAILMODES {dict(modes)}')
print(f'SCORE model={MODEL} hits={hits} total={len(results)} '
      f'trials={len(golds)} k={K}')
print(f'LEGACY_SCORE hits={legacy_hits} total={len(results)}')
