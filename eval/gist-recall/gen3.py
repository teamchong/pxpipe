#!/usr/bin/env python3
# Tier-3: state tracking across imaged history. A value mutates 3x; probe
# final value, first value, and change count. 45k chars, production density.
import json, random, os
random.seed(31337)
N=6
WORK=os.path.join(os.path.dirname(__file__),'work3'); os.makedirs(WORK,exist_ok=True)
REPO=os.path.abspath(os.path.join(os.path.dirname(__file__),'..','..'))
SRC=''.join(open(os.path.join(REPO,f)).read() for f in
 ['src/core/render.ts','src/core/transform.ts','src/core/proxy.ts','src/core/history.ts','src/dashboard.ts'])
def filler(n):
    i=random.randint(0,len(SRC)-n-1)
    f=random.choice(['src/core/render.ts','src/core/transform.ts','src/core/proxy.ts'])
    return f"[tool_use Read]\n{{\"file_path\":\"{f}\"}}\n[tool_result]\n{SRC[i:i+n]}\n[assistant]\nReviewed {f}.\n"
probes=[]
for sid in range(N):
    vals=random.sample([1200,1800,2400,3600,4800,5400,7200,8400,9600],3)
    knob=random.choice(['BATCH_WINDOW_MS','FLUSH_INTERVAL_MS','LEASE_TTL_MS','DEBOUNCE_MS'])
    events=[
      (0.10,f"[user]\nset {knob} to {vals[0]} to start.\n[assistant]\n{knob}={vals[0]} committed.\n"),
      (0.42,f"[user]\np95 regressed, bump {knob} to {vals[1]}.\n[assistant]\n{knob} changed {vals[0]} -> {vals[1]}.\n"),
      (0.76,f"[user]\nafter the load test, final answer: {knob} = {vals[2]}. lock it.\n[assistant]\n{knob} changed {vals[1]} -> {vals[2]}, locked.\n"),
    ]
    total=45000; parts=[]; pos=0
    for dp,text in events:
        gap=int(total*dp)-pos
        if gap>400: parts.append(filler(gap)); pos+=gap
        parts.append(text); pos+=len(text)
    if total-pos>400: parts.append(filler(total-pos))
    open(f"{WORK}/s{sid}.txt",'w').write(f"=== session s{sid} transcript ===\n"+''.join(parts)+"\n=== end ===\n")
    probes += [
      dict(session=sid,type='final', q=f"What is the FINAL (locked) value of {knob} at the end of the session?", gold=str(vals[2])),
      dict(session=sid,type='first', q=f"What was the FIRST value {knob} was set to at the start?", gold=str(vals[0])),
      dict(session=sid,type='count', q=f"How many distinct values was {knob} set to over the whole session? Answer with a number.", gold='3'),
    ]
json.dump(probes,open(f"{WORK}/probes.json",'w'),indent=1)
print(f"{N} sessions, {len(probes)} probes")
