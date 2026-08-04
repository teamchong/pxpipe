#!/usr/bin/env python3
"""Run one shard of DeepSWE v1.1 through Claude Code + pxpipe, on a Max subscription.

Wiring, and why it is not just ANTHROPIC_BASE_URL=http://127.0.0.1:47821:

  agent container -> squid -> host:80 -> socat -> host:47821 (pxpipe) -> upstream

Pier seals the agent container on an `internal: true` network and gives it exactly
one exit: a squid sidecar whose ACL is derived from the hostname of
ANTHROPIC_BASE_URL. Two constraints fall out of squid's generated config:

    acl Safe_ports port 80 443
    http_access deny !Safe_ports

so the base URL must land on port 80 (plain HTTP, no CONNECT, no CA to install),
and the container cannot reach 127.0.0.1 at all. Hence host.docker.internal and
the socat shim publishing host port 80 -> pxpipe. Publishing 80 through Docker
needs no sudo; binding it directly from pxpipe would.

Auth reuses the host's own subscription the way cci does: the macOS keychain item
holds an sk-ant-oat01 access token, and pier already forwards
CLAUDE_CODE_OAUTH_TOKEN into the container, so no `claude setup-token` is needed.
The token is short lived and only the host refreshes it, so it is re-read from
the keychain before every task rather than captured once at startup.

Resume: state lives in the results tree, not in memory. A task with a reward.json
is done and is skipped, so re-running the same shard after a quota cutoff picks
up exactly where it stopped.
"""

import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Not /tmp: macOS wipes it on reboot, which killed a shard at startup with
# FileNotFoundError after 0 tasks. Sibling checkout of the tasks repo.
TASKS = Path(os.environ.get(
    "DEEPSWE_TASKS", HERE.parents[2] / "deep-swe" / "tasks"))
RESULTS = Path(os.environ.get("DEEPSWE_RESULTS", HERE / "results"))
MANIFEST = RESULTS / "manifest.jsonl"

PXPIPE_PORT = int(os.environ.get("PXPIPE_PORT", "47821"))
SHIM_NAME = "pxpipe-deepswe-80"
BASE_URL = "http://host.docker.internal"  # port 80 by squid's Safe_ports
MODEL = os.environ.get("DEEPSWE_MODEL", "claude-opus-5")
NO_PROXY = False  # set by --no-proxy; control arm talks to api.anthropic.com

# ---------------------------------------------------------------------------
# Tunables. Edit the numbers here; nothing else in this file hardcodes them.
# ---------------------------------------------------------------------------
# Reasoning effort handed to the agent. The system card's 68.8% is a high-effort
# run. Unset resolves to high inside the container anyway, but pinning it is
# what puts the value in the manifest, so a result can be attributed later.
EFFORT = "high"  # low | medium | high | max
# Every DeepSWE task.toml gives the agent the same budget. Nothing reads the
# file; this is the number to change if the task set ever ships a different one.
AGENT_BUDGET_S = 5400.0
# pxpipe renders history to PNGs, which costs wall clock that the 5400s never
# accounted for: measured 22.6 s/turn against 9.5 s bare. Scale the agent's
# budget rather than the verifier's, and document it in the PR.
AGENT_TIMEOUT_MULTIPLIER = 2.0
# Grading happens after the agent stops and is not covered by the agent budget.
VERIFIER_SLACK_MIN = 30.0
# Our own SIGKILL on the pier process, and the one that actually bit: set below
# the agent budget it fires first, subprocess.run kills the trial before it can
# write reward.json, and the task is recorded as TIMEOUT instead of as whatever
# the agent was about to score. Derived so the two can no longer disagree by
# accident -- raise the multiplier and this follows it.
TASK_TIMEOUT_MIN = AGENT_BUDGET_S * AGENT_TIMEOUT_MULTIPLIER / 60 + VERIFIER_SLACK_MIN
# Wall clock after which a --shard worker stops picking up new tasks. Tasks
# already running are not interrupted, so a shard can overrun this by one task.
BUDGET_MIN = 270.0
# ---------------------------------------------------------------------------

