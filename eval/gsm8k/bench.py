# GSM8K: text baseline vs pixelpipe-rendered-image, both solved by `claude -p`.
# The image arm gets ONLY the PNG (problem text not in the prompt), so it must
# read the image to answer. Exact-match on the final integer.
import json, subprocess, re, os
from concurrent.futures import ThreadPoolExecutor

N     = int(os.environ.get('N', '100'))
OFF   = int(os.environ.get('OFF', '100'))
MODEL = os.environ.get('MODEL', 'claude-opus-4-8')
DATA  = os.environ.get('GSM_DATA', '/tmp/gsm8k_test.jsonl')
IMGS  = os.environ.get('GSM_IMGS', './imgs')

probs = [json.loads(l) for l in open(DATA).read().strip().split('\n')[OFF:OFF + N]]

def gold(p): return p['answer'].split('####')[-1].strip().replace(',', '')
def numify(s):
    if s is None: return None
    s = str(s).replace(',', '').replace('$', '').strip().rstrip('.')
    try: return float(s)
    except: return None
def extract(out):
    if not out: return None
    m = re.search(r'ANSWER:\s*\$?(-?[\d.,]+)', out)
    if m: return m.group(1)
    nums = re.findall(r'-?\d[\d,]*(?:\.\d+)?', out)
    return nums[-1] if nums else None
def claude(prompt, timeout=180):
    try:
        return subprocess.run(['claude', '-p', '--model', MODEL, prompt],
                              capture_output=True, text=True, timeout=timeout).stdout
    except Exception:
        return ''
def one(args):
    i, p = args
    g = numify(gold(p))
    b  = numify(extract(claude(
        f"Solve this math problem. Show brief reasoning, then end with exactly 'ANSWER: <number>'.\n\n{p['question']}")))
    im = numify(extract(claude(
        f"A math word problem is shown in the image at {IMGS}/q{i}.png. "
        f"Read the problem from the image, solve it, then end with exactly 'ANSWER: <number>'.")))
    return (b is not None and b == g, im is not None and im == g, g, b, im)

with ThreadPoolExecutor(max_workers=6) as ex:
    res = list(ex.map(one, list(enumerate(probs))))

bc = sum(1 for r in res if r[0]); ic = sum(1 for r in res if r[1])
print(f"N={N} (offset {OFF}, model {MODEL})")
print(f"  baseline (text)   = {bc}/{N} = {100*bc/N:.1f}%")
print(f"  pixelpipe (image) = {ic}/{N} = {100*ic/N:.1f}%")
print(f"  delta             = {100*(ic-bc)/N:+.1f} pp")
for i, (bok, iok, g, b, im) in enumerate(res):
    if bok and not iok:
        print(f"    image miss q{i}: gold={g} text={b} image={im}")
