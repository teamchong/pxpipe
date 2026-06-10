#!/usr/bin/env python3
# Gist-recall A/B generator. Builds realistic session transcripts with injected
# gist-tier facts (decisions, numerics, paths, names, negations) at controlled
# depths, plus one unanswerable probe per session. Values are randomized per
# seed so nothing can come from training data.
import json, random, os, sys

random.seed(20260610)
N_SESSIONS = 10
WORK = os.path.join(os.path.dirname(__file__), 'work')
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))

# --- filler: real source files chopped into tool_result-shaped blocks ---
SRC = []
for f in ['src/core/render.ts','src/core/transform.ts','src/core/proxy.ts',
          'src/core/history.ts','src/core/tracker.ts','src/dashboard.ts']:
    try: SRC.append(open(os.path.join(REPO, f)).read())
    except: pass
CORPUS = '\n'.join(SRC)

def filler(n_chars):
    i = random.randint(0, len(CORPUS) - n_chars - 1)
    chunk = CORPUS[i:i+n_chars]
    fname = random.choice(['src/core/render.ts','src/core/transform.ts','src/core/proxy.ts','src/core/history.ts'])
    return (f"[tool_use Read]\n{{\"file_path\":\"{fname}\"}}\n[tool_result]\n{chunk}\n"
            f"[assistant]\nLooked at {fname}; continuing with the change.\n")

FIRST = ['Mara','Priya','Tobias','Ingrid','Soren','Aiko','Dmitri','Lucia','Farid','Nadia']
LAST  = ['Okafor','Lindqvist','Tanaka','Moreau','Petrov','Alvarez','Khoury','Berg','Nakamura','Costa']
PKGS  = ['zustand','immer','valtio','jotai','mobx','redux-toolkit','xstate','nanostores']
DIRS  = ['scheduler','quota','retry','batcher','flusher','mailbox','journal','cursor']
FLAGS = ['ENABLE_SHARDING','USE_BROTLI','STRICT_CAS','ASYNC_FSYNC','LEGACY_PINS','HOT_RELOAD_V2']

def make_facts(sid):
    name = f"{random.choice(FIRST)} {random.choice(LAST)}"
    ms = random.choice([1250, 2750, 3400, 4500, 6200, 7800, 9100]) + random.randint(0,9)*10
    d = random.choice(DIRS)
    path = f"src/{d}/{random.choice(['core','io','sync'])}.ts"
    pick, reject = random.sample(PKGS, 2)
    flag = random.choice(FLAGS)
    pct = random.randint(11, 94)
    facts = [
      dict(type='decision',
           text=f"[user]\nteam sync outcome: we are going with {pick} for the store layer, {reject} was rejected because the bundle delta was too big.\n[assistant]\nNoted, {pick} it is for the store layer; I will not add {reject}.\n",
           q="Which package was chosen for the store layer?", gold=pick, wrong=reject),
      dict(type='numeric',
           text=f"[user]\nops note: the upstream gateway hard-times-out at 10s, so set our retry budget to exactly {ms}ms and do not change it without a ticket.\n[assistant]\nSet the retry budget constant to {ms}ms.\n",
           q="What exact value in ms was the retry budget set to?", gold=str(ms)),
      dict(type='path',
           text=f"[assistant]\nFound it: the double-flush race lives in {path}, the lock is released before the journal write lands.\n[user]\nok fix it there, nowhere else.\n",
           q="In which file path was the double-flush race found?", gold=path),
      dict(type='name',
           text=f"[user]\nfyi the on-call reviewer for this change is {name}, route the PR to them.\n[assistant]\nWill request review from {name}.\n",
           q="Who was named as the on-call reviewer for the PR?", gold=name),
      dict(type='negation',
           text=f"[user]\nimportant: we did NOT enable {flag} in prod, it only looked enabled because of the stale config cache. coverage stayed at {pct}%.\n[assistant]\nUnderstood: {flag} is OFF in prod, the dashboard was lying; coverage {pct}%.\n",
           q=f"Was {flag} enabled in prod? Answer ENABLED or OFF.", gold='OFF'),
    ]
    # unanswerable: plausible question whose fact was never stated
    un_q = random.choice([
      "What port number was the staging proxy moved to?",
      "Which database migration version was rolled back?",
      "What was the Docker base image pinned to?",
      "Which AWS region was the failover assigned to?",
      "What git tag was the hotfix released under?"])
    facts.append(dict(type='unanswerable', text='', q=un_q, gold='UNKNOWN'))
    return facts

probes = []
for sid in range(N_SESSIONS):
    facts = make_facts(sid)
    answerable = facts[:5]
    random.shuffle(answerable)
    depths = sorted(random.sample([0.10,0.22,0.35,0.48,0.61,0.74,0.80], 5))
    total = 15000
    parts, pos = [], 0
    for fact, dp in zip(answerable, depths):
        gap = int(total*dp) - pos
        if gap > 400: parts.append(filler(gap)); pos += gap
        parts.append(fact['text']); pos += len(fact['text'])
    tail = total - pos
    if tail > 400: parts.append(filler(tail))
    txt = (f"=== session s{sid}: earlier coding session transcript ===\n" + ''.join(parts)
           + "\n=== end of transcript ===\n")
    open(f"{WORK}/s{sid}.txt",'w').write(txt)
    for f in facts:
        probes.append(dict(session=sid, type=f['type'], q=f['q'], gold=f['gold']))
json.dump(probes, open(f"{WORK}/probes.json",'w'), indent=1)
print(f"wrote {N_SESSIONS} sessions, {len(probes)} probes -> {WORK}")
