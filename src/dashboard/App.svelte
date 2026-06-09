<script lang="ts">
  // Root component. Owns no state of its own — every panel subscribes to its
  // own slice of the polling stores. The legacy dashboard polled everything
  // on the same 2s/5s cadences and rebuilt all DOM on every tick; we keep
  // the cadences but let Svelte's reactivity diff at the field level.

  import RecentRequests from './components/RecentRequests.svelte';
  import LatestPng from './components/LatestPng.svelte';
  import Sessions from './components/Sessions.svelte';
  import StatsTable from './components/StatsTable.svelte';
  import CompressionToggle from './components/CompressionToggle.svelte';
  import SessionSummary from './components/SessionSummary.svelte';
  import ToastTray from './components/ToastTray.svelte';
  import { stats } from './stores/index.js';

  // The footer's `port  ·  uptime  ·  live` line lives at the top of the
  // legacy template — it tells the operator the dashboard is actually
  // receiving polls. We surface it via the same store everyone else uses.
  $: sub = $stats.data
    ? `port ${location.port || '80'}  ·  uptime ${formatDuration($stats.data.uptime_sec)}  ·  live`
    : ($stats.error ? 'proxy unreachable' : 'connecting...');

  function formatDuration(s: number): string {
    s = Math.floor(s);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return (h ? h + 'h ' : '') + (m || h ? m + 'm ' : '') + sec + 's';
  }
</script>

<h1><span class="dot"></span>pxpipe</h1>
<div class="sub">{sub}</div>

<CompressionToggle />

<SessionSummary />

<div class="row">
  <div class="panel">
    <h2>recent requests</h2>
    <RecentRequests />
  </div>
  <div class="panel">
    <h2>latest rendered image</h2>
    <LatestPng />
  </div>
</div>

<div class="panel" style="margin-bottom:22px">
  <h2>sessions <span class="small" style="color:#6e7681">(top savers)</span></h2>
  <Sessions />
</div>

<div class="panel" style="margin-bottom:22px">
  <h2>stats <span class="small" style="color:#6e7681">(full history)</span></h2>
  <StatsTable />
</div>

<ToastTray />

<style>
  /* Match the legacy dashboard 1:1 — same fonts, colors, spacing. The page
     looks identical pre/post rewrite to keep visual regression cheap. */
  :global(body) {
    margin: 0;
    padding: 24px;
    background: #0d1117;
    color: #c9d1d9;
    font:
      14px/1.45 -apple-system,
      BlinkMacSystemFont,
      'SF Mono',
      Menlo,
      monospace;
  }
  h1 {
    font-size: 18px;
    font-weight: 600;
    margin: 0 0 6px;
    letter-spacing: -0.01em;
  }
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #3fb950;
    margin-right: 6px;
    vertical-align: middle;
    animation: pulse 2s infinite;
  }
  .sub {
    color: #8b949e;
    font-size: 12px;
    margin-bottom: 22px;
  }
  .row {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 14px;
    margin-bottom: 22px;
  }
  @media (max-width: 1200px) {
    .row {
      grid-template-columns: repeat(2, 1fr);
    }
  }
  @media (max-width: 900px) {
    .row {
      grid-template-columns: 1fr;
    }
  }
  .panel {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 10px;
    padding: 14px 16px;
    /* Grid items default to `min-width: auto`, which refuses to shrink a
       track below its content's min-content size. A replaced element (the
       latest-render <img>) has a large intrinsic width that propagates into
       that minimum even through an `overflow: hidden` ancestor, blowing the
       `1fr` track past the viewport. `min-width: 0` lets the track shrink so
       the `width: 100%` crop box actually constrains the image. */
    min-width: 0;
  }
  .panel :global(h2) {
    font-size: 13px;
    font-weight: 600;
    margin: 0 0 14px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #8b949e;
  }
  @keyframes pulse {
    50% {
      opacity: 0.4;
    }
  }
</style>
