<script lang="ts">
  // The five savings cards at the top of the dashboard. Each card has a
  // collapsible "show calculation" block that shows the formula and the
  // actual numbers that produced this turn's headline figure. The math is
  // explained in src/core/baseline.ts — this component just renders it.

  import { stats } from '../stores/index.js';
  import { numFmt, escapeHtml, round1 } from '../lib/format.js';

  $: s = $stats.data;
  $: pa = s?.pricing_assumptions ?? null;

  // Each card's "show calculation" body. Computed lazily so we don't pay
  // for the string concat when the operator never opens the <details>.
  function row(key: string, val: number | string | undefined, note?: string): string {
    const v = typeof val === 'number' ? numFmt(val) : String(val ?? '-');
    return (
      `<div><span class="k">` +
      key +
      `:</span> <span class="v">` +
      escapeHtml(v) +
      `</span> <span class="k">` +
      (note || '') +
      `</span></div>`
    );
  }

  $: savedMath = s && pa
    ? `<div><span class="k">formula:</span> <span class="v">saved = baseline - actual</span></div>` +
      `<div><span class="k">weights:</span> <span class="v">input×1.0, cache_create×1.25, cache_read×0.10</span></div>` +
      `<div style="height:6px"></div>` +
      row('baseline', s.baseline_input_weighted, '(cache-aware: cacheable×weight + cold_tail)') +
      row('actual', s.actual_input_weighted, '(input + cc×1.25 + cr×0.10 from usage)') +
      row('saved', s.saved_input_tokens, `<span class="op">=</span> baseline - actual`) +
      `<span class="src">output excluded - identical with/without compression</span>`
    : '';

  $: inRate = pa ? pa.input_per_mtok : 0;
  $: usdMath = s && pa
    ? `<div><span class="k">formula:</span> <span class="v">$ saved = $</span>` +
      ` × ` +
      inRate +
      `/Mtok</div>` +
      `<div style="height:6px"></div>` +
      row('saved_tokens', s.saved_input_tokens, '(cache-aware, input-side)') +
      row(
        'saved_usd',
        `$${(s.saved_usd || 0).toFixed(4)} `,
        `<span class="op">=</span> saved_tokens × input_rate / 1e6`,
      ) +
      `<span class="src">source: ${escapeHtml(pa.source || 'docs.anthropic.com pricing')}</span>`
    : '';

  // Diagnostic only — no longer the headline. See `split` math below for
  // the headline.
  $: pctMath = s && pa
    ? `<div><span class="k">formula:</span> <span class="v">` +
      ` share_of_spend = saved / (all_baseline_equivalent + all_output × ` +
      (pa.output_multiplier ?? 5) +
      `)</span></div>` +
      `<div><span class="k">why this is diagnostic, not the headline:</span> <span class="v">` +
      `this is a counterfactual ("what the user WOULD have paid"). It depends on the count_tokens probe, ` +
      `the cache-aware baseline split, and an Opus 4.7 input-rate assumption. Useful as a sanity check, ` +
      `but the operator's real question is "did the compressed path cost less per request than the ` +
      `passthrough path on real traffic" — that's the headline split above, no counterfactuals.</span></div>` +
      `<div style="height:6px"></div>` +
      row('saved', s.saved_input_tokens, '(measured-rows numerator; cache-aware)') +
      row(
        'all_baseline_equivalent',
        s.all_baseline_equivalent_weighted,
        '(every paid request, weighted; baseline on measured + actual on the rest)',
      ) +
      row(
        'all_output × ' + (pa.output_multiplier ?? 5),
        s.all_output_weighted,
        '(every paid request, output × ' + (pa.output_multiplier ?? 5) + ')',
      ) +
      row(
        'all_counterfactual_total',
        s.all_baseline_equivalent_weighted + s.all_output_weighted,
        `<span class="op">=</span> all_baseline_equivalent + all_output`,
      ) +
      row(
        'share_of_spend',
        (s.saved_pct_of_all_spend || 0).toFixed(1) + '%',
        `<span class="op">=</span> saved / all_counterfactual_total × 100`,
      ) +
      row(
        'all_usage_requests',
        s.all_usage_requests,
        '(denominator request count - compressed + passthrough + probe-failed)',
      ) +
      `<span class="src">measured numerator, all-rows counterfactual denominator - bounded at 100%</span>`
    : '';

  // Headline "compressed vs passthrough" math. Direct observed split — no
  // counterfactuals, no probe gating. Each bucket is the sum of actual
  // billed token-equivalents (input + cc×1.25 + cr×0.10 + out×5) for that
  // path, converted to $ at the assumed input rate.
  $: splitMath = s && pa
    ? `<div><span class="k">formula:</span> <span class="v">` +
      `bucket_$ = (Σ actual_input + Σ output × ` + (pa.output_multiplier ?? 5) +
      `) × $` + (pa.input_per_mtok ?? 5) + `/Mtok</span></div>` +
      `<div><span class="k">why:</span> <span class="v">` +
      `partition the paid-rows set by which path actually ran this turn ` +
      `(\`info.compressed = true\` for slab/history compression; false for ` +
      `passthrough or bypassed). Same $/Mtok rate on both sides so the ` +
      `rate-assumption bias cancels in the delta. Selection bias (the ` +
      `gate routes each turn) does NOT cancel — interpret with sample ` +
      `counts.</span></div>` +
      `<div style="height:6px"></div>` +
      row(
        'compressed (n=' + s.compressed_paid_requests + ')',
        '$' + (s.compressed_actual_usd || 0).toFixed(4),
        'total · avg $' + (s.compressed_avg_usd_per_request || 0).toFixed(4) + '/req',
      ) +
      row(
        'passthrough (n=' + s.passthrough_paid_requests + ')',
        '$' + (s.passthrough_actual_usd || 0).toFixed(4),
        'total · avg $' + (s.passthrough_avg_usd_per_request || 0).toFixed(4) + '/req',
      ) +
      row(
        'compressed − passthrough',
        '$' + (s.compressed_minus_passthrough_avg_usd || 0).toFixed(4) + '/req',
        s.split_sufficient_sample
          ? '(both buckets ≥ ' + s.split_min_sample_per_bucket + ' — delta is meaningful)'
          : '(small sample: need ≥ ' + s.split_min_sample_per_bucket +
            ' per bucket; treat delta as noisy)',
      ) +
      `<span class="src">no counterfactual, no probe gate — pure observed $/req on each path</span>`
    : '';

  $: tokeqMath = s && pa
    ? `<div><span class="k">formula:</span> <span class="v">` +
      `token_equivalent = input + output × ` +
      (pa.output_multiplier ?? 5) +
      `</span></div>` +
      `<div><span class="k">why:</span> <span class="v">` +
      `matches Anthropic's per-Mtok price ratio ($` +
      (pa.input_per_mtok ?? 5) +
      ` input vs $` +
      ((pa.input_per_mtok ?? 5) * (pa.output_multiplier ?? 5)) +
      ` output)</span></div>` +
      `<div style="height:6px"></div>` +
      row('actual_input', s.actual_input_weighted, '(weighted upstream usage)') +
      `<div><span class="k">+</span> <span class="v">` +
      `<span class="op">=</span> raw output_tokens (already weighted)</span></div>` +
      row('actual_token_equivalent', s.actual_token_equivalent) +
      row(
        'baseline_token_equivalent',
        s.baseline_token_equivalent,
        '(unproxied counterfactual, same ' + ' × ' + (pa.output_multiplier ?? 5) + ' on output)',
      ) +
      `<div style="height:6px"></div>` +
      `<div><span class="k">measured vs billed:</span> <span class="v">` +
      `we now SSE-tee response bodies + count text_delta / thinking_delta / tool_use chars ` +
      `so you can compare what we actually saw on the wire against output_tokens. ` +
      `The redacted_thinking block count is included because Anthropic ships those ` +
      `as opaque server-encrypted bytes with no char count — output_tokens ` +
      `invisibly. This is what surfaced the May-2026 weekly-meter gap.</span></div>` +
      `<div style="height:6px"></div>` +
      row(
        'events_with_measurement',
        s.events_with_measurement,
        '(events where SSE/JSON scanner produced char counts)',
      ) +
      row(
        'measured_text_chars',
        s.measured_text_chars,
        '(content_block_delta · text_delta + response content[].text)',
      ) +
      row(
        'measured_thinking_chars',
        s.measured_thinking_chars,
        '(content_block_delta · thinking_delta + response reasoning text)',
      ) +
      row(
        'measured_tool_use_chars',
        s.measured_tool_use_chars,
        '(content_block_delta · input_json_delta + tool_use blocks)',
      ) +
      row(
        'measured_redacted_blocks',
        s.measured_redacted_block_count,
        '(opaque encrypted blocks - chars unavailable, billed but unmeasurable)',
      ) +
      `<span class="src">measured - no estimation</span>`
    : '';
