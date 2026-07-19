// Server-rendered HTML dashboard — htmx polls fragments, Alpine drives the toast tray.
// Presentation only; server code (src/dashboard.ts, src/node.ts) needs no edits.

import { HTMX_JS, ALPINE_JS } from './vendor.js';
import { CACHE_CREATE_RATE, CACHE_READ_RATE } from '../core/baseline.js';
import type {
  StatsPayload,
  RecentPayload,
  RecentRow,
  SessionsPayload,
  SessionRow,
  FullStatsPayload,
  CurrentSessionPayload,
} from './types.js';

// ---- helpers --------------------------------------------------------

export function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

function numFmt(n: number | null | undefined): string {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('en-US');
}

/** "12.3k" / "1.2M" compact formatter for headline numbers. */
function kFmt(n: number | null | undefined): string {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  if (a >= 1_000_000) return (v / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1) + 'M';
  if (a >= 1000) return (v / 1000).toFixed(a >= 100_000 ? 0 : 1) + 'k';
  return String(Math.round(v));
}

function formatDuration(s: number): string {
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (h ? h + 'h ' : '') + (m || h ? m + 'm ' : '') + sec + 's';
}

function shortPath(p: string | null | undefined): string {
  if (!p) return '-';
  const parts = String(p).split('/');
  return parts[parts.length - 1] || p;
}

// ---- compression toggle (kill switch) ------------------------------------

export function renderToggleFragment(enabled: boolean): string {
  // NOTE: "PASSTHROUGH MODE", "Disable compression", "Enable compression" are asserted by tests.
  const banner = enabled
    ? ''
    : `<div class="banner"><strong>PASSTHROUGH MODE</strong> — compression is off. Every request goes to Claude unchanged: no images, no savings. Use this to A/B test, or if the upstream API is having problems.</div>`;
  // Button POSTs the OPPOSITE of current state; 2s poll keeps it fresh.
  const confirm = enabled
    ? ` hx-confirm="Turn compression off?\n\nRequests will pass straight through to Claude, unchanged. Restarting the proxy turns it back on."`
    : '';
  return (
    banner +
    `<div class="switch">` +
    `<span class="switch-state ${enabled ? 'on' : 'off'}"><span class="switch-dot"></span>${enabled ? 'Compression on' : 'Compression off'}</span>` +
    `<button class="switch-btn" type="button" hx-post="/fragments/toggle" hx-target="#frag-toggle" hx-vals='{"enabled": ${!enabled}}'${confirm}>` +
    (enabled ? 'Disable compression' : 'Enable compression') +
    `</button>` +
    `<span class="hint">kill switch · resets to on when you restart</span>` +
    `</div>`
  );
}

// ---- compress scope (which models get imaged) ----------------------------

/** Chip catalog — UNION with env scope + active set, so env-var models stay toggleable. Labels are cosmetic. */
const MODEL_CATALOG: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
];

const GPT_MODEL_CATALOG: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'gpt-5.6-sol', label: 'GPT 5.6 Sol' },
  { id: 'gpt-5.5', label: 'GPT 5.5' },
];

const GROK_MODEL_CATALOG: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'grok-4.5', label: 'Grok 4.5' },
];

export function renderModelsFragment(
  active: string[],
  configured: string[],
  enabled: boolean,
): string {
  const on = new Set(active);
  const labelOf = new Map(
    [...MODEL_CATALOG, ...GPT_MODEL_CATALOG, ...GROK_MODEL_CATALOG].map((m) => [m.id, m.label]),
  );
  // Union the catalog with env-configured + active ids so PXPIPE_MODELS-enabled
  // families always show as toggles, then split into two chip rows (Claude /
  // OpenAI Responses) plus the PXPIPE_MODELS CSV textbox that mirrors the scope.
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of [
    ...MODEL_CATALOG.map((m) => m.id),
    ...GPT_MODEL_CATALOG.map((m) => m.id),
    ...GROK_MODEL_CATALOG.map((m) => m.id),
    ...configured,
    ...active,
  ]) {
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  const chipFor = (id: string): string => {
    const lit = on.has(id);
    const label = labelOf.get(id) ?? id;
    return (
      `<button class="chip${lit ? ' on' : ''}" type="button" ` +
      `hx-post="/fragments/models" hx-target="#frag-models" ` +
      `hx-vals='${escapeHtml(`{"model":${JSON.stringify(id)},"on":${!lit}}`)}'>${escapeHtml(label)}${lit ? ' ✓' : ''}</button>`
    );
  };
  const claudeChips = ids.filter((id) => id.startsWith('claude')).map(chipFor).join('');
  const gptChips = ids.filter((id) => id.startsWith('gpt')).map(chipFor).join('');
  const grokChips = ids.filter((id) => id.startsWith('grok')).map(chipFor).join('');
  const otherChips = ids
    .filter((id) => !id.startsWith('claude') && !id.startsWith('gpt') && !id.startsWith('grok'))
    .map(chipFor)
    .join('');
  const moot = enabled
    ? ''
    : `<div class="models"><span class="hint">compression is off — these settings have no effect right now</span></div>`;
  return (
    moot +
    `<div class="models">` +
    `<span class="models-label">Image Claude models</span>` +
    claudeChips +
    `<span class="hint">unlisted models get plain text</span>` +
    `</div>` +
    `<div class="models">` +
    `<span class="models-label">Image OpenAI Responses models</span>` +
    gptChips +
    grokChips +
    otherChips +
    `<span class="hint">opt-in · no Anthropic cache_control</span>` +
    `</div>` +
    `<div class="models">` +
    `<span class="models-label">PXPIPE_MODELS</span>` +
    `<input class="models-csv" id="models-csv" type="text" name="list" ` +
    `value="${escapeHtml(active.join(','))}" spellcheck="false" autocomplete="off" ` +
    `hx-post="/fragments/models" hx-target="#frag-models" hx-trigger="change">` +
    `<span class="hint">CSV of bases, or off · applies on enter/blur · export to persist</span>` +
    `</div>`
  );
}

// ---- session hero --------------------------------------------------------

// Must stay in lockstep with ASSUMED_INPUT_USD_PER_MTOK in src/dashboard.ts.
const INPUT_USD_PER_MTOK = 10.0;
void INPUT_USD_PER_MTOK; // suppress unused-var; renderHeaderFragment uses the server's pricing block.

// Lifetime hero. Reads the SAME cumulative weighted totals as the header strip
// (serveStats), so the headline and the "$ saved" tiles can never disagree, and
// the number stops swinging on tiny per-session samples. Cache-weighted on
// purpose ("lifeweight"): it answers "did pxpipe move my real, cache-discounted
// bill since this proxy started", not a raw token count.
export function renderSessionSummaryFragment(s: StatsPayload): string {
  const measured = s.compressed_requests ?? 0;
  if (measured <= 0) {
    return (
      `<div class="hero hero-empty">` +
      `<div class="hero-eyebrow">Since start</div>` +
      `<div class="hero-headline">Warming up…</div>` +
      `<div class="hero-sub">Point Claude Code at this proxy and send a message. The moment a request flows through, your running savings show up right here.</div>` +
      `</div>`
    );
  }
  // Cache-aware reduction — same basis as the Details panel + Saved column.
  // Raw count_tokens would over-claim: most of the text baseline would have been
  // cheap cache-reads (~0.1×), not full-price tokens. Weighting both sides at their
  // real cache rate is the only comparison that can't contradict the Saved column.
  // Input-only: pxpipe never touches output, so lumping it in just dampened the %.
  const baselineW = s.baseline_input_weighted ?? 0; // same context as text, cache-aware
  const actualW = s.actual_input_weighted ?? 0; // what we actually sent, cache-aware
  const outMult = s.pricing_assumptions?.output_multiplier || 5;
  const rawOutput = (s.output_weighted ?? 0) / outMult; // reply — never compressed
  const inputPct = baselineW > 0 ? (1 - actualW / baselineW) * 100 : 0;
  const positive = inputPct >= 0;
  const bigNum = `${Math.abs(inputPct).toFixed(0)}%`;
  const word = positive ? 'fewer tokens' : 'more tokens';

  return (
    `<div class="hero${positive ? '' : ' hero-neg'}">` +
    `<div class="hero-eyebrow">Since start · ${numFmt(measured)} request${measured === 1 ? '' : 's'} imaged</div>` +
    `<div class="hero-headline"><span class="hero-num">${bigNum}</span> ${word} after caching</div>` +
    `<div class="hero-sub">` +
    `<strong>${kFmt(actualW)}</strong> effective tokens vs <strong>${kFmt(baselineW)}</strong> if this same context ` +
    `stayed plain text — both counted after normal cache discounts since this proxy started. ` +
    `Your latest messages and Claude's live output are never compressed.` +
    `</div>` +
    `<div class="hero-meta">` +
    `Cache-aware — cached reads counted at their real ~0.1× weight, not full price · ` +
    `output untouched (${kFmt(rawOutput)}) · no $ assumptions` +
    `</div>` +
    `</div>`
  );
}