# The proxy re-reads this per request, so the bearer the container froze at
# startup stops mattering. Shared by all shards: one writer, one credential.
TOKEN_FILE = Path(os.environ.get(
    "ANTHROPIC_OAUTH_TOKEN_FILE", Path.home() / ".pxpipe-deepswe-token"))


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, **kw)


def oauth_token(min_valid_s=900):
    """Host subscription token, refreshed if it won't outlive min_valid_s.

    Only the host CLI can refresh; the container gets a bearer string it cannot
    renew. A one-turn host call is the cheapest way to force a rotation.

    The bearer is frozen at container start, so a token merely valid *now* is
    not enough: a task that runs 110 min with 20 min of token left dies at
    minute 21 with "OAuth access token has expired" and grades as a real
    failure. Callers pass the task timeout so the whole run is covered.
    """
    def read():
        # Two stores, and the CLI moves between them across versions/logins:
        # keychain items keyed by config dir ("Claude Code-credentials-<hash>",
        # several stale ones accumulate including the unsuffixed legacy name)
        # and the plain file $CLAUDE_CONFIG_DIR/.credentials.json. Read both and
        # take the newest, so a login that lands in one store isn't invisible.
        blobs = []
        dump = sh("security dump-keychain")
        names = set(re.findall(r'"svce"<blob>="(Claude Code-credentials[^"]*)"', dump.stdout))
        for n in names:
            r = sh(f'security find-generic-password -s "{n}" -w')
            if r.returncode == 0:
                blobs.append(r.stdout)
        cfg = os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude"
        for d in {cfg, "~/.claude"}:
            p = Path(d).expanduser() / ".credentials.json"
            if p.is_file():
                blobs.append(p.read_text())
        best = None
        for b in blobs:
            try:
                c = json.loads(b)["claudeAiOauth"]
                exp = c["expiresAt"]
            except (json.JSONDecodeError, KeyError, TypeError):
                continue
            if best is None or exp > best["expiresAt"]:
                best = c
        return best

    c = read()
    if c and c["expiresAt"] / 1000 - time.time() > min_valid_s:
        return c["accessToken"]
    # Refresh must reach api.anthropic.com; inheriting ANTHROPIC_BASE_URL sends
    # it into pxpipe, which answers fine and never rotates anything.
    clean = {k: v for k, v in os.environ.items()
             if k not in ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN",
                          "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN")}
    sh("claude -p ok --max-turns 1", env=clean)  # rotates the keychain item
    c = read()
    if not c or c["expiresAt"] / 1000 < time.time():
        return None
    return c["accessToken"]


def write_token_file():
    """Publish the current host token where the proxy can re-read it.

    Atomic: the proxy stats this file on every request, so a partial write would
    be served as a bearer. Created 0600 because it is a live credential.
    """
    tok = oauth_token(min_valid_s=1800)
    if tok is None:
        return False
    tmp = TOKEN_FILE.with_suffix(".tmp")
    # 0600 at creation: chmod after writing leaves the token briefly readable
    # by any user on the host.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(tok)
    os.replace(tmp, TOKEN_FILE)
    return True


def token_refresher():
    """Keep TOKEN_FILE ahead of expiry for as long as the shard runs.

    This is what unbinds task length from token life: the container's bearer is
    frozen at start, but the proxy substitutes whatever is in this file, so a
    task can outlive the token it started with.
    """
    def loop():
        while True:
            time.sleep(900)
            try:
                write_token_file()
            except OSError:
                pass  # next tick retries; the proxy keeps the last good token
    threading.Thread(target=loop, daemon=True).start()


def pxpipe_serve_has_token_file():
    """True if the proxy holding PXPIPE_PORT already has the env var wired.

    Shards run 4-up and each calls pxpipe_up(), so restarting unconditionally
    would drop the other shards' in-flight requests.

    Ask the port who owns it rather than matching argv: a proxy started as
    `pnpm run restart` is `node bin/cli.js`, which no 'pxpipe serve' pattern
    matches, so argv matching reports "no token file" for a perfectly good
    proxy and we spawn a duplicate that cannot bind.
    """
    for pid in sh(f"lsof -nP -iTCP:{PXPIPE_PORT} -sTCP:LISTEN -t").stdout.split():
        if "ANTHROPIC_OAUTH_TOKEN_FILE=" in sh(f"ps eww {pid}").stdout:
            return True
    return False


