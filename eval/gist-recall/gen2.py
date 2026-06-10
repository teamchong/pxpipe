#!/usr/bin/env python3
# Tier-2 (hard): 45k-char sessions + distractors that share surface form with the gold.
import json, random, os
random.seed(992260610)
N = 6
WORK = os.path.join(os.path.dirname(__file__), 'work2'); os.makedirs(WORK, exist_ok=True)
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC = ''.join(open(os.path.join(REPO,f)).read() for f in
  ['src/core/render.ts','src/core/transform.ts','src/core/proxy.ts','src/core/history.ts','src/dashboard.ts'])
def filler(n):
    i = random.randint(0, len(SRC)-n-1)
    f = random.choice(['src/core/render.ts','src/core/transform.ts','src/core/proxy.ts'])
    return f"[tool_use Read]\n{{\"file_path\":\"{f}\"}}\n[tool_result]\n{SRC[i:i+n]}\n[assistant]\nReviewed {f}.\n"
FIRST=['Mara','Priya','Tobias','Ingrid','Soren','Aiko','Dmitri','Lucia','Farid','Nadia']
LAST=['Okafor','Lindqvist','Tanaka','Moreau','Petrov','Alvarez','Khoury','Berg','Nakamura','Costa']
PKGS=['zustand','immer','valtio','jotai','mobx','redux-toolkit','xstate','nanostores']
DIRS=['scheduler','quota','retry','batcher','flusher','mailbox','journal','cursor']
FLAGS=['ENABLE_SHARDING','USE_BROTLI','STRICT_CAS','ASYNC_FSYNC','LEGACY_PINS','HOT_RELOAD_V2']
probes=[]
for sid in range(N):
    reviewer=f"{random.choice(FIRST)} {random.choice(LAST)}"; author=f"{random.choice(FIRST)} {random.choice(LAST)}"
    while author==reviewer: author=f"{random.choice(FIRST)} {random.choice(LAST)}"
    ms=random.choice([1250,2750,3400,4500,6200,7800,9100])+random.randint(0,9)*10
    ttl=ms+random.choice([500,1500,2500]); d=random.choice(DIRS)
    gold_path=f"src/{d}/core.ts"; decoy_path=f"src/{d}/io.ts"
    pick,reject=random.sample(PKGS,2); flag=random.choice(FLAGS)
    items=[
     (0.06, f"[user]\n{author} (the patch author) thinks {reject} would be fine here, docs are nice.\n[assistant]\n{reject} is a reasonable candidate; let me also benchmark {pick}.\n", None),
     (0.14, f"[assistant]\nNote: the cache TTL is {ttl}ms, unrelated to the retry budget discussion.\n", None),
     (0.22, f"[assistant]\nThe symptom first appeared in {decoy_path} (stack trace top frame), still tracing root cause.\n", None),
     (0.30, f"[user]\nstaging note: {flag} IS enabled in staging since Tuesday.\n[assistant]\nAck, {flag} on in staging.\n", None),
     (0.40, f"[user]\nfinal call after benchmarks: store layer goes with {pick}; {reject} rejected, bundle delta too big.\n[assistant]\nLocked in: {pick}.\n",
        dict(type='decision', q="What was the FINAL package chosen for the store layer?", gold=pick)),
     (0.50, f"[user]\nops: retry budget is exactly {ms}ms, do not confuse it with the cache TTL.\n[assistant]\nRetry budget set: {ms}ms.\n",
        dict(type='numeric', q="What exact value in ms was the RETRY BUDGET set to (not the cache TTL)?", gold=str(ms))),
     (0.60, f"[assistant]\nRoot cause found: the double-flush race is in {gold_path}; {decoy_path} was only the symptom site.\n[user]\nfix only the root cause file.\n",
        dict(type='path', q="Which file contained the ROOT CAUSE of the double-flush race?", gold=gold_path)),
     (0.70, f"[user]\nrouting: the on-call REVIEWER is {reviewer}; {author} stays author and cannot self-review.\n[assistant]\nPR review to {reviewer}.\n",
        dict(type='name', q="Who is the on-call REVIEWER for the PR (not the author)?", gold=reviewer)),
     (0.80, f"[user]\nimportant: in PROD, {flag} was NOT enabled, prod dashboard showed stale config cache.\n[assistant]\nConfirmed: {flag} OFF in prod, ON only in staging.\n",
        dict(type='negation', q=f"In PROD specifically, was {flag} enabled? Answer ENABLED or OFF.", gold='OFF')),
    ]
    total=45000; parts=[]; pos=0
    for dp,text,probe in items:
        gap=int(total*dp)-pos
        if gap>400: parts.append(filler(gap)); pos+=gap
        parts.append(text); pos+=len(text)
        if probe: probes.append(dict(session=sid, **probe))
    if total-pos>400: parts.append(filler(total-pos))
    open(f"{WORK}/s{sid}.txt",'w').write(f"=== session s{sid} transcript ===\n"+''.join(parts)+"\n=== end ===\n")
    probes.append(dict(session=sid, type='unanswerable', q=random.choice([
      "What port number was the staging proxy moved to?","Which database migration version was rolled back?",
      "What was the Docker base image pinned to?","Which AWS region was the failover assigned to?"]), gold='UNKNOWN'))
json.dump(probes, open(f"{WORK}/probes.json",'w'), indent=1)
print(f"wrote {N} sessions x45k chars, {len(probes)} probes")
