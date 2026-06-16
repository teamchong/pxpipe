#!/usr/bin/env python3
# Grade the cell-size sweep. Two metrics per size:
#   per-label  = right hex id under the right label (strict; needs read + row-assoc)
#   bag-of-ids = gold ids found ANYWHERE in output (isolates pure glyph reading)
import json, os, re, sys
from collections import Counter

D = "/tmp/sweep"
golds = json.load(open(f"{D}/golds.json"))
TAG = sys.argv[1] if len(sys.argv) > 1 else "opus"
CELL = {"s0":"5x8","s1":"7x10","s2":"10x16","s3":"14x22","s4":"20x32"}
LINE = re.compile(r"^\s*([A-E])\s*[:.]\s*`?([0-9a-fA-F]{12})`?\s*$")
HEX12 = re.compile(r"[0-9a-fA-F]{12}")

print(f"tag={TAG}")
print(f"{'cell':7s} {'per-label':>10s} {'bag-of-ids':>11s}  pages  top confusions")
for k in ["s0","s1","s2","s3","s4"]:
    lab_hit=lab_tot=bag_hit=bag_tot=pages=bad=0
    conf=Counter()
    for i in range(len(golds[k])):
        p=f"{D}/out_{TAG}_{k}_{i}.txt"
        if not os.path.exists(p) or os.path.getsize(p)==0: bad+=1; continue
        txt=open(p).read()
        labeled={}
        for ln in txt.splitlines():
            m=LINE.match(ln.strip())
            if m: labeled[m.group(1)]=m.group(2).lower()
        allids={h.lower() for h in HEX12.findall(txt)}
        gold=golds[k][i]
        pages+=1
        # bag: each gold id present anywhere?
        for lbl,gid in gold.items():
            bag_tot+=1
            if gid in allids: bag_hit+=1
        # per-label (only if model gave 5 clean labeled lines)
        if len(labeled)==5:
            for lbl,gid in gold.items():
                lab_tot+=1
                g=labeled.get(lbl,"")
                if g==gid: lab_hit+=1
                elif len(g)==12:
                    for a,b in zip(gid,g):
                        if a!=b: conf[(a,b)]+=1
    lp=f"{100*lab_hit/lab_tot:.0f}%" if lab_tot else "--"
    bp=f"{100*bag_hit/bag_tot:.0f}%" if bag_tot else "--"
    cf=", ".join(f"{a}->{b}x{n}" for (a,b),n in sorted(conf.items(),key=lambda x:-x[1])[:6])
    print(f"{CELL[k]:7s} {lab_hit:2d}/{lab_tot:<2d} {lp:>4s} {bag_hit:2d}/{bag_tot:<2d} {bp:>4s}  {pages}pg b{bad}  {cf}")
