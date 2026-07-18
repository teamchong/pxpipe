/**
 * END-TO-END cache-alignment contract through the REAL proxy.
 *
 * Unlike anthropic-cache-align / gpt-cache-align (which call collapseHistory /
 * planGptCollapse directly), this drives `createProxy` against a FAKE upstream
 * and asserts on the bytes the proxy actually FORWARDS. That closes the gap the
 * unit tests can't see: routing, the gate, marker relocation, transform-once,
 * and — the headline — that the cacheable image PREFIX stays byte-identical as
 * the conversation grows turn-by-turn (the real Claude Code / OpenCode loop).
 *
 *   fake api  = the upstream output (canned responses + count_tokens probe)
 *   our input = pxpipe's transform of the request body
 *
 * If a regression ever makes the rendered prefix non-deterministic (timestamp,
 * map ordering, re-imaging on every turn), the byte-identity assertions below go
 * red — which is exactly the cache-busting failure that costs real money.
 *
 * Run just this file:  pnpm vitest run tests/cache-stability-e2e.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createProxy } from '../src/core/proxy.js';
import { countCacheControlMarkers } from '../src/core/measurement.js';
import { HISTORY_SYNTHETIC_INTRO } from '../src/core/history.js';
import { resetEnvSplitState } from '../src/core/transform.js';

// Pin the model scope so these proxy-contract tests stay independent of the developer shell.
let ambientPxpipeModels: string | undefined;
beforeAll(() => {
  ambientPxpipeModels = process.env.PXPIPE_MODELS;
  process.env.PXPIPE_MODELS = 'claude-fable-5,gpt-5.6-sol';
});
// The env split learns across sessions keyed by claudeMdSha, and every test
// here shares the same `# CLAUDE.md` fixture slab — without a reset, an env
// entry that one test proved stable would promote into the slab in a LATER
// test's fresh session, changing what relocates to the tail.
beforeEach(() => resetEnvSplitState());
afterAll(() => {
  if (ambientPxpipeModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = ambientPxpipeModels;
});

// ---------------------------------------------------------------------------
// Fake upstream — records every outbound MAIN request body and answers with a
// canned, well-formed response so the proxy completes. The /count_tokens probe
// is answered separately (never recorded as a main request).
// ---------------------------------------------------------------------------
interface Captured {
  url: string;
  path: string;
  body: string;
  authorization: string | null;
  apiKey: string | null;
}

function fakeUpstream() {
  const main: Captured[] = [];
  const sidePaths: string[] = [];
  const real = globalThis.fetch;

  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    const path = url.pathname;

    // Anthropic baseline probe — stub it, don't record as a main request.
    if (path.endsWith('/count_tokens')) {
      sidePaths.push(path);
      return new Response(JSON.stringify({ input_tokens: 9999 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    main.push({
      url: req.url,
      path,
      body: await req.clone().text(),
      authorization: req.headers.get('authorization'),
      apiKey: req.headers.get('x-api-key'),
    });

    if (path.includes('chat/completions')) {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_1',
          object: 'chat.completion',
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (path.includes('responses')) {
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          object: 'response',
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
          ],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    // Anthropic /v1/messages
    return new Response(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  return {
    main,
    sidePaths,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

/** Force imaging deterministically (matches proxy-usage.test.ts). */
const FORCE = { charsPerToken: 1, minCompressChars: 1 } as const;

const slab = (n: number) => '# CLAUDE.md\nYou are helpful.\n' + 'rule. '.repeat(Math.ceil(n / 6));
const filler = (n: number) => 'x'.repeat(n);

// ---- outbound-body inspectors -------------------------------------------
/** Every Anthropic image block across all messages, in order, with its marker. */
function anthropicImages(bodyText: string): { data: string; marked: boolean }[] {
  const b = JSON.parse(bodyText);
  const out: { data: string; marked: boolean }[] = [];
  for (const m of b.messages ?? []) {
    if (!Array.isArray(m.content)) continue;
    for (const blk of m.content) {
      if (blk?.type === 'image') {
        out.push({ data: blk.source.data, marked: blk.cache_control !== undefined });
      }
    }
  }
  return out;
}

/** The first-text-block banner of whichever message holds the marked image,
 *  or undefined if that message doesn't START with a text block (i.e. the
 *  marker is on an image-first message = the slab message, NOT the synthetic). */
