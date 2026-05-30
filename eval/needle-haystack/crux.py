#!/usr/bin/env python3
import os, sys, subprocess, secrets, re

FONT = "/System/Library/Fonts/SFNSMono.ttf"
from PIL import Image, ImageDraw, ImageFont

WORK = "/tmp/needle_eval/crux"
os.makedirs(WORK, exist_ok=True)

def hexneedle():
    return secrets.token_hex(6)  # 12 hex chars

def render_billboard(text, path):
    # one line, huge font, lots of whitespace
    font = ImageFont.truetype(FONT, 120)
    img = Image.new("RGB", (1400, 500), "white")
    d = ImageDraw.Draw(img)
    bb = d.textbbox((0,0), text, font=font)
    w, h = bb[2]-bb[0], bb[3]-bb[1]
    d.text(((1400-w)/2, (500-h)/2 - bb[1]), text, fill="black", font=font)
    img.save(path)

def render_clean(needle, path):
    # moderate font, real hard newlines, hex on its own labeled line, light context
    font = ImageFont.truetype(FONT, 30)
    lines = [
        "Configuration reference",
        "",
        "    cache.ttl_seconds = 3600",
        "    cache.max_value_kb = 256",
        "",
        f"    SECRET_TOKEN = {needle}",
        "",
        "    rate.refill_per_sec = 10",
        "    rate.burst_capacity = 30",
    ]
    img = Image.new("RGB", (1100, 420), "white")
    d = ImageDraw.Draw(img)
    y = 30
    for ln in lines:
        d.text((40, y), ln, fill="black", font=font)
        y += 42
    img.save(path)

def ask_opus(path, what):
    prompt = (f"Read the image at {path}. {what} "
              "Reply with ONLY the value, no other words, no punctuation.")
    out = subprocess.run(
        ["claude","-p","--model","claude-opus-4-8","--no-session-persistence", prompt],
        capture_output=True, text=True, timeout=120, cwd=WORK,
    ).stdout
    m = re.search(r'[0-9a-f]{12}', out)
    return (m.group(0) if m else ""), out.strip().replace("\n"," ")[:80]

def run(tier, n):
    ok = 0
    for i in range(1, n+1):
        needle = hexneedle()
        path = f"{WORK}/{tier}_{i}.png"
        if tier == "billboard":
            render_billboard(needle, path)
            what = "What is the hex string shown?"
        else:
            render_clean(needle, path)
            what = "What is the value of SECRET_TOKEN?"
        got, raw = ask_opus(path, what)
        hit = int(got == needle)
        ok += hit
        print(f"{tier}\t{i}\t{needle}\t{got or '-'}\t{hit}\t{raw}")
    print(f">>> {tier}: {ok}/{n}  {100*ok/n:.0f}%")

if __name__ == "__main__":
    tier = sys.argv[1]; n = int(sys.argv[2])
    run(tier, n)
