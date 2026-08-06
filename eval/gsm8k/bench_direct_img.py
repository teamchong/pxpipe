import json,re,os,subprocess,sys
from concurrent.futures import ThreadPoolExecutor
D=os.path.dirname(os.path.abspath("eval/gsm8k/x"))
IMGS=os.path.join(D,"novel_imgs_claude-opus-5")
gold=[json.loads(l) for l in open("/tmp/novel.jsonl")]
N=min(len(gold),len(os.listdir(IMGS)))
def g(a): return re.sub(r'[^\d-]','',a["answer"].split("####")[-1])
def one(i):
    p=(f"A math word problem is shown in the image at {IMGS}/q{i}.png. "
       "Read the problem from the image, solve it, then end with exactly 'ANSWER: <number>'.")
    try:
        r=subprocess.run(["claude","-p","--allowedTools","Read","--model","claude-opus-5",p],
            capture_output=True,text=True,timeout=300,stdin=subprocess.DEVNULL)
        o=r.stdout
    except Exception as e: return i,None,g(gold[i]),f"ERR {e}"
    m=re.search(r'ANSWER:\s*(-?[\d,]+)',o)
    return i,(m.group(1).replace(",","") if m else None),g(gold[i]),o[-200:]
res=[]
with ThreadPoolExecutor(max_workers=8) as ex:
    for t in ex.map(one,range(N)):
        res.append(t); print("done",t[0],t[1],"gold",t[2],flush=True)
hit=sum(1 for _,p,gg,_ in res if p is not None and p==gg)
nom=sum(1 for _,p,_,_ in res if p is None)
print(f"\n=== IMAGE ARM (direct claude -p, no cci.py) ===")
print(f"score {hit}/{N}   no-ANSWER-marker: {nom}/{N}")
json.dump([{"i":i,"pred":p,"gold":gg} for i,p,gg,_ in res],open("/tmp/real_arith.json","w"),indent=1)
for i,p,gg,tail in res:
    if p!=gg: print(f"  miss q{i}: gold={gg} pred={p} tail={tail!r}"[:300])
