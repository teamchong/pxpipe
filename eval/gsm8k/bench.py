# GSM8K: text baseline vs pxpipe-rendered-image, both solved by `claude -p`.
# The image arm gets ONLY the PNG (problem text not in the prompt), so it must
# read the image to answer. Exact-match on the final integer.
import json, subprocess, re, os, sys
from concurrent.futures import ThreadPoolExecutor

N     = int(os.environ.get('N', '100'))
OFF   = int(os.environ.get('OFF', '100'))
MODEL = os.environ.get('MODEL')
if not MODEL:
    sys.exit("bench.py: MODEL is not set — refusing to guess a model.\n"
             "  MODEL=claude-opus-5 python3 eval/gsm8k/bench.py")
DATA  = os.environ.get('GSM_DATA', '/tmp/gsm8k_test.jsonl')
IMGS  = os.environ.get('GSM_IMGS', './imgs')
CCI   = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib', 'cci.py')

probs = [json.loads(l) for l in open(DATA).read().strip().split('\n')[OFF:OFF + N]]

def gold(p): return p['answer'].split('####')[-1].strip().replace(',', '')
def numify(s):
    if s is None: return None
    s = str(s).replace(',', '').replace('$', '').strip().rstrip('.')
    try: return float(s)
    except: return None
NO_MARKER = []   # every trial whose score came from the unsound fallback below
def extract(out):
    if not out: return None
    m = re.search(r'ANSWER:\s*\$?(-?[\d.,]+)', out)
    if m: return m.group(1)
    # No ANSWER: marker. cci.py returns terse output ("8435 + 5591 = 14026;
    # 14026 + 2365 = 16391") and NO model actually emits the marker, so this
    # fallback is load-bearing for every number this bench has ever produced.
    # It is also unsound: it returns the last number found anywhere, so an arm
    # that merely echoes the problem scores as a confident wrong answer. That
    # is how the opus-5 image arm produced a clean 0/100 in which all 100
    # recorded "answers" were exactly the last number of the problem text
    # (8435,5591,2365 -> 2365). Kept, because removing it voids the working
    # text arm too -- but every use is now counted and reported below.
    nums = re.findall(r'-?\d[\d,]*(?:\.\d+)?', out)
    if not nums: return None
    NO_MARKER.append(1)
    return nums[-1]
# Trials must bypass the pxpipe proxy. If ANTHROPIC_BASE_URL points at the local
# proxy, each trial's context gets imaged and the measurement is invalid (reads as
# a near-zero score). Mirrors the guard already present in eval/gist-recall/run.py
# and eval/verbatim-15/run.py, which strip this var the same way.
BASE_ENV = {k: v for k, v in os.environ.items() if k != 'ANTHROPIC_BASE_URL'}

def claude(prompt, timeout=180):
    try:
        return subprocess.run([sys.executable, CCI, '--model', MODEL, '--allowedTools', 'Read', prompt],
                              capture_output=True, text=True, timeout=timeout,
                              env=dict(BASE_ENV, CCI_TIMEOUT=str(max(30, timeout - 30)))).stdout
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
bu = sum(1 for r in res if r[3] is None); iu = sum(1 for r in res if r[4] is None)
print(f"N={N} (offset {OFF}, model {MODEL})")
print(f"  baseline (text)   = {bc}/{N} = {100*bc/N:.1f}%  (no answer at all: {bu}/{N})")
print(f"  pxpipe (image) = {ic}/{N} = {100*ic/N:.1f}%  (no answer at all: {iu}/{N})")
# Provenance of the scores above. Trials with no ANSWER: marker were scored by
# taking the last number in the transcript, which cannot distinguish "computed
# the answer" from "echoed the problem". Publish nothing from a run where this
# is high without checking the misses against the problems' own numbers.
if NO_MARKER:
    print(f"  !! {len(NO_MARKER)}/{2*N} arms had no ANSWER: marker and were scored "
          f"by last-number fallback -- these scores are not trustworthy on their own.")
print(f"  delta             = {100*(ic-bc)/N:+.1f} pp")
for i, (bok, iok, g, b, im) in enumerate(res):
    if bok and not iok:
        print(f"    image miss q{i}: gold={g} text={b} image={im}")