// ---- stat strip + "Show the math" drawer ----------------------------------

function mathRow(key: string, val: number | string | undefined, note = ''): string {
  const v = typeof val === 'number' ? numFmt(val) : String(val ?? '-');
  return `<div><span class="k">${key}:</span> <span class="v">${escapeHtml(v)}</span> <span class="k">${note}</span></div>`;
}

function mathBlock(title: string, body: string): string {
  return `<section class="math-block"><h4>${title}</h4><div class="formula">${body}</div></section>`;
}

/** Stat tile; `tip` adds a hover "?" explainer. */
function statTile(
  label: string,
  value: string,
  sub: string,
  cls = '',
  tip = '',
): string {
  const q = tip
    ? `<span class="q" tabindex="0" aria-label="${escapeHtml(tip)}" data-tip="${escapeHtml(tip)}">?</span>`
    : '';
  return (
    `<div class="tile">` +
    `<div class="tile-label">${label}${q}</div>` +
    `<div class="tile-value ${cls}">${value}</div>` +
    `<div class="tile-sub">${sub}</div>` +
    `</div>`
  );
}

export function renderHeaderFragment(s: StatsPayload, port: number): string {
  const pa = s.pricing_assumptions;

  // Compare the same imaged requests on both sides. Passthrough requests are
  // generally smaller because the profitability gate selected them, so their
  // average is not a valid "without pxpipe" counterfactual.
  const cAvg = s.compressed_avg_usd_per_request ?? 0;
  const paidImaged = s.compressed_paid_requests ?? 0;
  const withoutAvg = paidImaged > 0 ? cAvg + (s.saved_usd ?? 0) / paidImaged : 0;
  const costTile = paidImaged > 0
    ? statTile(
        'Cost per request',
        `$${cAvg.toFixed(4)}`,
        `vs $${withoutAvg.toFixed(4)} without pxpipe`,
        cAvg <= withoutAvg ? 'pos' : 'neg',
        'Average cost of paid imaged requests versus the cache-aware text counterfactual for those same requests. Unmeasured requests are assigned zero savings.',
      )
    : statTile(
        'Cost per request',
        'collecting…',
        'waiting for a paid imaged request',
        'muted-val',
        'The comparison appears after an imaged request returns provider usage.',
      );

  const strip =
    `<div class="strip">` +
    statTile('Requests', numFmt(s.requests), `${numFmt(s.compressed_requests)} turned into images`) +
    statTile(
      'Input tokens saved',
      numFmt(s.saved_input_tokens),
      'vs sending the same context as text',
      'pos',
      'Bulky context (system prompt, tool output, old turns) sent as compact images instead of text. Cache-aware, input side only — recent turns and the live output stay text.',
    ) +
    statTile(
      'Estimated saved',
      `$${(s.saved_usd ?? 0).toFixed(2)}`,
      `at $${pa.input_per_mtok}/M base input price`,
      '',
      'Cache-aware estimate using the server-reported 5-minute/1-hour write split when available (1.25×/2×), cache reads (0.10×), and the base input price.',
    ) +
    costTile +
    `</div>`;

  // math drawer
  const savedMath =
    `<div><span class="k">formula:</span> <span class="v">saved = baseline − actual</span></div>` +
    `<div><span class="k">weights:</span> <span class="v">input×1.0, cache_write_5m×1.25, cache_write_1h×2.0, cache_read×0.10</span></div>` +
    `<div class="sp"></div>` +
    mathRow('baseline', s.baseline_input_weighted, '(cache-aware: cacheable×weight + cold_tail)') +
    mathRow('actual', s.actual_input_weighted, '(input + cc_5m×1.25 + cc_1h×2.0 + cr×0.10)') +
    mathRow('saved', s.saved_input_tokens, `<span class="op">=</span> baseline − actual`) +
    `<span class="src">output excluded — identical with/without compression</span>`;

  const usdMath =
    `<div><span class="k">formula:</span> <span class="v">$ saved = saved_tokens × $${pa.input_per_mtok}/Mtok</span></div>` +
    `<div class="sp"></div>` +
    mathRow('saved_tokens', s.saved_input_tokens, '(cache-aware, input-side)') +
    mathRow('saved_usd', `$${(s.saved_usd || 0).toFixed(4)} `, `<span class="op">=</span> saved_tokens × input_rate / 1e6`) +
    `<span class="src">source: ${escapeHtml(pa.source || 'docs.anthropic.com pricing')}</span>`;

  const costPerRequestMath =
    `<div><span class="k">formula:</span> <span class="v">without_pxpipe = actual_imaged + measured_savings</span></div>` +
    `<div><span class="k">why:</span> <span class="v">both averages cover the same paid imaged requests. Passthrough requests are not used because the profitability gate selects a different, generally smaller population.</span></div>` +
    `<div class="sp"></div>` +
    mathRow(`actual imaged (n=${paidImaged})`, `$${(s.compressed_actual_usd || 0).toFixed(4)}`, `total · avg $${cAvg.toFixed(4)}/req`) +
    mathRow('measured savings', `$${(s.saved_usd || 0).toFixed(4)}`, 'cache-aware input-side total') +
    mathRow('without pxpipe', `$${withoutAvg.toFixed(4)}/req`, '<span class="op">=</span> (actual imaged + measured savings) / n') +
    `<span class="src">unmeasured imaged rows remain in n and actual cost, with zero assumed savings</span>`;

  const pctMath =
    `<div><span class="k">formula:</span> <span class="v">share_of_spend = saved / (all_baseline_equivalent + all_output × ${pa.output_multiplier})</span></div>` +
    `<div><span class="k">diagnostic, not the headline:</span> <span class="v">this is a counterfactual ("what you WOULD have paid"). It leans on the count_tokens probe, the cache-aware split, and an input-rate assumption. Useful as a sanity check; the real-traffic answer is the compressed-vs-passthrough split above.</span></div>` +
    `<div class="sp"></div>` +
    mathRow('saved', s.saved_input_tokens, '(measured-rows numerator; cache-aware)') +
    mathRow('all_baseline_equivalent', s.all_baseline_equivalent_weighted, '(every paid request; baseline on measured + actual on the rest)') +
    mathRow(`all_output × ${pa.output_multiplier}`, s.all_output_weighted, '(every paid request)') +
    mathRow('share_of_spend', (s.saved_pct_of_all_spend || 0).toFixed(1) + '%', `<span class="op">=</span> saved / counterfactual_total × 100`) +
    mathRow('all_usage_requests', s.all_usage_requests, '(denominator request count — compressed + passthrough + probe-failed)') +
    `<span class="src">measured numerator, all-rows counterfactual denominator — bounded at 100%</span>`;

  const tokeqMath =
    `<div><span class="k">formula:</span> <span class="v">token_equivalent = input + output × ${pa.output_multiplier}</span></div>` +
    `<div><span class="k">why:</span> <span class="v">matches Anthropic's per-Mtok price ratio ($${pa.input_per_mtok} input vs $${pa.input_per_mtok * pa.output_multiplier} output) — this is what the weekly-limit meter counts.</span></div>` +
    `<div class="sp"></div>` +
    mathRow('actual_token_equivalent', s.actual_token_equivalent) +
    mathRow('baseline_token_equivalent', s.baseline_token_equivalent, `(unproxied counterfactual, same ×${pa.output_multiplier} on output)`) +
    `<div class="sp"></div>` +
    mathRow('events_with_measurement', s.events_with_measurement, '(events where the SSE/JSON scanner produced char counts)') +
    mathRow('measured_text_chars', s.measured_text_chars, '') +
    mathRow('measured_thinking_chars', s.measured_thinking_chars, '') +
    mathRow('measured_tool_use_chars', s.measured_tool_use_chars, '') +
    mathRow('measured_redacted_blocks', s.measured_redacted_block_count, '(opaque encrypted blocks — billed but unmeasurable)') +
    `<span class="src">measured — no estimation</span>`;

  const drawer =
    `<details class="drawer" id="math-drawer">` +
    `<summary>Show the math &amp; honesty receipts</summary>` +
    `<div class="drawer-intro">Every number above, derived from the same per-event log. The proxy only moves <em>input</em> tokens; output is shown on both sides so percentages stay honest.</div>` +
    `<div class="math-grid">` +
    mathBlock('Input tokens saved', savedMath) +
    mathBlock('Dollars saved', usdMath) +
    mathBlock('Cost per imaged request', costPerRequestMath) +
    mathBlock('Share of total spend (diagnostic)', pctMath) +
    mathBlock('Token-equivalent (what the weekly cap counts)', tokeqMath) +
    `</div></details>`;

  // NOTE: tests assert the header fragment contains the port number.
  const updated = `<div class="updated"><span class="live-dot"></span>live · port ${port} · uptime ${formatDuration(s.uptime_sec)}</div>`;

  return strip + drawer + updated;
}

// ---- request x-ray (image vs text breakdown) -----------------------------