function markedBanner(bodyText: string): string | undefined {
  const b = JSON.parse(bodyText);
  for (const m of b.messages ?? []) {
    if (!Array.isArray(m.content)) continue;
    const marked = m.content.some(
      (c: any) => c?.type === 'image' && c.cache_control !== undefined,
    );
    if (marked) return m.content[0]?.type === 'text' ? m.content[0].text : undefined;
  }
  return undefined;
}

/** GPT chat-completions image data URLs across all messages, in order. */
function gptChatImages(bodyText: string): string[] {
  const b = JSON.parse(bodyText);
  const out: string[] = [];
  for (const m of b.messages ?? []) {
    if (!Array.isArray(m.content)) continue;
    for (const c of m.content) if (c?.type === 'image_url') out.push(c.image_url.url);
  }
  return out;
}

/** GPT Responses image data URLs across all input items, in order.
 *  (Extract the data URL, not the whole block — append-only correctness is about
 *  the image BYTES, not structural fields like `detail`.) */
function gptResponsesImages(bodyText: string): string[] {
  const b = JSON.parse(bodyText);
  const out: string[] = [];
  for (const m of b.input ?? []) {
    if (!Array.isArray(m.content)) continue;
    for (const c of m.content) if (c?.type === 'input_image') out.push(c.image_url);
  }
  return out;
}

// ---- request-body builders ----------------------------------------------
function anthropicBody(opts: {
  model?: string;
  slabChars?: number;
  /** Appended verbatim to the slab text INSIDE the marked system block —
   *  used to inject a volatile `# Environment` section next to static content. */
  sysSuffix?: string;
  turns: { role: 'user' | 'assistant'; text: string }[];
}): string {
  const system = opts.slabChars
    ? [
        {
          type: 'text',
          text: slab(opts.slabChars) + (opts.sysSuffix ?? ''),
          cache_control: { type: 'ephemeral' },
        },
      ]
    : 'short';
  return JSON.stringify({
    model: opts.model ?? 'claude-fable-5',
    max_tokens: 16,
    system,
    messages: opts.turns.map((t) => ({ role: t.role, content: t.text })),
  });
}

function turns(n: number, chars: number): { role: 'user' | 'assistant'; text: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: `turn ${i}: ${filler(chars)}`,
  }));
}

async function driveAnthropic(body: string, cap = fakeUpstream(), proxyOpts = {}) {
  const proxy = createProxy({
    upstream: 'http://anthropic.test',
    apiKey: 'sk-ant-test',
    transform: FORCE,
    onRequest: () => {},
    ...proxyOpts,
  });
  const res = await proxy(
    new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-test' },
      body,
    }),
  );
  await res.text();
  return cap;
}

