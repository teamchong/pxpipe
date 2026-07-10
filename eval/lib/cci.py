#!/usr/bin/env python3
"""
cci.py - interactive Claude session shim. Drop-in replacement for `claude -p`.

Drives the REAL interactive TUI (Max-subscription auth via keychain, NO API key)
instead of headless -p, then scrapes results off the screen with a real terminal
emulator (pyte), not naive ANSI strip.

What we read off the live session (no transcript - this isolated mode never
writes one):
  - reply  : the last assistant '⏺' block on screen
  - $       : /cost  -> "Total cost: $X"   <- the ONLY server-truth number
  - tokens : /context -> "N/200k tokens" + per-category breakdown (ESTIMATE,
             as the panel itself states). The /cost per-model token breakdown
             is a local estimate too and is intentionally NOT used.
Both /context and /cost are captured BEFORE /quit.

ISOLATION (the demo's proven combo; --bare is NOT usable - it forces
ANTHROPIC_API_KEY and never reads OAuth/keychain, breaking Max auth):
    --setting-sources project --strict-mcp-config --dangerously-skip-permissions
=> no global/project CLAUDE.md, no MCP, OAuth/Max intact.

TRUST GATE: --dangerously-skip-permissions does NOT bypass the workspace-trust
dialog on a PTY (only skipped when stdout is not a TTY). When the gate appears
we accept it by pressing "1" + Enter ("Yes, I trust this folder").

ENV passes straight through (harness owns ANTHROPIC_BASE_URL / proxy on-off).
ARGV is `claude -p`-style; -p / --output-format / --strict-mcp-config /
--no-session-persistence are absorbed. Prompt = positional arg, else stdin.
"""
import sys, os, time, json, re, shutil, subprocess

CLAUDE = os.environ.get("CCI_CLAUDE_BIN", os.path.expanduser("~/.claude/local/claude"))
if not os.path.exists(CLAUDE):
    CLAUDE = shutil.which("claude") or CLAUDE
TIMEOUT = float(os.environ.get("CCI_TIMEOUT", "300"))
READY_TIMEOUT = float(os.environ.get("CCI_READY_TIMEOUT", "60"))
QUIET_S = float(os.environ.get("CCI_QUIET_S", "4.0"))
DEBUG = os.environ.get("CCI_DEBUG")
ROWS = int(os.environ.get("CCI_ROWS", "60"))    # tall buffer (e.g. 1500) for long replies
COLS = int(os.environ.get("CCI_COLS", "200"))


def parse_argv(argv):
    model = None; output_format = "text"; allowed = None; prompt = None
    takes_val = {"--model", "--output-format", "--allowedTools", "--allowed-tools",
                 "--add-dir", "--mcp-config", "--permission-mode",
                 "--append-system-prompt", "--system-prompt", "--settings"}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--model":
            model = argv[i + 1]; i += 2; continue
        if a == "--output-format":
            output_format = argv[i + 1]; i += 2; continue
        if a in ("--allowedTools", "--allowed-tools"):
            allowed = argv[i + 1]; i += 2; continue
        if a in ("-p", "--print", "--no-session-persistence", "--strict-mcp-config",
                 "--dangerously-skip-permissions", "--verbose"):
            i += 1; continue
        if a in takes_val:
            i += 2; continue
        if a.startswith("-"):
            i += 1; continue
        prompt = a; i += 1
    if prompt is None and not sys.stdin.isatty():
        prompt = sys.stdin.read()
    return model, output_format, allowed, prompt


def pnum(s):
    """'517'->517, '38.5k'->38500, '1.2m'->1200000, '12,345'->12345."""
    s = s.strip().replace(",", "")
    m = re.match(r"([\d.]+)\s*([kKmM]?)", s)
    if not m:
        return 0
    v = float(m.group(1)); suf = m.group(2).lower()
    if suf == "k":
        v *= 1_000
    elif suf == "m":
        v *= 1_000_000
    return int(round(v))


def parse_cost_total(text):
    """The ONLY server-truth value on /cost: Total cost in USD (or None)."""
    m = re.search(r"Total cost:\s*\$([\d.]+)", text)
    return float(m.group(1)) if m else None


