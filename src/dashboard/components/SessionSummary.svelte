<script lang="ts">
  // One-line headline for the current session: dollar-weighted savings ratio.
  //
  // Math (no cherry-pick):
  //   saved_$ = Σ baseline_$ − Σ actual_$         (over requests where we measured baseline)
  //   saved_% = saved_$ / Σ baseline_$
  //
  // `baseline_$` is the cache-aware bill Anthropic would have charged for the
  // uncompressed body with the SAME cache_control markers Claude Code sent —
  // measured by the counterfactual baseline probe on a sampled subset of
  // requests. Caching savings stay credited to Claude Code; what remains is
  // proxy-attributable savings only.
  //
  // Unmeasured requests (probe skipped, passthroughs) don't enter either sum.
  // We only report what we measured.
  import { currentSession } from '../stores/index.js';

  $: data = $currentSession.data;
  $: err = $currentSession.error;

  $: baselineUsd = data?.baselineInputWeighted ?? 0;
  $: actualUsd = data?.actualInputWeighted ?? 0;
  $: savedUsd = Math.max(0, baselineUsd - actualUsd);
  $: savedPct = baselineUsd > 0 ? (savedUsd / baselineUsd) * 100 : 0;
  $: measuredReqs = data?.baselineMeasuredCount ?? 0;

  function fmtUsd(n: number): string {
    return '$' + n.toFixed(2);
  }
</script>

{#if err}
  <div class="line muted">session: {err}</div>
{:else if measuredReqs > 0}
  <div class="line">
    <span class="label">THIS SESSION</span>
    — saved <span class="num">{fmtUsd(savedUsd)}</span>
    (<span class="num">{savedPct.toFixed(1)}%</span>)
    · <span class="muted">{measuredReqs} requests</span>
  </div>
{/if}

<style>
  .line {
    font-size: 14px;
    color: #c9d1d9;
    margin-bottom: 12px;
    padding: 8px 12px;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
  }
  .label {
    font-weight: 600;
    color: #8b949e;
    letter-spacing: 0.04em;
  }
  .num {
    font-variant-numeric: tabular-nums;
    color: #3fb950;
    font-weight: 600;
  }
  .muted {
    color: #6e7681;
  }
</style>