def pxpipe_up():
    """Bind non-loopback: the shim container dials host.docker.internal."""
    probe = (
        "docker run --rm --add-host host.docker.internal:host-gateway alpine/socat "
        f"-T2 - TCP:host.docker.internal:{PXPIPE_PORT} </dev/null"
    )
    if sh(probe).returncode == 0:
        if pxpipe_serve_has_token_file():
            return True
        # Up, but from before the token file existed: it would forward the
        # container's frozen bearer and expire mid-task. Nothing is in flight
        # yet at shard start, so a restart here is cheap.
        sh("pkill -f 'pxpipe serve'")
        time.sleep(2)
    log = RESULTS / "pxpipe.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    subprocess.Popen(
        ["pxpipe", "serve", "--port", str(PXPIPE_PORT)],
        env=dict(os.environ, HOST="0.0.0.0",
                 ANTHROPIC_OAUTH_TOKEN_FILE=str(TOKEN_FILE)),
        stdout=log.open("a"), stderr=subprocess.STDOUT, start_new_session=True,
    )
    for _ in range(20):
        time.sleep(1)
        if sh(probe).returncode == 0:
            return True
    return False


def pid_alive(pid):
    try:
        os.kill(pid, 0)
    except (OSError, ValueError):
        return False
    return True


def state_dir():
    """Claims and the git lock, kept out of RESULTS so they never get committed.

    Per results dir, so the two arms cannot claim each other's tasks.
    """
    d = Path.home() / ".pxpipe-deepswe-state" / RESULTS.name
    d.mkdir(parents=True, exist_ok=True)
    return d


def claim(task):
    """Take exclusive ownership of a task, or report someone else has it.

    Continuous mode has no fixed shard slices, so all workers see the same queue
    and must agree on who runs what. mkdir is the atomic primitive; the pid
    inside lets a later worker reclaim a task whose owner was killed mid-run
    (docker crash, disk full, reboot), which a bare lockfile could not.
    """
    d = state_dir() / "claims" / task
    try:
        d.mkdir(parents=True)
    except FileExistsError:
        try:
            owner = int((d / "pid").read_text())
        except (OSError, ValueError):
            owner = None
        if owner is not None and owner != os.getpid() and pid_alive(owner):
            return False
    (d / "pid").write_text(str(os.getpid()))
    time.sleep(0.5)  # settle a two-way reclaim race before burning tokens
    try:
        return int((d / "pid").read_text()) == os.getpid()
    except (OSError, ValueError):
        return False


