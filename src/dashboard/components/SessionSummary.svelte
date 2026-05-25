<script lang="ts">
  // One-line headline for the current session: dollar-weighted savings ratio.
  //
  // Math (no cherry-pick):
  //   saved_$    = Σ baseline_$ − Σ actual_$        over MEASURED rows only
  //                (honest numerator — we can only know what we saved on
  //                 requests where the baseline probe ran)
  //   totalBill_$ = Σ actual_input_$ + Σ output_$   over ALL session rows
  //                (measured + unmeasured + passthrough — what Anthropic
  //                 actually billed for this session)
  //   saved_%    = saved_$ / totalBill_$ × 100
  //
  // `baseline_$` is the cache-aware bill Anthropic would have charged for the
  // uncompressed body with the SAME cache_control markers Claude Code sent —
  // measured by the counterfactual baseline probe on a sampled subset of
  // requests. Caching savings stay credited to Claude Code; what remains is
  // proxy-attributable savings only.
  //
  // Why this denominator and not Σ baseline_$? Σ baseline_$ is filtered to
  // measured rows only, which cherry-picks the wins (the slice where we
  // proved savings) and ignores the rest of the bill the user actually
  // paid. Dividing by the full session bill matches the global
  // `saved_pct_of_all_spend` math and produces a number the user can
  // reconcile against an invoice.
  import { currentSession } from '../stores/index.js';

  $: data = $currentSession.data;
  $: err = $currentSession.error;

  // backend exposes raw weighted tokens; convert to $ at Opus 4.x rates.
  // These MUST stay in lockstep with the server-side constants
  // `ASSUMED_INPUT_USD_PER_MTOK` and `OUTPUT_TOKEN_RATE` in src/dashboard.ts.
  const INPUT_USD_PER_MTOK = 5.0;
  const OUTPUT_TOKEN_RATE = 5.0;
  // Numerator: honest savings over the MEASURED slice.
  $: baselineTok = data?.baselineInputWeighted ?? 0;
  $: actualTok = data?.actualInputWeighted ?? 0;
  $: savedTok = Math.max(0, baselineTok - actualTok);
  $: savedUsd = (savedTok * INPUT_USD_PER_MTOK) / 1_000_000;
  // Denominator: ALL-rows session bill ($) = input + output across every
  // request the proxy saw this session, measured or not.
  $: allActualTok = data?.allActualInputWeighted ?? 0;
  $: allOutputTok = data?.allOutputWeighted ?? 0;
  $: totalBillUsd =
    (allActualTok * INPUT_USD_PER_MTOK) / 1_000_000 +
    (allOutputTok * OUTPUT_TOKEN_RATE) / 1_000_000;
  $: savedPct = totalBillUsd > 0 ? (savedUsd / totalBillUsd) * 100 : 0;
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
    of <span class="muted">{fmtUsd(totalBillUsd)}</span> total bill
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