export interface ContextMapData {
  id: number; // first image id (matches recent-table link)
  baselineTokens: number; // RAW count_tokens as plain text (cache-blind; sub-line only)
  realInput: number; // RAW input + cache_create + cache_read (cache-blind)
  baselineInputEff: number; // cache-WEIGHTED baseline — what text would actually be billed
  actualInputEff: number; // cache-WEIGHTED actual — what the images were actually billed
  haveBaseline: boolean; // weighted pair is trustworthy (baseline probe resolved)
  cacheRead: number; // cache_read tokens this turn. >0 ⇒ the actual request hit cache.
  warm: boolean; // did the TEXT baseline's prefix read warm? Server-observed only:
  // true iff the actual request had cache_read > 0. This keeps the text baseline
  // on the same cache state as the image path; no wall-clock-only inference.
  output: number;
  imageCount: number;
  baselineImagedTokens?: number;
  buckets: Partial<Record<string, number>>; // bucket → chars rendered to PNG
  imageIds: number[]; // image-ring ids for the gallery
  compressed: boolean;
  model?: string;
  responsesComposition?: {
    instructions: number; systemDeveloper: number; userAssistant: number;
    functionCalls: number; functionOutputs: number; reasoningEncrypted: number;
    compactionOpaque: number; toolsJson: number; other: number;
    totalLocal: number; imageParts: number;
    completedFunctionPairs?: number; recentNativeFunctionPairs?: number;
    oldFunctionPairs?: number; openFunctionCalls?: number;
    orphanFunctionOutputs?: number; malformedFunctionItems?: number;
    imageableFunctionCalls?: number; imageableFunctionOutputs?: number;
    collapsedFunctionPairs?: number; collapsedFunctionCalls?: number;
    collapsedFunctionOutputs?: number;
  };
  /** Difference between the provider text counterfactual and local o200k buckets.
   * Can include envelope, tokenizer, and server-side additions. */
  responsesUnexplainedTokens?: number;
  restored?: boolean; // rebuilt from JSONL after a restart — PNG thumbnails are gone
}

const CTXMAP_BUCKETS: ReadonlyArray<readonly [string, string]> = [
  ['static_slab', 'System prompt + tool docs'],
  ['reminder', 'System-reminder blocks'],
  ['tool_result_prose', 'Tool results — prose'],
  ['tool_result_log', 'Tool results — logs'],
  ['tool_result_json', 'Tool results — JSON'],
  ['history', 'Older conversation turns'],
];

/** Image-vs-text breakdown for one request. */
export function renderContextMapFragment(
  c: ContextMapData | undefined,
  history: ContextMapData[] = [],
  notFound = false,
): string {
  const isLatest = c !== undefined && c.id === (history.at(-1)?.id ?? -1);
  if (notFound) {
    return `<div class="ctxmap"><div class="empty-note">That request's breakdown isn't kept anymore — only the most recent requests are. Pick <strong>Details</strong> on a newer row.</div></div>`;
  }
  if (!c || (c.baselineTokens <= 0 && c.imageCount <= 0)) {
    return `<div class="ctxmap"><div class="empty-note">Pick <strong>Details</strong> on a request to see exactly which parts became images and which stayed as text.</div></div>`;
  }
  // Cache-aware billing-equivalent basis — identical to the recent row's
  // As-text / Sent / Saved/lost columns. These are not raw token counts; they apply
  // Anthropic's cache rates so create/read misses are visible in the comparison.
  // The two panels can never contradict each other. The raw
  // count_tokens ratio is cache-blind: it over-states savings whenever the
  // prefix would have been a cheap cache-read, so it must NOT drive the
  // headline. It survives only as a clarifying sub-line below.
  const showCompare = c.haveBaseline && c.baselineInputEff > 0;
  const base = c.baselineInputEff;
  const real = c.actualInputEff;
  const pct = showCompare ? Math.round((1 - real / base) * 100) : 0;
  const rawShrink = c.baselineTokens > 0 ? Math.round((1 - c.realInput / c.baselineTokens) * 100) : 0;
  const totalImagedChars = CTXMAP_BUCKETS.reduce((a, [key]) => a + (c.buckets[key] ?? 0), 0);

  const imgRows = CTXMAP_BUCKETS.map(([key, label]) => [label, c.buckets[key] ?? 0] as const)
    .filter(([, ch]) => ch > 0)
    .map(
      ([label, ch]) =>
        `<div class="ctx-row"><span class="ctx-lbl">${label}</span><span class="ctx-val">${kFmt(ch)} chars</span></div>`,
    )
    .join('');

  const rc = c.responsesComposition;
  const responseRows: ReadonlyArray<readonly [string, number]> = rc
    ? [
        ['Instructions', rc.instructions],
        ['System / developer items', rc.systemDeveloper],
        ['User / assistant text kept native', rc.userAssistant],
        ['Native tool JSON', rc.toolsJson],
        ['Function calls', rc.functionCalls],
        ['Function outputs', rc.functionOutputs],
        ['Function outputs eligible in old closed pairs', rc.imageableFunctionOutputs ?? 0],
        ['Function outputs actually imaged this request', rc.collapsedFunctionOutputs ?? 0],
        ['Reasoning / encrypted items', rc.reasoningEncrypted],
        ['Compaction / opaque items', rc.compactionOpaque],
        ['Other Responses items', rc.other],
      ]
    : [];
  const responseBreakdown = rc
    ? `<div class="split-note" style="margin-top:12px"><strong>Original Responses composition (local o200k estimate)</strong></div>` +
      responseRows.filter(([, n]) => n > 0).map(([label, n]) =>
        `<div class="ctx-row"><span class="ctx-lbl">${label}</span><span class="ctx-val">${kFmt(n)} tok</span></div>`,
      ).join('') +
      `<div class="ctx-row"><span class="ctx-lbl">Imageable text baseline</span><span class="ctx-val">${kFmt(c.baselineImagedTokens ?? 0)} tok</span></div>` +
      `<div class="ctx-row"><span class="ctx-lbl">Adjacent completed pairs (old / recent native / imaged)</span><span class="ctx-val">${rc.completedFunctionPairs ?? 0} (${rc.oldFunctionPairs ?? 0} / ${rc.recentNativeFunctionPairs ?? 0} / ${rc.collapsedFunctionPairs ?? 0})</span></div>` +
      `<div class="ctx-row"><span class="ctx-lbl">Open calls kept native</span><span class="ctx-val">${rc.openFunctionCalls ?? 0}</span></div>` +
      `<div class="ctx-row"><span class="ctx-lbl">Native image parts</span><span class="ctx-val">${rc.imageParts}</span></div>` +
      `<div class="ctx-row"><span class="ctx-lbl">Provider tokens not explained locally</span><span class="ctx-val">${kFmt(c.responsesUnexplainedTokens ?? 0)} tok</span></div>` +
      `<div class="split-note">This diagnostic uses local o200k counts only; it never calls Anthropic /count_tokens.</div>`
    : '';

  const ids = c.imageIds ?? [];
  const modelLabel = c.model ? escapeHtml(c.model) : 'the model';
  const gallery = ids.length
    ? `<div class="pages-title">${ids.length} image page${ids.length === 1 ? '' : 's'} sent to ${modelLabel} — click one to read the exact text behind it:</div>` +
      `<div class="pages">` +
      ids
        .map(
          (id) =>
            `<img class="page" src="/proxy-latest-png?id=${id}" alt="page ${id}" loading="lazy" title="Click to read the source text behind page ${id}" onclick="ppPin(${id});ppSource(true)" onerror="this.classList.add('page-gone'); this.alt='page ${id} expired from buffer';" />`,
        )
        .join('') +
      `</div>`
    : c.restored && c.imageCount > 0
      ? `<div class="pages-title">${c.imageCount} image page${c.imageCount === 1 ? '' : 's'} were sent — thumbnails expired when the proxy restarted. The breakdown above is reconstructed from the saved log.</div>`
      : '';

  // Did the TEXT baseline's prefix read warm this turn? This follows the actual
  // request's observed cache state: cache_read > 0 means warm, cache_read === 0
  // means cold. No wall-clock-only counterfactual is credited.
  const warm = showCompare && c.warm;
  const textNoun = warm ? 'cached text' : 'text';
  // Raw count_tokens can grow (imaging bloated a short prompt), so say so rather
  // than rendering a nonsensical "shrank -36%".
  const rawPhrase =
    rawShrink >= 0 ? `Raw content shrank ${rawShrink}%.` : `Raw content grew ${-rawShrink}%.`;
  const headline = !showCompare
    ? `<strong>${kFmt(c.actualInputEff || c.realInput)}</strong> billing-equivalent input tokens sent`
    : pct >= 0
      ? `<span class="ctx-big">${pct}%</span> smaller — ${textNoun} would bill as <strong>${kFmt(base)}</strong> input tokens; images billed as <strong>${kFmt(real)}</strong>`
      : `<span class="ctx-big">${-pct}%</span> bigger — images billed as <strong>${kFmt(real)}</strong> input tokens vs <strong>${kFmt(base)}</strong> for ${textNoun}`;
  // Clarifying sub-line. It must match the actual request's cache state: claiming
  // a 0.1× read discount when cache_read===0 would count hypothetical cache as a
  // pxpipe effect, so cold rows price both paths cold.
  const subnote = !showCompare
    ? 'Billed tokens count cache discounts (reads at 0.1×) — no trustworthy text baseline for this request yet.'
    : !warm
      ? `No warm text cache this turn — the text counterfactual's prefix is priced at the 1.25× create rate (the same event the imaged path pays), identical basis to the Saved column. The gap is purely token count. ${rawPhrase}`
      : pct < 0 && rawShrink > 0
          ? `Billed = after cache discounts (reads at 0.1×), same basis as the Saved column. The raw text is ${rawShrink}% smaller, but most of it would have been a cheap cache-read — so imaging it cost more.`
          : `Billed = after cache discounts (reads at 0.1×), same basis as the Saved column. ${rawPhrase}`;
  const title = isLatest ? 'Latest request' : 'Selected request';

  return (
    `<div class="ctxmap">` +
    `<div class="ctx-headline"><span class="ctx-title">${title}</span> ${headline}</div>` +
    `<div class="split-note ctx-subnote">${subnote}</div>` +
    `<div class="legend"><span class="tag tag-img">Became an image</span><span class="tag tag-txt">Stayed as text</span></div>` +
    `<div class="split">` +
    `<div class="split-col split-img">` +
    `<div class="split-head">Compressed into images <span class="split-sum">${kFmt(totalImagedChars)} chars · ${c.imageCount} page${c.imageCount === 1 ? '' : 's'}</span></div>` +
    (imgRows || `<div class="ctx-row muted-row">nothing imaged this request</div>`) +
    `<div class="split-note">pxpipe can misread exact values inside images — treat these as gist, not byte-exact.</div>` +
    `</div>` +
    `<div class="split-col split-txt">` +
    `<div class="split-head">Kept as plain text <span class="split-sum">byte-exact</span></div>` +
    `<div class="ctx-row"><span class="ctx-lbl">Your latest messages</span><span class="ctx-val">verbatim</span></div>` +
    `<div class="ctx-row"><span class="ctx-lbl">Model reply (output)</span><span class="ctx-val">${kFmt(c.output)} tok</span></div>` +
    `<div class="split-note">never imaged — safe for IDs, hashes and exact numbers.</div>` +
    `</div>` +
    `</div>` +
    responseBreakdown +
    gallery +
    `</div>`
  );
}

