#!/usr/bin/env python3
import os, sys, subprocess, secrets, re
from PIL import Image, ImageDraw, ImageFont

FONT = "/System/Library/Fonts/SFNSMono.ttf"
WORK = "/tmp/needle_eval/sweep"
os.makedirs(WORK, exist_ok=True)
W, H = 1568, 1276          # pixelpipe-equivalent dims -> ~2668 image tokens
IMG_TOKENS = round(W*H/750)

FILLER = ("the quick brown fox jumps over the lazy dog while the cache layer "
          "evicts stale keys and the scheduler drains the queue in order ").split()

def needle(): return secrets.token_hex(6)

def make_lines(pt, n_needle_line, needle_val):
    font = ImageFont.truetype(FONT, pt)
    # chars per line at this font
    cw = font.getbbox("M")[2]
    cpl = max(8, (W-40)//cw)
    lh = int(pt*1.35)
    nlines = (H-40)//lh
    words = (FILLER*200)
    lines, wi = [], 0
    for _ in range(nlines):
        ln = ""
        while wi < len(words) and len(ln)+len(words[wi])+1 <= cpl:
            ln += words[wi]+" "; wi += 1
        lines.append(ln.rstrip())
    mid = nlines//2
    lines[mid] = f"SECRET_TOKEN = {needle_val}"[:cpl]
    chars = sum(len(l) for l in lines)
    return font, lines, lh, chars

def render(pt, path, needle_val):
    font, lines, lh, chars = make_lines(pt, None, needle_val)
    img = Image.new("RGB",(W,H),"white"); d=ImageDraw.Draw(img)
    y=20
    for ln in lines:
        d.text((20,y),ln,fill="black",font=font); y+=lh
    img.save(path)
    return chars

def ask(path):
    p=(f"Read the image at {path}. What is the value of SECRET_TOKEN? "
       "Reply with ONLY the value, no other words.")
    out=subprocess.run(["claude","-p","--model","claude-opus-4-8",
        "--no-session-persistence",p],capture_output=True,text=True,
        timeout=120,cwd=WORK).stdout
    m=re.search(r'[0-9a-f]{12}',out); return m.group(0) if m else ""

def run(pt,n):
    ok=0; chars=0
    for i in range(1,n+1):
        nd=needle(); path=f"{WORK}/{pt}_{i}.png"
        chars=render(pt,path,nd)
        got=ask(path); hit=int(got==nd); ok+=hit
        print(f"  {pt}pt trial{i}: {nd} -> {got or '-'} {'OK' if hit else 'x'}")
    # text-equivalent tokens of the chars packed in one image (cc empirical ~3.5 c/tok generic)
    txt_tok=round(chars/3.5)
    ratio=txt_tok/IMG_TOKENS
    print(f">>> {pt}pt: {ok}/{n} ({100*ok/n:.0f}%) | chars/img={chars} "
          f"| img_tok={IMG_TOKENS} txt_tok~{txt_tok} | compression={ratio:.2f}x")

if __name__=="__main__":
    n=int(sys.argv[2]) if len(sys.argv)>2 else 6
    for pt in [int(x) for x in sys.argv[1].split(",")]:
        run(pt,n)
