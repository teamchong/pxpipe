#!/usr/bin/env python3
"""Navidrome ON-arm replication: the 10-pair bench produced its single
ON/OFF split on this instance (ON fail, OFF pass) at n=1. Re-run the ON
arm 3 more times to see whether the fail reproduces or was agentic noise.

Separation by construction: dedicated proxy on :47825 with its own event
log (~/.pxpipe/events-nav-rep.jsonl) so the bench arm logs stay clean.
Reuses the bench git cache; grading happens afterwards with the official
harness against the already-cached navidrome Docker image.
"""
import json, os, subprocess, sys, time

IID = "instance_navidrome__navidrome-677d9947f302c9f7bba8c08c788c3dc99f235f39"
WORK = os.path.expanduser("~/swe-pro-nav-rep")
CACHE = os.path.expanduser("~/swe-pro-bench/cache")
CLAUDE = os.path.expanduser("~/.claude/local/claude")
MODEL = "claude-fable-5"
PORT = 47825
LOG = os.path.expanduser("~/.pxpipe/events-nav-rep.jsonl")
TIMEOUT = 1800
REPS = 3

PROMPT = """You are fixing a real GitHub issue in this repository ({repo}, Go).

<issue>
{problem}
</issue>

## Requirements
{requirements}

## Interface
{interface}

Rules:
- Find the root cause and make the minimal source change that fixes the issue.
- Do NOT modify any test files; fix the library/source code only.
- The project's full test environment is NOT installed here. Do not try to pip-install the project or run its full test suite; rely on reading the code. Tiny one-off python snippets to check pure logic are fine.
- Do not commit. Leave your changes in the working tree.
- When done, briefly state which file(s) you changed and why."""


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, **kw)


def ensure_proxy():
    r = sh(f"curl -sf http://127.0.0.1:{PORT}/api/stats >/dev/null 2>&1; lsof -nP -iTCP:{PORT} -sTCP:LISTEN | tail -1")
    if str(PORT) in r.stdout:
        return
    root = os.path.expanduser("~/Downloads/repos/pixelpipe")
    env = dict(os.environ, PORT=str(PORT), PXPIPE_LOG=LOG)
    subprocess.Popen(["node", "bin/cli.js"], cwd=root, env=env,
                     stdout=open(f"/tmp/pxpipe-nav-rep.log", "a"),
                     stderr=subprocess.STDOUT, start_new_session=True)
    time.sleep(3)
    r = sh(f"lsof -nP -iTCP:{PORT} -sTCP:LISTEN | tail -1")
    if str(PORT) not in r.stdout:
        sys.exit(f"FATAL: rep proxy did not come up on :{PORT}")


def main():
    import pyarrow.parquet as pq
    t = pq.read_table("/tmp/swepro.parquet").to_pylist()
    inst = next(r for r in t if r["instance_id"] == IID)
    cache = os.path.join(CACHE, inst["repo"].replace("/", "_") + ".git")
    assert os.path.exists(cache), "bench git cache missing"
    ensure_proxy()
    prompt = PROMPT.format(
        repo=inst["repo"],
        problem=(inst.get("problem_statement") or "").strip(),
        requirements=(inst.get("requirements") or "").strip() or "(see issue)",
        interface=(inst.get("interface") or "").strip() or "No new interfaces are introduced.",
    )
    env = dict(os.environ, ANTHROPIC_BASE_URL=f"http://127.0.0.1:{PORT}")
    for i in range(1, REPS + 1):
        d = os.path.join(WORK, f"rep{i}")
        pf = os.path.join(WORK, f"patch_rep{i}.diff")
        if os.path.exists(pf):
            print(f"rep{i}: cached"); continue
        sh(f"rm -rf {d}")
        r = sh(f"git clone -q {cache} {d} && git -C {d} checkout -q {inst['base_commit']}")
        if r.returncode != 0:
            print(f"rep{i}: checkout-fail"); continue
        t0 = time.time()
        try:
            r = subprocess.run([CLAUDE, "-p", "--model", MODEL, "--dangerously-skip-permissions", prompt],
                               cwd=d, env=env, capture_output=True, text=True, timeout=TIMEOUT)
            rc, tail = r.returncode, ((r.stdout or "") + (r.stderr or ""))[-800:]
        except subprocess.TimeoutExpired:
            rc, tail = -9, "TIMEOUT"
        dur = round(time.time() - t0, 1)
        diff = sh(f"git -C {d} diff", cwd=d).stdout
        open(pf, "w").write(diff)
        json.dump({"rc": rc, "dur_s": dur, "patch_bytes": len(diff), "tail": tail},
                  open(os.path.join(WORK, f"meta_rep{i}.json"), "w"), indent=1)
        print(f"rep{i}: done rc={rc} dur={dur}s patch={len(diff)}b")


if __name__ == "__main__":
    os.makedirs(WORK, exist_ok=True)
    main()
