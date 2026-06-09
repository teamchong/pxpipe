<script lang="ts">
  // Image viewer. When selectedImageId is null, follows the latest render
  // via cache-busting on preview_meta. When pinned to an id, fetches that
  // specific image from the ring; degrades gracefully if the id has been
  // evicted.

  import { recent, selectedImageId } from '../stores/index.js';

  $: hasPreview = $recent.data?.has_preview === true;
  $: meta = $recent.data?.preview_meta ?? '';
  $: imageIds = $recent.data?.image_ids ?? [];
  $: pinned = $selectedImageId;

  // when pinned, check if the id is still resident in the ring
  $: pinnedEvicted = pinned != null && !imageIds.includes(pinned);

  // url for the <img> element
  $: imgUrl = pinned != null
    ? `/proxy-latest-png?id=${pinned}`
    : (hasPreview ? '/proxy-latest-png?t=' + encodeURIComponent(meta) : '');

  // caption text
  $: caption = pinned != null
    ? `image #${pinned}`
    : (meta ? meta + ' - showing top-left at native resolution' : '');

  // --- source-text viewer ---------------------------------------------
  // Fetches /api/image-source so the operator can see the JSON/tool-result
  // text that was rendered into the PNG, side by side with the image.
  let showSource = false;
  let sourceText: string | null = null;
  let sourceErr: string | null = null;
  let sourceForKey = '';

  // key identifying the currently displayed image (pin id or latest meta)
  $: sourceKey = pinned != null ? `id:${pinned}` : `latest:${meta}`;

  async function loadSource() {
    sourceForKey = sourceKey;
    sourceText = null;
    sourceErr = null;
    try {
      const url = pinned != null ? `/api/image-source?id=${pinned}` : '/api/image-source';
      const res = await fetch(url);
      if (!res.ok) {
        sourceErr = 'source text not captured for this image';
        return;
      }
      const body = await res.json();
      sourceText = body.source_text ?? '';
    } catch {
      sourceErr = 'failed to fetch source text';
    }
  }

  function toggleSource() {
    showSource = !showSource;
    if (showSource) void loadSource();
  }

  // refetch when the displayed image changes while the panel is open
  $: if (showSource && sourceKey !== sourceForKey) void loadSource();
</script>

<div class="wrap">
  {#if pinned != null}
    <div class="pin-bar">
      <button class="back-btn" on:click={() => selectedImageId.set(null)}>← latest</button>
    </div>
    {#if pinnedEvicted}
      <div class="evicted">(image #{pinned} no longer in buffer)</div>
    {:else}
      <div class="preview-crop">
        <img src={imgUrl} alt="image #{pinned}" />
      </div>
    {/if}
  {:else if hasPreview}
    <div class="preview-crop">
      <img src={imgUrl} alt="latest rendered" />
    </div>
  {:else}
    <div class="sub">(none yet)</div>
  {/if}
</div>
<div class="small">
  {caption}
  {#if pinned != null ? !pinnedEvicted : hasPreview}
    <button class="src-btn" on:click={toggleSource}>{showSource ? 'hide source text' : 'view source text'}</button>
  {/if}
</div>
{#if showSource}
  {#if sourceErr}
    <div class="evicted">{sourceErr}</div>
  {:else if sourceText == null}
    <div class="evicted">loading…</div>
  {:else}
    <pre class="src-pane">{sourceText}</pre>
  {/if}
{/if}

<style>
  .wrap {
    margin-top: 0;
  }
  /* Crop is done client-side via CSS (object-position + overflow:hidden).
     The legacy dashboard pulled a separately-cropped PNG which doubled
     image traffic. The full 1466×1568 image lives on disk; we just show
     the top-left corner at native res. */
  .preview-crop {
    width: 100%;
    height: 400px;
    overflow: hidden;
    background: #fff;
    border: 1px solid #30363d;
    border-radius: 4px;
    padding: 4px;
    box-sizing: border-box;
  }
  .preview-crop img {
    display: block;
    width: auto;
    height: auto;
    max-width: none;
    image-rendering: pixelated;
  }
  .sub {
    color: #6e7681;
    font-size: 12px;
  }
  .small {
    font-size: 11px;
    color: #6e7681;
    margin-top: 8px;
  }
  .pin-bar {
    margin-bottom: 8px;
  }
  .back-btn {
    font-size: 11px;
    background: #21262d;
    color: #58a6ff;
    border: 1px solid #30363d;
    border-radius: 4px;
    padding: 2px 8px;
    cursor: pointer;
  }
  .back-btn:hover {
    background: #30363d;
  }
  .src-btn {
    font-size: 11px;
    background: #21262d;
    color: #58a6ff;
    border: 1px solid #30363d;
    border-radius: 4px;
    padding: 1px 6px;
    margin-left: 8px;
    cursor: pointer;
  }
  .src-btn:hover {
    background: #30363d;
  }
  .src-pane {
    margin-top: 8px;
    max-height: 400px;
    overflow: auto;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 4px;
    padding: 8px;
    font-size: 11px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
    color: #c9d1d9;
  }
  .evicted {
    font-size: 11px;
    color: #6e7681;
    padding: 12px 0;
  }
</style>
