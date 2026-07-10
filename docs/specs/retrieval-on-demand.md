# Retrieval-on-demand for imaged content (B6)

**Status: SPEC ONLY — no implementation in this document or its commit.** This
describes the design for a future implementer; it does not modify
`transform.ts`, `node.ts`, `dashboard.ts`, or `tracker.ts`. See §11 for the
phased rollout a follow-up task should execute against this design.

**Rollout gate (2026-07-10): do not implement this before telemetry proves the
need.** The live plan is to measure `tier0_dropped_total`, omissions,
400/refusal rows, cache-prefix stability, and the cheap per-block factsheet
fidelity test first. Variant A (`~/.pxpipe/stash`, deterministic handle,
`GET /stash/:id`, TTL/GC) only proceeds behind a separate flag/canary and a
dedicated security review if those measurements show a real fidelity gap that
factsheet captions cannot close.

## 1. Problem & scope

`docs/LEGIBILITY-AUDIT-2026-07-01.md` (recommendation #4, lines 94-98) draws
the line pxpipe already lives by: **sparse** precision-critical tokens (a
handful of SHAs, ids, numbers per page) are handled today by the factsheet
(`src/core/factsheet.ts`) — a verbatim text caption riding next to the image.
**Dense** precision (every symbol in a code dump, a large table) exceeds any
fixed-size sidecar budget; the audit's proposed answer is a re-fetch path: expose
`RecoverableBlock` (`src/core/transform.ts:68-76`) — which today already
captures the byte-exact original text + provenance for every block pxpipe
renders to image — behind something the caller can pull on. The audit calls
this mechanism "half-built." This spec is the other half: the retrieval
channel's wire format, storage, lifecycle, security posture, and integration
points, so an implementer can build it without re-deriving the design.

**What exists today (verified against `feat/efficiency-pack` @ `aa2ffd9`):**

- `TransformOptions.emitRecoverable` (`transform.ts:131-134`, default `false`)
  — gates whether `recordRecoverable()` (`transform.ts:838-853`) does
  anything. Three call sites populate it: reminder text (`transform.ts:1950`),
  `tool_result` content (`transform.ts:2024`), and `tool_result` sub-parts
  (`transform.ts:2102`).
- The id is `'rec_' + sha8(kind + '\0' + toolUseId + '\0' + text)` — an 8-hex-char
  (32-bit) content-address, stable across calls with identical inputs
  (`transform.ts:845`, verified stable by `tests/recoverable.test.ts:89-110`).
- **This channel is dead in production.** `grep -n emitRecoverable
  src/node.ts src/worker.ts` returns no matches — neither host ever sets the
  option, so `info.recoverable` is never populated outside tests. Even if it
  were, `toTrackEvent()` in `src/core/tracker.ts` does not serialize
  `info.recoverable` into the JSONL event — the array (and the original text
  it carries) is discarded with the rest of `info` when the request finishes.
  Today, once pxpipe images a block, the original bytes are gone the moment
  the response is written.

This spec proposes closing that gap: persist the recoverable text to a small
on-disk stash, embed a short **handle** (not the full text) in the prompt in
place of today's silent loss, and expose a `GET /stash/:id` endpoint the
*calling agent* (Claude Code itself, or whatever sits in front of pxpipe) can
fetch from — using tools it already has (Bash/`curl`), no new Anthropic-side
tool-calling loop required. That's "Variant A," and the only variant Phase
1-4 below target. §9 sketches "Variant B" (a model-callable tool) and
explains why it's materially harder and explicitly deferred.

## 2. Non-goals / boundary with parallel work

Three other in-flight tasks touch adjacent territory. This spec draws an
explicit line so a future implementer doesn't collide:

- **B7 (dedup content by sha + global identifier manifest)** is a different
  concern — a content-dedup index, keyed by sha, most likely with its own
  manifest file. This spec's per-block stash entries are keyed by `rec_<sha8>`
  too, but **do not assume a shared manifest file, shared directory, or
  shared key namespace with B7 without explicit coordination**. If both land,
  reconcile at implementation time; until then treat `~/.pxpipe/stash/` as
  owned exclusively by this spec's retrieval channel.
- **B5+B8 (tiered fidelity + pixel minimization)** changes *what* gets imaged
  and at what fidelity, not whether the original text is recoverable. This
  spec's stash is agnostic to which tier produced a given image — it stashes
  whatever `recordRecoverable()` is handed, unconditionally of tier. No part
  of this design should assume a particular tier shape.
- **Variant B (model-callable tool retrieval)** is described in §9 for
  completeness but is out of scope for the phases in §11. It requires a
  stateful tool-call interception loop pxpipe does not have today (see §9).

## 3. Handle format

Two related but distinct artifacts:

**The id** (unchanged): `rec_` + 8 lowercase hex chars, exactly as
`recordRecoverable()` computes it today. No change to the hashing scheme —
reusing it means ids stashed to disk are identical to ids already exercised
by `tests/recoverable.test.ts`, and any code that already computes or expects
this id format keeps working.

**The handle** is the new, richer, prompt-facing string that stands in for
the discarded text. It must be short (this is the whole point — the point of
imaging was to save tokens, so the handle must cost near-zero) and must give
the model enough to decide *whether* it needs to fetch, without needing to
fetch to find out. Proposed shape:

```
[full text available: rec_a1b2c3d4 — <kind> from <toolUseId|"reminder">, <len> chars, <imageCount> image(s) — fetch: GET /stash/rec_a1b2c3d4]
```

- `<kind>` is one of `reminder` / `tool_result` / `tool_result_part`, taken
  directly from `RecoverableBlock.kind`.
- `<len>` is `text.length` — gives the model a magnitude signal ("this is a
  40-char id, don't bother" vs "this is a 12,000-char file, maybe I do need
  it") without spending tokens on a summary.
- No free-text "summary" field is proposed for phase 1: generating a
  meaningful summary of arbitrary tool output cheaply (without another model
  call) is itself an open problem, and a bad summary is worse than no
  summary — it can talk the model out of fetching content it actually needs.
  If a future phase adds one, it must be optional and computed once at stash-write
  time (never per-request), stored in the stash JSON (§4), and appended to
  the handle only when present.
- The endpoint path is included literally so the calling agent (which has
  Bash/`curl`, not a `pxpipe` SDK) can act on the handle without needing to
  already know pxpipe's URL scheme. The dashboard's own port is already
  printed to the operator's terminal at boot (`node.ts:1120`), and Claude Code
  running against `ANTHROPIC_BASE_URL=http://127.0.0.1:47821` (per
  `node.ts:177`) is already on the same host — so a relative fetch to that
  same origin is a reasonable, low-cost action for the agent to take on its
  own initiative if it decides it needs the exact bytes.

**Placement (critical invariant).** The handle text must be *appended to* the
existing factsheet caption string — never inserted as a new, separate text
block. The factsheet caption is built and pushed once, immediately after the
image blocks, at exactly three places: `transform.ts:1946-1947` (reminder),
`transform.ts:2035-2038` (tool_result), `transform.ts:2097-2098`
(tool_result_part). At each site, `cache_control` (when the source block
carried one) is placed on the **last image block**, never on the trailing
text caption (see `srcCacheControl` handling at `transform.ts:1936-1943` and
`transform.ts:2087-2093`). Concatenating the handle onto the same caption
string:

1. Keeps the per-block image/text block count exactly as it is today — no new
   block is introduced, so nothing shifts which block is "last" and eligible
   for the relocated `cache_control` marker.
2. Guarantees `countCacheControlMarkers()` (`src/core/measurement.ts:194`)
   still returns the same in==out count with the handle present as without
   it — the handle rides as plain appended text on a block that already
   carries no `cache_control` of its own.
3. Matches the existing precedent: the factsheet caption is already "just
   text glued onto the end," and the handle is more of the same category of
   thing, not a new category.

## 4. Stash on-disk format

**Location:** `~/.pxpipe/stash/`, a sibling of the existing
`~/.pxpipe/events.jsonl` (`node.ts:119`) and `~/.pxpipe/4xx-bodies/`
(`node.ts:933`) — same home-relative convention, same "a single `rm -rf`
cleans up everything pxpipe wrote" property the 4xx-bodies comment
(`node.ts:930-932`) already relies on. Lazily `mkdir -p`'d on first write,
exactly like `maybeWriteBodySidecar()` (`node.ts:566-570`).

**One file per entry:** `<stashDir>/<id>.json` — unlike the 4xx-body sidecar
(`<ts>-<sha8>.json.gz`, `node.ts:576`), no timestamp prefix is needed in the
filename, because `id` (`rec_<sha8>`) is already content-derived and globally
collision-safe; a bare `<id>.json` name is also what makes the `GET
/stash/:id` route trivial (§8) — the id *is* the filename, no directory scan
or index needed to resolve a request.

**Schema:**

```jsonc
{
  "id": "rec_a1b2c3d4",
  "kind": "tool_result",          // "reminder" | "tool_result" | "tool_result_part"
  "toolUseId": "toolu_01Abc...",  // present iff kind !== "reminder"
  "text": "<verbatim original text — the exact bytes to restore>",
  "len": 41823,                   // text.length, duplicated out of `text` so
                                   // size can be read via `stat`-adjacent info
                                   // (or a metadata-only read) without
                                   // parsing/decoding the full JSON.
  "imageCount": 6,
  "createdAt": "2026-07-07T12:34:56.789Z"  // explicit, not just relying on
                                            // file mtime — see §5 on why.
}
```

Uncompressed JSON (not gzipped, unlike the 4xx-body sidecar): stash entries
are expected to be read back promptly and relatively small compared to the
4xx-body use case (which stores raw request bytes specifically because they
were *too big* to inline in JSONL); gzip can be revisited if entry sizes in
practice justify it, but is not part of this phase.

**Write path.** `recordRecoverable()` is the single existing call site that
knows `{kind, toolUseId, text, imageCount}` for every recordable block
(`transform.ts:839-853`). The natural extension point is inside that
function, gated by a *second*, independent flag — proposed env var
`PXPIPE_STASH` (checked once, lazily, the same defensive-`try/catch` pattern
`envDisabled()` in `render-cache.ts:41-49` already uses so Workers — which
has no `process` — degrades cleanly instead of throwing).

**`emitRecoverable` and `PXPIPE_STASH` are deliberately two separate knobs, not
one:**

| Flag | Controls |
|---|---|
| `emitRecoverable` (existing, `TransformOptions`) | Whether `recordRecoverable()` runs at all — computes the id, pushes an entry onto `info.recoverable`. |
| `PXPIPE_STASH=1` (new, env-gated, Node-only) | Whether that entry's `text` is *additionally* written to `~/.pxpipe/stash/<id>.json` on disk. |

When `PXPIPE_STASH=1`, the in-memory `info.recoverable` entry pushed by
`recordRecoverable()` should **drop its `text` field** (replace with
`stashed: true`) rather than holding the same bytes in two places
(`info.recoverable` in the request's live memory *and* on disk) for the
lifetime of the request/telemetry object. This requires adding one optional
field to `RecoverableBlock` (`transform.ts:68-76`):

```ts
export interface RecoverableBlock {
  readonly id: string;
  readonly kind: 'reminder' | 'tool_result' | 'tool_result_part';
  readonly toolUseId?: string;
  /** Original text — present when the block was recorded in-memory only
   *  (PXPIPE_STASH off). Absent when `stashed` is true; fetch via
   *  GET /stash/:id instead. */
  readonly text?: string;
  readonly imageCount: number;
  /** True when the text was persisted to `~/.pxpipe/stash/<id>.json`
   *  instead of being held in this entry. New, optional, additive — existing
   *  consumers reading `.text` are unaffected when this is absent/false. */
  readonly stashed?: boolean;
}
```

This is additive and backward compatible: `tests/recoverable.test.ts`
exercises `PXPIPE_STASH` unset (i.e. `0`/default), and every assertion in
that file reads `entry.text` directly — under the default (stash off), `text`
is populated exactly as today, so **that file requires zero changes** and
must continue to pass unmodified (this is the regression gate called out in
the brief and in §10).

## 5. Lifecycle / GC

Two independent bounds, both enforced by a **disk-resident, mtime-based
sweep** — not the in-memory LRU pattern `render-cache.ts` uses (`MAX_ENTRIES`
/ `MAX_BYTES`, `render-cache.ts:33-34`), because that cache is intentionally
scoped to one process's lifetime and evicts by recency-of-use; the stash must
survive a proxy restart (a Claude Code session frequently outlives a single
pxpipe process across reconnects) and evicts by **age since creation**, not
recency of access — retrieval is expected to be rare and bursty (the model
asks for one specific block once), so an LRU-style "keep what's hot" policy
is the wrong shape here.

- **TTL** — proposed default 24h, override `PXPIPE_STASH_TTL_MS`. Compared
  against the stash entry's own `createdAt` field (not filesystem mtime,
  which a backup/sync tool or `cp -p` could preserve or reset unpredictably)
  — `createdAt` is the authoritative clock. Filesystem mtime is still useful
  as a **cheap first-pass filter** during a sweep (stat is far cheaper than
  reading+parsing every JSON file), but the final expiry decision reads
  `createdAt` from the file content once a candidate is found stale by
  mtime.
- **Size cap** — proposed defaults `PXPIPE_STASH_MAX_BYTES` (e.g. 256 MB,
  mirroring `render-cache.ts:34`'s order of magnitude) and
  `PXPIPE_STASH_MAX_ENTRIES` (e.g. 2048). When either is exceeded, sweep
  oldest-`createdAt`-first until back under both caps. This is the hard
  backstop against a pathological session that stashes far more/faster than
  TTL alone would bound (TTL bounds *duration*, the size cap bounds *total
  footprint* regardless of duration).
- **Sweep trigger.** Lazy, piggybacked on writes — analogous to
  `maybeWriteBodySidecar`'s lazy `mkdir` (`node.ts:566-567`): a write that
  would push the directory over either cap triggers a synchronous sweep
  first; independently, a low-frequency time-gated sweep (e.g. "at most once
  per 10 minutes of process uptime," a simple in-memory
  `lastSweepAt`/`Date.now()` guard, same idea as `render-cache.ts`'s module-level
  counters) catches pure-TTL expiry even during a quiet period with no new
  writes. No external cron dependency (vesemir or otherwise) is required for
  correctness — pxpipe must self-clean even run standalone — but nothing
  prevents an operator from *also* wiring an external periodic sweep for
  defense in depth; that's an operational choice, not part of this spec's
  correctness contract.
- **Crash / never-swept worst case.** If the process is killed before any
  sweep runs, the worst-case footprint is bounded by
  `min(MAX_BYTES, TTL × average write rate × average entry size)` — the next
  process start's first write (or its own time-gated sweep) will catch up.
  This is an accepted, documented bound, not a gap to close in phase 1.
- **Deletion** is a plain `fs.promises.unlink`, wrapped in try/catch and
  swallowed on failure (matches the existing swallow-on-write-failure
  precedent in `maybeWriteBodySidecar`, `node.ts:577-582`) — a sweep that
  can't delete one file must not abort the sweep for the rest, and must
  never throw into the request path that triggered it.
- **Concurrent-writer caveat.** Nothing in the current codebase guards
  `events.jsonl` against multiple simultaneous pxpipe processes sharing one
  `~/.pxpipe` directory (the `WriteStream`-with-single-`fd` pattern around
  `node.ts:540-546` implicitly assumes one writer). This spec inherits the
  same implicit assumption for the stash directory: **one active pxpipe
  process per host** is the supported topology. A sweep racing a concurrent
  writer's `mkdir`/`unlink` in a multi-process deployment is a known,
  unaddressed risk shared with the existing sidecar mechanism, not a
  regression this spec introduces — flagged again in §12.
- **Kill switch.** `PXPIPE_STASH=0` (the default) disables writing entirely;
  no directory is created, no sweep runs, behavior is byte-identical to
  today. This is the regression contract `tests/recoverable.test.ts` must
  keep validating unmodified.

## 6. Security

- **Trust boundary is loopback, and today has zero auth on any route.** The
  dashboard binds `127.0.0.1` by default (`node.ts:110`, override via `HOST`
  env at `node.ts:1106-1107`), and `dashboardPath()` /
  `dispatchDashboard()` — the exact mechanism `GET /stash/:id` would extend —
  perform no authentication or authorization check anywhere in the current
  codebase. The new endpoint inherits that model as-is: **any local
  process/user on the machine can read any non-expired stash entry**, and if
  an operator opts into `HOST=0.0.0.0` (or any non-loopback interface), any
  network peer that can reach the port can too. This spec does not add auth
  — it is called out here as an explicit, inherited risk, not solved by this
  phase.
- **The id is not a capability token.** `rec_<sha8>` is 32 bits of entropy
  over `(kind, toolUseId, text)` — a content address, not a secret. It must
  never be treated as authorization to read; if the dashboard is ever
  exposed beyond loopback, a 32-bit id space is enumerable
  (~4.3B combinations) by brute force in a feasible time against an
  unthrottled endpoint. No rate limiting exists on the dashboard today
  (verified: `dispatchDashboard` has no throttling logic) — this is a real,
  not theoretical, exposure *if and only if* `HOST` is widened. Under the
  default loopback bind it is a non-issue in practice (an attacker already
  on-host has far easier access to `~/.pxpipe/stash/` directly on the
  filesystem than through HTTP).
- **New incremental risk vs. today: durability.** Before this spec, the
  original (pre-image) text exists only transiently in process memory for
  the duration of one request — it is never written anywhere once the
  response is sent (confirmed: `tracker.ts` doesn't serialize
  `info.recoverable`, so today there is no persistent copy at all, imaged or
  otherwise, beyond the rendered PNG pixels themselves). The stash
  *deliberately* changes that: it makes a plaintext copy durable on disk for
  up to `PXPIPE_STASH_TTL_MS`. Any content sensitive enough to be a concern
  in a `tool_result` (secrets pasted into a file the model read, credentials
  echoed by a command) is *already* being sent to Anthropic as an image in
  the same request — this spec does not create a new destination for the
  content, but it does create a new **retention window** the content wasn't
  previously exposed to (an attacker with delayed-but-eventual filesystem
  access, e.g. a later-compromised session, now has a TTL-long window to
  find something a request-scoped memory buffer would never have exposed).
  Operators who run pxpipe over secret-bearing tool output should be aware
  `PXPIPE_STASH=1` changes this profile; the default is `0`, preserving
  today's stricter (no-persistence) behavior until explicitly opted in.
- **No content scanning.** This spec does not propose (and no infrastructure
  exists for) scanning stash writes for secrets/PII before persisting. Out
  of scope; flagged again as an open risk in §12, not a requirement gating
  phase 1.
- **Directory permissions.** No hardening beyond default OS user-owned
  permissions on `~/.pxpipe/` (same as `events.jsonl` and `4xx-bodies/`
  today) is proposed. If pxpipe's threat model changes (e.g. multi-user
  hosts), this would need revisiting — out of scope here.

## 7. Integration points for the future implementer (touch points only — no edits in this task)

- **`transform.ts:839-853` (`recordRecoverable`)** — extend to check
  `PXPIPE_STASH` (lazily, `try/catch`-guarded like `render-cache.ts:41-49`)
  and, when on, write the stash JSON (§4) and push a `stashed: true` entry
  (no `text`) instead of today's full-text entry.
- **`transform.ts:68-76` (`RecoverableBlock`)** — add the optional `stashed`
  field (and make `text` optional) as shown in §4. Purely additive.
- **Three call sites** (`transform.ts:1950`, `2024`, `2102`) — unchanged in
  shape; they already pass `{kind, toolUseId, text, imageCount}` to
  `recordRecoverable`, which is exactly what the extended writer needs. No
  call-site edits required.
- **Handle text** — appended by each of the same three call sites,
  immediately after building the factsheet caption
  (`transform.ts:1946-1947`, `2035-2038`, `2097-2098`), per the concatenation
  rule in §3. This *does* require call-site edits — the handle string
  depends on the same `id` `recordRecoverable` just computed (or would need
  to expose it — `recordRecoverable` returning the freshly computed `id`
  instead of `void` is a plausible small signature change; must remain
  `async` since `sha8()` is).
- **`node.ts` / `worker.ts` wiring** — today *neither* host file ever sets
  `emitRecoverable` (confirmed by grep in §1); a future implementer's first
  patch necessarily includes threading `emitRecoverable` (from an env/config
  knob — e.g. a new `PXPIPE_RECOVERABLE=1`, independent of `PXPIPE_STASH`, or
  simply implied by `PXPIPE_STASH=1`) into the `TransformOptions` object each
  host builds before calling into `transform.ts`. **`worker.ts` has no
  filesystem** — it should either force `PXPIPE_STASH` off unconditionally
  (Workers keeps today's no-stash behavior indefinitely) or, if
  `emitRecoverable` alone is wired there without stash, keep entries fully
  in-memory (`stashed` always `false`) since there is nowhere to persist to. A
  future KV-backed Workers stash is conceivable but explicitly out of scope
  here.
- **`tracker.ts` (`toTrackEvent`, ~line 168+)** — still will not serialize
  `info.recoverable` into JSONL after this spec's changes, and this spec does
  not require fixing that. The stash *is* the persistence mechanism now (it
  doesn't need the JSONL event to also carry the text); flagged as a related,
  independent, and explicitly deferred gap — not a blocker for phases 1-4.

## 8. `GET /stash/:id` endpoint

- **Node-only.** `dashboardPath()` / `dispatchDashboard()`
  (`src/dashboard.ts:1496-1510`, `src/node.ts:325-331`) exist only in the
  Node host and are dispatched before the upstream proxy call
  (`node.ts:1083-1091`) — confirmed `worker.ts` has no equivalent dashboard
  routing at all, so a Cloudflare Worker deployment simply never sees this
  route; that's consistent with §7's stash-is-Node-only conclusion.
- **Route matching.** Add a case to the `DashboardRoute` union in
  `dashboard.ts` (e.g. `{ kind: 'stash'; id: string }`), matched in
  `dashboardPath()` by prefix on `/stash/`. **Validate the id shape
  (`^rec_[0-9a-f]{8}$`) inside the route matcher itself, before any
  filesystem call** — this both rejects malformed requests cheaply and
  closes a path-traversal vector (a `../../../etc/passwd`-shaped "id" never
  reaches `path.join` because it's rejected by the regex first, not because
  the join is "safe").
- **Handler.** In `dispatchDashboard()`, the new case reads
  `<stashDir>/<id>.json`; on ENOENT (deleted, expired, or never existed)
  return **404**; on success return **200** with the JSON body (§4's schema,
  possibly trimmed of `text` if a `?meta=1` query variant is added later —
  out of scope for phase 1, which returns the full entry). No new dependency
  — reuses the same `fs.promises` access already imported in `node.ts`.
- **No auth**, per §6 — this endpoint is exactly as exposed as every other
  dashboard route today.

## 9. Variant B — model-callable tool retrieval (described, deferred)

The audit's phrasing ("wiring it to a model-callable 'rehydrate this region
as text' tool") describes a fundamentally different shape than Variant A:
the **model itself** (on Anthropic's side of the wire) would need a `tools[]`
definition (e.g. `pxpipe_stash_get(id)`) it can invoke mid-turn. Implementing
that requires pxpipe to:

1. Inject a synthetic tool definition into the outgoing `tools[]` array on
   every request (or only when `info.recoverable`/stash entries exist for
   this conversation).
2. Intercept a `tool_use` block for that specific tool name in the
   **response** stream, **before** relaying the response back to the caller.
3. Synthesize a `tool_result` from the stash entry itself (not from
   Anthropic), and either inject it into a follow-up request pxpipe issues
   on the model's behalf, or hand control back to the caller with a
   "continue this tool loop" signal.

This is a **stateful, multi-round proxy loop** — pxpipe today is a
single-shot request→transform→forward, response→pass-through relay; it never
inspects assistant turns or intercepts `tool_use` blocks at all. Building
Variant B means adding an entirely new control-flow class to pxpipe, not
extending an existing one. It is explicitly **out of scope** for the phases
in §11. Variant A (this spec's target) sidesteps all of this by relying on
the fact that the actual consumer sitting on the other side of most pxpipe
deployments (Claude Code) already has generic shell/network tool access
(Bash) and can act on a plain-text hint in its own context on its own
initiative — no new Anthropic-side tool definition, no interception, no
proxy-side statefulness required.

## 10. Test plan (future `tests/stash-*.test.ts`)

All of the following are **new tests a future implementation phase must
add**; none exist yet, and none are added by this spec (SPEC ONLY per the
task's hard constraint). Proposed file: `tests/stash-retrieval.test.ts`,
run via `npx vitest run tests/stash-retrieval.test.ts` (full suite:
`npx vitest run`).

1. **Round-trip, byte-identical.** Write a stash entry (`PXPIPE_STASH=1`,
   `emitRecoverable=true`) for a known text blob, then read it back via
   whatever the phase-1 read path is (direct fs read for phase 1, then via
   `GET /stash/:id` once phase 2 lands) — assert the returned `text` is
   `===` the original input, not just similar-length or re-encoded.
2. **GC — TTL expiry.** Write an entry with a forced/mocked `createdAt` older
   than `PXPIPE_STASH_TTL_MS`; run the sweep; assert the file is gone and a
   subsequent read returns 404/ENOENT. A second entry written "now" in the
   same sweep must **not** be deleted (sweep must be age-selective, not
   wholesale).
3. **GC — size cap eviction.** Write entries past `PXPIPE_STASH_MAX_ENTRIES`
   (or `MAX_BYTES`); assert the sweep evicts oldest-`createdAt`-first until
   back under the cap, and the newest entries survive.
4. **Kill-switch regression.** With `PXPIPE_STASH` unset/`0`,
   `tests/recoverable.test.ts` **must continue to pass with zero
   modifications** — `info.recoverable[].text` populated exactly as today,
   no `stashed` field, no directory created on disk. This is the single most
   important regression gate: it proves the existing contract this spec
   builds on top of is untouched by default.
5. **Cache-control invariant.** With the handle text appended per §3,
   `countCacheControlMarkers()` (`src/core/measurement.ts:194`) on the
   transformed request body must report the **same count** as the identical
   request with the handle disabled — proves the handle never duplicates or
   drops a `cache_control` marker. Run this against all three call sites
   (reminder, tool_result, tool_result_part), each with and without a source
   `cache_control` present on the original block.
6. **404 on unknown/expired id.** `GET /stash/rec_00000000` (well-formed,
   never written) → 404. A previously-valid id whose file the GC sweep has
   since deleted → 404 (not a stale 200 with garbage data).
7. **Malformed id rejected before any filesystem access.** `GET
   /stash/../../etc/passwd`-shaped or otherwise non-`rec_[0-9a-f]{8}`
   paths never reach `fs.readFile` — assert via a spy/mock that the fs layer
   is never invoked for a malformed id (proves the regex gate in §8 is
   actually load-bearing, not just documented).

## 11. Rollout phases

| Phase | Scope | Depends on |
|---|---|---|
| 0 | This spec. No code. | — |
| 1 | `recordRecoverable` extended with `PXPIPE_STASH` write path (§4, §7); `RecoverableBlock.stashed`/optional `text`; direct fs read/write tests (test 1, 4 from §10) — no HTTP yet. Default `PXPIPE_STASH=0` — behavior unchanged until opted in. | §4, §7 |
| 2 | `GET /stash/:id` in `dashboard.ts`/`node.ts` (§8); e2e round-trip test through the real HTTP route (test 1 upgraded, test 6, test 7). | Phase 1 |
| 3 | GC sweep — TTL + size cap (§5); tests 2 and 3. | Phase 1 |
| 4 | Handle text wired into the three `transform.ts` call sites (§3, §7); cache-control invariant tests (test 5); `node.ts`/`worker.ts` env-knob wiring so `emitRecoverable`/`PXPIPE_STASH` are actually reachable outside unit tests (closing the §1 "dead in production" gap) — still defaulted off. | Phases 1-3 |
| 5 (optional, separate spec) | Variant B — model-callable tool retrieval (§9). Not scheduled; write a new spec before starting. | Phase 4 |

Each phase should land as its own PR with its own tests green
(`npx vitest run`) before the next phase starts, per the repo's existing
incremental-task convention (see `docs/ADAPTIVE_CPT_PLAN.md`'s
"plan locked, not implemented" framing for the same staged-spec pattern).

## 12. Open risks / non-goals summary

- **Auth.** No authentication on `GET /stash/:id`, inherited from the
  dashboard's existing no-auth posture (§6). Not solved here.
- **Retention window.** Stash makes previously-transient text durable on
  disk for up to `PXPIPE_STASH_TTL_MS` (§6) — a real, if bounded, change in
  exposure profile for any sensitive tool output. Default-off mitigates but
  does not eliminate this for operators who opt in.
- **Workers has no FS.** Stash is Node-only indefinitely unless a separate,
  explicitly-scoped future spec designs a KV-backed variant (§7, §11).
- **Concurrent multi-process writers** to one `~/.pxpipe/stash/` directory
  are unguarded, matching the existing (also unguarded) `events.jsonl`
  single-writer assumption (§5) — not a new gap, but not closed by this spec
  either.
- **No secret/PII scanning** before persisting stash entries (§6) — out of
  scope.
- **Coordination with B7** (dedup/global manifest) and **B5+B8** (tiered
  fidelity) — boundaries stated in §2; no shared file/module assumed without
  explicit reconciliation at implementation time.
- **`tracker.ts` still drops `info.recoverable` from JSONL** — acceptable
  because the stash is now the persistence mechanism, but flagged (§7) as an
  adjacent gap a future task may want to revisit independently.