def parse_context(text):
    """/context: total context tokens + per-category estimate breakdown."""
    out = {"tokens": None, "max": None, "pct": None, "breakdown": {}}
    mt = re.search(r"([\d.,]+\s*[kKmM]?)\s*/\s*([\d.,]+\s*[kKmM]?)\s*tokens"
                   r"(?:\s*\((\d+(?:\.\d+)?)%\))?", text)
    if mt:
        out["tokens"] = pnum(mt.group(1))
        out["max"] = pnum(mt.group(2))
        if mt.group(3):
            out["pct"] = float(mt.group(3))
    for m in re.finditer(r"([A-Za-z][A-Za-z ]+?):\s*([\d.,]+\s*[kKmM]?)\s*"
                         r"(?:tokens?)?\s*\(([\d.]+)%\)", text):
        name = m.group(1).strip()
        if name.lower() in ("total cost",):
            continue
        out["breakdown"][name] = {"tokens": pnum(m.group(2)), "pct": float(m.group(3))}
    # Fallback (Claude Code >= 2.1.x): the "N / M tokens" header is gone from
    # /context; derive usage from the category breakdown instead. Used tokens =
    # sum of everything except free/reserved buffers; max = sum of all rows.
    if out["tokens"] is None and out["breakdown"]:
        skip = ("free space", "autocompact buffer")
        used = sum(v["tokens"] for k, v in out["breakdown"].items()
                   if k.lower() not in skip)
        total = sum(v["tokens"] for v in out["breakdown"].values())
        if used > 0:
            out["tokens"] = used
            out["max"] = total or None
            if total:
                out["pct"] = round(100.0 * used / total, 1)
    return out


def extract_reply(lines):
    """Reply = the last assistant bullet block (lines under a leading '⏺'/'●').

    Claude Code renders the assistant bullet as '⏺' (U+23FA) on some builds
    and '●' (U+25CF) on others (observed on Windows v2.1.206)."""
    out = []; cap = False
    for t in lines:
        s = t.strip()
        if s.startswith("⏺") or s.startswith("●"):
            cap = True
            out = [s.lstrip("⏺●").strip()]
        elif cap:
            if (not s) or s.startswith("❯") or s.startswith("✻") \
                    or s.startswith("⎿") or "bypass permissions" in s \
                    or "esc to interrupt" in s or set(s) <= set("─╌╭╮╰╯│ "):
                break
            out.append(s)
    return "\n".join(x for x in out if x).strip()


class _WinChild:
    """Minimal pexpect.spawn-alike backed by pywinpty (ConPTY). Windows only.

    Exposes exactly the surface main() uses: read_nonblocking / send /
    sendcontrol / close, raising pexpect.TIMEOUT / pexpect.EOF so feed()
    stays platform-agnostic.
    """

    def __init__(self, cmd, args, cwd, env, dimensions, timeout):
        import pexpect
        from winpty import PTY
        self._pexpect = pexpect
        rows, cols = dimensions
        exe = shutil.which(cmd) or cmd
        low = exe.lower()
        if low.endswith((".cmd", ".bat")):
            appname = os.environ.get("COMSPEC", r"C:\Windows\System32\cmd.exe")
            argv = ["/c", exe] + list(args)
        elif low.endswith((".js", ".mjs", ".cjs")):
            appname = shutil.which("node")
            argv = [exe] + list(args)
        else:
            appname = exe
            argv = list(args)
        self._pty = PTY(cols, rows)
        envblock = "\0".join("%s=%s" % (k, v) for k, v in env.items()) + "\0"
        self._pty.spawn(appname, cmdline=" " + subprocess.list2cmdline(argv),
                        cwd=cwd, env=envblock)

    def read_nonblocking(self, size=65536, timeout=0.3):
        end = time.time() + max(timeout or 0, 0)
        while True:
            # pywinpty 3.x: read() takes only `blocking` (internal chunk size).
            data = self._pty.read(blocking=False)
            if data:
                return data
            if self._pty.iseof() or not self._pty.isalive():
                raise self._pexpect.EOF("child EOF")
            if time.time() >= end:
                raise self._pexpect.TIMEOUT("no data in %ss" % timeout)
            time.sleep(0.05)

    def send(self, s):
        self._pty.write(s)

    def sendcontrol(self, ch):
        self._pty.write(chr(ord(ch.lower()) - ord("a") + 1))

    def close(self, force=False):
        try:
            pid = getattr(self._pty, "pid", None)
            if force and pid:
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                               capture_output=True)
        except Exception:
            pass
        self._pty = None


