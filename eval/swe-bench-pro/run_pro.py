#!/usr/bin/env python3
"""Paired SWE-bench Pro runs: pxpipe ON vs OFF. Generation only.

Measurement hygiene (the rules that make the numbers trustworthy):
- Bench-dedicated proxies on fresh ports (ON 47823, OFF 47824) with their own
  PXPIPE_LOG files. The operator's own Claude session (47821) can never
  pollute the bench logs - separation by construction, not by time-window.
- Docker grading does NOT involve the proxy at all: containers run the
  repo's test suite only, make no model calls, and get no ANTHROPIC_BASE_URL.
- Per-request savings come from the proxy's own `count_tokens` counterfactual
  probe (uncompressed body vs sent body), so they have no turn-count confound.

Quota safety (resume-by-default):
- Instances run sequentially; both arms of a pair run in parallel.
- Every patch/meta is written to disk the moment a run finishes.
- A pair whose patch file already exists is skipped, so if the weekly limit
  hits mid-bench, just re-run this script after the reset.
- If a run's transcript smells like a rate/usage-limit error, the script
  stops cleanly instead of burning the remaining instances on garbage.
"""
import json, os, re, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.expanduser("~/swe-pro-bench")
CACHE = os.path.join(WORK, "cache")
CLAUDE = os.path.expanduser("~/.claude/local/claude")
MODEL = "claude-fable-5"
ARMS = {"on": 47823, "off": 47824}
LOGS = {a: os.path.expanduser(f"~/.pxpipe/events-bench-{a}.jsonl") for a in ARMS}
TIMEOUT = 1800  # 30 min hard cap per run; Pro tasks are long-horizon
QUOTA_RE = re.compile(r"rate.?limit|usage limit|exceed.*limit|quota", re.I)

PROMPT = """You are implementing a change in this repository ({repo}).

# Issue
{problem}

# Requirements
{requirements}

# Interface
{interface}

Make the minimal source change to satisfy the requirements exactly (names,
signatures, types). Do NOT modify test files. The project's full test
environment is NOT installed here - do not run the test suite or install
dependencies; write the source code only. Leave your changes in the working
tree (do not commit)."""


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, **kw)


def ensure_proxies():
    """Bench proxies only. Compression: ON arm default-on, OFF arm forced off."""
    root = os.path.abspath(os.path.join(HERE, "..", ".."))
    for arm, port in ARMS.items():
        for attempt in range(3):
            if sh(f"curl -sf -o /dev/null http://127.0.0.1:{port}/").returncode == 0:
                break
            subprocess.Popen(
                ["node", "bin/cli.js"], cwd=root,
                env=dict(os.environ, PORT=str(port), PXPIPE_LOG=LOGS[arm]),
                stdout=open(f"/tmp/pxpipe-bench-{arm}.log", "a"),
                stderr=subprocess.STDOUT, start_new_session=True)
            time.sleep(3)
        else:
            sys.exit(f"FATAL: bench proxy '{arm}' did not come up on :{port}")
    for arm, port in ARMS.items():
        r = sh(f"curl -s http://127.0.0.1:{port}/api/compression "
               f"-X POST -H 'content-type: application/json' "
               f"-d '{{\"enabled\":{'true' if arm == 'on' else 'false'}}}'")
        print(f"[proxy] {arm} :{port} -> {r.stdout.strip()}")


def load_instances():
    with open(os.path.join(HERE, "instances.json")) as f:
        picks = json.load(f)
    import pyarrow.parquet as pq
    t = pq.read_table("/tmp/swepro.parquet").to_pylist()
    by_id = {r["instance_id"]: r for r in t}
    return [by_id[i] for i in picks]


def run_one(inst, arm):
    iid = inst["instance_id"]
    d = os.path.join(WORK, iid, arm)
    pdir = os.path.join(WORK, iid)
    patch_file = os.path.join(pdir, f"patch_{arm}.diff")
    if os.path.exists(patch_file):
        return iid, arm, "cached"
    os.makedirs(pdir, exist_ok=True)
    repo = inst["repo"]
    cache = os.path.join(CACHE, repo.replace("/", "_") + ".git")
    if not os.path.exists(cache):
        # clone to an arm-suffixed temp then rename: atomic vs the other arm
        tmp = f"{cache}.tmp-{arm}"
        sh(f"rm -rf {tmp}")
        r = sh(f"git clone -q --bare https://github.com/{repo}.git {tmp}")
        if r.returncode != 0:
            return iid, arm, "cache-clone-fail"
        if not os.path.exists(cache):
            os.rename(tmp, cache)
        else:
            sh(f"rm -rf {tmp}")
    sh(f"rm -rf {d}")
    r = sh(f"git clone -q {cache} {d} && git -C {d} checkout -q {inst['base_commit']}")
    if r.returncode != 0:
        return iid, arm, "checkout-fail"
    if inst.get("before_repo_set_cmd"):
        sh(inst["before_repo_set_cmd"], cwd=d)
    prompt = PROMPT.format(
        repo=repo,
        problem=(inst.get("problem_statement") or "").strip(),
        requirements=(inst.get("requirements") or "").strip() or "(see issue)",
        interface=(inst.get("interface") or "").strip() or "No new interfaces are introduced.",
    )
    env = dict(os.environ, ANTHROPIC_BASE_URL=f"http://127.0.0.1:{ARMS[arm]}")
    t0 = time.time()
    try:
        r = subprocess.run(
            [CLAUDE, "-p", "--model", MODEL, "--dangerously-skip-permissions", prompt],
            cwd=d, env=env, capture_output=True, text=True, timeout=TIMEOUT)
        rc, tail = r.returncode, ((r.stdout or "") + (r.stderr or ""))[-3000:]
    except subprocess.TimeoutExpired:
        rc, tail = -9, "TIMEOUT"
    dur = round(time.time() - t0, 1)
    diff = sh(f"git -C {d} diff", cwd=d).stdout
    open(patch_file, "w").write(diff)
    json.dump({"rc": rc, "dur_s": dur, "patch_bytes": len(diff), "tail": tail[-800:]},
              open(os.path.join(pdir, f"meta_{arm}.json"), "w"), indent=1)
    if rc != 0 and QUOTA_RE.search(tail):
        return iid, arm, "QUOTA"
    return iid, arm, f"done rc={rc} dur={dur}s patch={len(diff)}b"


def main():
    os.makedirs(CACHE, exist_ok=True)
    ensure_proxies()
    insts = load_instances()
    print(f"{len(insts)} instances; resume = skip existing patches\n")
    for inst in insts:
        with ThreadPoolExecutor(max_workers=2) as ex:
            results = list(ex.map(lambda a: run_one(inst, a), ARMS))
        for iid, arm, status in results:
            print(f"[{iid[:48]}] {arm}: {status}", flush=True)
        if any(s == "QUOTA" for _, _, s in results):
            print("\nUSAGE LIMIT HIT - stopping cleanly. Completed pairs are on "
                  "disk; re-run this script after the reset to resume.")
            sys.exit(2)
    # predictions for the grader
    for arm in ARMS:
        preds = []
        for inst in insts:
            pf = os.path.join(WORK, inst["instance_id"], f"patch_{arm}.diff")
            if os.path.exists(pf):
                preds.append({"instance_id": inst["instance_id"],
                              "patch": open(pf).read(), "prefix": ""})
        out = os.path.join(WORK, f"preds_{arm}.json")
        json.dump(preds, open(out, "w"))
        print(f"wrote {out} ({len(preds)} patches)")


if __name__ == "__main__":
    main()