// ===========================================================================
describe('e2e cache alignment — Anthropic /v1/messages through the real proxy', () => {
  it('never adds a cache_control marker; the one caller marker is conserved', async () => {
    const body = anthropicBody({ slabChars: 80_000, turns: turns(4, 20) });
    const inMarks = countCacheControlMarkers(new TextEncoder().encode(body));
    const cap = await driveAnthropic(body);
    cap.restore();

    expect(cap.main).toHaveLength(1);
    expect(inMarks).toBe(1); // sanity: caller sent exactly one
    const outMarks = countCacheControlMarkers(new TextEncoder().encode(cap.main[0]!.body));
    expect(outMarks).toBe(1); // conserved — not dropped, not duplicated
  });

  it('relocates the surviving marker onto an IMAGE block in the forwarded body', async () => {
    const cap = await driveAnthropic(anthropicBody({ slabChars: 80_000, turns: turns(4, 20) }));
    cap.restore();

    const imgs = anthropicImages(cap.main[0]!.body);
    expect(imgs.length).toBeGreaterThan(0);
    const marked = imgs.filter((i) => i.marked);
    expect(marked).toHaveLength(1); // the breakpoint sits on exactly one image
  });

  it('CACHE-STABLE: the marked slab image is byte-identical as short tail turns are appended', async () => {
    // Same big slab; only the (tiny, non-collapsing) tail grows. The cache
    // breakpoint must point at byte-identical content both times → cache_read.
    const base = turns(2, 20);
    const cap1 = await driveAnthropic(anthropicBody({ slabChars: 80_000, turns: base }));
    cap1.restore();
    const cap2 = await driveAnthropic(
      anthropicBody({ slabChars: 80_000, turns: [...base, ...turns(4, 20)] }),
    );
    cap2.restore();

    const marked1 = anthropicImages(cap1.main[0]!.body).find((i) => i.marked);
    const marked2 = anthropicImages(cap2.main[0]!.body).find((i) => i.marked);
    expect(marked1).toBeDefined();
    expect(marked2).toBeDefined();
    expect(marked2!.data).toBe(marked1!.data); // byte-identical cached prefix
  });

  it('APPEND-ONLY: frozen history images stay byte-identical when growth advances the collapse window', async () => {
    // No slab (every image is a history page). 30 turns collapses a small
    // window; 120 turns advances the boundary and emits MORE pages. The earlier
    // pages must render identical bytes so Anthropic cache_reads the prefix.
    // NB: Anthropic's LAST history image is partial (it absorbs content as the
    // boundary moves), so the invariant is "all-but-last pages are a byte-
    // identical prefix" — not the whole list (that's the GPT sealed-section rule).
    const cap1 = await driveAnthropic(anthropicBody({ turns: turns(30, 4000) }));
    cap1.restore();
    const cap2 = await driveAnthropic(anthropicBody({ turns: turns(120, 4000) }));
    cap2.restore();

    const a = anthropicImages(cap1.main[0]!.body).map((i) => i.data);
    const b = anthropicImages(cap2.main[0]!.body).map((i) => i.data);
    expect(a.length).toBeGreaterThan(1);
    expect(b.length).toBeGreaterThan(a.length); // boundary advanced → pages appended
    expect(b[0]).toBe(a[0]); // the frozen prefix anchor never re-renders
    // Empirically (this path, dense char-packed images) the LAST page is partial:
    // it absorbs more content as the boundary advances, so it legitimately differs.
    // Earlier pages must be a byte-identical prefix. (GPT's sealed sections are
    // stricter — see the GPT append-only test, which asserts the FULL prefix.)
    expect(b.slice(0, a.length - 1)).toEqual(a.slice(0, a.length - 1));
    // No slab → relocateAnchorToHistoryImage never runs; input had 0 markers
    // (plain-string system), so the proxy must not invent one.
    expect(countCacheControlMarkers(new TextEncoder().encode(cap1.main[0]!.body))).toBe(0);
  });

  it('CARRY-OVER (#11): the marked history image is a frozen page, not the partial tail, across an advance', async () => {
    // Slab present (so the anchor relocates onto a history image) + enough history
    // to collapse AND advance the window. The marker must land on a byte-FROZEN page
    // (the carry-over anchor), never the last partial page — else the cached prefix
    // busts on every advance (#11). Before the fix the marker sat on the LAST image.
    const cap1 = await driveAnthropic(anthropicBody({ slabChars: 80_000, turns: turns(80, 4000) }));
    cap1.restore();
    const cap2 = await driveAnthropic(anthropicBody({ slabChars: 80_000, turns: turns(200, 4000) }));
    cap2.restore();

    const imgs1 = anthropicImages(cap1.main[0]!.body);
    const imgs2 = anthropicImages(cap2.main[0]!.body);
    const markedIdx1 = imgs1.findIndex((i) => i.marked);

    // Conserved: exactly one marker, and it sits on an image.
    expect(imgs1.filter((i) => i.marked)).toHaveLength(1);
    expect(markedIdx1).toBeGreaterThanOrEqual(0);
    // The advance is real (the window grew), so the byte-frozen check isn't vacuous.
    expect(imgs2.length).toBeGreaterThan(imgs1.length);
    // (1) NOT the last (partial, still-growing) page — that placement is the #11 bust.
    expect(markedIdx1).toBeLessThan(imgs1.length - 1);
    // (2) The marked page is byte-frozen: it reappears identically after the advance,
    //     so Anthropic cache_reads the prefix instead of re-creating it.
    expect(imgs2.some((i) => i.data === imgs1[markedIdx1]!.data)).toBe(true);
  });

  it('relocates the single marker onto the HISTORY image once history collapses', async () => {
    // The trickiest cache move (relocateAnchorToHistoryImage), end-to-end: with a
    // tiny tail the caller marker stays on the SLAB image; once history collapses
    // the SAME single marker moves onto the history synthetic image, so one
    // breakpoint caches slab+history as one stable segment.
    const capSlab = await driveAnthropic(anthropicBody({ slabChars: 80_000, turns: turns(4, 20) }));
    capSlab.restore();
    const capHist = await driveAnthropic(anthropicBody({ slabChars: 80_000, turns: turns(120, 4000) }));
    capHist.restore();

    // Both: exactly one marked image (conserved, never duplicated).
    expect(anthropicImages(capSlab.main[0]!.body).filter((i) => i.marked)).toHaveLength(1);
    expect(anthropicImages(capHist.main[0]!.body).filter((i) => i.marked)).toHaveLength(1);
    // No history → the marker sits on the SLAB image, which lives in messages[0]
    // (an image-first message), NOT on a history synthetic.
    const slabMsg0 = JSON.parse(capSlab.main[0]!.body).messages[0];
    expect(
      slabMsg0.content.some((b: any) => b?.type === 'image' && b.cache_control !== undefined),
    ).toBe(true);
    expect(markedBanner(capSlab.main[0]!.body)).toBeUndefined();
    // History collapsed → marker relocated ONTO the history synthetic image.
    expect(markedBanner(capHist.main[0]!.body)).toBe(HISTORY_SYNTHETIC_INTRO);
  });

  it('ENV SPLIT: a git-status change in `# Environment` never re-renders the slab image', async () => {
    // Cross-session cache bust regression: Claude Code injects a `# Environment`
    // markdown section (working dir, git status, model ID) into the system text
    // with no XML wrapper. Baked into the slab PNG, a one-file edit flipped
    // system_sha8 717f1fce → 5efaa4bb and re-created the whole prefix. The fix
    // (stripMarkdownEnvSection) pulls it out BEFORE the static/dynamic split:
    // slab bytes must be independent of git state, while the env text still
    // reaches the model as plain system text after the anchor.
    const env = (git: string) =>
      `\n# Environment\nWorking directory: /repo\nPlatform: darwin\nGit status:\n${git}`;
    const cap1 = await driveAnthropic(
      anthropicBody({ slabChars: 80_000, sysSuffix: env('clean'), turns: turns(4, 20) }),
    );
    cap1.restore();
    const cap2 = await driveAnthropic(
      anthropicBody({
        slabChars: 80_000,
        sysSuffix: env('modified: src/pricing.ts'),
        turns: turns(4, 20),
      }),
    );
    cap2.restore();

    // Tail turns identical + no collapse (4 turns < minCollapsePrefix) → every
    // forwarded image is a slab image. ALL of them must be byte-identical across
    // the two "sessions" — the env change may not reach the renderer at all.
    const a = anthropicImages(cap1.main[0]!.body).map((i) => i.data);
    const b = anthropicImages(cap2.main[0]!.body).map((i) => i.data);
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);

    // Not dropped: the volatile section re-enters as trailing TEXT on the LAST
    // user message (per-turn live tail), so the model still sees the current
    // git state. It must NOT ride in system: system bytes sit BEFORE the slab
    // anchor in Anthropic's prefix order (tools → system → messages), so any
    // env change there cold-restarts the entire anchored prefix (48.8% of
    // telemetry-era cold-create waste).
    const sysText = (bodyText: string): string => {
      const sys = JSON.parse(bodyText).system;
      return Array.isArray(sys) ? sys.map((s: any) => s?.text ?? '').join('\n') : String(sys ?? '');
    };
    const lastUserText = (bodyText: string): string => {
      const msgs = JSON.parse(bodyText).messages as Array<{ role: string; content: unknown }>;
      const m = [...msgs].reverse().find((x) => x.role === 'user')!;
      return Array.isArray(m.content)
        ? m.content.map((c: any) => (c?.type === 'text' ? c.text : '')).join('\n')
        : String(m.content ?? '');
    };
    expect(lastUserText(cap2.main[0]!.body)).toContain('modified: src/pricing.ts');
    expect(lastUserText(cap1.main[0]!.body)).toContain('Git status:\nclean');
    // And the section left both the imaged region AND system entirely — nothing
    // upstream of the anchor may depend on git state. (Byte-equality above is
    // the load-bearing check; this pins the mechanism.)
    expect(lastUserText(cap2.main[0]!.body)).toContain('# Environment');
    expect(sysText(cap2.main[0]!.body)).not.toContain('modified: src/pricing.ts');
    expect(sysText(cap2.main[0]!.body)).not.toContain('# Environment');
    // Regression (2026-07): the relocated block must be delimited as injected
    // context, never blended into user prose — undelimited, it can BECOME the
    // entire visible message on an empty/short user turn (observed live).
    expect(lastUserText(cap2.main[0]!.body)).toMatch(
      /<system-reminder>[\s\S]*relocated by pxpipe[\s\S]*# Environment[\s\S]*<\/system-reminder>/,
    );
  });

  it('ENV RELOCATION: model-identity/catalog lines are redacted from the relocated block', async () => {
    // Regression (2026 LinkedIn report): relocating `# Environment` into the
    // LAST user message re-surfaced "You are powered by … Fable 5" and "default
    // to the latest and most capable Claude models" as fresh per-turn guidance,
    // exactly where the parent model chooses subagent models — subagents that
    // should run on haiku were spawned on fable, and pxpipe INCREASED cost.
    // Fix: redactModelIdentityLines on the relocation path (transform.ts). The
    // rest of the env block (cwd, git, platform) must survive untouched.
    const env =
      `\n# Environment\nWorking directory: /repo\nPlatform: darwin\n` +
      `You are powered by the model named Fable 5. The exact model ID is claude-fable-5.\n` +
      `The most recent Claude models are the Claude 5 family, Opus 4.8, and Haiku 4.5. ` +
      `When building AI applications, default to the latest and most capable Claude models.\n` +
      `Git status:\nclean`;
    const cap = await driveAnthropic(
      anthropicBody({ slabChars: 80_000, sysSuffix: env, turns: turns(4, 20) }),
    );
    cap.restore();

    const bodyText = cap.main[0]!.body;
    const sys = JSON.parse(bodyText).system;
    const sysStr = Array.isArray(sys)
      ? sys.map((s: any) => s?.text ?? '').join('\n')
      : String(sys ?? '');
    const msgs = JSON.parse(bodyText).messages as Array<{ role: string; content: unknown }>;
    const lastUser = [...msgs].reverse().find((x) => x.role === 'user')!;
    const lastUserStr = Array.isArray(lastUser.content)
      ? lastUser.content.map((c: any) => (c?.type === 'text' ? c.text : '')).join('\n')
      : String(lastUser.content ?? '');

    // Identity/catalog lines: gone from the relocated block — and not moved
    // back into system either (they'd cache-bust the anchored prefix there).
    for (const needle of [
      'You are powered by',
      'exact model ID is',
      'most recent Claude models',
      'default to the latest and most capable',
    ]) {
      expect(lastUserStr).not.toContain(needle);
      expect(sysStr).not.toContain(needle);
    }
    // Non-identity env lines still reach the model on the live tail.
    expect(lastUserStr).toContain('# Environment');
    expect(lastUserStr).toContain('Working directory: /repo');
    expect(lastUserStr).toContain('Git status:\nclean');
  });

  it('FIRST COLLAPSE (turn-2 rewrite): no frozen chunk yet → anchor stays on the SLAB image', async () => {
    // With defaults (keepTail 4, minCollapsePrefix 10, freezeChunk 10) and a slab
    // (protectedPrefix 1), 15 messages give collapse range [1..11) = exactly 10 =
    // one freeze window → no fully-frozen chunk → carryOverImageOrdinal undefined.
    // Before the fix, relocateAnchorToHistoryImage ran anyway and pinned the anchor
    // to the newest STILL-GROWING history image — a volatile breakpoint that forced
    // a one-time full-prefix rewrite (~53k tokens/session). The anchor must stay on
    // the byte-stable slab image until a frozen chunk exists to pin to.
    const cap1 = await driveAnthropic(anthropicBody({ slabChars: 80_000, turns: turns(15, 4000) }));
    cap1.restore();
    // +2 tail turns: collapseChunk snapping keeps the boundary at 11, so the
    // history image is unchanged — the cacheable prefix must be byte-stable.
    const cap2 = await driveAnthropic(anthropicBody({ slabChars: 80_000, turns: turns(17, 4000) }));
    cap2.restore();

    for (const cap of [cap1, cap2]) {
      const body = cap.main[0]!.body;
      // Guard against a vacuous pass: collapse really happened.
      expect(body).toContain(HISTORY_SYNTHETIC_INTRO.slice(0, 40));
      // Marker conserved…
      expect(anthropicImages(body).filter((i) => i.marked)).toHaveLength(1);
      // …and NOT on the history synthetic: the marked message is image-first
      // (the slab in messages[0]), not the text-banner history message.
      expect(markedBanner(body)).toBeUndefined();
    }
    // The marked image is byte-identical across the advance — the whole point:
    // the breakpoint sits on frozen bytes, so the prefix cache_reads, not re-creates.
    const m1 = anthropicImages(cap1.main[0]!.body).find((i) => i.marked)!;
    const m2 = anthropicImages(cap2.main[0]!.body).find((i) => i.marked)!;
    expect(m2.data).toBe(m1.data);
  });

  it('GATE: an out-of-scope model is forwarded byte-for-byte untouched (no images)', async () => {
    // claude-3-5-sonnet is NOT in the default PXPIPE_MODELS scope → passthrough.
    const body = anthropicBody({ model: 'claude-3-5-sonnet', slabChars: 80_000, turns: turns(4, 20) });
    const cap = await driveAnthropic(body);
    cap.restore();
    expect(anthropicImages(cap.main[0]!.body)).toHaveLength(0);
    // "untouched" must mean the whole payload, not merely image-free.
    expect(JSON.parse(cap.main[0]!.body)).toEqual(JSON.parse(body));
  });

  it('ROUTING + AUTH: forwards to the configured upstream; only count_tokens side calls (dual probe with a marker)', async () => {
    const cap = await driveAnthropic(anthropicBody({ slabChars: 80_000, turns: turns(4, 20) }));
    // count_tokens is fire-and-forget — give it a tick before asserting.
    await new Promise((r) => setTimeout(r, 30));
    cap.restore();

    expect(cap.main).toHaveLength(1);
    expect(cap.main[0]!.url).toBe('http://anthropic.test/v1/messages');
    expect(cap.main[0]!.apiKey).toBe('sk-ant-test');
    // The body carries a cache_control marker, so BOTH probes fire: the full-body
    // baseline AND the truncated cacheable-prefix probe. Exactly two, both
    // count_tokens, no other side endpoint leaks. A suppressed second probe → red.
    expect(cap.sidePaths).toEqual([
      '/v1/messages/count_tokens',
      '/v1/messages/count_tokens',
    ]);
  });

  it('produces valid JSON with well-formed base64 PNGs on EVERY page', async () => {
    const cap = await driveAnthropic(anthropicBody({ slabChars: 80_000, turns: turns(4, 20) }));
    cap.restore();
    const parsed = JSON.parse(cap.main[0]!.body);
    expect(Array.isArray(parsed.messages)).toBe(true);
    const imgs = anthropicImages(cap.main[0]!.body);
    expect(imgs.length).toBeGreaterThan(0);
    // EVERY page must be a real PNG (base64 PNG magic = 'iVBORw0KGgo'), not just
    // the first — a corrupted page 2+ would otherwise slip through.
    expect(imgs.every((i) => i.data.length > 100 && i.data.startsWith('iVBORw0KGgo'))).toBe(true);
  });
});