</script>

<div class="grid">
  <div class="card">
    <div class="label">requests</div>
    <div class="value">{numFmt(s?.requests)}</div>
    <div class="small">— {numFmt(s?.compressed_requests)} compressed</div>
  </div>
  <div class="card">
    <div class="label">input tokens saved</div>
    <div class="value pos">{numFmt(s?.saved_input_tokens)}</div>
    <div class="small">cache-aware, input-side only</div>
    {#if s && pa}
      <details class="math">
        <summary>show calculation</summary>
        <div class="formula">{@html savedMath}</div>
      </details>
    {/if}
  </div>
  <div class="card">
    <div class="label">$ saved</div>
    <div class="value">$ {(s?.saved_usd ?? 0).toFixed(2)}</div>
    <div class="small">at $5/M input tokens (Opus 4.7)</div>
    {#if s && pa}
      <details class="math">
        <summary>show calculation</summary>
        <div class="formula">{@html usdMath}</div>
      </details>
    {/if}
  </div>
  <div class="card">
    <div class="label">compressed $/req</div>
    <div class="value">$ {(s?.compressed_avg_usd_per_request ?? 0).toFixed(4)}</div>
    <div class="small">
      n={numFmt(s?.compressed_paid_requests)} · total $ {(s?.compressed_actual_usd ?? 0).toFixed(4)}
    </div>
  </div>
  <div class="card">
    <div class="label">passthrough $/req</div>
    <div class="value">$ {(s?.passthrough_avg_usd_per_request ?? 0).toFixed(4)}</div>
    <div class="small">
      n={numFmt(s?.passthrough_paid_requests)} · total $ {(s?.passthrough_actual_usd ?? 0).toFixed(4)}
    </div>
  </div>
  <div class="card">
    <div class="label">compressed − passthrough $/req</div>
    {#if s?.split_sufficient_sample}
      <div class="value" class:pos={(s?.compressed_minus_passthrough_avg_usd ?? 0) <= 0} class:neg={(s?.compressed_minus_passthrough_avg_usd ?? 0) > 0}>
        {((s?.compressed_minus_passthrough_avg_usd ?? 0) >= 0 ? '+$ ' : '-$ ')}{Math.abs(s?.compressed_minus_passthrough_avg_usd ?? 0).toFixed(4)}
      </div>
      <div class="small">negative = compressed path cheaper · both buckets ≥ {s?.split_min_sample_per_bucket}</div>
    {:else}
      <div class="value small-sample">small sample</div>
      <div class="small">
        need ≥ {s?.split_min_sample_per_bucket} requests per bucket · have
        {numFmt(s?.compressed_paid_requests)} / {numFmt(s?.passthrough_paid_requests)}
      </div>
    {/if}
    {#if s && pa}
      <details class="math">
        <summary>show calculation</summary>
        <div class="formula">{@html splitMath}</div>
      </details>
    {/if}
  </div>
  <div class="card">
    <div class="label">token-equivalent total</div>
    <div class="value">{numFmt(s?.actual_token_equivalent)}</div>
    <div class="small">input + 5×output billed at 5× input rate</div>
    {#if s && pa}
      <details class="math">
        <summary>show calculation</summary>
        <div class="formula">{@html tokeqMath}</div>
      </details>
    {/if}
  </div>
</div>

{#if s && pa}
  <details class="diagnostic">
    <summary>diagnostic: counterfactual "share of spend saved"</summary>
    <div class="diagnostic-body">
      <div class="diag-headline">
        share of spend saved (counterfactual):
        <span class:pos={(s?.saved_pct_of_all_spend ?? 0) >= 0} class:neg={(s?.saved_pct_of_all_spend ?? 0) < 0}>
          {(s?.saved_pct_of_all_spend ?? 0).toFixed(1)}%
        </span>
        <span class="small">
          ({numFmt(s?.all_usage_requests)} paid req · compressed + passthrough + probe-failed)
        </span>
      </div>
      <div class="formula">{@html pctMath}</div>
    </div>
  </details>
{/if}

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 14px;
    margin-bottom: 22px;
  }
  @media (max-width: 1400px) {
    .grid {
      grid-template-columns: repeat(3, 1fr);
    }
  }
  @media (max-width: 900px) {
    .grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }
  .card {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 10px;
    padding: 14px 16px;
  }
  .label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #8b949e;
    margin-bottom: 10px;
  }
  .value {
    font-size: 24px;
    font-weight: 600;
    color: #e6edf3;
    font-variant-numeric: tabular-nums;
  }
  .value.pos {
    color: #3fb950;
  }
  .value.neg {
    color: #f85149;
  }
  .value.small-sample {
    color: #8b949e;
    font-size: 18px;
    font-weight: 500;
  }
  .diagnostic {
    margin: 0 0 22px;
    font-size: 12px;
    color: #8b949e;
  }
  .diagnostic :global(summary) {
    cursor: pointer;
    user-select: none;
    color: #58a6ff;
    padding: 6px 0;
  }
  .diagnostic :global(summary::-webkit-details-marker) {
    display: none;
  }
  .diagnostic :global(summary::before) {
    content: '▸ ';
    color: #6e7681;
    font-size: 9px;
  }
  .diagnostic :global([open] summary::before) {
    content: '▾ ';
  }
  .diagnostic-body {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 12px 14px;
    margin-top: 6px;
  }
  .diag-headline {
    color: #c9d1d9;
    margin-bottom: 8px;
  }
  .diag-headline .pos {
    color: #3fb950;
    font-weight: 600;
  }
  .diag-headline .neg {
    color: #f85149;
    font-weight: 600;
  }
  .small {
    font-size: 11px;
    color: #6e7681;
    margin-top: 4px;
  }
  .math {
    margin-top: 10px;
    font-size: 11px;
  }
  .math :global(summary) {
    cursor: pointer;
    user-select: none;
    color: #58a6ff;
  }
  .math :global(summary::-webkit-details-marker) {
    display: none;
  }
  .math :global(summary::before) {
    content: '▸ ';
    color: #6e7681;
    font-size: 9px;
  }
  .math :global([open] summary::before) {
    content: '▾ ';
  }
  .math :global(summary:hover) {
    color: #79c0ff;
  }
  .formula {
    background: #0d1117;
    border: 1px solid #21262d;
    border-radius: 6px;
    padding: 8px 10px;
    margin-top: 6px;
    font:
      11px/1.5 'SF Mono',
      Menlo,
      monospace;
    color: #c9d1d9;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .formula :global(.k) {
    color: #8b949e;
  }
  .formula :global(.v) {
    color: #e6edf3;
  }
  .formula :global(.op) {
    color: #f0883e;
  }
  .formula :global(.src) {
    color: #6e7681;
    font-size: 10px;
    display: block;
    margin-top: 6px;
    border-top: 1px solid #21262d;
    padding-top: 6px;
  }
</style>
