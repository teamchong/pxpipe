#!/usr/bin/env python3
# Paired SWE-bench Lite pilot: same instance, same model, proxy compression ON vs OFF.
# Generation only - grading happens afterwards via swebench.harness.run_evaluation.
import json, os, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = "/tmp/swe-pilot/cache"
WORK = "/tmp/swe-pilot/work"
CLAUDE = os.path.expanduser("~/.claude/local/claude")
ARMS = {"on": "http://localhost:47821", "off": "http://localhost:47822"}
TIMEOUT = 1500  # 25 min per run, hard cap

PROMPT = """You are fixing a real GitHub issue in this repository.

<issue>
{problem}
</issue>

Rules:
- Find the root cause and make the minimal source change that fixes the issue.
- Do NOT modify any test files; fix the library/source code only.
- The project's full test environment is NOT installed here. Do not try to pip-install the project or run its full test suite; rely on reading the code. Tiny one-off python snippets to check pure logic are fine.
- Do not commit. Leave your changes in the working tree.
- When done, briefly state which file(s) you changed and why."""

def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, **kw)

def run_one(inst, arm):
    iid = inst["instance_id"]
    repo = inst["repo"]
    cache = os.path.join(CACHE, repo.replace("/", "_") + ".git")
    d = os.path.join(WORK, iid, arm)
    patch_file = os.path.join(WORK, iid, f"patch_{arm}.diff")
    meta_file = os.path.join(WORK, iid, f"meta_{arm}.json")
    if os.path.exists(patch_file):  # resume support
        return iid, arm, "cached"
    sh(f"rm -rf {d} && mkdir -p {d}")
    r = sh(f"git clone -q {cache} {d} && git -C {d} checkout -q {inst['base_commit']}")
    if r.returncode != 0:
        open(meta_file, "w").write(json.dumps({"error": "clone: " + r.stderr[-500:]}))
        return iid, arm, "clone-fail"
    env = dict(os.environ,
               ANTHROPIC_BASE_URL=ARMS[arm],
               CLAUDE_CONFIG_DIR=os.path.expanduser("~/.claude"),
               CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS="1")
    t0 = time.time()
    try:
        r = subprocess.run(
            [CLAUDE, "-p", PROMPT.format(problem=inst["problem_statement"]),
             "--dangerously-skip-permissions"],
            cwd=d, env=env, capture_output=True, text=True, timeout=TIMEOUT)
        status, out = r.returncode, (r.stdout or "")[-2000:]
    except subprocess.TimeoutExpired:
        status, out = -9, "TIMEOUT"
    dur = round(time.time() - t0, 1)
    sh(f"git -C {d} add -N .")  # include untracked files in diff
    diff = sh(f"git -C {d} diff {inst['base_commit']}").stdout
    open(patch_file, "w").write(diff)
    open(meta_file, "w").write(json.dumps(
        {"status": status, "dur_s": dur, "patch_bytes": len(diff), "tail": out}))
    return iid, arm, f"done {dur}s patch={len(diff)}b"

def main():
    insts = json.load(open(os.path.join(HERE, "instances.json")))
    os.makedirs(WORK, exist_ok=True)
    # interleave arms so both proxies see similar load over time
    jobs = [(i, a) for i in insts for a in ("on", "off")]
    with ThreadPoolExecutor(max_workers=2) as ex:
        for iid, arm, msg in ex.map(lambda j: run_one(*j), jobs):
            print(f"[{time.strftime('%H:%M:%S')}] {iid} {arm}: {msg}", flush=True)
    # build predictions files
    for arm in ("on", "off"):
        preds = []
        for inst in insts:
            pf = os.path.join(WORK, inst["instance_id"], f"patch_{arm}.diff")
            patch = open(pf).read() if os.path.exists(pf) else ""
            preds.append({"instance_id": inst["instance_id"],
                          "model_name_or_path": f"pxpipe-{arm}",
                          "model_patch": patch})
        out = os.path.join(HERE, f"preds_{arm}.json")
        json.dump(preds, open(out, "w"), indent=1)
        print("wrote", out, "non-empty:", sum(1 for p in preds if p["model_patch"].strip()))

if __name__ == "__main__":
    main()
