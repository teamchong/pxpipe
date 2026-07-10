#!/usr/bin/env node
/**
 * Paired image-reading pilot for the exact gpt-5.6-sol model.
 *
 * Default mode is render-only and cannot call a model. Live mode is guarded by
 * both SOL_PROFILE_LIVE=1 and a literal approval acknowledgement. Requests go
 * directly to OPENAI_BASE_URL / Responses and refuse pxpipe's known local port,
 * so the images under test are not recursively transformed.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countTokens } from 'gpt-tokenizer';
import {
  reflow,
  renderCellHeight,
  renderCellWidth,
  renderTextToPngs,
} from '../../dist/core/render.js';
import { resolveGptProfile } from '../../dist/core/gpt-model-profiles.js';
import { visionTokensForModel } from '../../dist/core/openai.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK_DIR = join(HERE, '.work');
const PREFLIGHT_PATH = join(HERE, 'preflight.json');
const RESULTS_PATH = join(HERE, 'results.json');
const RAW_DIR = join(HERE, 'raw');

const MODEL = 'gpt-5.6-sol';
const MAX_CALLS = 4;
const LIVE = /^(1|true)$/i.test(process.env.SOL_PROFILE_LIVE || '');
const APPROVAL_ACK = 'approved-4-sol-profile-calls';
const HAS_APPROVAL = process.env.SOL_PROFILE_PAID_APPROVAL === APPROVAL_ACK;
const TIMEOUT_MS = Number(process.env.SOL_PROFILE_TIMEOUT_MS || 180_000);
const RESUME_AFTER_OUTPUT_CAP = process.env.SOL_PROFILE_RESUME_AFTER_OUTPUT_CAP === '1';
const RESUME_OLD_AS_RETUNE = process.env.SOL_PROFILE_RESUME_OLD_AS_RETUNE === '1';
const RESUME_SPACED_RETUNE = process.env.SOL_PROFILE_RESUME_SPACED_RETUNE === '1';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

const LEVELS = ['TRACE', 'DEBUG', 'INFO ', 'NOTICE'];
const UNITS = ['scheduler', 'checksum', 'canary', 'ledger', 'relay', 'watchdog'];
const NOTES = [
  'synthetic sample accepted without state change',
  'checkpoint observed and journal cursor advanced',
  'read only probe completed with stable ordering',
  'queue sample retained for deterministic replay',
  'heartbeat recorded while gate remained unchanged',
  'fixture noise line emitted for density control',
];

const FIXTURE_SPECS = [
  {
    id: 'alpha',
    seed: 0x51a7c0de,
    expected: {
      fingerprint: 'c7a1e90b4d2f',
      camelCase: 'retryBudgetSeconds',
      path: '/srv/sol-pilot/releases/alpha-07/config/runtime-map.json',
      port: '47831',
      gist: 'B',
      unstated: 'NOT STATED',
    },
    guardQuestion: 'Which cloud region hosted the canary?',
    forbiddenGuardTerms: ['region'],
    factsAt: new Map([
      [17, 'DEPLOYMENT_FINGERPRINT=c7a1e90b4d2f ; copy all 12 lowercase hex characters exactly.'],
      [44, 'RUNTIME_FIELD=retryBudgetSeconds ; preserve camelCase spelling exactly.'],
      [72, 'RUN_SUMMARY: The canary stayed paused because the checksum mismatch remained.'],
      [101, 'ACTIVE_MANIFEST=/srv/sol-pilot/releases/alpha-07/config/runtime-map.json'],
      [128, 'CONTROL_PORT=47831 ; this is the listener used by the synthetic relay.'],
    ]),
  },
  {
    id: 'beta',
    seed: 0xb37af11e,
    expected: {
      fingerprint: '8d3f6a20c1e7',
      camelCase: 'maxVisualTokens',
      path: '/opt/sol-pilot/fixtures/beta/session-ledger.toml',
      port: '18082',
      gist: 'A',
      unstated: 'NOT STATED',
    },
    guardQuestion: 'Who owned the incident response?',
    forbiddenGuardTerms: ['owner', 'owned'],
    factsAt: new Map([
      [12, 'CONTROL_PORT=18082 ; this is the listener used by the synthetic relay.'],
      [39, 'ACTIVE_MANIFEST=/opt/sol-pilot/fixtures/beta/session-ledger.toml'],
      [68, 'RUN_SUMMARY: Health checks recovered, so the staged rollout resumed.'],
      [98, 'RUNTIME_FIELD=maxVisualTokens ; preserve camelCase spelling exactly.'],
      [127, 'DEPLOYMENT_FINGERPRINT=8d3f6a20c1e7 ; copy all 12 lowercase hex characters exactly.'],
    ]),
  },
];

function buildFixture(spec) {
  const next = lcg(spec.seed);
  const lines = [
    `SOL PROFILE PILOT FIXTURE ${spec.id.toUpperCase()}`,
    'Synthetic terminal transcript. The labelled records below are the only source of facts.',
    'Noise records use eight-character trace ids; the deployment fingerprint is explicitly labelled and has twelve characters.',
  ];
  for (let i = 0; i < 144; i++) {
    const fact = spec.factsAt.get(i);
    if (fact) lines.push(`[fact ${String(i).padStart(3, '0')}] ${fact}`);
    const a = next();
    const b = next();
    const hh = String((i * 7 + 3) % 24).padStart(2, '0');
    const mm = String((i * 11 + 5) % 60).padStart(2, '0');
    const ss = String((i * 13 + 7) % 60).padStart(2, '0');
    const ms = String(a % 1000).padStart(3, '0');
    const level = LEVELS[a % LEVELS.length];
    const unit = UNITS[b % UNITS.length].padEnd(9, ' ');
    const trace8 = a.toString(16).padStart(8, '0');
    const queue = String((b >>> 8) % 997).padStart(3, '0');
    const shard = String((a >>> 16) % 41).padStart(2, '0');
    const note = NOTES[((a ^ b) >>> 0) % NOTES.length];
    lines.push(
      `[${hh}:${mm}:${ss}.${ms}] ${level} ${unit} cycle=${String(i).padStart(3, '0')} ` +
      `trace8=${trace8} queue=${queue} shard=${shard} note="${note}"`,
    );
  }
  lines.push('END SYNTHETIC TRANSCRIPT');
  const text = lines.join('\n');
  const lower = text.toLowerCase();
  for (const term of spec.forbiddenGuardTerms) {
    invariant(!lower.includes(term), `${spec.id}: unstated guard term leaked into fixture: ${term}`);
  }
  return text;
}

function promptFor(spec) {
  return [
    'Read only the attached synthetic terminal image(s). Do not use outside knowledge and do not guess.',
    'Return exactly one JSON object with these six string keys and no Markdown:',
    '- "fingerprint": the 12-character DEPLOYMENT_FINGERPRINT value.',
    '- "camelCase": the RUNTIME_FIELD value, preserving case.',
    '- "path": the complete ACTIVE_MANIFEST value.',
    '- "port": the CONTROL_PORT digits.',
    '- "gist": choose only "A", "B", or "C":',
    '  A = the rollout resumed after health checks recovered;',
    '  B = the rollout stayed paused because a checksum mismatch remained;',
    '  C = the transcript does not state the rollout outcome.',
    `- "unstated": answer "${spec.guardQuestion}"; if absent, return exactly "NOT STATED".`,
    'If an exact field is unreadable, return "UNREADABLE" for that field instead of inventing a value.',
  ].join('\n');
}

const resolvedSol = resolveGptProfile(MODEL);
const oldStyle = {
  font: 'spleen-5x8',
  cellWBonus: 0,
  cellHBonus: 0,
  aa: true,
  grid: false,
  gridCols: 0,
  colorCycle: false,
  markerScale: 1,
  markerRed: false,
};
const PROFILES = {
  old_shared: {
    name: 'old_shared',
    cols: 152,
    maxHeightPx: 1932,
    style: oldStyle,
  },
  current_sol: {
    name: 'current_sol',
    cols: resolvedSol.stripCols,
    maxHeightPx: resolvedSol.maxHeightPx,
    style: { ...resolvedSol.style },
  },
  retuned_sol_9x12: {
    name: 'retuned_sol_9x12',
    cols: 84,
    maxHeightPx: resolvedSol.maxHeightPx,
    // Retune only the Sol candidate: keep its JetBrains glyph atlas, but use
    // the same effective cell density that rescued exact recall for Grok.
    style: { ...resolvedSol.style, cellWBonus: 3, cellHBonus: 1 },
  },
};

invariant(MODEL === 'gpt-5.6-sol', 'This harness must never target a different model family');
invariant(PROFILES.old_shared.cols === 152, 'Old shared profile must stay at 152 columns');
invariant(renderCellWidth(PROFILES.old_shared.style) === 5, 'Old shared profile must use 5px cells');
invariant(renderCellHeight(PROFILES.old_shared.style) === 8, 'Old shared profile must use 8px cells');
invariant(PROFILES.current_sol.cols === 126, 'Current Sol profile must stay at 126 columns for this pilot');
invariant(PROFILES.current_sol.maxHeightPx === 1932, 'Current Sol max height must be 1932px');
invariant(PROFILES.current_sol.style.font === 'jetbrains-mono-10', 'Current Sol profile must use JetBrains Mono 10');
invariant(PROFILES.current_sol.style.aa === true, 'Current Sol profile must use grayscale AA');
invariant(renderCellWidth(PROFILES.current_sol.style) === 6, 'Current Sol profile must use 6px cells');
invariant(renderCellHeight(PROFILES.current_sol.style) === 11, 'Current Sol profile must use 11px cells');
invariant(PROFILES.retuned_sol_9x12.cols === 84, 'Retuned Sol candidate must use 84 columns');
invariant(renderCellWidth(PROFILES.retuned_sol_9x12.style) === 9, 'Retuned Sol candidate must use 9px cells');
invariant(renderCellHeight(PROFILES.retuned_sol_9x12.style) === 12, 'Retuned Sol candidate must use 12px cells');

const CALL_ORDER = [
  { fixture: 'alpha', profile: 'current_sol' },
  { fixture: 'alpha', profile: 'old_shared' },
  { fixture: 'beta', profile: 'old_shared' },
  { fixture: 'beta', profile: 'current_sol' },
];
// If the first attempt consumed its whole output cap as hidden reasoning, it is
// not a recall observation. A manually reviewed resume still counts that attempt
// against the cap, retries the candidate with reasoning disabled, retains one
// paired old-profile arm, and spends the final call on candidate replication.
const OUTPUT_CAP_RESUME_ORDER = [
  { fixture: 'alpha', profile: 'current_sol' },
  { fixture: 'alpha', profile: 'old_shared' },
  { fixture: 'beta', profile: 'current_sol' },
];
const OLD_FALLBACK_RETUNE_ORDER = [
  { fixture: 'alpha', profile: 'old_shared' },
  { fixture: 'beta', profile: 'old_shared' },
];
const SPACED_RETUNE_ORDER = [
  { fixture: 'alpha', profile: 'retuned_sol_9x12' },
];
invariant(CALL_ORDER.length <= MAX_CALLS, 'Call plan exceeds the four-call cap');

function safePct(value) {
  return Math.round(value * 10) / 10;
}

async function renderArm(spec, profile) {
  const source = buildFixture(spec);
  const packed = reflow(source);
  invariant(typeof packed === 'string', `${spec.id}: fixture unexpectedly contains the reflow sentinel`);
  const prompt = promptFor(spec);
  const images = await renderTextToPngs(packed, profile.cols, profile.style, profile.maxHeightPx);
  invariant(images.length > 0, `${spec.id}/${profile.name}: renderer returned no images`);
  if (profile.name !== 'retuned_sol_9x12') {
    invariant(images.length === 1, `${spec.id}/${profile.name}: original pilot arms must remain one image per call`);
  }

  const outDir = join(WORK_DIR, spec.id, profile.name);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'fixture.txt'), `${source}\n`);
  await writeFile(join(outDir, 'prompt.txt'), `${prompt}\n`);

  const pages = [];
  let imageTokens = 0;
  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    invariant(image.droppedChars === 0, `${spec.id}/${profile.name}: renderer dropped ${image.droppedChars} chars`);
    const file = join(outDir, `page-${i + 1}.png`);
    await writeFile(file, image.png);
    const tokens = visionTokensForModel(MODEL, image.width, image.height);
    imageTokens += tokens;
    pages.push({
      file: file.slice(HERE.length + 1),
      width: image.width,
      height: image.height,
      bytes: image.png.byteLength,
      sha256: sha256(image.png),
      estimatedImageTokens: tokens,
    });
  }

  const textTokensCharsPer4 = Math.ceil(source.length / 4);
  const sourceTokenizerTokens = countTokens(source);
  // The source itself is image-only. This estimate covers the user prompt and
  // a small Responses envelope allowance; actual usage is captured live.
  const projectedNonImageInputTokens = countTokens(prompt) + 16 + images.length * 8;
  const projectedInputTokens = imageTokens + projectedNonImageInputTokens;
  return {
    fixture: spec.id,
    profile: profile.name,
    source,
    prompt,
    expected: spec.expected,
    sourceChars: source.length,
    sourceSha256: sha256(source),
    sourceTokenizerTokens,
    textTokensCharsPer4,
    pages,
    imageTokens,
    projectedNonImageInputTokens,
    projectedInputTokens,
    estimatedSavingsVsTextPct: safePct((1 - imageTokens / textTokensCharsPer4) * 100),
    imageDataUrls: images.map((image) => `data:image/png;base64,${Buffer.from(image.png).toString('base64')}`),
  };
}

function summarizeArm(arm) {
  const { source, prompt, imageDataUrls, ...summary } = arm;
  return summary;
}

function totalsFor(arms) {
  const totals = {
    calls: arms.length,
    imageTokens: 0,
    projectedNonImageInputTokens: 0,
    projectedInputTokens: 0,
    byProfile: {},
  };
  for (const arm of arms) {
    totals.imageTokens += arm.imageTokens;
    totals.projectedNonImageInputTokens += arm.projectedNonImageInputTokens;
    totals.projectedInputTokens += arm.projectedInputTokens;
    const p = totals.byProfile[arm.profile] || {
      calls: 0,
      imageTokens: 0,
      projectedNonImageInputTokens: 0,
      projectedInputTokens: 0,
    };
    p.calls++;
    p.imageTokens += arm.imageTokens;
    p.projectedNonImageInputTokens += arm.projectedNonImageInputTokens;
    p.projectedInputTokens += arm.projectedInputTokens;
    totals.byProfile[arm.profile] = p;
  }
  const oldTokens = totals.byProfile.old_shared?.imageTokens || 0;
  const solTokens = totals.byProfile.current_sol?.imageTokens || 0;
  totals.currentVsOldImageTokenIncreasePct = oldTokens > 0
    ? safePct((solTokens / oldTokens - 1) * 100)
    : null;
  return totals;
}

function responsesEndpoint() {
  const raw = process.env.SOL_PROFILE_BASE_URL || process.env.OPENAI_BASE_URL || '';
  if (!raw) throw new Error('OPENAI_BASE_URL (or SOL_PROFILE_BASE_URL) is required for a live run');
  const url = new URL(raw);
  // Current pxpipe listener from the pilot brief. The eval must hit the direct
  // upstream Responses endpoint (currently ocproxy on 127.0.0.1:8082), not pxpipe.
  invariant(url.port !== '47821', 'Refusing pxpipe port 47821: raw image eval must bypass pxpipe');
  const base = raw.replace(/\/$/, '');
  return base.endsWith('/responses') ? base : `${base}/responses`;
}

function extractOutput(response) {
  let text = typeof response?.output_text === 'string' ? response.output_text : '';
  const refusals = [];
  if (!text && Array.isArray(response?.output)) {
    for (const item of response.output) {
      if (!item || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part && (part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
          text += part.text;
        }
        if (part?.type === 'refusal' && typeof part.refusal === 'string') refusals.push(part.refusal);
      }
    }
  }
  return { text: text.trim(), refusals };
}

function parseObject(text) {
  const trimmed = text.trim();
  if (!trimmed) return { value: null, strictJson: false, error: 'empty output' };
  let candidate = trimmed;
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidate = fenced[1].trim();
  try {
    return { value: JSON.parse(candidate), strictJson: candidate === trimmed, error: null };
  } catch (firstError) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return { value: JSON.parse(candidate.slice(start, end + 1)), strictJson: false, error: null };
      } catch {
        // Report the original parse error below.
      }
    }
    return { value: null, strictJson: false, error: String(firstError) };
  }
}

const RESPONSE_KEYS = ['fingerprint', 'camelCase', 'path', 'port', 'gist', 'unstated'];
const EXACT_KEYS = ['fingerprint', 'camelCase', 'path', 'port'];

function scoreResponse(arm, response, output) {
  const parsed = parseObject(output.text);
  const value = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)
    ? parsed.value
    : null;
  const keys = value ? Object.keys(value).sort() : [];
  const schemaValid = Boolean(value) &&
    keys.join('\n') === [...RESPONSE_KEYS].sort().join('\n') &&
    RESPONSE_KEYS.every((key) => typeof value[key] === 'string');
  const exact = {};
  const confabulations = [];
  const abstentions = [];
  let exactCorrect = 0;

  for (const key of EXACT_KEYS) {
    const got = schemaValid ? value[key].trim() : '';
    const expected = arm.expected[key];
    const ok = got === expected;
    exact[key] = { expected, got, ok };
    if (ok) exactCorrect++;
    else if (got === 'UNREADABLE' || got === 'NOT STATED') abstentions.push(key);
    else if (got && !arm.source.includes(got)) confabulations.push({ field: key, value: got });
  }

  const gistGot = schemaValid ? value.gist.trim() : '';
  const unstatedGot = schemaValid ? value.unstated.trim() : '';
  const gistOk = gistGot === arm.expected.gist;
  const guardOk = unstatedGot === 'NOT STATED';
  if (unstatedGot === 'UNREADABLE') abstentions.push('unstated');
  else if (unstatedGot && !guardOk) confabulations.push({ field: 'unstated', value: unstatedGot });

  const completed = !response || response.status === undefined || response.status === 'completed';
  const pass = completed && output.refusals.length === 0 && schemaValid &&
    exactCorrect === EXACT_KEYS.length && gistOk && guardOk && confabulations.length === 0;
  return {
    responseStatus: response?.status || null,
    incompleteReason: response?.incomplete_details?.reason || null,
    outputText: output.text,
    refusals: output.refusals,
    parseError: parsed.error,
    strictJson: parsed.strictJson,
    schemaValid,
    exact,
    exactCorrect,
    exactTotal: EXACT_KEYS.length,
    gist: { expected: arm.expected.gist, got: gistGot, ok: gistOk },
    guard: { expected: 'NOT STATED', got: unstatedGot, ok: guardOk },
    confabulations,
    abstentions,
    pass,
  };
}

async function callResponses(arm, sequence) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is required for a live run');
  const endpoint = responsesEndpoint();
  const payload = {
    model: MODEL,
    stream: false,
    max_output_tokens: Number(process.env.SOL_PROFILE_MAX_OUTPUT_TOKENS || 512),
    reasoning: { effort: process.env.SOL_PROFILE_REASONING_EFFORT || 'none' },
    text: { verbosity: 'low' },
    input: [{
      role: 'user',
      content: [
        ...arm.imageDataUrls.map((image_url) => ({ type: 'input_image', image_url, detail: 'original' })),
        { type: 'input_text', text: arm.prompt },
      ],
    }],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = performance.now();
  let response;
  let fetchError = null;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    fetchError = String(error);
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Math.round(performance.now() - started);
  if (fetchError) {
    return { endpoint, latencyMs, status: null, headers: {}, rawBody: '', json: null, error: fetchError };
  }

  const rawBody = await response.text();
  let json = null;
  let parseError = null;
  try { json = JSON.parse(rawBody); } catch (error) { parseError = String(error); }
  const headers = {};
  for (const name of ['x-request-id', 'openai-processing-ms', 'cf-ray']) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  const error = response.ok
    ? parseError
    : (json?.error?.message || `Responses HTTP ${response.status}`);

  const stem = `${String(sequence).padStart(2, '0')}-${arm.fixture}-${arm.profile}`;
  await mkdir(RAW_DIR, { recursive: true });
  await writeFile(join(RAW_DIR, `${stem}.response.json`), rawBody);
  await writeJsonAtomic(join(RAW_DIR, `${stem}.receipt.json`), {
    sequence,
    fixture: arm.fixture,
    profile: arm.profile,
    request: {
      endpoint,
      model: MODEL,
      maxOutputTokens: payload.max_output_tokens,
      reasoningEffort: payload.reasoning.effort,
      imageDetail: 'original',
      imageSha256: arm.pages.map((page) => page.sha256),
      imageDimensions: arm.pages.map((page) => `${page.width}x${page.height}`),
      prompt: arm.prompt,
    },
    response: { status: response.status, headers, latencyMs, rawBodySha256: sha256(rawBody), error },
  });
  return { endpoint, latencyMs, status: response.status, headers, rawBody, json, error };
}

const preparedByKey = new Map();
for (const spec of FIXTURE_SPECS) {
  for (const profile of Object.values(PROFILES)) {
    const arm = await renderArm(spec, profile);
    preparedByKey.set(`${spec.id}/${profile.name}`, arm);
  }
}
const callArms = CALL_ORDER.map(({ fixture, profile }) => {
  const arm = preparedByKey.get(`${fixture}/${profile}`);
  invariant(arm, `Missing prepared arm ${fixture}/${profile}`);
  return arm;
});

const preflight = {
  generatedAt: new Date().toISOString(),
  live: false,
  model: MODEL,
  endpointPolicy: 'direct Responses endpoint; port 47821 is rejected',
  callCap: MAX_CALLS,
  callOrder: CALL_ORDER,
  profiles: Object.fromEntries(Object.entries(PROFILES).map(([name, profile]) => [name, {
    cols: profile.cols,
    maxHeightPx: profile.maxHeightPx,
    cell: `${renderCellWidth(profile.style)}x${renderCellHeight(profile.style)}`,
    style: profile.style,
  }])),
  arms: callArms.map(summarizeArm),
  totals: totalsFor(callArms),
  finalRetuneCandidate: summarizeArm(preparedByKey.get('alpha/retuned_sol_9x12')),
  tokenNotes: {
    image: 'pxpipe production visionTokensForModel(gpt-5.6-sol, width, height) patch estimate',
    nonImage: 'gpt-tokenizer(prompt) plus a small Responses-envelope allowance; provider usage may differ',
    textBaseline: 'source chars/4, used only for estimated image-vs-text savings',
  },
};
await writeJsonAtomic(PREFLIGHT_PATH, preflight);

console.log(`Sol profile pilot · model=${MODEL} · live=${LIVE}`);
console.log('Direct-image design: 2 deterministic fixtures × 2 profiles; one structured response per arm.');
for (const arm of callArms) {
  const dims = arm.pages.map((page) => `${page.width}x${page.height}`).join(',');
  console.log(
    `${arm.fixture.padEnd(5)} ${arm.profile.padEnd(11)} ${dims.padEnd(12)} ` +
    `image=${String(arm.imageTokens).padStart(4)} input≈${String(arm.projectedInputTokens).padStart(4)} ` +
    `text≈${String(arm.textTokensCharsPer4).padStart(4)} save≈${arm.estimatedSavingsVsTextPct}%`,
  );
}
console.log(`Projected maximum: ${preflight.totals.calls} calls, ${preflight.totals.imageTokens} image tokens, ` +
  `≈${preflight.totals.projectedInputTokens} total input tokens.`);
console.log(`Preflight: ${PREFLIGHT_PATH}`);

if (!LIVE) {
  console.log('DRY RUN ONLY: no network request was made.');
  process.exit(0);
}
if (!HAS_APPROVAL) {
  throw new Error(
    `Paid calls are locked. After explicit approval, set SOL_PROFILE_PAID_APPROVAL=${APPROVAL_ACK}`,
  );
}

let results;
let liveCallArms = callArms;
if (RESUME_SPACED_RETUNE) {
  results = JSON.parse(await readFile(RESULTS_PATH, 'utf8'));
  invariant(results.model === MODEL, 'Spaced-retune result model mismatch');
  invariant(results.calls.length === 3, 'Spaced retune requires exactly three prior attempts');
  const oldFailure = results.calls[2];
  invariant(oldFailure.fixture === 'alpha' && oldFailure.profile === 'old_shared', 'Unexpected old-profile attempt');
  invariant(oldFailure.score?.responseStatus === 'completed', 'Old-profile attempt did not complete');
  invariant(oldFailure.score?.exactCorrect === 0, 'Old profile did not clearly fail exact recall');
  invariant(oldFailure.score?.confabulations?.length === 4, 'Old profile failure did not contain four exact-field confabulations');
  liveCallArms = SPACED_RETUNE_ORDER.map(({ fixture, profile }) => {
    const arm = preparedByKey.get(`${fixture}/${profile}`);
    invariant(arm, `Missing spaced-retune arm ${fixture}/${profile}`);
    return arm;
  });
  invariant(results.calls.length + liveCallArms.length <= MAX_CALLS, 'Spaced retune would exceed paid-call cap');
  results.stoppedEarly = false;
  results.stopReason = null;
  results.finalRetune = {
    reason: 'both 6x11 JetBrains and 5x8 Spleen returned 0/4 exact with four confabulations',
    reviewedAt: new Date().toISOString(),
    candidate: 'Sol-only JetBrains Mono 10 with effective 9x12 cells / 84 columns',
    remainingOrder: SPACED_RETUNE_ORDER,
  };
} else if (RESUME_OLD_AS_RETUNE) {
  results = JSON.parse(await readFile(RESULTS_PATH, 'utf8'));
  invariant(results.model === MODEL, 'Retune result model mismatch');
  invariant(results.calls.length === 2, 'Old-profile retune requires exactly two prior attempts');
  const validFailure = results.calls[1];
  invariant(validFailure.fixture === 'alpha' && validFailure.profile === 'current_sol', 'Unexpected valid candidate attempt');
  invariant(validFailure.score?.responseStatus === 'completed', 'Candidate attempt did not complete');
  invariant(validFailure.score?.exactCorrect === 0, 'Candidate did not clearly fail exact recall');
  invariant(validFailure.score?.confabulations?.length === 4, 'Candidate failure did not contain four exact-field confabulations');
  liveCallArms = OLD_FALLBACK_RETUNE_ORDER.map(({ fixture, profile }) => {
    const arm = preparedByKey.get(`${fixture}/${profile}`);
    invariant(arm, `Missing old-profile retune arm ${fixture}/${profile}`);
    return arm;
  });
  invariant(results.calls.length + liveCallArms.length <= MAX_CALLS, 'Old-profile retune would exceed paid-call cap');
  results.stoppedEarly = false;
  results.stopReason = null;
  results.retune = {
    reason: 'current Sol 6x11 profile returned 0/4 exact with four confabulations',
    reviewedAt: new Date().toISOString(),
    candidate: 'Sol-only fallback to old shared Spleen 5x8 / 152 columns',
    remainingOrder: OLD_FALLBACK_RETUNE_ORDER,
  };
} else if (RESUME_AFTER_OUTPUT_CAP) {
  results = JSON.parse(await readFile(RESULTS_PATH, 'utf8'));
  invariant(results.model === MODEL, 'Resume result model mismatch');
  invariant(results.calls.length === 1, 'Output-cap resume requires exactly one prior attempt');
  const first = results.calls[0];
  invariant(first.fixture === 'alpha' && first.profile === 'current_sol', 'Unexpected first attempt');
  invariant(first.score?.responseStatus === 'incomplete', 'First attempt was not incomplete');
  invariant(first.score?.incompleteReason === 'max_output_tokens', 'First attempt was not output-capped');
  invariant(!first.score?.outputText, 'First attempt unexpectedly contained an answer');
  liveCallArms = OUTPUT_CAP_RESUME_ORDER.map(({ fixture, profile }) => {
    const arm = preparedByKey.get(`${fixture}/${profile}`);
    invariant(arm, `Missing resume arm ${fixture}/${profile}`);
    return arm;
  });
  invariant(results.calls.length + liveCallArms.length <= MAX_CALLS, 'Resume would exceed paid-call cap');
  results.stoppedEarly = false;
  results.stopReason = null;
  results.resume = {
    reason: 'first attempt returned only hidden reasoning and hit max_output_tokens',
    reviewedAt: new Date().toISOString(),
    priorAttemptsCountAgainstCap: true,
    changedReasoningEffort: 'none',
    remainingOrder: OUTPUT_CAP_RESUME_ORDER,
  };
} else {
  results = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    live: true,
    preflightSha256: sha256(JSON.stringify(preflight)),
    plannedCalls: CALL_ORDER.length,
    completedCalls: 0,
    stoppedEarly: false,
    stopReason: null,
    calls: [],
  };
}
await writeJsonAtomic(RESULTS_PATH, results);

for (let i = 0; i < liveCallArms.length; i++) {
  const arm = liveCallArms[i];
  const sequence = results.calls.length + 1;
  console.log(`CALL ${sequence}/${MAX_CALLS}: ${arm.fixture}/${arm.profile}`);
  const receipt = await callResponses(arm, sequence);
  const output = receipt.json ? extractOutput(receipt.json) : { text: '', refusals: [] };
  const score = scoreResponse(arm, receipt.json, output);
  const row = {
    sequence,
    fixture: arm.fixture,
    profile: arm.profile,
    imageDimensions: arm.pages.map((page) => `${page.width}x${page.height}`),
    estimatedImageTokens: arm.imageTokens,
    estimatedSavingsVsTextPct: arm.estimatedSavingsVsTextPct,
    latencyMs: receipt.latencyMs,
    httpStatus: receipt.status,
    responseHeaders: receipt.headers,
    transportError: receipt.error,
    usage: receipt.json?.usage || null,
    responseId: receipt.json?.id || null,
    responseModel: receipt.json?.model || null,
    reasoningEffort: receipt.json?.reasoning?.effort || null,
    rawResponseBody: receipt.rawBody,
    rawResponseSha256: sha256(receipt.rawBody),
    score,
  };
  results.calls.push(row);
  results.completedCalls = results.calls.length;
  await writeJsonAtomic(RESULTS_PATH, results);

  console.log(`  exact=${score.exactCorrect}/${score.exactTotal} gist=${score.gist.ok ? 'ok' : 'fail'} ` +
    `guard=${score.guard.ok ? 'ok' : 'fail'} confab=${score.confabulations.length} ` +
    `latency=${receipt.latencyMs}ms`);

  if (receipt.error || !score.pass) {
    results.stoppedEarly = i < liveCallArms.length - 1;
    results.stopReason = receipt.error
      ? `transport/API failure on ${arm.fixture}/${arm.profile}: ${receipt.error}`
      : `clear acceptance failure on ${arm.fixture}/${arm.profile}`;
    await writeJsonAtomic(RESULTS_PATH, results);
    console.log(`STOP: ${results.stopReason}`);
    break;
  }
}

console.log(`Results: ${RESULTS_PATH}`);