def main():
    try:
        import pexpect, pyte
        if os.name == "nt":
            import winpty  # noqa: F401  (ConPTY backend for _WinChild)
    except ImportError as e:
        sys.stderr.write("cci: missing dependency (%s). Install: pip install pexpect pyte%s\n"
                         % (e, " pywinpty" if os.name == "nt" else ""))
        sys.exit(3)
    model, output_format, allowed, prompt = parse_argv(sys.argv[1:])
    if not prompt:
        sys.stderr.write("cci: no prompt (positional arg or stdin)\n")
        sys.exit(2)

    args = ["--setting-sources", "project", "--strict-mcp-config",
            "--dangerously-skip-permissions"]
    if model:
        args += ["--model", model]
    if allowed:
        args += ["--allowedTools", allowed]

    env = dict(os.environ)
    env["TERM"] = "xterm-256color"
    for k in list(env):
        if "VSCODE" in k or k in ("TERM_PROGRAM", "CLAUDE_CODE_SSE_PORT", "CLAUDECODE"):
            env.pop(k, None)

    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.Stream(screen)
    if os.name == "nt":
        child = _WinChild(CLAUDE, args, cwd=os.getcwd(), env=env,
                          dimensions=(ROWS, COLS), timeout=TIMEOUT)
    else:
        child = pexpect.spawn(CLAUDE, args, cwd=os.getcwd(), env=env,
                              encoding="utf-8", codec_errors="replace",
                              dimensions=(ROWS, COLS), timeout=TIMEOUT)

    def feed(slice_s=0.3):
        try:
            stream.feed(child.read_nonblocking(65536, timeout=slice_s))
            return True
        except pexpect.TIMEOUT:
            return False
        except pexpect.EOF:
            return None

    def disp():
        return [ln.rstrip() for ln in screen.display]

    def scr():
        return "\n".join(disp())

    def settle(label, seconds=7):
        """Send a slash command and drain the screen for `seconds`."""
        screen.reset()
        child.send(label + "\r")
        end = time.time() + seconds
        while time.time() < end:
            if feed(0.3) is None:
                break
        return scr()

    # "working" = any live spinner state, not just the footer string. The spinner
    # glyph + its elapsed-second counter ("(12s · esc to interrupt)") refresh every
    # ~1s, so this stays TRUE across the whole turn — including the preamble->tool
    # gap where the bare "esc to interrupt" footer briefly drops. That keeps the
    # QUIET_S window as a pure slow-render cushion, never the thing deciding "done".
    working_re = re.compile(
        r"esc to interrupt"          # footer affordance while busy
        r"|\(\s*\d+\s*s\b"           # elapsed-second counter, ticks every ~1s
        r"|^\s*[✻✶✳✽✢⋆∗·*]\s+\S+…",  # animated spinner glyph + verb + ellipsis
        re.I | re.M)
    trust_re = re.compile(r"trust this folder|Quick safety check|created or one you trust", re.I)
    ready_re = re.compile(r"Welcome back|Try \"|bypass permissions")

    # 1) wait for ready; accept trust gate by pressing 1 + Enter
    deadline = time.time() + READY_TIMEOUT
    ready = False
    while time.time() < deadline:
        g = feed(0.3)
        if g is None:
            break
        s = scr()
        if trust_re.search(s):
            child.send("1\r"); time.sleep(0.8); continue
        if ready_re.search(s) and not working_re.search(s):
            ready = True; break
    if not ready:
        sys.stderr.write("cci: never reached ready\n--- screen ---\n" + scr() + "\n")
        child.close(force=True); sys.exit(1)
    time.sleep(0.4)

    # 2) submit prompt, then retry Enter until the turn PROVABLY starts. A single
    #    Enter can no-op while the input box is still catching up to the welcome
    #    render, which would leave the prompt unsubmitted.
    if "\n" in prompt:
        child.send("\x1b[200~" + prompt + "\x1b[201~")   # bracketed paste: newlines don't submit early
    else:
        child.send(prompt)
    time.sleep(0.6)

    def turn_started():
        s = scr()
        if working_re.search(s):
            return True
        return any(ln.strip().startswith("⏺") for ln in disp())

    started = False
    for _ in range(6):
        child.send("\r")
        t0 = time.time()
        while time.time() - t0 < 3:
            feed(0.3)
            if turn_started():
                started = True
                break
        if started:
            break

    # 3) wait for completion: once started, done when neither the working
    #    indicator nor new output has appeared for QUIET_S (spinner animation
    #    counts as activity, so tool calls don't look idle mid-turn).
    hard = time.time() + TIMEOUT
    last_active = time.time()
    seen = started
    time.sleep(0.5)
    while time.time() < hard:
        g = feed(0.3)
        if g is None:
            break
        if working_re.search(scr()):
            seen = True; last_active = time.time(); continue
        if g:
            last_active = time.time(); continue
        if seen and (time.time() - last_active) > QUIET_S:
            break

    reply = extract_reply(disp())
    if DEBUG:
        sys.stderr.write("\n--- REPLY SCREEN ---\n" + scr() + "\n")

    # 4) capture BOTH panels BEFORE quitting
    context_raw = settle("/context")
    ctx = parse_context(context_raw)
    cost_raw = settle("/cost")
    total_cost = parse_cost_total(cost_raw)
    if DEBUG:
        sys.stderr.write("\n--- /context ---\n" + context_raw +
                         "\n--- /cost ---\n" + cost_raw + "\n")

    # 5) quit
    try:
        child.send("/quit\r"); time.sleep(0.5)
        child.sendcontrol("c"); child.sendcontrol("c")
    except Exception:
        pass
    child.close(force=True)

    if output_format == "json":
        out = {"type": "result", "subtype": "success", "result": reply,
               "total_cost_usd": total_cost,          # server-truth ($)
               "context_tokens": ctx["tokens"],       # estimate
               "context_max": ctx["max"],
               "context_pct": ctx["pct"],
               "context_breakdown": ctx["breakdown"]}  # estimate, per category
        sys.stdout.write(json.dumps(out))
    else:
        sys.stdout.write(reply)
    sys.stdout.flush()
    sys.exit(0)


if __name__ == "__main__":
    main()
