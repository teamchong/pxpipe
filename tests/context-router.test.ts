/**
 * Context risk router — classifier + exact-token extractor + keepSharp adapter.
 *
 * Covers the five decision cases from the handoff plus the two invariants that
 * make it safe: (a) no raw secret ever appears in any output/snapshot, and
 * (b) `makeKeepSharp` is a valid drop-in for pxpipe's existing `keepSharp` hook.
 */

import { describe, expect, it } from 'vitest';
import {
  extractExactTokens,
  hasSecret,
  shannonEntropy,
  redactSecrets,
  SECRET_REDACTION,
} from '../src/core/exact-token-extractor.js';
import { assessContextRisk } from '../src/core/risk-classifier.js';
import {
  routeBlock,
  makeKeepSharp,
  makeRedactingHooks,
  buildRescueStrip,
} from '../src/core/context-router.js';

/** Big low-risk prose filler with zero exact anchors (numbers/paths avoided). */
const PROSE = (
  'Context compression trades exactness for size. The router decides which blocks ' +
  'are safe to render as images and which must stay as text so an agent never ' +
  'silently misreads something it needs verbatim. '
).repeat(120);

describe('exact-token extractor', () => {
  it('extracts paths, hashes, uuids, urls, versions', () => {
    const text =
      'see src/core/baseline.ts and ../tests/x.test.ts, commit 7dd54d3, ' +
      'id 75e2167f-cc7f-45cf-a1dd-35c19f14c123, https://example.com/a, v1.2.3';
    const kinds = new Set(extractExactTokens(text).map((t) => t.kind));
    expect(kinds.has('path')).toBe(true);
    expect(kinds.has('hash')).toBe(true);
    expect(kinds.has('uuid')).toBe(true);
    expect(kinds.has('url')).toBe(true);
    expect(kinds.has('version')).toBe(true);
  });

  it('does not mistake a plain 7-digit number for a git hash', () => {
    const tokens = extractExactTokens('the count was 1234567 items');
    expect(tokens.some((t) => t.kind === 'hash')).toBe(false);
  });

  it('shannon entropy is higher for random tokens than prose', () => {
    expect(shannonEntropy('aaaaaaaa')).toBeLessThan(shannonEntropy('aB3xQ9pL7z'));
  });
});

describe('risk classifier — handoff cases', () => {
  // Case 1: low-risk prose → imaged, no exact tokens.
  it('Case 1: long prose is low risk and compressible', () => {
    const a = assessContextRisk(PROSE);
    expect(a.risk).toBe('low');
    expect(a.decision).toBe('image_only');
    expect(a.exactTokens).toHaveLength(0);
    expect(a.compressible).toBe(true);
  });

  // Case 2: stack trace with paths + line numbers → high risk, stays exact.
  it('Case 2: stack trace preserves paths and line:col anchors', () => {
    const text =
      "Error: Cannot find module './foo'\n" +
      '    at src/core/index.ts:42:13\n' +
      '    at tests/core.test.ts:7:5\n';
    const a = assessContextRisk(text);
    expect(a.risk).toBe('high');
    expect(['image_plus_exact_rescue', 'text_only']).toContain(a.decision);
    const vals = a.exactTokens.map((t) => t.value);
    expect(vals).toContain('src/core/index.ts');
    expect(vals).toContain('tests/core.test.ts');
    expect(vals).toContain('42:13');
    expect(vals).toContain('7:5');
  });

  // Case 3: secrets → critical, redact_or_block, and never printed raw.
  it('Case 3: secrets are critical, blocked, and never leaked', () => {
    const secret = 'sk-ant-abc123456789xyz';
    const text = `ANTHROPIC_API_KEY=${secret}\nPXPIPE_WORKER_SECRET=hunter2hunter2hunter2`;
    const a = assessContextRisk(text);
    expect(a.risk).toBe('critical');
    expect(a.decision).toBe('redact_or_block');
    expect(hasSecret(a.exactTokens)).toBe(true);
    // The raw secret must not appear anywhere in the assessment output.
    expect(JSON.stringify(a)).not.toContain(secret);
    expect(JSON.stringify(a)).not.toContain('hunter2');
  });

  // Case 4: command block → high risk, kept exact, commands captured.
  it('Case 4: command block stays exact with commands/urls preserved', () => {
    const text =
      'npx pxpipe-proxy\n' +
      'ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude\n' +
      'pnpm install && pnpm test\n';
    const a = assessContextRisk(text);
    expect(a.risk).toBe('high');
    expect(['text_only', 'image_plus_exact_rescue']).toContain(a.decision);
    const cmds = a.exactTokens.filter((t) => t.kind === 'command').map((t) => t.value);
    expect(cmds.some((c) => c.includes('pnpm install && pnpm test'))).toBe(true);
    expect(cmds.some((c) => c.includes('claude'))).toBe(true);
  });

  // Case 5: large mixed tool output — bulk imaged, sparse anchors rescued.
  it('Case 5: large sparse-anchor output routes image_plus_exact_rescue', () => {
    const bulk = 'processed record ok, retry scheduled, cache warm\n'.repeat(400);
    const text = bulk + '\nartifact at dist/out.js built from commit a1b2c3d\n';
    const a = assessContextRisk(text);
    expect(a.decision).toBe('image_plus_exact_rescue');
    expect(a.compressible).toBe(true);
    const vals = a.exactTokens.map((t) => t.value);
    expect(vals).toContain('dist/out.js');
    expect(vals.some((v) => v === 'a1b2c3d')).toBe(true);
  });

  it('measured gate: MANY DISTINCT anchors exceed the rescue budget → text_only', () => {
    // 200 distinct paths — more than the factsheet can rescue, so imaging would drop
    // the overflow to OCR. Must stay text.
    const distinctPaths = Array.from({ length: 200 }, (_, i) => `src/mod${i}/file${i}.ts`).join('\n');
    const big = distinctPaths + '\n' + 'x'.repeat(7000); // push over the small-block floor
    const a = assessContextRisk(big);
    expect(a.decision).toBe('text_only');
    expect(a.reasons.some((r) => r.startsWith('anchors_exceed_rescue_budget'))).toBe(true);
  });

  it('measured gate: many IDENTICAL anchors dedupe to one → images (rescuable)', () => {
    // 300 copies of the SAME path = 1 distinct anchor. The factsheet dedupes, so one
    // rescue slot covers them all — this SHOULD image (the old coverage heuristic
    // wrongly kept it as text).
    const repeated = 'src/core/module-number-XX/file-name-here.ts\n'.repeat(300);
    const a = assessContextRisk(repeated);
    expect(a.decision).toBe('image_plus_exact_rescue');
    expect(a.reasons.some((r) => r.startsWith('rescuable_anchors'))).toBe(true);
  });
});