def commit(task, reward):
    """Checkpoint one task's artifacts. Workers serialize on the flock.

    Per task, not per batch: a run that dies at task 60 should leave 59 tasks
    committed, not zero. Concurrent `git add` would otherwise fight over
    index.lock and lose a worker's results.
    """
    with (state_dir() / "gitlock").open("w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        sh(f"git add -A {RESULTS}")
        sh(f'git commit -q -m "eval: {task} reward={reward}"')


def task_ids():
    return sorted(p.name for p in TASKS.iterdir() if (p / "task.toml").exists())


def reward_of(task):
    """Terminal state for a task, or None if it never got graded."""
    for p in sorted((RESULTS / task).rglob("reward.json")):
        try:
            return json.loads(p.read_text())
        except (OSError, json.JSONDecodeError):
            continue
    return None


def usage_of(task):
    """Token totals for a task, summed over the agent's session transcript.

    pier does not aggregate usage anywhere, so the only source is the per-message
    `usage` block the CLI writes into its session jsonl.
    """
    tot = {"input_tokens": 0, "output_tokens": 0,
           "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}
    turns = 0
    efforts = set()
    for p in (RESULTS / task).rglob("*.jsonl"):
        for line in p.read_text(errors="replace").splitlines():
            if '"effort"' in line:
                efforts.update(re.findall(r'"effort"\s*:\s*"([^"]*)"', line))
            try:
                u = json.loads(line).get("message", {}).get("usage")
            except json.JSONDecodeError:
                continue
            if not isinstance(u, dict):
                continue
            turns += 1
            for k in tot:
                v = u.get(k)
                if isinstance(v, int):
                    tot[k] += v
    tot["assistant_turns"] = turns
    # What we set, not what a transcript scrape happened to find. The scrape goes
    # empty whenever the jsonl is missing or rotated before we read it, which used
    # to record effort=None on runs that demonstrably sent high on the wire.
    tot["effort"] = EFFORT
    tot["effort_observed"] = sorted(efforts)
    return tot


def preflight():
    """Fail before burning quota, not 40 minutes into a shard."""
    problems = []
    if not TASKS.is_dir():
        problems.append(f"tasks dir missing: {TASKS} (git clone datacurve-ai/deep-swe)")
    if sh("docker info").returncode != 0:
        problems.append("docker daemon is not running")
    if oauth_token() is None:
        problems.append(
            "no usable subscription token: keychain item missing or expired and "
            "a host refresh call did not renew it. Run `claude` once and retry."
        )
    if not NO_PROXY and not pxpipe_up():
        problems.append(f"pxpipe did not come up on 0.0.0.0:{PXPIPE_PORT}")
    return problems


def shim_up():
    """Publish host:80 -> pxpipe. Idempotent."""
    running = lambda: bool(sh(f"docker ps -q -f name=^{SHIM_NAME}$").stdout.strip())
    if running():
        return
    # Parallel shards all race here for one shared container. Never `rm -f`: that
    # would kill a shim a sibling just started. Losing the name race is success.
    sh(f"docker rm {SHIM_NAME}")  # exited leftover only; no-op if in use
    r = sh(
        f"docker run -d --name {SHIM_NAME} -p 80:80 "
        f"--add-host host.docker.internal:host-gateway alpine/socat "
        f"TCP-LISTEN:80,fork,reuseaddr TCP:host.docker.internal:{PXPIPE_PORT}"
    )
    if r.returncode != 0:
        for _ in range(10):
            time.sleep(1)
            if running():
                return
        sys.exit(f"could not start port-80 shim: {r.stderr.strip()}")
    time.sleep(1)


def run_task(task, timeout_s):
    out = RESULTS / task
    out.mkdir(parents=True, exist_ok=True)
    # The container freezes this bearer for the whole task. Behind the proxy that
    # no longer caps task length -- the proxy swaps in TOKEN_FILE per request --
    # so only the control arm still needs a token that outlives the task.
    token = oauth_token(min_valid_s=timeout_s if NO_PROXY else 900)
    if token is None:
        return 0.0, "no usable subscription token"
    env = dict(os.environ, CLAUDE_CODE_OAUTH_TOKEN=token,
               CLAUDE_CODE_EFFORT_LEVEL=EFFORT)
    if NO_PROXY:
        env.pop("ANTHROPIC_BASE_URL", None)  # CLI default: api.anthropic.com
    else:
        env["ANTHROPIC_BASE_URL"] = BASE_URL
    env.pop("ANTHROPIC_API_KEY", None)  # else the CLI prefers it over the subscription
    cmd = [
        "pier", "run",
        "-p", str(TASKS / task),
        "--agent", "claude-code",
        "--model", MODEL,
        "-o", str(out),
        "--job-name", task,
        "-n", "1",  # 8 GB + 2 cpu per task; this host has 10 GB total
        # pxpipe renders history to PNGs, which costs wall clock the task.toml
        # budget never accounted for: measured 22.6 s/turn vs 9.5 s bare. Scale
        # the agent budget rather than the verifier's, and record it in the PR.
        "--agent-timeout-multiplier", str(AGENT_TIMEOUT_MULTIPLIER),
        "-y",
    ]
    t0 = time.time()
    try:
        r = subprocess.run(cmd, env=env, timeout=timeout_s,
                           capture_output=True, text=True)
        tail = (r.stdout or "")[-1500:]
    except subprocess.TimeoutExpired:
        tail = "TIMEOUT"
    return round(time.time() - t0, 1), tail


def record(row):
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    with MANIFEST.open("a") as f:
        f.write(json.dumps(row) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shard", type=int,
                    help="0-based shard index; omit to drain every remaining "
                         "task, claiming one at a time (run 4 of these)")
    ap.add_argument("--size", type=int, default=12, help="tasks per shard")
    ap.add_argument("--budget-min", type=float,
                    help=f"stop starting new tasks past this wall clock "
                         f"(default: {BUDGET_MIN:g} for --shard, unlimited when "
                         f"draining)")
    ap.add_argument("--task-timeout-min", type=float, default=TASK_TIMEOUT_MIN,
                    help=f"hard cap per task (default: {TASK_TIMEOUT_MIN:g}); must "
                         f"exceed the {AGENT_BUDGET_S:g}s agent budget times "
                         f"{AGENT_TIMEOUT_MULTIPLIER:g}, plus verifier slack")
    ap.add_argument("--list", action="store_true", help="print the shard and exit")
    ap.add_argument("--no-proxy", action="store_true",
                    help="control arm: bypass pxpipe, hit api.anthropic.com")
    ap.add_argument("--results-dir",
                    help="results tree; use a separate one per arm so resume "
                         "does not treat the other arm's rewards as done")
    args = ap.parse_args()

    # `pxpipe warp` exports HTTP_PROXY=http://127.0.0.1:<ephemeral> to its
    # children. docker forwards that into builds, where 127.0.0.1 is the
    # container itself, so every fetch dies once the warp session that owned the
    # port exits. The container reaches the API at host.docker.internal, never
    # through a proxy var, so drop them before pier sees the environment.
    for k in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy",
              "ALL_PROXY", "all_proxy"):
        os.environ.pop(k, None)

    global NO_PROXY, RESULTS, MANIFEST
    NO_PROXY = args.no_proxy
    if args.results_dir:
        RESULTS = Path(args.results_dir).expanduser().resolve()
        MANIFEST = RESULTS / "manifest.jsonl"

    ids = task_ids()
    if args.shard is None:
        shard = ids  # claims decide ownership, not slicing
    else:
        shard = ids[args.shard * args.size:(args.shard + 1) * args.size]
        if not shard:
            sys.exit(f"shard {args.shard} is empty ({len(ids)} tasks, size {args.size})")

    if args.list:
        total = (len(ids) + args.size - 1) // args.size
        print(f"shard {args.shard}/{total - 1}, {len(shard)} tasks of {len(ids)}")
        for t in shard:
            r = reward_of(t)
            print(f"  {'done ' if r else '     '} {t}")
        return

    if not NO_PROXY:
        # Publish before preflight: pxpipe_up() may start the proxy, and the
        # proxy is useless as a token source until this file exists.
        if not write_token_file():
            sys.exit("no usable subscription token to publish for the proxy")
        token_refresher()

    problems = preflight()
    if problems:
        sys.exit("preflight failed:\n  - " + "\n  - ".join(problems))
    if not NO_PROXY:
        shim_up()

    # A drain worker that stops on a clock would leave the queue half-run and
    # need relaunching, which is the batching this replaces.
    budget = args.budget_min if args.budget_min is not None else (
        None if args.shard is None else BUDGET_MIN)
    deadline = time.time() + budget * 60 if budget else float("inf")
    for t in shard:
        prior = reward_of(t)
        if prior is not None:
            print(f"[skip] {t} reward={prior.get('reward')}")
            continue
        if time.time() > deadline:
            print(f"[budget] stopping before {t}; re-run this shard to continue")
            break
        if args.shard is None and not claim(t):
            continue  # another worker owns it
        print(f"[run ] {t}")
        dur, tail = run_task(t, args.task_timeout_min * 60)
        r = reward_of(t)
        row = {"task": t, "shard": args.shard, "seconds": dur,
               "reward": (r or {}).get("reward"), "graded": r is not None,
               "model": MODEL, "usage": usage_of(t),
               "ts": time.strftime("%FT%TZ", time.gmtime())}
        record(row)
        print(f"[{'ok  ' if row['graded'] else 'fail'}] {t} "
              f"reward={row['reward']} {dur}s")
        if not row["graded"]:
            print(tail)
        if args.shard is None:
            commit(t, row["reward"])

    done = [t for t in shard if reward_of(t) is not None]
    passed = sum(1 for t in done if (reward_of(t) or {}).get("reward"))
    label = "all" if args.shard is None else args.shard
    print(f"shard {label}: {passed}/{len(done)} passed, "
          f"{len(shard) - len(done)} remaining")


if __name__ == "__main__":
    main()