// ---- recent requests table -----------------------------------------------

function statusCls(status: number): string {
  if (status >= 500) return 'bad';
  if (status >= 400) return 'warn';
  return 'good';
}

export function renderRecentFragment(p: RecentPayload): string {
  const rows = (p.recent ?? []).slice().reverse();
  const body =
    rows.length === 0
      ? `<tr><td colspan="10" class="empty-cell">No requests yet — they stream in here live.</td></tr>`
      : rows
          .map((e: RecentRow, i: number) => {
            const viewId = (e.img_ids ?? (e.img_id != null ? [e.img_id] : []))[0];
            const viewLink =
              viewId != null
                ? `<a class="row-view" href="#" hx-get="/fragments/context-map?req=${viewId}" hx-target="#frag-context-map" hx-swap="innerHTML">Details →</a>`
                : `<span class="muted">—</span>`;
            const saved = e.session_saved_so_far_delta;
            // A loss that disappears when the newly written prefix is repriced at
            // the read rate is just the one-time cache-create premium — the
            // purchase price of the cheap cache reads on the turns that follow.
            // Mark it so create turns don't read as gate failures.
            const cc = e.cache_create ?? 0;
            const createLoss =
              saved != null &&
              saved < 0 &&
              cc > 0 &&
              saved + cc * (CACHE_CREATE_RATE - CACHE_READ_RATE) > 0;
            const createNote = createLoss
              ? ` <span class="mk-create" title="Cache-create turn: this loss is the one-time ${CACHE_CREATE_RATE}× premium for writing ${numFmt(cc)} tokens to cache. Later turns re-read that prefix at ${CACHE_READ_RATE}×, which typically recoups it.">create</span>`
              : '';
            const savedCell = saved == null
              ? `<td class="num muted">—</td>`
              : saved > 0
                ? `<td class="num pos">${numFmt(saved)}</td>`
                : saved < 0
                  ? `<td class="num neg">${numFmt(saved)}${createNote}</td>`
                  : `<td class="num">0</td>`;
            const imaged = e.cc_added
              ? `<span class="badge badge-img">image</span>`
              : `<span class="badge badge-txt">text</span>`;
            return (
              `<tr>` +
              `<td class="muted">${i + 1}</td>` +
              `<td><span class="pill pill-${statusCls(e.status)}">${e.status}</span></td>` +
              `<td class="endp">${escapeHtml(shortPath(e.path))}</td>` +
              `<td>${e.model ? `<code>${escapeHtml(e.model)}</code>` : '<span class="muted">—</span>'}</td>` +
              `<td>${imaged}</td>` +
              `<td class="num">${e.cache_read != null ? numFmt(e.cache_read) : '—'}</td>` +
              `<td class="num">${e.baseline_input != null ? numFmt(e.baseline_input) : '—'}</td>` +
              `<td class="num">${e.actual_input != null ? numFmt(e.actual_input) : '—'}</td>` +
              savedCell +
              `<td class="num">${viewLink}</td>` +
              `</tr>`
            );
          })
          .join('');
  return (
    `<table class="rtable"><thead><tr>` +
    `<th>#</th>` +
    `<th>Result</th>` +
    `<th>Endpoint</th>` +
    `<th>Model</th>` +
    `<th title="Was this request's context compressed into an image?">Sent as</th>` +
    `<th class="num" title="Tokens served from Claude's cache (cheap)">Cache hits</th>` +
    `<th class="num" title="Billing-equivalent input if kept as plain text, after cache create/read rates">As text</th>` +
    `<th class="num" title="Actual billing-equivalent input after imaging, after cache create/read rates">Sent</th>` +
    `<th class="num" title="As-text minus Sent; negative means imaging cost more">Saved/lost</th>` +
    `<th></th>` +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}

// ---- image ↔ source inspector --------------------------------------------

export interface LatestFragmentInput {
  payload: RecentPayload;
  pin: number | null; // pinned image id, or null to follow latest
  showSource: boolean;
  sourceText: string | null; // null = not captured
}

export function renderLatestFragment(inp: LatestFragmentInput): string {
  const { payload, pin, showSource, sourceText } = inp;
  const hasPreview = payload.has_preview === true;
  const meta = payload.preview_meta ?? '';
  const imageIds = payload.image_ids ?? [];
  const pinnedEvicted = pin != null && !imageIds.includes(pin);

  // Pinned id, or latest (cache-busted by meta).
  const imgSrc =
    pin != null
      ? `/proxy-latest-png?id=${pin}`
      : `/proxy-latest-png?t=${encodeURIComponent(meta)}`;

  const pinBar =
    pin != null
      ? `<div class="viewer-bar"><button class="mini-btn" type="button" onclick="ppPin(null)">← back to latest</button><span class="mini-label">image #${pin}</span></div>`
      : '';

  let main: string;
  if (pin != null && pinnedEvicted) {
    main = `<div class="evicted">image #${pin} is no longer in the buffer</div>`;
  } else if (pin != null || hasPreview) {
    // When source pane is open the image appears inside the pairing — don't duplicate it.
    main = showSource ? '' : `<div class="frame"><img src="${imgSrc}" alt="rendered page" /></div>`;
  } else {
    main = `<div class="empty-note">No images yet — they appear the instant pxpipe compresses a request.</div>`;
  }

  const showBtn = pin != null ? !pinnedEvicted : hasPreview;
  const caption =
    pin != null ? `image #${pin}` : meta ? `${escapeHtml(meta)} · top-left at native size` : '';
  const srcBtn = showBtn
    ? `<button class="mini-btn" type="button" onclick="ppSource(${showSource ? 'false' : 'true'})">${showSource ? 'hide source text' : 'show the text behind this image'}</button>`
    : '';

  let pane = '';
  if (showSource) {
    pane =
      sourceText == null
        ? `<div class="evicted">source text wasn't captured for this image</div>`
        : `<div class="pairing">` +
          `<div class="pair-col"><div class="pair-head pair-img">What Claude sees · image</div><div class="frame frame-sm"><img src="${imgSrc}" alt="rendered page" /></div></div>` +
          `<div class="pair-mid">made from ↓</div>` +
          `<div class="pair-col"><div class="pair-head pair-txt">The original text · byte-exact</div><pre class="src-pane">${escapeHtml(sourceText)}</pre></div>` +
          `</div>`;
  }

  return pinBar + main + `<div class="viewer-caption">${caption} ${srcBtn}</div>` + pane;
}

// ---- sessions bar chart --------------------------------------------------

const TOP_N = 8;

export function renderSessionsFragment(p: SessionsPayload): string {
  const all = p.sessions ?? [];
  const rows = [...all]
    .sort((a, b) => (b.tokensSavedEst ?? 0) - (a.tokensSavedEst ?? 0))
    .slice(0, TOP_N);
  const max = rows.reduce((m, s) => Math.max(m, s.tokensSavedEst ?? 0), 0);

  const label = (s: SessionRow) => {
    const proj = s.claudeCode?.projectPath || s.project;
    return proj ? shortPath(proj) : s.id.slice(0, 8);
  };
  const barPct = (v: number) => (max <= 0 || v <= 0 ? 0 : (v / max) * 100);

  const status = `<div class="status">${all.length} session${all.length === 1 ? '' : 's'} tracked</div>`;
  if (rows.length === 0) return status + `<div class="empty">No sessions yet.</div>`;

  const chart = rows
    .map((s) => {
      const v = s.tokensSavedEst ?? 0;
      const pct = barPct(v);
      const fill = pct > 0 ? `<div class="bar-fill" style="width:max(3px,${pct}%)"></div>` : '';
      return (
        `<div class="bar-row">` +
        `<div class="bar-label" title="${escapeHtml(s.claudeCode?.projectPath || s.project || s.id)}">${escapeHtml(label(s))}</div>` +
        `<div class="bar-track">${fill}</div>` +
        `<div class="bar-val${v < 0 ? ' neg' : ''}">${numFmt(v)}</div>` +
        `</div>`
      );
    })
    .join('');

  return (
    status +
    `<div class="bars">${chart}</div>` +
    `<div class="axis">tokens saved per session (cache-aware) · top ${rows.length} of ${all.length}</div>`
  );
}

// ---- full-history stats table --------------------------------------------

export function renderStatsTableFragment(p: FullStatsPayload): string {
  if (p.error || !p.summary) {
    return `<div class="status">${escapeHtml(p.error || 'no data')}</div><table class="dtable"><tbody></tbody></table>`;
  }
  const s = p.summary;
  const totalIn = (s.inputTokensTotal || 0) + (s.cacheCreateTokensTotal || 0) + (s.cacheReadTokensTotal || 0);
  const hitRateTok = totalIn > 0 ? ((s.cacheReadTokensTotal / totalIn) * 100).toFixed(1) + '%' : '-';
  const hitRateEv =
    s.eventsWithBaseline > 0 ? ((s.cacheHitEvents / s.eventsWithBaseline) * 100).toFixed(1) + '%' : '-';
  const charRatio =
    s.origCharsTotal > 0 ? ((s.imageBytesTotal / s.origCharsTotal) * 100).toFixed(3) + 'x' : '-';

  // NOTE: the literal word "requests" is asserted by tests.
  const tr = (k: string, v: string) => `<tr><td>${k}</td><td class="num">${v}</td></tr>`;
  return (
    `<div class="status">${numFmt(p.parsed)} events parsed from disk</div>` +
    `<table class="dtable"><tbody>` +
    tr('requests', numFmt(s.total)) +
    tr('2xx / 4xx / 5xx', `${numFmt(s.ok2xx)} / ${numFmt(s.err4xx)} / ${numFmt(s.err5xx)}`) +
    tr('compressed', numFmt(s.compressed)) +
    tr('passthrough', numFmt(s.passthrough)) +
    tr('input tokens', numFmt(s.inputTokensTotal)) +
    tr('cache create', numFmt(s.cacheCreateTokensTotal)) +
    tr('cache read', numFmt(s.cacheReadTokensTotal)) +
    tr('cache hit (by tokens)', hitRateTok) +
    tr('cache hit (by events)', hitRateEv) +
    tr('original chars', numFmt(s.origCharsTotal)) +
    tr('image bytes', numFmt(s.imageBytesTotal)) +
    tr('bytes / char', charRatio) +
    tr('latency p50 / p95', `${numFmt(s.durationP50)} / ${numFmt(s.durationP95)} ms`) +
    tr('first-byte p50 / p95', `${numFmt(s.firstByteP50)} / ${numFmt(s.firstByteP95)} ms`) +
    `</tbody></table>`
  );
}

// ---- page shell -------------------------------------------------------------

// Favicon mirrors the .flame-dot glyph: a glossy flame sphere (radial highlight
// at 35%/30%, --flame -> --flame-strong) ringed by a faint --flame-tint halo.
// Inlined as a URL-encoded SVG data URI so the dashboard stays self-contained
// (no extra route/static asset). Keep colors in sync with :root in CSS below.
const FAVICON =
  "data:image/svg+xml," +
  "%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E" +
  "%3Cdefs%3E%3CradialGradient%20id='f'%20cx='35%25'%20cy='30%25'%20r='80%25'%3E" +
  "%3Cstop%20offset='0%25'%20stop-color='%23ffd0a8'/%3E" +
  "%3Cstop%20offset='55%25'%20stop-color='%23ff5a1f'/%3E" +
  "%3Cstop%20offset='100%25'%20stop-color='%23e8420a'/%3E" +
  "%3C/radialGradient%3E%3C/defs%3E" +
  "%3Ccircle%20cx='16'%20cy='16'%20r='15.5'%20fill='%23fff1ea'/%3E" +
  "%3Ccircle%20cx='16'%20cy='16'%20r='10'%20fill='url(%23f)'/%3E%3C/svg%3E";

const CSS = `
  :root {
    --bg: #faf6f2; --surface: #ffffff; --surface-2: #fbf4ee;
    --border: #efe5db; --border-strong: #e4d6c8;
    --ink: #241f1b; --ink-2: #5d534a; --muted: #9b9189;
    --flame: #ff5a1f; --flame-strong: #e8420a; --flame-ink: #bd3a08; --flame-tint: #fff1ea;
    --good: #1f9d57; --good-tint: #e7f6ee; --bad: #d8483b; --bad-tint: #fcebe9; --warn: #b7791f; --warn-tint: #fbf0db;
    --img: #ff5a1f; --img-ink: #bd3a08; --img-tint: #fff1ea;
    --txt: #2f7db0; --txt-ink: #1f5f8b; --txt-tint: #e9f3fb;
    --radius: 14px;
    --shadow: 0 1px 2px rgba(60,35,15,.05), 0 8px 24px rgba(60,35,15,.05);
    --mono: 'SF Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color-scheme: light;
  }
  /* Dark theme: same warm-flame identity, inverted neutrals. Set before first
     paint by the <head> script (localStorage 'pp-theme' else system pref);
     toggled by ppTheme(). Accents (flame/img/txt) are lifted for contrast. */
  :root[data-theme="dark"] {
    --bg: #17120f; --surface: #211a15; --surface-2: #2a211b;
    --border: #352a22; --border-strong: #46382e;
    --ink: #f6efe8; --ink-2: #cabbac; --muted: #9a8c7d;
    --flame: #ff6a33; --flame-strong: #e8420a; --flame-ink: #ff9a63; --flame-tint: #3a2318;
    --good: #3fbd76; --good-tint: #15291f; --bad: #f0645a; --bad-tint: #341b18; --warn: #d99a3a; --warn-tint: #33260f;
    --img: #ff6a33; --img-ink: #ff9a63; --img-tint: #3a2318;
    --txt: #5aa3d6; --txt-ink: #8cc3ea; --txt-tint: #142631;
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 10px 28px rgba(0,0,0,.45);
    color-scheme: dark;
  }
  /* Dark fix-ups for the few intentionally hard-coded (light) spots. */
  :root[data-theme="dark"] .banner { border-color: #6e342c; color: #f4b9b1; }
  :root[data-theme="dark"] .banner strong { color: #ffd6cf; }
  :root[data-theme="dark"] .toast { box-shadow: 0 8px 24px rgba(0,0,0,.5); }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 22px 26px 64px; background: var(--bg); color: var(--ink-2);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased; }
  b, strong { color: var(--ink); }
  .good { color: var(--good); } .bad { color: var(--bad); }
  .muted { color: var(--muted); }

  /* topbar */
  .topbar { display: flex; align-items: flex-start; justify-content: space-between;
    gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .flame-dot { width: 14px; height: 14px; border-radius: 50%;
    background: radial-gradient(circle at 35% 30%, #ffd0a8, var(--flame) 55%, var(--flame-strong));
    box-shadow: 0 0 0 4px var(--flame-tint); flex: none; }
  .wordmark { font-size: 22px; font-weight: 800; color: var(--ink); letter-spacing: -0.02em; }
  .tagline { font-size: 12.5px; color: var(--muted); margin-top: 1px; max-width: 460px; }
  .controls { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }

  /* kill switch */
  .banner { display: block; margin: 0 0 8px; padding: 9px 13px; background: var(--bad-tint);
    border: 1px solid #f3b6af; border-radius: 9px; color: #9c2b20; font-size: 12px; max-width: 520px; }
  .banner strong { color: #8a2117; }
  .switch { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; justify-content: flex-end; }
  .switch-state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600;
    padding: 3px 10px; border-radius: 999px; }
  .switch-state.on { color: var(--good); background: var(--good-tint); }
  .switch-state.off { color: var(--bad); background: var(--bad-tint); }
  .switch-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .switch-btn { background: var(--surface); color: var(--ink); border: 1px solid var(--border-strong);
    padding: 6px 13px; cursor: pointer; border-radius: 8px; font: inherit; font-size: 12px; font-weight: 600;
    box-shadow: var(--shadow); }
  .switch-btn:hover { border-color: var(--flame); color: var(--flame-ink); }
  .hint { color: var(--muted); font-size: 11px; }
  .theme-btn { background: var(--surface); color: var(--ink-2); border: 1px solid var(--border-strong);
    padding: 5px 11px; cursor: pointer; border-radius: 8px; font: inherit; font-size: 12px; font-weight: 600;
    box-shadow: var(--shadow); display: inline-flex; align-items: center; gap: 6px; line-height: 1; }
  .theme-btn:hover { border-color: var(--flame); color: var(--flame-ink); }

  /* model chips */
  .models { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 18px; }
  .models-label { color: var(--ink-2); font-size: 12px; font-weight: 600; }
  .models-csv { flex: 1 1 260px; min-width: 220px; color: var(--ink); background: var(--surface);
    border: 1px solid var(--border-strong); border-radius: 6px; padding: 4px 8px;
    font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .models-csv:focus { outline: none; border-color: var(--flame-ink); }
  .models-routing { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 18px; }
  #routing-help { border: 1px solid var(--border-strong); border-radius: 10px; background: var(--surface);
    color: var(--ink); max-width: 600px; padding: 16px 20px; }
  #routing-help::backdrop { background: rgba(20, 12, 6, .4); }
  #routing-help h3 { margin: 0 0 8px; font-size: 14px; color: var(--ink); }
  #routing-help p, #routing-help li { font-size: 12px; line-height: 1.55; color: var(--ink-2); margin: 6px 0; }
  #routing-help ul { margin: 6px 0; padding-left: 18px; }
  #routing-help code { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ink); }
  #routing-help pre { background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 10px; margin: 8px 0; overflow-x: auto;
    font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ink); }
  .chip { background: var(--surface); color: var(--ink-2); border: 1px solid var(--border-strong);
    border-radius: 999px; padding: 4px 12px; cursor: pointer; font: inherit; font-size: 12px; }
  .chip:hover { border-color: var(--flame); color: var(--flame-ink); }
  .chip.on { background: var(--flame-tint); color: var(--flame-ink); border-color: var(--flame);
    font-weight: 600; }

  /* collapsed model-scope section (#116): the default compress scope is Fable 5
     only, so the three family rows stay hidden until the user opts in. The
     <details> wrapper lives in the static shell — NOT inside #frag-models —
     because the every-2s innerHTML poll would otherwise reset its open state. */
  .models-collapse { margin: 0 0 18px; }
  .models-collapse .models { margin: 0 0 10px; }
  .models-collapse .models:last-child { margin-bottom: 0; }
  .models-summary { cursor: pointer; color: var(--ink-2); font-size: 12px; font-weight: 600;
    margin: 0 0 8px; user-select: none; }
  .models-summary:hover { color: var(--flame-ink); }
  .models-warning { color: var(--ink-2); background: var(--surface); border: 1px solid var(--border-strong);
    border-left: 3px solid var(--bad); border-radius: 8px; padding: 8px 12px; font-size: 12px;
    margin: 0 0 12px; }

  /* session hero */
  #frag-session { display: block; margin-bottom: 16px; }
  .hero { background: linear-gradient(135deg, var(--flame-tint), var(--surface) 60%); border: 1px solid var(--border);
    border-left: 4px solid var(--flame); border-radius: var(--radius); padding: 20px 24px; box-shadow: var(--shadow); }
  .hero-neg { border-left-color: var(--bad); }
  .hero-eyebrow { font-size: 11.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--muted); margin-bottom: 8px; }
  .hero-headline { font-size: 28px; font-weight: 700; color: var(--ink); letter-spacing: -0.02em; line-height: 1.1; }
  .hero-num { font-size: 56px; font-weight: 800; line-height: 1; margin-right: 8px;
    background: linear-gradient(135deg, #ff9a4d, var(--flame) 55%, var(--flame-strong));
    -webkit-background-clip: text; background-clip: text; color: transparent;
    font-variant-numeric: tabular-nums; }
  .hero-neg .hero-num { background: linear-gradient(135deg, #f0857a, var(--bad));
    -webkit-background-clip: text; background-clip: text; color: transparent; }
  .hero-sub { font-size: 14.5px; color: var(--ink-2); margin-top: 12px; max-width: 720px; }
  .hero-meta { font-size: 12px; color: var(--muted); margin-top: 10px; padding-top: 10px;
    border-top: 1px dashed var(--border-strong); }
  .hero-empty .hero-headline { color: var(--muted); font-size: 24px; }

  /* stat strip */
  .strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 14px; }
  @media (max-width: 1000px) { .strip { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 560px) { .strip { grid-template-columns: 1fr; } }
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 14px 16px; box-shadow: var(--shadow); }
  .tile-label { font-size: 11.5px; font-weight: 600; color: var(--ink-2); margin-bottom: 8px;
    display: flex; align-items: center; gap: 5px; }
  .tile-value { font-size: 26px; font-weight: 800; color: var(--ink); font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em; line-height: 1.1; }
  .tile-value.pos { color: var(--good); } .tile-value.neg { color: var(--bad); }
  .tile-value.muted-val { color: var(--muted); font-size: 18px; font-weight: 600; }
  .tile-sub { font-size: 11.5px; color: var(--muted); margin-top: 6px; }
  .q { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px;
    border-radius: 50%; background: var(--surface-2); border: 1px solid var(--border-strong);
    color: var(--muted); font-size: 9px; font-weight: 700; cursor: help; position: relative; outline: none; }
  .q:hover, .q:focus-visible { color: var(--flame-ink); border-color: var(--flame); }
  .q::after { content: attr(data-tip); position: absolute; z-index: 50; left: 50%; bottom: calc(100% + 8px);
    width: min(280px, 75vw); transform: translate(-50%, 4px); padding: 8px 10px; border-radius: 7px;
    background: var(--ink); color: var(--surface); box-shadow: var(--shadow); font-size: 11px; font-weight: 500;
    line-height: 1.4; text-align: left; pointer-events: none; opacity: 0; visibility: hidden;
    transition: opacity .12s, transform .12s, visibility .12s; }
  .q::before { content: ''; position: absolute; z-index: 51; left: 50%; bottom: calc(100% + 3px);
    transform: translateX(-50%); border: 5px solid transparent; border-top-color: var(--ink);
    pointer-events: none; opacity: 0; visibility: hidden; transition: opacity .12s, visibility .12s; }
  .q:hover::after, .q:focus-visible::after { opacity: 1; visibility: visible; transform: translate(-50%, 0); }
  .q:hover::before, .q:focus-visible::before { opacity: 1; visibility: visible; }

  /* drawer */
  .drawer { margin: 0 0 14px; background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; }
  .drawer > summary { cursor: pointer; user-select: none; list-style: none; padding: 12px 16px;
    font-size: 13px; font-weight: 600; color: var(--flame-ink); display: flex; align-items: center; gap: 8px; }
  .drawer > summary::-webkit-details-marker { display: none; }
  .drawer > summary::before { content: '▸'; color: var(--flame); font-size: 11px; }
  .drawer[open] > summary::before { content: '▾'; }
  .drawer > summary:hover { background: var(--surface-2); }
  .drawer-intro { padding: 0 16px 10px; font-size: 12px; color: var(--ink-2); }
  .drawer-intro em { color: var(--flame-ink); font-style: normal; font-weight: 600; }
  .math-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; padding: 0 16px 16px; }
  @media (max-width: 860px) { .math-grid { grid-template-columns: 1fr; } }
  .math-block h4 { margin: 0 0 6px; font-size: 12px; color: var(--ink); }
  .formula { background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px;
    padding: 9px 11px; font: 11px/1.55 var(--mono); color: var(--ink-2); white-space: pre-wrap;
    word-break: break-word; }
  .formula .k { color: var(--muted); } .formula .v { color: var(--ink); } .formula .op { color: var(--flame); }
  .formula .sp { height: 6px; }
  .formula .src { color: var(--muted); font-size: 10px; display: block; margin-top: 7px;
    border-top: 1px solid var(--border); padding-top: 6px; }
  .updated { font-size: 11px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
  .live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--good); animation: pulse 2s infinite; }
  @keyframes pulse { 50% { opacity: 0.35; } }

  /* sections */
  .section { margin-top: 26px; }
  .section-head { font-size: 14px; font-weight: 700; color: var(--ink); margin: 0 0 12px;
    display: flex; align-items: baseline; gap: 10px; }
  .section-sub { font-size: 12px; font-weight: 400; color: var(--muted); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 16px 18px; box-shadow: var(--shadow); min-width: 0; }
  .card-head { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--muted); margin: 0 0 12px; }
  .card-head.spaced { margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--border); }

  /* x-ray */
  .xray { display: grid; grid-template-columns: 1.15fr 1fr; gap: 16px; align-items: start; }
  @media (max-width: 1000px) { .xray { grid-template-columns: 1fr; } }

  /* context map */
  .ctxmap { font-size: 13px; }
  .empty-note { color: var(--muted); font-size: 12.5px; padding: 14px; background: var(--surface-2);
    border: 1px dashed var(--border-strong); border-radius: 10px; }
  .ctx-headline { font-size: 13px; color: var(--ink-2); margin-bottom: 10px; }
  .ctx-title { display: inline-block; font-weight: 700; color: var(--ink); margin-right: 6px; }
  .ctx-big { font-size: 22px; font-weight: 800; color: var(--flame); font-variant-numeric: tabular-nums; }
  .legend { display: flex; gap: 8px; margin-bottom: 10px; }
  .tag { font-size: 11px; font-weight: 600; padding: 3px 9px 3px 22px; border-radius: 999px; position: relative; }
  .tag::before { content: ''; position: absolute; left: 9px; top: 50%; transform: translateY(-50%);
    width: 8px; height: 8px; border-radius: 2px; }
  .tag-img { background: var(--img-tint); color: var(--img-ink); }
  .tag-img::before { background: var(--img); }
  .tag-txt { background: var(--txt-tint); color: var(--txt-ink); }
  .tag-txt::before { background: var(--txt); }
  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  @media (max-width: 560px) { .split { grid-template-columns: 1fr; } }
  .split-col { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--surface); }
  .split-img { border-top: 3px solid var(--img); background: linear-gradient(180deg, var(--img-tint), var(--surface) 40%); }
  .split-txt { border-top: 3px solid var(--txt); background: linear-gradient(180deg, var(--txt-tint), var(--surface) 40%); }
  .split-head { font-size: 12px; font-weight: 700; color: var(--ink); margin-bottom: 8px; display: flex;
    flex-direction: column; gap: 2px; }
  .split-sum { font-size: 10.5px; font-weight: 600; color: var(--muted); }
  .ctx-row { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; padding: 4px 0;
    border-bottom: 1px solid var(--border); }
  .ctx-row:last-of-type { border-bottom: none; }
  .ctx-lbl { color: var(--ink-2); } .ctx-val { color: var(--ink); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .muted-row { color: var(--muted); font-style: italic; }
  .split-note { font-size: 10.5px; color: var(--muted); margin-top: 7px; }
  .pages-title { font-size: 11px; color: var(--ink-2); margin: 12px 0 6px; }
  .pages { display: flex; flex-wrap: wrap; gap: 6px; max-height: 320px; overflow: auto;
    background: var(--surface-2); padding: 6px; border: 1px solid var(--border); border-radius: 8px; }
  .page { height: 130px; width: auto; max-width: 230px; object-fit: contain; object-position: top left;
    image-rendering: pixelated; background: #fff; border: 1px solid var(--border-strong); border-radius: 4px;
    cursor: pointer; transition: border-color .12s, transform .12s; }
  .page:hover { border-color: var(--flame); transform: translateY(-1px); }
  .page.page-gone { width: 150px; height: 56px; background: var(--surface-2); border: 1px dashed var(--border-strong);
    color: var(--muted); font-size: 10px; cursor: default; }

  /* recent requests */
  .row-view { color: var(--flame-ink); font-weight: 600; text-decoration: none; cursor: pointer; white-space: nowrap; }
  .row-view:hover { text-decoration: underline; }
  table.rtable, table.dtable { width: 100%; border-collapse: collapse; font-size: 12px; }
  .rtable th, .dtable th { text-align: left; color: var(--muted); font-weight: 600; padding: 7px 8px;
    border-bottom: 1px solid var(--border-strong); white-space: nowrap; }
  .rtable td, .dtable td { padding: 7px 8px; border-bottom: 1px solid var(--border);
    font-variant-numeric: tabular-nums; vertical-align: middle; color: var(--ink-2); }
  .rtable tr:last-child td, .dtable tr:last-child td { border-bottom: none; }
  .rtable tbody tr:hover, .rtable tbody tr:hover { background: var(--surface-2); }
  /* Keep wide tables inside their card: scroll horizontally rather than
     pushing the card border out. Fires only when the nowrap columns exceed
     the card width (narrow x-ray column / small window); no scrollbar when
     they fit. The table keeps width:100% so it fills at wide widths. */
  #frag-recent, #frag-stats { overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }
  #frag-recent table, #frag-stats table { min-width: max-content; }
  #frag-latest { overflow: auto; scrollbar-width: thin; }
  th.num, td.num { text-align: right; }
  td.pos { color: var(--good); font-weight: 600; }
  td.neg { color: var(--bad); font-weight: 600; }
  .endp { color: var(--ink); font-family: var(--mono); font-size: 11px; }
  .empty-cell { color: var(--muted); text-align: center; padding: 18px; }
  .pill { display: inline-block; min-width: 38px; text-align: center; font-size: 11px; font-weight: 700;
    padding: 2px 8px; border-radius: 999px; font-variant-numeric: tabular-nums; }
  .pill-good { background: var(--good-tint); color: var(--good); }
  .pill-warn { background: var(--warn-tint); color: var(--warn); }
  .pill-bad { background: var(--bad-tint); color: var(--bad); }
  .badge { font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
  .mk-create { font-size: 9.5px; font-weight: 700; color: var(--muted); border: 1px solid var(--muted);
    border-radius: 999px; padding: 0 5px; margin-left: 4px; vertical-align: 1px; cursor: help; white-space: nowrap; }
  .badge-img { background: var(--img-tint); color: var(--img-ink); }
  .badge-txt { background: var(--txt-tint); color: var(--txt-ink); }

  /* inspector */
  .viewer-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .mini-btn { font-size: 11px; background: var(--surface); color: var(--flame-ink); border: 1px solid var(--border-strong);
    border-radius: 7px; padding: 3px 9px; cursor: pointer; font-weight: 600; }
  .mini-btn:hover { border-color: var(--flame); }
  .mini-label { font-size: 11px; color: var(--muted); }
  .frame { background: #fff; border: 1px solid var(--border-strong); border-radius: 8px; padding: 5px;
    overflow: auto; max-height: 360px; scrollbar-width: thin; }
  .frame img { display: block; width: auto; height: auto; max-width: none; image-rendering: pixelated; }
  .frame-sm { max-height: 260px; }
  .viewer-caption { font-size: 11px; color: var(--muted); margin-top: 8px; display: flex; align-items: center;
    gap: 10px; flex-wrap: wrap; }
  .pairing { display: grid; grid-template-columns: 1fr; gap: 10px; margin-top: 10px; }
  .pair-head { font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 6px; display: inline-block;
    margin-bottom: 6px; }
  .pair-img { background: var(--img-tint); color: var(--img-ink); }
  .pair-txt { background: var(--txt-tint); color: var(--txt-ink); }
  .pair-mid { font-size: 11px; font-weight: 600; color: var(--muted); text-align: center; }
  .src-pane { margin: 0; max-height: 280px; overflow: auto; background: var(--surface-2);
    border: 1px solid var(--border); border-radius: 8px; padding: 9px; font: 11px/1.45 var(--mono);
    white-space: pre-wrap; word-break: break-word; color: var(--ink-2); }
  .evicted { font-size: 11.5px; color: var(--muted); padding: 12px; background: var(--surface-2);
    border: 1px dashed var(--border-strong); border-radius: 8px; }

  /* sessions bars */
  .status { margin-bottom: 12px; color: var(--muted); font-size: 12px; }
  .bars { display: flex; flex-direction: column; gap: 8px; }
  .bar-row { display: flex; align-items: center; gap: 12px; font-size: 12px; }
  .bar-label { width: 150px; flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--ink); font-family: var(--mono); font-size: 11px; }
  .bar-track { flex: 1; min-width: 0; height: 16px; background: var(--surface-2); border-radius: 5px;
    overflow: hidden; border: 1px solid var(--border); }
  .bar-fill { height: 100%; border-radius: 5px 0 0 5px;
    background: linear-gradient(90deg, #ffa766, var(--flame)); }
  .bar-val { width: 78px; flex: none; text-align: right; font-variant-numeric: tabular-nums;
    color: var(--flame-ink); font-weight: 600; }
  .bar-val.neg { color: var(--bad); }
  .axis { margin-top: 12px; color: var(--muted); font-size: 11px; }
  .empty { text-align: center; color: var(--muted); padding: 22px; font-size: 12px; }

  /* toast tray */
  .tray { position: fixed; bottom: 16px; right: 16px; display: flex; flex-direction: column; gap: 8px;
    z-index: 1000; pointer-events: none; }
  .toast { background: var(--surface); color: var(--bad); border: 1px solid #f0b3ab; border-radius: 9px;
    padding: 10px 14px; font-size: 12px; box-shadow: 0 8px 24px rgba(60,35,15,.14); display: flex;
    align-items: center; gap: 12px; pointer-events: auto; max-width: 360px; }
  .toast button { background: transparent; color: inherit; border: 0; cursor: pointer; font-size: 16px;
    line-height: 1; padding: 0; }
`;

// Client glue: window.pp (pin+source state) → hx-vals; preserves <details> open state across swaps; routes htmx errors to toast tray.
const GLUE_JS = `
  window.pp = { pin: null, src: false };
  function ppPin(id) {
    window.pp.pin = id;
    htmx.trigger('#frag-latest', 'pp-refresh');
  }
  function ppSource(on) {
    window.pp.src = on;
    htmx.trigger('#frag-latest', 'pp-refresh');
  }
  document.body.addEventListener('htmx:beforeSwap', function (ev) {
    const open = [];
    ev.detail.target.querySelectorAll('details[open][id]').forEach(function (d) { open.push(d.id); });
    ev.detail.target.__ppOpen = open;
  });
  document.body.addEventListener('htmx:afterSwap', function (ev) {
    (ev.detail.target.__ppOpen || []).forEach(function (id) {
      const d = document.getElementById(id);
      if (d) d.setAttribute('open', '');
    });
  });
  document.body.addEventListener('htmx:responseError', function (ev) {
    window.dispatchEvent(new CustomEvent('pp-toast', {
      detail: { text: ev.detail.xhr.status + ' ' + ev.detail.requestConfig.path }
    }));
  });
  document.body.addEventListener('htmx:sendError', function (ev) {
    window.dispatchEvent(new CustomEvent('pp-toast', {
      detail: { text: 'proxy unreachable: ' + ev.detail.requestConfig.path }
    }));
  });
`;

// Theme: light/dark via data-theme on <html>; saved in localStorage, defaults to system pref.
const THEME_JS = `
  (function () {
    function apply(t) {
      document.documentElement.dataset.theme = t;
      var b = document.getElementById('theme-btn');
      if (b) {
        b.textContent = t === 'dark' ? '☀ Light' : '☾ Dark';
        b.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      }
    }
    window.ppTheme = function () {
      var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('pp-theme', next); } catch (e) {}
      apply(next);
    };
    apply(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  })();
`;

export function renderPage(port: number): string {
  // hx-trigger="load, every Ns": paint on load then poll (2s live, 5s aggregates).
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>pxpipe — live dashboard</title>
<link rel="icon" href="${FAVICON}" />
<style>${CSS}</style>
<script>
  // Set theme before first paint (no flash): saved choice wins, else system preference.
  (function () {
    try {
      var s = localStorage.getItem('pp-theme');
      var dark = s ? s === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    } catch (e) { document.documentElement.dataset.theme = 'light'; }
  })();
</script>
</head>
<body>

<header class="topbar">
  <div class="brand">
    <span class="flame-dot"></span>
    <div>
      <div class="wordmark">pxpipe</div>
      <div class="tagline">See exactly what got turned into images to shrink your Claude Code bill.</div>
    </div>
  </div>
  <div class="controls">
    <button type="button" id="theme-btn" class="theme-btn" onclick="ppTheme()" aria-label="Toggle dark mode" title="Toggle dark / light mode">☾ Dark</button>
    <div id="frag-toggle" hx-get="/fragments/toggle" hx-trigger="load, every 2s" hx-swap="innerHTML"></div>
  </div>
</header>

<details class="models-collapse">
  <summary class="models-summary">Image model scope <span class="hint">Fable 5 only by default · expand to experiment with other families</span></summary>
  <div class="models-warning">⚠ Image compression is tuned for Fable 5 only — other families can use <strong>more</strong> tokens, not less. Opt in only for deliberate experiments (custom system prompt, subagent model setup, …).</div>
  <div id="frag-models" hx-get="/fragments/models" hx-trigger="load, every 2s [!document.activeElement || document.activeElement.id !== 'models-csv']" hx-swap="innerHTML"></div>
  <div class="models-routing"><span class="hint">imaging scope ≠ provider routing — non-Anthropic IDs also need routing env on the proxy</span> <button class="mini-btn" type="button" onclick="document.getElementById('routing-help').showModal()">routing help</button></div>
</details>

<dialog id="routing-help" onclick="if (event.target === this) this.close()">
  <h3>Routing Claude Code to OpenAI / Cloudflare models</h3>
  <p>Claude models use Anthropic by default. Two optional routes can run together — set on the <strong>pxpipe process</strong> (keep provider credentials out of Claude Code):</p>
  <ul>
    <li><code>OPENAI_MODELS</code> — exact model IDs routed to OpenAI Responses (<code>OPENAI_UPSTREAM</code> + <code>OPENAI_API_KEY</code>)</li>
    <li><code>CLOUDFLARE_MODELS</code> — exact model IDs routed to Cloudflare's OpenAI-compatible endpoint (<code>CLOUDFLARE_ACCOUNT_ID</code> + <code>CLOUDFLARE_API_TOKEN</code>)</li>
  </ul>
  <p>If a model appears in both lists: <code>CLOUDFLARE_MODELS &gt; OPENAI_MODELS &gt; default routing</code>.</p>
  <pre>OPENAI_UPSTREAM=https://api.openai.com \\
OPENAI_API_KEY=your-openai-key \\
OPENAI_MODELS=gpt-5.6-sol \\
CLOUDFLARE_ACCOUNT_ID=your-account-id \\
CLOUDFLARE_API_TOKEN=your-cloudflare-token \\
CLOUDFLARE_MODELS=moonshotai/kimi-k3 \\
npx pxpipe-proxy</pre>
  <p>Non-Anthropic IDs are advertised with a <code>claude-</code> prefix because Claude Code needs a Claude-shaped ID; pxpipe strips it before forwarding. Switch to one inside Claude Code with <code>/model claude-&lt;model&gt;</code> — e.g. <code>/model claude-moonshotai/kimi-k3</code> — or launch with <code>claude --model claude-moonshotai/kimi-k3</code>. Verify discovery with <code>curl …/v1/models</code>.</p>
  <p><code>PXPIPE_MODELS</code> above is separate: it controls image compression, not routing. Kimi K3 on Cloudflare is the only non-Anthropic model tested end to end — see <code>docs/CLAUDE_CODE_PROVIDER_ROUTING.md</code>.</p>
  <button class="mini-btn" type="button" onclick="this.closest('dialog').close()">close</button>
</dialog>

<div id="frag-session" hx-get="/fragments/session-summary" hx-trigger="load, every 2s" hx-swap="innerHTML">
  <div class="hero hero-empty"><div class="hero-headline">Connecting…</div></div>
</div>

<div id="frag-header" hx-get="/fragments/header" hx-trigger="load, every 2s" hx-swap="innerHTML"></div>

<section class="section">
  <h2 class="section-head">What happened to your context <span class="section-sub">click a request to see image vs text</span></h2>
  <div class="xray">
    <div class="card">
      <h3 class="card-head">Recent requests</h3>
      <div id="frag-recent" hx-get="/fragments/recent" hx-trigger="load, every 2s" hx-swap="innerHTML"></div>
    </div>
    <div class="card">
      <h3 class="card-head">Image vs text breakdown</h3>
      <div id="frag-context-map" hx-get="/fragments/context-map" hx-trigger="load" hx-swap="innerHTML"></div>
      <h3 class="card-head spaced">Image ↔ source inspector</h3>
      <div id="frag-latest" hx-get="/fragments/latest" hx-trigger="load, every 2s, pp-refresh" hx-swap="innerHTML"
           hx-vals='js:{pin: window.pp.pin == null ? "" : window.pp.pin, source: window.pp.src ? "1" : ""}'></div>
    </div>
  </div>
</section>

<section class="section">
  <h2 class="section-head">Top sessions <span class="section-sub">by tokens saved</span></h2>
  <div class="card">
    <div id="frag-sessions" hx-get="/fragments/sessions" hx-trigger="load, every 5s" hx-swap="innerHTML"></div>
  </div>
</section>

<section class="section">
  <h2 class="section-head">Full history <span class="section-sub">every event on disk</span></h2>
  <div class="card">
    <div id="frag-stats" hx-get="/fragments/stats" hx-trigger="load, every 5s" hx-swap="innerHTML"></div>
  </div>
</section>

<div class="tray" x-data="{ toasts: [], next: 1 }"
     @pp-toast.window="const id = next++; toasts.push({ id, text: $event.detail.text }); setTimeout(() => toasts = toasts.filter(t => t.id !== id), 5000)">
  <template x-for="t in toasts" :key="t.id">
    <div class="toast"><span x-text="t.text"></span><button type="button" @click="toasts = toasts.filter(x => x.id !== t.id)" aria-label="dismiss">&times;</button></div>
  </template>
</div>

<script>${HTMX_JS}</script>
<script>${GLUE_JS}</script>
<script>${THEME_JS}</script>
<script>${ALPINE_JS}</script>
</body>
</html>`;
}
