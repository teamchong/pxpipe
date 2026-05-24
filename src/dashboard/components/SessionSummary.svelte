<script lang="ts">
  // Top-of-dashboard headline. Dollar-weighted savings ratio scoped to the
  // most-recently-active session, with per-bucket breakdown of where the
  // savings came from and a list of passthrough reasons for requests we
  // didn't compress. Polls 2s via the `currentSession` store.
  import { currentSession } from '../stores/index.js';

  $: data = $currentSession.data;
  $: err = $currentSession.error;
  $: hasSession = data && data.sessionId != null;

  function fmtUsd(n: number): string {
    return '$' + n.toFixed(2);
  }
  function fmtPct(n: number): string {
    return n.toFixed(1) + '%';
  }
  function fmtDuration(sec: number): string {
    if (sec < 60) return Math.round(sec) + 's';
    const m = Math.floor(sec / 60);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }
  function fmtChars(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k';
    return (n / 1_000_000).toFixed(1) + 'M';
  }

  $: bucketTotal = data?.bucketChars
    ? Object.values(data.bucketChars).reduce((a, b) => a + b, 0)
    : 0;
  $: bucketEntries = data?.bucketChars
    ? (Object.entries(data.bucketChars) as [string, number][])
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
    : [];
  $: passthroughEntries = data?.passthroughReasons
    ? (Object.entries(data.passthroughReasons) as [string, number][])
        .sort((a, b) => b[1] - a[1])
    : [];

  // Static key→label / key→color maps. The Record type matches the spec's
  // `bucketChars` shape so any new bucket added in tracker.ts will show up
  // in legend order. Hex codes chosen to match the legacy panel palette.
  const BUCKET_LABELS: Record<string, string> = {
    static_slab: 'slab',
    reminder: 'reminder',
    tool_result: 'tool_result',
    history: 'history',
    billing: 'billing',
    dynamic: 'dynamic',
  };
  const BUCKET_COLORS: Record<string, string> = {
    static_slab: '#b9be0',
    reminder: '#85c5f6',
    tool_result: '#10b981',
    history: '#f59e0b',
    billing: '#8e7681',
    dynamic: '#ef4444',
  };
</script>

<div class="panel session-summary">
  {#if err}
    <div class="error">error: {err}</div>
  {:else if !data}
    <div class="loading">loading…</div>
  {:else if !hasSession}
    <h2>This session</h2>
    <div class="empty">{data.message ?? 'no active session yet'}</div>
  {:else}
    <div class="header">
      <h2>This session</h2>
      <div class="sub">
        started {fmtDuration(data.uptimeSec ?? 0)} ago · {data.requests} requests
      </div>
    </div>

    <div class="headline">
      <div class="big">
        Saved <span class="pct">{fmtPct(data.savedPct ?? 0)}</span>
      </div>
      <div class="usd">
        {fmtUsd(data.savedUsd ?? 0)} of {fmtUsd(data.baselineUsd ?? 0)} baseline
      </div>
    </div>

    <div class="bar">
      <div class="bar-fill" style="width: {Math.max(0, Math.min(100, data.savedPct ?? 0))}%"></div>
    </div>

    {#if bucketEntries.length > 0}
      <div class="section">
        <div class="section-label">Where it came from</div>
        <div class="bucket-bar">
          {#each bucketEntries as [key, val]}
            {@const w = bucketTotal > 0 ? (val / bucketTotal) * 100 : 0}
            <div
              class="bucket-seg"
              style="width: {w}%; background: {BUCKET_COLORS[key] ?? '#8e7681'}"
              title="{BUCKET_LABELS[key] ?? key}: {fmtChars(val)} chars ({w.toFixed(1)}%)"
            ></div>
          {/each}
        </div>
        <div class="bucket-legend">
          {#each bucketEntries as [key, val]}
            {@const w = bucketTotal > 0 ? (val / bucketTotal) * 100 : 0}
            <span class="legend-item">
              <span class="swatch" style="background: {BUCKET_COLORS[key] ?? '#8e7681'}"></span>
              {BUCKET_LABELS[key] ?? key} {w.toFixed(0)}%
            </span>
          {/each}
        </div>
      </div>
    {/if}

    {#if passthroughEntries.length > 0}
      <div class="section">
        <div class="section-label">
          Where it didn't · {data.passthroughRequests ?? 0} of {data.requests} requests passed through
        </div>
        <ul class="passthrough-list">
          {#each passthroughEntries as [reason, count]}
            <li><span class="reason">{reason}</span> <span class="count">{count}</span></li>
          {/each}
        </ul>
      </div>
    {:else if (data.passthroughRequests ?? 0) === 0}
      <div class="section">
        <div class="section-label-good">✓ Every request compressed</div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .session-summary {
    margin-bottom: 22px;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 12px;
  }
  h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #8e7681;
  }
  .sub {
    font-size: 12px;
    color: #8e7681;
  }
  .headline {
    margin-bottom: 10px;
  }
  .big {
    font-size: 18px;
    font-weight: 600;
    color: #c9d1d9;
  }
  .pct {
    color: #3fb950;
    font-variant-numeric: tabular-nums;
  }
  .usd {
    font-size: 12px;
    color: #8e7681;
    margin-top: 2px;
    font-variant-numeric: tabular-nums;
  }
  .bar {
    margin-top: 8px;
    height: 6px;
    background: #21262d;
    border-radius: 3px;
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
    background: #3fb950;
    transition: width 1s ease;
  }
  .section {
    margin-top: 16px;
  }
  .section-label {
    font-size: 11px;
    color: #8e7681;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 6px;
  }
  .section-label-good {
    color: #3fb950;
    text-transform: none;
    letter-spacing: 0;
    font-size: 12px;
  }
  .bucket-bar {
    display: flex;
    height: 8px;
    border-radius: 4px;
    overflow: hidden;
    background: #21262d;
  }
  .bucket-seg {
    height: 100%;
    transition: width 1s ease;
  }
  .bucket-legend {
    margin-top: 6px;
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    font-size: 11px;
    color: #c9d1d9;
  }
  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-variant-numeric: tabular-nums;
  }
  .swatch {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }
  .passthrough-list {
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 12px;
    color: #c9d1d9;
  }
  .passthrough-list li {
    display: flex;
    justify-content: space-between;
    padding: 2px 0;
    font-variant-numeric: tabular-nums;
  }
  .reason {
    color: #8e7681;
  }
  .count {
    color: #8e7681;
  }
  .loading, .empty, .error {
    color: #8e7681;
    font-size: 12px;
  }
  .error {
    color: #f85149;
  }
</style>
