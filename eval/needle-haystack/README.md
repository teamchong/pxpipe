# needle-haystack eval

Receipts for the needle eval. It measures the **worst case** for a lossy
compressor (exact recovery of a random fact from imaged content), not the whole
product. Its "dead" conclusion was later **reversed** on live measurement —
see the correction in [`/POSTMORTEM.md`](../../POSTMORTEM.md).

**Question:** if you put a unique fact *only* inside content rendered to PNG (never
in the text tail), can Opus retrieve it? If no, *verbatim* recall from images is unsafe.

**Finding (stands):** verbatim 0/15 (both `opus-4-5` and `opus-4-8`); semantic 27–40%
(≈ prior-guessing, p≈0.45). So imaged content is **unreliable for verbatim recall**
and can be silently confabulated. This is the caveat, not the verdict: on real
(dense) traffic pixelpipe still saves ~68% as a *gist* tier — see POSTMORTEM correction.

| file | phase | what it does |
|---|---|---|
| `run3.sh` | 1–2 | 2×2 N=15 harness: {verbatim, semantic} × {compression ON, OFF}, via the live proxy. `MODEL=claude-opus-4-8` (Phase 1 was the same script on `-4-5`). |
| `results2.tsv` | 2 | raw per-trial output of the `opus-4-8` run. |
| `crux.py` | 3 | feeds custom images straight to Opus (bypasses pixelpipe's renderer) to separate *encoder can't read hex* from *render too dense*. Billboard 120pt → 8/8; clean 30pt → 8/8. The encoder reads hex fine when it's big. |
| `sweep.py` | 4 | font-size density sweep at fixed ~2,668-image-token dimensions. Finds the cliff: 22pt 100%, 16pt 17% (near-miss corruption), 12pt unreadable. |

## Run

1. Start the pixelpipe proxy on `127.0.0.1:47821`.
2. `./run3.sh`  (needs the `claude` CLI on a MAX plan — no API key).
3. Python tiers need PIL + a monospace TTF (`crux.py`, `sweep.py`).

## Open follow-up — partially answered

The sweep used English-prose filler (~3.5 chars/token). Real CC traffic is ~1.17
chars/token, where 22pt could hit ~1.4× compression at 100% read. The **live proxy
record** (POSTMORTEM correction, 2026-05-29) confirmed the direction: on real dense
traffic pixelpipe measured ~68% fewer input tokens. Still worth re-running `sweep.py`
with dense JSON/tool-output filler to pin the controlled per-font-size cliff. See
POSTMORTEM §"open question" and the correction block.
