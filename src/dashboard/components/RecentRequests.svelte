<script lang="ts">
  // Ring buffer of the last N requests, polled every 2s. The legacy
  // dashboard wiped the whole `<tbody>` on every tick which made shift+click
  // selection and scroll position fight each other. Svelte's keyed each
  // block diffs by ts and only touches changed rows.

  import { recent, selectedImageId } from '../stores/index.js';
  import { numFmt } from '../lib/format.js';

  $: rows = $recent.data?.recent ?? [];

  function statusCls(status: number): string {
    if (status >= 500) return 'bad';
    if (status >= 400) return 'warn';
    return 'good';
  }
  function shortPath(p: string): string {
    if (!p) return '-';
    const parts = p.split('/');
    return parts[parts.length - 1] || p;
  }
</script>

<table>
  <thead>
    <tr>
      <th>#</th>
      <th class="num">status</th>
      <th>path</th>
      <th class="num">cc</th>
      <th class="num">cr</th>
      <th class="num">baseline</th>
      <th class="num">actual</th>
      <th class="num">saved</th>
      <th class="num">img</th>
    </tr>
  </thead>
  <tbody>
    {#each rows.slice().reverse() as e, i (e.ts + ':' + i)}
      <tr>
        <td>{i + 1}</td>
        <td class="num {statusCls(e.status)}">{e.status}</td>
        <td class="small">{shortPath(e.path)}</td>
        <td class="num">{e.cc_added ? '✓' : '-'}</td>
        <td class="num">{e.cache_read != null ? numFmt(e.cache_read) : '-'}</td>
        <td class="num">{e.baseline_input != null ? numFmt(e.baseline_input) : '-'}</td>
        <td class="num">{e.actual_input != null ? numFmt(e.actual_input) : '-'}</td>
        <td class="num pos">
          {(e.session_saved_so_far_delta ?? 0) > 0
            ? '+' + numFmt(e.session_saved_so_far_delta ?? 0)
            : '-'}
        </td>
        <td class="img-cell">
          {#if (e.img_ids && e.img_ids.length > 0) || e.img_id != null}
            {@const ids = e.img_ids ?? (e.img_id != null ? [e.img_id] : [])}
            <div class="thumb-strip">
              {#each ids as id}
                <button type="button" class="thumb-btn" title="image #{id}"
                        on:click={() => selectedImageId.set(id)}>
                  <img class="thumb" src="/proxy-latest-png?id={id}" alt="img {id}" />
                </button>
              {/each}
            </div>
          {:else}
            <span class="muted">-</span>
          {/if}
        </td>
      </tr>
    {:else}
      <tr><td colspan="9" class="small" style="color:#6e7681">no requests yet</td></tr>
    {/each}
  </tbody>
</table>

<style>
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  th {
    text-align: left;
    color: #6e7681;
    font-weight: 500;
    padding: 6px 8px;
    border-bottom: 1px solid #30363d;
  }
  td {
    padding: 6px 8px;
    border-bottom: 1px solid #21262d;
    font-variant-numeric: tabular-nums;
  }
  tr:last-child td {
    border-bottom: none;
  }
  th.num,
  td.num {
    text-align: right;
  }
  .small {
    font-size: 11px;
    color: #6e7681;
  }
  td.good {
    color: #3fb950;
  }
  td.warn {
    color: #d29922;
  }
  td.bad {
    color: #f85149;
  }
  td.pos {
    color: #3fb950;
  }
  .muted {
    color: #6e7681;
  }
  .thumb-strip {
    display: flex;
    gap: 3px;
    align-items: center;
    justify-content: flex-end;
  }
  .thumb-btn {
    padding: 0;
    border: 1px solid #30363d;
    border-radius: 3px;
    background: #fff;
    cursor: pointer;
    line-height: 0;
  }
  .thumb-btn:hover,
  .thumb-btn:focus-visible {
    border-color: #58a6ff;
    outline: none;
  }
  .thumb {
    height: 28px;
    width: auto;
    max-width: 28px;
    object-fit: cover;
    object-position: top left;
    display: block;
    image-rendering: pixelated;
  }
  .img-cell {
    text-align: right;
  }
</style>