// ===========================================================================
describe('e2e cache alignment — GPT (OpenAI) through the real proxy', () => {
  function gptChatBody(opts: {
    model?: string;
    systemChars: number;
    turns: { role: 'user' | 'assistant'; text: string }[];
  }): string {
    return JSON.stringify({
      model: opts.model ?? 'gpt-5.6-sol',
      messages: [
        { role: 'system', content: slab(opts.systemChars) },
        ...opts.turns.map((t) => ({ role: t.role, content: t.text })),
      ],
    });
  }

  function gptResponsesBody(opts: {
    systemChars: number;
    turns: { role: 'user' | 'assistant'; text: string }[];
  }): string {
    return JSON.stringify({
      model: 'gpt-5.6-sol',
      instructions: slab(opts.systemChars),
      input: opts.turns.map((t) => ({ role: t.role, content: t.text })),
    });
  }

  async function driveGpt(path: string, body: string, cap = fakeUpstream()) {
    const proxy = createProxy({
      openAIUpstream: 'https://openai.test',
      openAIApiKey: 'sk-openai-test',
      transform: FORCE,
      onRequest: () => {},
    });
    const res = await proxy(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
    await res.text();
    return cap;
  }

  it('chat: emits NO cache_control (OpenAI prefix cache is markerless)', async () => {
    const cap = await driveGpt(
      '/v1/chat/completions',
      gptChatBody({ systemChars: 60_000, turns: turns(4, 20) }),
    );
    cap.restore();
    expect(cap.main).toHaveLength(1);
    expect(countCacheControlMarkers(new TextEncoder().encode(cap.main[0]!.body))).toBe(0);
    expect(gptChatImages(cap.main[0]!.body).length).toBeGreaterThan(0);
  });

  it('chat APPEND-ONLY: the imaged prefix is byte-identical as the conversation grows', async () => {
    // Big system → slab images AND (since the slab gate clears) history collapses.
    // The cacheable prefix = [slab image] + [frozen history pages]. Stability comes
    // from sectionTokens-sealed sections keyed by ABSOLUTE turn index (t="N"):
    // earlier turns render identical bytes regardless of how much tail is appended.
    const small = turns(30, 4000);
    const cap1 = await driveGpt('/v1/chat/completions', gptChatBody({ systemChars: 60_000, turns: small }));
    cap1.restore();
    const cap2 = await driveGpt(
      '/v1/chat/completions',
      gptChatBody({ systemChars: 60_000, turns: [...small, ...turns(20, 4000)] }),
    );
    cap2.restore();

    const a = gptChatImages(cap1.main[0]!.body);
    const b = gptChatImages(cap2.main[0]!.body);
    expect(a.length).toBeGreaterThan(1); // slab image + ≥1 sealed history page
    expect(b.length).toBeGreaterThan(a.length); // growth sealed more pages
    // GPT seals whole sections (leftover stays text) → strict prefix append-only.
    expect(b.slice(0, a.length)).toEqual(a);
  });

  it('responses APPEND-ONLY: completed-pair pages are byte-identical as native state grows', async () => {
    const pairItems = (n: number, start = 0) => {
      const out: Array<Record<string, unknown>> = [];
      for (let i = start; i < start + n; i++) {
        const id = `call_${i}`;
        out.push({ type: 'function_call', call_id: id, name: 'read', arguments: `{\"path\":\"f${i}\"}` });
        out.push({ type: 'function_call_output', call_id: id, output: `result ${i}: ${filler(4000)}` });
      }
      return out;
    };
    const body = (pairs: Array<Record<string, unknown>>) => JSON.stringify({
      model: 'gpt-5.6-sol', instructions: slab(60_000),
      input: [{ role: 'user', content: 'live request stays native' }, ...pairs],
    });
    const small = pairItems(70);
    const cap1 = await driveGpt('/v1/responses', body(small));
    cap1.restore();
    const cap2 = await driveGpt('/v1/responses', body([...small, ...pairItems(20, 70)]));
    cap2.restore();

    const a = gptResponsesImages(cap1.main[0]!.body);
    const b = gptResponsesImages(cap2.main[0]!.body);
    expect(a.length).toBeGreaterThan(1); // slab image + ≥1 completed-pair page
    // The static slab stays byte-identical. Pair sections deliberately reserve the
    // newest six completed pairs as native, so appending pairs can move the exact
    // old/native frontier even while every removed pair remains protocol-closed.
    expect(b[0]).toBe(a[0]);
    const parsed = JSON.parse(cap2.main[0]!.body);
    const calls = new Set(parsed.input.filter((x: any) => x.type === 'function_call').map((x: any) => x.call_id));
    const outputs = parsed.input.filter((x: any) => x.type === 'function_call_output');
    expect(outputs.every((x: any) => calls.has(x.call_id))).toBe(true);
  });

  it('GATE: an out-of-scope GPT model is forwarded byte-for-byte untouched (no images)', async () => {
    const body = gptChatBody({ model: 'gpt-4o', systemChars: 60_000, turns: turns(4, 20) });
    const cap = await driveGpt('/v1/chat/completions', body);
    cap.restore();
    expect(gptChatImages(cap.main[0]!.body)).toHaveLength(0);
    expect(JSON.parse(cap.main[0]!.body)).toEqual(JSON.parse(body));
  });

  it('ROUTING + AUTH: forwards to the configured OpenAI upstream with the configured key', async () => {
    const cap = await driveGpt(
      '/v1/chat/completions',
      gptChatBody({ systemChars: 60_000, turns: turns(4, 20) }),
    );
    cap.restore();
    expect(cap.main).toHaveLength(1);
    expect(cap.main[0]!.url).toBe('https://openai.test/v1/chat/completions');
    expect(cap.main[0]!.authorization).toBe('Bearer sk-openai-test');
  });
});