describe('router + keepSharp adapter', () => {
  it('makeKeepSharp keeps secrets and commands as text, images prose', () => {
    const keep = makeKeepSharp('coding-agent');
    expect(keep({ text: 'ANTHROPIC_API_KEY=sk-ant-abcdef1234567890' })).toBe(true);
    expect(keep({ text: 'pnpm install && pnpm test' })).toBe(true);
    expect(keep({ text: PROSE })).toBe(false);
  });

  it('makeKeepSharp is defensive against bad input', () => {
    const keep = makeKeepSharp();
    // @ts-expect-error — exercising the runtime guard
    expect(keep(undefined)).toBe(false);
    // @ts-expect-error — non-string text
    expect(keep({ text: 42 })).toBe(false);
  });

  it('strict policy pins any anchor-bearing block to text', () => {
    const keepStrict = makeKeepSharp('strict');
    const small = 'the file is src/index.ts';
    expect(keepStrict({ text: small })).toBe(true);
  });

  it('redactSecrets masks the value in place, preserves the rest, leaks nothing', () => {
    const secret = 'sk-ant-api03-REDACTsecret1234567890abcdef';
    const text = `preamble line\nANTHROPIC_API_KEY=${secret}\ntrailing line`;
    const { redacted, count } = redactSecrets(text);
    expect(count).toBe(1);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain(SECRET_REDACTION);
    expect(redacted).toContain('preamble line');
    expect(redacted).toContain('trailing line');
  });

  it('redactSecrets is a no-op when there is no secret', () => {
    const text = 'just a path src/index.ts and a version v1.2.3';
    const { redacted, count } = redactSecrets(text);
    expect(count).toBe(0);
    expect(redacted).toBe(text);
  });

  it('makeRedactingHooks: secret block redacts (not kept text); prose neither', () => {
    const { keepSharp, redactBlock } = makeRedactingHooks('coding-agent');
    const secretText = 'log\n'.repeat(50) + 'TOKEN=abcdEFGH1234secretVALUE6789xyz';
    // Secret block is NOT pinned as text — it will image with the value masked.
    expect(keepSharp({ text: secretText })).toBe(false);
    const masked = redactBlock({ text: secretText });
    expect(masked).not.toBeNull();
    expect(masked!).toContain(SECRET_REDACTION);
    expect(masked!).not.toContain('abcdEFGH1234secretVALUE6789xyz');
    // Prose: no redaction, and (large) it images.
    expect(redactBlock({ text: PROSE })).toBeNull();
    // A non-secret dense/high-risk block still stays text under keepSharp.
    expect(keepSharp({ text: 'file at src/a.ts' })).toBe(true);
  });

  it('rescue strip lists exact tokens and prints no raw secret', () => {
    // Bulk must exceed the 6000-char small-block floor to reach the image lane.
    const text = 'log line\n'.repeat(900) + 'built dist/app.js at v2.0.1\n';
    const r = routeBlock(text, 'default');
    expect(r.rescueStrip).toBeDefined();
    expect(r.rescueStrip!).toContain('dist/app.js');
    expect(r.rescueStrip!).toContain('v2.0.1');

    const secretAssess = assessContextRisk('KEY_TOKEN=supersecretvalue123456');
    const strip = buildRescueStrip(secretAssess);
    expect(strip).not.toContain('supersecretvalue123456');
  });
});
