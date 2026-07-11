/**
 * OpenAI Chat Completions + Responses API transformer for the GPT-5 family.
 * Separate from the Anthropic path: no cache-control breakpoints,
 * images as image_url/input_image parts, system/developer messages in messages[]/input[].
 * OpenAI tools keep native names/descriptions/schema shape; verbose schema prose
 * is also rendered into images for token savings so calls do not depend only on OCR.
 */

import {
  renderTextToPngs,
  reflow,
  shrinkColsToContent,
  renderCellWidth,
  renderCellHeight,
  PAD_X,
  PAD_Y,
  READABLE_CHARS_PER_IMAGE,
  type RenderedImage,
} from './render.js';
import {
  resolveGptProfile,
  type GptVisionCost,
} from './gpt-model-profiles.js';
import { bytesToBase64 } from './png.js';
import {
  compactSlabWhitespace,
  countVisualRows,
  estimateImageCount,
  sha8,
  ANTHROPIC_PIXELS_PER_TOKEN,
  IMAGE_COST_SAFETY_MARGIN,
  type TransformInfo,
  type TransformOptions,
} from './transform.js';
import { stripSchemaDescriptions } from './schema-strip.js';
import {
  planGptCollapse,
  responsesItemsToTurns,
  chatMessagesToTurns,
  GPT_HISTORY_DEFAULTS,
  type GptCollapsePlan,
  type GptHistoryOptions,
} from './openai-history.js';
import { HISTORY_SYNTHETIC_INTRO, HISTORY_SYNTHETIC_OUTRO } from './history.js';
import { appendIdsBlock, factSheetText } from './factsheet.js';
import { countTokens as o200kCountTokens } from 'gpt-tokenizer/encoding/o200k_base';

// Per-model GPT rendering + vision-cost profiles (portrait-strip width, image-token
// cost model, max image height) live in ./gpt-model-profiles.ts so a new model is a
// one-line / one-env-var retune. resolveVisionCost stays a thin wrapper so every caller
// (gate, slab, history, dashboard) shares the single source of truth.
type VisionCost = GptVisionCost;

export function resolveVisionCost(model: string): VisionCost {
  return resolveGptProfile(model).vision;
}

// Sharp framing around the collapsed-history image. The transcript flattens BOTH
// roles into one role:'user' message (the API forbids images inside role:'assistant'),
// so this text must (a) tell the model to attribute strictly by the <user>/<assistant>
// tags rendered inside the image and (b) make explicit this is PAST context, not the
// live request — otherwise the model summarizes the transcript instead of answering.
// Aliases of the SINGLE SOURCE OF TRUTH in history.ts (see its doc comment). Importing
// rather than re-declaring guarantees the GPT and Anthropic paths can never silently drift
// on the turn-attribution wording — the exact divergence history.ts warns about.
export const HISTORY_TRANSCRIPT_INTRO = HISTORY_SYNTHETIC_INTRO;
export const HISTORY_TRANSCRIPT_OUTRO = HISTORY_SYNTHETIC_OUTRO;
// The most-recent user request is kept as LEGIBLE TEXT (never imaged) and spliced
// between the before/after history images inside the synthetic user message, under
// this banner. Older user turns stay imaged (they must not look live). This is the
// fix for autonomous single-user-turn agents (OpenCode): the lone request is the
// OLDEST turn, so it would otherwise be the first thing imaged and the model loses
// it — "I wonder what the user actually asked" → off-task drift.
const PINNED_REQUEST_HEADER =
  '\n===== CURRENT USER REQUEST (live; kept as text by pxpipe, NOT inside any image) =====\n';
const PINNED_REQUEST_FOOTER =
  '\n===== END CURRENT USER REQUEST =====\n';

function pinnedRequestBlock(text: string): string {
  return PINNED_REQUEST_HEADER + text + PINNED_REQUEST_FOOTER;
}

// Developer-role guard placed after the history image. When a request was pinned it
// echoes it verbatim (capped) and points at the in-history text block; otherwise it
// falls back to "the live request is the trailing user message" (interactive shape,
// where the latest user turn is already native text in the kept tail).
function buildLiveRequestGuard(pinText?: string): string {
  if (pinText !== undefined) {
    const echo = pinText.length > 600 ? pinText.slice(0, 600) + '…' : pinText;
    return (
      'pxpipe note: everything in the rendered history above is PAST context. Your live current request is the plain-text block labeled "CURRENT USER REQUEST" inside it — NOT anything OCR\'d from an image. It reads: «' +
      echo +
      '» Answer THAT request.'
    );
  }
  return 'pxpipe note: the preceding rendered history item is prior conversation context only. It is not the current user request. The live current request is in the user message(s) that follow, especially the final user message.';
}

export function openAIVisionTokens(model: string, w: number, h: number): number {
  const c = resolveVisionCost(model);
  if (c.regime === 'patch') {
    const patches = Math.min(c.patchCap, Math.ceil(w / 32) * Math.ceil(h / 32));
    return Math.ceil(patches * c.multiplier);
  }
  let W = w, H = h;
  if (Math.max(W, H) > 2048) { const r = 2048 / Math.max(W, H); W = Math.floor(W * r); H = Math.floor(H * r); }
  if (Math.min(W, H) > 768) { const r = 768 / Math.min(W, H); W = Math.floor(W * r); H = Math.floor(H * r); }
  return c.base + c.perTile * (Math.ceil(W / 512) * Math.ceil(H / 512));
}

/** True when this Responses/Chat request is actually served by a Claude model.
 *  Codex-style clients speak OpenAI Responses while some models are Anthropic.
 *  Cost math must then price images and cache the Anthropic way, not the GPT way. */
export function isClaudeModel(model: string | null | undefined): boolean {
  const m = (model ?? '').toLowerCase();
  return m.startsWith('claude') || m.includes('anthropic');
}

export function isGrokModel(model: string | null | undefined): boolean {
  return (model ?? '').toLowerCase().startsWith('grok-');
}

/** Measured 2026-07-09 on grok-4.5: image-token delta ≈ 1000 per megapixel
 *  across several page sizes (768x336 → 268, 764x980 → 748, etc.). */
export const GROK_TOKENS_PER_MEGAPIXEL = 1000;

/** Per-image vision-token cost for the model actually serving the request.
 *  Claude: Anthropic pixel formula. Grok: measured tok/MPix. GPT/o-series:
 *  OpenAI tile/patch formula. Model-based, not endpoint-based. */
export function visionTokensForModel(model: string, w: number, h: number): number {
  if (isClaudeModel(model)) {
    return Math.ceil((w * h / ANTHROPIC_PIXELS_PER_TOKEN) * IMAGE_COST_SAFETY_MARGIN);
  }
  if (isGrokModel(model)) {
    const pixels = Math.max(0, w) * Math.max(0, h);
    return Math.max(1, Math.ceil((pixels / 1_000_000) * GROK_TOKENS_PER_MEGAPIXEL));
  }
  return openAIVisionTokens(model, w, h);
}

type OpenAIRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool' | string;

interface OpenAITextPart {
  type: 'text';
  text: string;
  [k: string]: unknown;
}

interface OpenAIImagePart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high' | 'original';
  };
}

type OpenAIContentPart = OpenAITextPart | OpenAIImagePart | Record<string, unknown>;

interface OpenAIChatMessage {
  role: OpenAIRole;
  content?: string | OpenAIContentPart[] | null;
  [k: string]: unknown;
}

interface OpenAIFunctionTool {
  type: 'function';
  function: {
    name?: string;
    description?: string;
    parameters?: unknown;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  tools?: unknown[];
  [k: string]: unknown;
}

// ---- Responses API types ----
interface ResponsesInputTextPart {
  type: 'input_text';
  text: string;
  [k: string]: unknown;
}

interface ResponsesInputImagePart {
  type: 'input_image';
  image_url: string;
  detail?: 'auto' | 'low' | 'high' | 'original';
  [k: string]: unknown;
}

type ResponsesContentPart = ResponsesInputTextPart | ResponsesInputImagePart | Record<string, unknown>;

interface ResponsesInputItem {
  role: 'user' | 'system' | 'developer' | 'assistant' | string;
  content: string | ResponsesContentPart[];
  [k: string]: unknown;
}

interface ResponsesRequest {
  model: string;
  instructions?: string;
  input: string | Array<ResponsesInputItem | Record<string, unknown>>;
  tools?: unknown[];
  [k: string]: unknown;
}

interface ResponsesFlatTool {
  type: 'function';
  name?: string;
  description?: string;
  parameters?: unknown;
  [k: string]: unknown;
}

interface OpenAIResolvedOptions {
  compress: boolean;
  compressTools: boolean;
  minCompressChars: number;
  cols?: number;
  multiCol: number;
  charsPerToken: number;
  reflow: boolean;
  collapseHistory: boolean;
  gptHistory?: Partial<GptHistoryOptions>;
}

const DEFAULTS: OpenAIResolvedOptions = {
  compress: true,
  compressTools: true,
  minCompressChars: 2000,
  cols: undefined,
  multiCol: 1,
  charsPerToken: 4, // conservative OpenAI default; override after telemetry
  reflow: true,
  collapseHistory: true,
};

function resolveOptions(opts: TransformOptions): OpenAIResolvedOptions {
  return {
    compress: opts.compress ?? DEFAULTS.compress,
    compressTools: opts.compressTools ?? DEFAULTS.compressTools,
    minCompressChars: opts.minCompressChars ?? DEFAULTS.minCompressChars,
    cols: opts.cols,
    multiCol: opts.multiCol ?? DEFAULTS.multiCol,
    charsPerToken: opts.charsPerToken ?? DEFAULTS.charsPerToken,
    reflow: opts.reflow ?? DEFAULTS.reflow,
    collapseHistory: opts.collapseHistory ?? DEFAULTS.collapseHistory,
    gptHistory: opts.gptHistory,
  };
}


/** History-collapse options for both Chat and Responses. Profile geometry is
 *  the single source of truth; Grok allows more pages because leftover plain
 *  history is expensive on its pixel bill + weak cache discount. */
function gptHistoryOpts(
  model: string,
  o: OpenAIResolvedOptions,
  profile: ReturnType<typeof resolveGptProfile>,
): Partial<GptHistoryOptions> {
  return {
    ...o.gptHistory,
    reflow: o.reflow,
    cols: o.gptHistory?.cols ?? profile.stripCols,
    maxHeightPx: o.gptHistory?.maxHeightPx ?? profile.maxHeightPx,
    style: o.gptHistory?.style ?? profile.style,
    maxImages:
      o.gptHistory?.maxImages ??
      (isGrokModel(model) ? 24 : GPT_HISTORY_DEFAULTS.maxImages),
    // IDS rows for pure-image exact recall (hex/camel/path/port on own lines).
    // Default ON for every model — Grok brute-force 7/7 on white 5×8; Fable/Sol
    // get the same visual isolation as defense in depth alongside the fact-sheet.
    idsBlock: o.gptHistory?.idsBlock ?? true,
  };
}

function emptyInfo(reason?: string): TransformInfo {
  return {
    compressed: false,
    reason,
    origChars: 0,
    compressedChars: 0,
    imageCount: 0,
    imageBytes: 0,
    staticChars: 0,
    dynamicChars: 0,
    dynamicBlockCount: 0,
    droppedChars: 0,
  };
}

/** Append IDS block so precision tokens get isolated pure-image rows (all models).
 *  IDS alone is not enough for Grok exact recall on live multi-seed; production
 *  still attaches factSheetText next to images (see slab/history below). */
function prepareImagedRenderText(text: string): string {
  return appendIdsBlock(text);
}

function maybeReflow(text: string, enabled: boolean): string {
  if (!enabled) return text;
  return reflow(text) ?? text;
}

function isTextPart(part: unknown): part is OpenAITextPart {
  return (
    typeof part === 'object'
    && part !== null
    && (part as { type?: unknown }).type === 'text'
    && typeof (part as { text?: unknown }).text === 'string'
  );
}

function contentText(content: OpenAIChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isTextPart)
    .map((p) => p.text)
    .join('\n\n');
}

function setTextContent(msg: OpenAIChatMessage, text: string): void {
  if (Array.isArray(msg.content)) {
    const kept = msg.content.filter((p) => !isTextPart(p));
    msg.content = [{ type: 'text', text }, ...kept];
  } else {
    msg.content = text;
  }
}

function firstUserText(req: OpenAIChatRequest): string {
  for (const msg of req.messages) {
    if (msg.role === 'user') return contentText(msg.content).slice(0, 4096);
  }
  return '';
}

function responsesContentText(content: ResponsesInputItem['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p): p is ResponsesInputTextPart =>
      typeof p === 'object'
      && p !== null
      && (p as { type?: unknown }).type === 'input_text'
      && typeof (p as { text?: unknown }).text === 'string')
    .map((p) => p.text)
    .join('\n\n');
}

function firstResponsesUserText(
  inputWasString: boolean,
  originalInput: string | undefined,
  inputItems: Array<ResponsesInputItem | Record<string, unknown>>,
): string {
  if (inputWasString) return (originalInput ?? '').slice(0, 4096);
  for (const item of inputItems) {
    if ((item as ResponsesInputItem).role !== 'user') continue;
    return responsesContentText((item as ResponsesInputItem).content).slice(0, 4096);
  }
  return '';
}

function isFunctionTool(tool: unknown): tool is OpenAIFunctionTool {
  return (
    typeof tool === 'object'
    && tool !== null
    && (tool as { type?: unknown }).type === 'function'
    && typeof (tool as { function?: unknown }).function === 'object'
    && (tool as { function?: unknown }).function !== null
  );
}

function isFlatFunctionTool(tool: unknown): tool is ResponsesFlatTool {
  return (
    typeof tool === 'object'
    && tool !== null
    && (tool as { type?: unknown }).type === 'function'
    && typeof (tool as { name?: unknown }).name === 'string'
  );
}

/** Full doc (prose + compact schema JSON) for one tool. On this path the docs are
 *  IMAGED, so carrying the schema here is compression, not duplication: the imaged
 *  copy keeps param docs readable while tools[] ships the stripped skeleton.
 *  (Contrast transform.ts renderToolDoc: text reference → prose only.) */
function renderToolDoc(tool: OpenAIFunctionTool): string {
  const f = tool.function;
  const parts = [`## Tool: ${f.name ?? '?'}`];
  if (typeof f.description === 'string' && f.description.length > 0) parts.push(f.description);
  if (f.parameters !== undefined) {
    parts.push('```json\n' + JSON.stringify(f.parameters) + '\n```');
  }
  return parts.join('\n');
}

function renderFlatToolDoc(tool: ResponsesFlatTool): string {
  const parts = [`## Tool: ${tool.name ?? '?'}`];
  if (typeof tool.description === 'string' && tool.description.length > 0) parts.push(tool.description);
  if (tool.parameters !== undefined) {
    parts.push('```json\n' + JSON.stringify(tool.parameters) + '\n```');
  }
  return parts.join('\n');
}

function rewriteToolsForGpt(tools: unknown[] | undefined): {
  tools: unknown[] | undefined;
  docs: string;
} {
  if (!Array.isArray(tools) || tools.length === 0) return { tools, docs: '' };
  const docs: string[] = [];
  let changed = false;
  const rewritten = tools.map((tool) => {
    if (!isFunctionTool(tool)) return tool;
    docs.push(renderToolDoc(tool));
    if (tool.function.parameters === undefined) return tool;
    changed = true;
    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: stripSchemaDescriptions(tool.function.parameters),
      },
    };
  });
  return { tools: changed ? rewritten : tools, docs: docs.join('\n\n') };
}

function rewriteFlatToolsForGpt(tools: unknown[] | undefined): {
  tools: unknown[] | undefined;
  docs: string;
} {
  if (!Array.isArray(tools) || tools.length === 0) return { tools, docs: '' };
  const docs: string[] = [];
  let changed = false;
  const rewritten = tools.map((tool) => {
    if (!isFlatFunctionTool(tool)) return tool;
    docs.push(renderFlatToolDoc(tool));
    if (tool.parameters === undefined) return tool;
    changed = true;
    return {
      ...tool,
      parameters: stripSchemaDescriptions(tool.parameters),
    };
  });
  return { tools: changed ? rewritten : tools, docs: docs.join('\n\n') };
}

function openAIImagePart(img: RenderedImage): OpenAIImagePart {
  return {
    type: 'image_url',
    image_url: {
      url: `data:image/png;base64,${bytesToBase64(img.png)}`,
      detail: 'original', // gpt-5.x: 'original' = 10k-patch/6000px budget; 'high' (2.5k/2048px) downscales dense text
    },
  };
}

/** Build a Responses API input_image part. */
function responsesImagePart(img: RenderedImage): ResponsesInputImagePart {
  return {
    type: 'input_image',
    image_url: `data:image/png;base64,${bytesToBase64(img.png)}`,
    detail: 'original', // see openAIImagePart: avoid 'high' downscale of dense text
  };
}

function countOutgoingTextChars(req: OpenAIChatRequest): number {
  let n = 0;
  for (const msg of req.messages) n += contentText(msg.content).length;
  if (Array.isArray(req.tools)) {
    for (const tool of req.tools) {
      if (!isFunctionTool(tool)) continue;
      const f = tool.function;
      if (typeof f.name === 'string') n += f.name.length;
      if (typeof f.description === 'string') n += f.description.length;
      if (f.parameters !== undefined) n += safeStringifyLen(f.parameters);
    }
  }
  return n;
}

/** Outgoing text-char denominator for the GPT Responses regression, mirroring
 *  countOutgoingTextChars for Chat: instructions + message-item text (string or
 *  input_text parts) + flat tool name/description/parameters. input_image base64
 *  is excluded on purpose — it is image cost, not text (responsesContentText
 *  already drops non-text parts). */
function countResponsesOutgoingTextChars(req: ResponsesRequest): number {
  let n = 0;
  if (typeof req.instructions === 'string') n += req.instructions.length;
  if (typeof req.input === 'string') {
    n += req.input.length;
  } else if (Array.isArray(req.input)) {
    for (const item of req.input) {
      n += responsesContentText((item as ResponsesInputItem).content).length;
    }
  }
  if (Array.isArray(req.tools)) {
    for (const tool of req.tools) {
      if (!isFlatFunctionTool(tool)) continue;
      if (typeof tool.name === 'string') n += tool.name.length;
      if (typeof tool.description === 'string') n += tool.description.length;
      if (tool.parameters !== undefined) n += safeStringifyLen(tool.parameters);
    }
  }
  return n;
}

function safeStringifyLen(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

function droppedCodepointsTop(droppedCodepoints: Map<number, number>): Record<string, number> | undefined {
  if (droppedCodepoints.size === 0) return undefined;
  const out: Record<string, number> = {};
  for (const [cp, count] of [...droppedCodepoints.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)) {
    out[`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`] = count;
  }
  return out;
}

/** Shared gate: image vs text token cost → profitability.
 *
 *  Text defaults to o200k (same baseline as savings math). Pass a non-default
 *  `charsPerToken` to force the length/cpt lever (tests use 1). Images bill full
 *  pages at maxHeight and the last page at residual height — charging every page
 *  as a full strip over-states cost and blocks profitable collapses. */
function evalOpenAIGate(
  model: string,
  renderedText: string,
  cols: number,
  charsPerToken: number,
): { imageTokens: number; textTokens: number; profitable: boolean } {
  const profile = resolveGptProfile(model);
  const style = profile.style;
  const cellW = renderCellWidth(style);
  const cellH = renderCellHeight(style);
  const stripW = 2 * PAD_X + cols * cellW;
  const maxLines = Math.max(1, Math.floor((profile.maxHeightPx - 2 * PAD_Y) / cellH));
  const maxCharsPerImage = Math.min(
    READABLE_CHARS_PER_IMAGE,
    Math.max(1, cols) * maxLines,
  );
  const linesPerImage = Math.min(
    maxLines,
    Math.max(1, Math.floor(maxCharsPerImage / Math.max(1, cols))),
  );
  const estImages = estimateImageCount(
    renderedText,
    cols,
    1,
    maxCharsPerImage,
    maxLines,
  );
  // Last page: residual soft-wrapped rows, not a full strip.
  const visualRows = countVisualRows(renderedText, cols);
  const lastPageLines = estImages <= 1
    ? Math.min(linesPerImage, Math.max(1, visualRows))
    : Math.min(
        linesPerImage,
        Math.max(1, visualRows - (estImages - 1) * linesPerImage),
      );
  const lastPageHeight = Math.min(
    profile.maxHeightPx,
    2 * PAD_Y + lastPageLines * cellH,
  );
  const fullPageTokens = visionTokensForModel(model, stripW, profile.maxHeightPx);
  const lastPageTokens = visionTokensForModel(model, stripW, lastPageHeight);
  const imageTokens =
    estImages <= 1
      ? lastPageTokens
      : (estImages - 1) * fullPageTokens + lastPageTokens;
  // Default: o200k. Non-default charsPerToken keeps the force/override lever.
  const textTokens =
    charsPerToken === DEFAULTS.charsPerToken
      ? Math.max(1, gptTextTokens(renderedText) || Math.ceil(renderedText.length / charsPerToken))
      : renderedText.length / Math.max(1e-6, charsPerToken);
  return { imageTokens, textTokens, profitable: imageTokens < textTokens };
}

/** Shared image-part accumulation from rendered PNGs. */
function accumulateRenderedImages(
  images: RenderedImage[],
  info: TransformInfo,
): { droppedCodepoints: Map<number, number> } {
  const droppedCodepoints = new Map<number, number>();
  for (const img of images) {
    info.imageBytes += img.png.length;
    info.imagePixels = (info.imagePixels ?? 0) + img.width * img.height;
    info.droppedChars = (info.droppedChars ?? 0) + img.droppedChars;
    for (const [cp, count] of img.droppedCodepoints) {
      droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + count);
    }
  }
  return { droppedCodepoints };
}

/** o200k_base token count — gpt-5 / gpt-4o / o-series share this encoding. The
 *  honest "as plain text" baseline for the content pxpipe imaged. Pure JS, no
 *  native build, runs in both Node and Workers. */
function gptTextTokens(text: string): number {
  if (!text) return 0;
  try {
    return o200kCountTokens(text);
  } catch {
    return 0;
  }
}

/** Vision-token cost of the rendered images, summed over their real dims —
 *  what GPT actually bills as input for the slab pxpipe imaged. */
function gptImageTokens(model: string, images: RenderedImage[]): number {
  let n = 0;
  for (const img of images) n += visionTokensForModel(model, img.width, img.height);
  return n;
}

/** Text-token value of what pxpipe replaced with images this request: the
 *  original system/developer text (now a pointer + image) plus the tool
 *  *description* tokens stripped from the native JSON (the verbose docs moved
 *  into the image). Tool *structure* stays in the JSON on both paths, so only
 *  the stripped delta counts. Compared against gptImageTokens for the saving. */
function gptBaselineImagedTokens(
  systemTexts: string[],
  originalTools: unknown[] | undefined,
  strippedTools: unknown[] | undefined,
): number {
  let n = 0;
  for (const t of systemTexts) n += gptTextTokens(t);
  const orig = Array.isArray(originalTools) && originalTools.length > 0
    ? gptTextTokens(JSON.stringify(originalTools))
    : 0;
  const stripped = Array.isArray(strippedTools) && strippedTools.length > 0
    ? gptTextTokens(JSON.stringify(strippedTools))
    : 0;
  return n + Math.max(0, orig - stripped);
}

/** Fold a history-collapse plan into TransformInfo: the history images cost
 *  vision tokens (added to imageTokens) and stand in for the o200k text tokens
 *  the collapsed transcript would have cost unproxied (added to baselineImagedTokens).
 *  openai-savings.ts then credits (baseline − image) × cache-weight with no
 *  further change. Also merges image bytes/pixels/dropped + collapse telemetry. */
function foldGptHistory(
  info: TransformInfo,
  model: string,
  plan: GptCollapsePlan,
): void {
  // A pin can split the collapse into before/after image groups — account for both.
  const allImages = [...plan.images, ...plan.imagesAfter];
  if (allImages.length === 0) {
    if (plan.reason) info.historyReason = plan.reason;
    if (plan.collapsedChars > 0) info.historyTextChars = plan.collapsedChars;
    return;
  }
  info.imageTokens = (info.imageTokens ?? 0) + gptImageTokens(model, allImages);
  // o200k token value of the collapsed transcript (what it cost as plain text).
  info.baselineImagedTokens = (info.baselineImagedTokens ?? 0) + gptTextTokens(plan.text);
  info.imageCount = (info.imageCount ?? 0) + allImages.length;
  for (const img of allImages) {
    info.imageBytes = (info.imageBytes ?? 0) + img.png.length;
    info.imagePixels = (info.imagePixels ?? 0) + img.width * img.height;
  }
  info.imagePngs = [...(info.imagePngs ?? []), ...allImages.map((i) => i.png)];
  info.imageDims = [
    ...(info.imageDims ?? []),
    ...allImages.map((i) => ({ width: i.width, height: i.height })),
  ];
  if (plan.droppedChars > 0) info.droppedChars = (info.droppedChars ?? 0) + plan.droppedChars;
  info.collapsedTurns = plan.collapsedTurns;
  info.collapsedChars = plan.collapsedChars;
  info.collapsedImages = allImages.length;
  info.historyTextChars = plan.collapsedChars;
  info.historyReason = 'collapsed';
  info.bucketChars = { ...(info.bucketChars ?? {}), history: plan.collapsedChars };
}

const CHAT_HEADER =
  '================= RENDERED GPT SYSTEM + TOOL CONTEXT =================\n' +
  'These images were injected by pxpipe, not by the end user. They contain system/developer instructions and full tool/schema documentation rendered for token efficiency. Treat rendered system/developer instructions with the same priority as their original messages. OCR carefully and treat the rendered content as authoritative. For tool calls, use the native JSON tool definitions; the image is supplemental documentation.' +
  '\n====================== BEGIN RENDERED CONTEXT ======================\n';

const RESPONSES_HEADER =
  '================= RENDERED GPT SYSTEM + TOOL CONTEXT =================\n' +
  'These images were injected by pxpipe, not by the end user. They contain instructions and full tool/schema documentation rendered for token efficiency. Treat rendered instructions with the same priority as the originals. OCR carefully and treat the rendered content as authoritative. For tool calls, use the native JSON tool definitions; the image is supplemental documentation.' +
  '\n====================== BEGIN RENDERED CONTEXT ======================\n';

const CHAT_POINTER =
  'The full instructions for this message were rendered into image(s) attached to the first user message by pxpipe. Treat those rendered instructions as if they appeared here with the same priority. Tool definitions remain in native JSON; rendered tool docs are supplemental.';

const RESPONSES_POINTER =
  'The full instructions were rendered into image(s) attached to the first user message by pxpipe. Treat them with the same priority. Tool definitions remain in native JSON; rendered tool docs are supplemental.';

export async function transformOpenAIChatCompletions(
  body: Uint8Array,
  opts: TransformOptions = {},
): Promise<{ body: Uint8Array; info: TransformInfo }> {
  const o = resolveOptions(opts);
  const info = emptyInfo();
  if (!o.compress) {
    info.reason = 'compress=false';
    return { body, info };
  }

  let req: OpenAIChatRequest;
  try {
    req = JSON.parse(new TextDecoder().decode(body));
  } catch (e) {
    info.reason = `parse_error: ${(e as Error).message}`;
    return { body, info };
  }
  if (!Array.isArray(req.messages)) {
    info.reason = 'parse_error: messages must be an array';
    return { body, info };
  }

  const firstUserIdx = req.messages.findIndex((m) => m.role === 'user');
  if (firstUserIdx < 0) {
    info.reason = 'no_user_message';
    return { body, info };
  }

  const authorityDocs: string[] = [];
  const systemTexts: string[] = [];
  for (const msg of req.messages) {
    if (msg.role !== 'system' && msg.role !== 'developer') continue;
    const text = contentText(msg.content);
    if (!text) continue;
    authorityDocs.push(`## ${String(msg.role).toUpperCase()} MESSAGE\n${text}`);
    systemTexts.push(text);
    info.staticChars += text.length;
  }

  const { tools: rewrittenTools, docs: toolDocs } = o.compressTools
    ? rewriteToolsForGpt(req.tools)
    : { tools: req.tools, docs: '' };

  const combinedRaw = [...authorityDocs, toolDocs].filter((s) => s.length > 0).join('\n\n');
  info.origChars = combinedRaw.length;
  if (!combinedRaw) {
    info.reason = 'no_static_context';
    return { body, info };
  }

  const firstUser = firstUserText(req);
  if (firstUser) info.firstUserSha8 = await sha8(firstUser);

  const combined = maybeReflow(compactSlabWhitespace(combinedRaw), o.reflow);
  if (combined.length < o.minCompressChars) {
    info.reason = `below_min_chars (${combined.length} < ${o.minCompressChars})`;
    return { body, info };
  }

  // Portrait strip only — multi-col would exceed 768px → downscale.
  const numCols = 1;
  const reflowNote = o.reflow
    ? ' The glyph ↵ (U+21B5) marks an original hard line break in content; treat it as a real newline.'
    : '';
  const header = CHAT_HEADER.replace('\n====', reflowNote + '\n====');
  const renderedText = prepareImagedRenderText(header + combined);
  const profile = resolveGptProfile(req.model);
  const maxCols = o.cols ?? profile.stripCols;
  const cols = Math.min(
    shrinkColsToContent(renderedText, maxCols, profile.style.markerScale, profile.style.font),
    profile.stripCols,
  );

  const gate = evalOpenAIGate(req.model, renderedText, cols, o.charsPerToken);
  info.gateEval = {
    site: 'slab',
    imageTokens: gate.imageTokens,
    textTokens: gate.textTokens,
    burnImageSide: 0,
    burnTextSide: 0,
    profitable: gate.profitable,
  };
  if (!gate.profitable) {
    info.reason = `not_profitable (slab=${combined.length} chars)`;
    info.passthroughReasons = { not_profitable: 1 };
    return { body, info };
  }

  const images = await renderTextToPngs(renderedText, cols, profile.style, profile.maxHeightPx);
  if (images.length === 0) {
    info.reason = 'render_empty';
    return { body, info };
  }

  const { droppedCodepoints } = accumulateRenderedImages(images, info);
  const topDropped = droppedCodepointsTop(droppedCodepoints);
  if (topDropped) info.droppedCodepointsTop = topDropped;

  const imageParts: OpenAIImagePart[] = images.map(openAIImagePart);
  info.imageCount = images.length;
  // GPT savings basis: vision tokens the images actually cost vs the text tokens
  // the same content would have cost unproxied. req.tools is still the original
  // (reassigned to the stripped set below). See src/core/openai-savings.ts.
  info.imageTokens = gptImageTokens(req.model, images);
  info.baselineImagedTokens = gptBaselineImagedTokens(systemTexts, req.tools, rewrittenTools);
  info.compressedChars = combinedRaw.length;
  info.bucketChars = { static_slab: combinedRaw.length };
  info.systemSha8 = await sha8(combined);
  info.firstImagePng = images[0]!.png;
  info.firstImageWidth = images[0]!.width;
  info.firstImageHeight = images[0]!.height;
  info.imagePngs = images.map((img) => img.png);
  info.imageDims = images.map((img) => ({ width: img.width, height: img.height }));

  // Verbatim fact-sheet: precision-critical tokens (paths, ids, versions, flags)
  // pulled from the pre-image text so exact strings survive OCR loss. Deterministic
  // → stays inside the cached prefix. See src/core/factsheet.ts.
  const slabFactSheet = factSheetText(combinedRaw);
  const slabUserMsg: OpenAIChatMessage = {
    role: 'user',
    content: [
      ...imageParts,
      ...(slabFactSheet ? [{ type: 'text', text: slabFactSheet } as OpenAIContentPart] : []),
      { type: 'text', text: '[End of rendered GPT system/tool context.]' },
    ],
  };
  req.messages = [
    ...req.messages.slice(0, firstUserIdx),
    slabUserMsg,
    ...req.messages.slice(firstUserIdx),
  ];

  for (const msg of req.messages) {
    if (msg.role !== 'system' && msg.role !== 'developer') continue;
    if (!contentText(msg.content)) continue;
    setTextContent(msg, CHAT_POINTER);
  }

  // Collapse the OLD conversation prefix into history image(s). The inserted slab
  // item carries static images and is protected; the original opening user prompt
  // remains collapsible history instead of looking like the live request.
  if (o.collapseHistory) {
    const turns = chatMessagesToTurns(req.messages);
    const profitable = (text: string, cols: number) =>
      evalOpenAIGate(req.model, text, cols, o.charsPerToken).profitable;
    const plan = await planGptCollapse(
      turns,
      firstUserIdx + 1,
      profitable,
      gptHistoryOpts(req.model, o, profile),
    );
    foldGptHistory(info, req.model, plan);
    const allImages = [...plan.images, ...plan.imagesAfter];
    if (allImages.length > 0) {
      // [intro][before-images][pinned request as TEXT][after-images][outro] —
      // chronological, with the live ask legible (not OCR-only) in its real slot.
      const content: OpenAIContentPart[] = [{ type: 'text', text: HISTORY_TRANSCRIPT_INTRO }];
      for (const img of plan.images) content.push(openAIImagePart(img));
      if (plan.pinText !== undefined) {
        content.push({ type: 'text', text: pinnedRequestBlock(plan.pinText) });
        for (const img of plan.imagesAfter) content.push(openAIImagePart(img));
      }
      // Verbatim fact-sheet for the imaged transcript (exact ids survive OCR loss).
      const histFactSheet = factSheetText(plan.text);
      if (histFactSheet) content.push({ type: 'text', text: histFactSheet });
      content.push({ type: 'text', text: HISTORY_TRANSCRIPT_OUTRO });
      const synthetic: OpenAIChatMessage = { role: 'user', content };
      const guard: OpenAIChatMessage = {
        role: 'developer',
        content: buildLiveRequestGuard(plan.pinText),
      };
      req.messages = [
        ...req.messages.slice(0, plan.start),
        synthetic,
        guard,
        ...req.messages.slice(plan.endExclusive),
      ];
      info.historyImageSha = await sha8(
        allImages.map((i) => bytesToBase64(i.png)).join(''),
      );
    }
  }

  if (rewrittenTools !== undefined) req.tools = rewrittenTools;
  info.outgoingTextChars = countOutgoingTextChars(req);
  info.compressed = true;
  return { body: new TextEncoder().encode(JSON.stringify(req)), info };
}

export async function transformOpenAIResponses(
  body: Uint8Array,
  opts: TransformOptions = {},
): Promise<{ body: Uint8Array; info: TransformInfo }> {
  const o = resolveOptions(opts);
  const info = emptyInfo();
  if (!o.compress) {
    info.reason = 'compress=false';
    return { body, info };
  }

  let req: ResponsesRequest;
  try {
    req = JSON.parse(new TextDecoder().decode(body));
  } catch (e) {
    info.reason = `parse_error: ${(e as Error).message}`;
    return { body, info };
  }

  // Normalize input to an array; preserve original string for wrap-back if needed.
  const inputWasString = typeof req.input === 'string';
  const originalInputString = inputWasString ? (req.input as string) : undefined;
  let inputItems: Array<ResponsesInputItem | Record<string, unknown>>;
  if (inputWasString) {
    inputItems = [];
  } else if (Array.isArray(req.input)) {
    inputItems = req.input as Array<ResponsesInputItem | Record<string, unknown>>;
  } else {
    info.reason = 'parse_error: input must be a string or array';
    return { body, info };
  }

  // Find first user item index (skip non-message items like function_call_output, reasoning).
  const firstUserIdx = inputItems.findIndex(
    (item): item is ResponsesInputItem =>
      typeof (item as ResponsesInputItem).role === 'string' &&
      (item as ResponsesInputItem).role === 'user',
  );
  if (!inputWasString && firstUserIdx < 0) {
    info.reason = 'no_user_message';
    return { body, info };
  }

  // Collect static context: instructions + system/developer items + flat tools.
  const authorityDocs: string[] = [];
  const systemTexts: string[] = [];
  if (typeof req.instructions === 'string' && req.instructions.length > 0) {
    authorityDocs.push(`## INSTRUCTIONS\n${req.instructions}`);
    systemTexts.push(req.instructions);
    info.staticChars += req.instructions.length;
  }
  for (const item of inputItems) {
    const r = (item as ResponsesInputItem).role;
    if (r !== 'system' && r !== 'developer') continue;
    const content = (item as ResponsesInputItem).content;
    // content may be a string OR an array of input_text parts (both are valid
    // Responses shapes for system/developer items) — read either form.
    const text = responsesContentText(content);
    if (!text) continue;
    authorityDocs.push(`## ${String(r).toUpperCase()} MESSAGE\n${text}`);
    systemTexts.push(text);
    info.staticChars += text.length;
  }

  const { tools: rewrittenTools, docs: toolDocs } = o.compressTools
    ? rewriteFlatToolsForGpt(req.tools)
    : { tools: req.tools, docs: '' };

  const combinedRaw = [...authorityDocs, toolDocs].filter((s) => s.length > 0).join('\n\n');
  info.origChars = combinedRaw.length;
  if (!combinedRaw) {
    info.reason = 'no_static_context';
    return { body, info };
  }

  const firstUser = firstResponsesUserText(inputWasString, originalInputString, inputItems);
  if (firstUser) info.firstUserSha8 = await sha8(firstUser);

  const combined = maybeReflow(compactSlabWhitespace(combinedRaw), o.reflow);
  if (combined.length < o.minCompressChars) {
    info.reason = `below_min_chars (${combined.length} < ${o.minCompressChars})`;
    return { body, info };
  }

  const reflowNote = o.reflow
    ? ' The glyph ↵ (U+21B5) marks an original hard line break in content; treat it as a real newline.'
    : '';
  const header = RESPONSES_HEADER.replace('\n====', reflowNote + '\n====');
  const renderedText = prepareImagedRenderText(header + combined);
  const profile = resolveGptProfile(req.model);
  const maxCols = o.cols ?? profile.stripCols;
  const cols = Math.min(
    shrinkColsToContent(renderedText, maxCols, profile.style.markerScale, profile.style.font),
    profile.stripCols,
  );

  const gate = evalOpenAIGate(req.model, renderedText, cols, o.charsPerToken);
  info.gateEval = {
    site: 'slab',
    imageTokens: gate.imageTokens,
    textTokens: gate.textTokens,
    burnImageSide: 0,
    burnTextSide: 0,
    profitable: gate.profitable,
  };
  if (!gate.profitable) {
    info.reason = `not_profitable (slab=${combined.length} chars)`;
    info.passthroughReasons = { not_profitable: 1 };
    return { body, info };
  }

  const images = await renderTextToPngs(renderedText, cols, profile.style, profile.maxHeightPx);
  if (images.length === 0) {
    info.reason = 'render_empty';
    return { body, info };
  }

  const { droppedCodepoints } = accumulateRenderedImages(images, info);
  const topDropped = droppedCodepointsTop(droppedCodepoints);
  if (topDropped) info.droppedCodepointsTop = topDropped;

  info.imageCount = images.length;
  // GPT savings basis (see src/core/openai-savings.ts). req.tools is still the
  // original here — reassigned to the stripped set below.
  info.imageTokens = gptImageTokens(req.model, images);
  info.baselineImagedTokens = gptBaselineImagedTokens(systemTexts, req.tools, rewrittenTools);
  info.compressedChars = combinedRaw.length;
  info.bucketChars = { static_slab: combinedRaw.length };
  info.systemSha8 = await sha8(combined);
  info.firstImagePng = images[0]!.png;
  info.firstImageWidth = images[0]!.width;
  info.firstImageHeight = images[0]!.height;
  info.imagePngs = images.map((img) => img.png);
  info.imageDims = images.map((img) => ({ width: img.width, height: img.height }));

  const imagePartsResp: ResponsesInputImagePart[] = images.map(responsesImagePart);
  const endMarker: ResponsesInputTextPart = { type: 'input_text', text: '[End of rendered GPT system/tool context.]' };
  // Verbatim fact-sheet (see src/core/factsheet.ts): exact tokens that survive OCR loss.
  const slabFactSheet = factSheetText(combinedRaw);
  const slabFactSheetPart: ResponsesInputTextPart[] = slabFactSheet
    ? [{ type: 'input_text', text: slabFactSheet }]
    : [];

  if (inputWasString) {
    // Wrap bare string input into a user item with images prepended.
    req.input = [{
      role: 'user',
      content: [
        ...imagePartsResp,
        ...slabFactSheetPart,
        endMarker,
        { type: 'input_text', text: originalInputString! },
      ],
    }];
  } else {
    // Insert a dedicated static-slab item. Do not attach it to the opening real
    // user prompt: that prompt is old history on long stateless Responses calls,
    // and protecting it made stale first-turn requests look live.
    const slabUserItem: ResponsesInputItem = {
      role: 'user',
      content: [...imagePartsResp, ...slabFactSheetPart, endMarker],
    };
    inputItems = [
      ...inputItems.slice(0, firstUserIdx),
      slabUserItem,
      ...inputItems.slice(firstUserIdx),
    ];
    req.input = inputItems;
  }

  // Replace instructions with pointer.
  if (typeof req.instructions === 'string' && req.instructions.length > 0) {
    req.instructions = RESPONSES_POINTER;
  }

  // Replace system/developer input items with a pointer. Mirror the collection
  // gate above for BOTH content shapes: a string becomes the pointer string; an
  // input_text part array keeps its array shape with a single pointer part, so a
  // request the caller sent as parts is not silently reshaped into a string.
  if (!inputWasString) {
    for (const item of inputItems) {
      const it = item as ResponsesInputItem;
      if (it.role !== 'system' && it.role !== 'developer') continue;
      const content = it.content;
      if (typeof content === 'string') {
        if (content.length > 0) it.content = RESPONSES_POINTER;
      } else if (Array.isArray(content) && responsesContentText(content).length > 0) {
        it.content = [{ type: 'input_text', text: RESPONSES_POINTER }];
      }
    }
  }

  // Collapse the OLD conversation prefix into history image(s). The inserted slab
  // item is protected; the transcript OpenCode resends every turn is the real cost.
  // Skip for bare-string input (single message, nothing to collapse).
  if (o.collapseHistory && !inputWasString) {
    const turns = responsesItemsToTurns(inputItems);
    const profitable = (text: string, cols: number) =>
      evalOpenAIGate(req.model, text, cols, o.charsPerToken).profitable;
    const plan = await planGptCollapse(
      turns,
      firstUserIdx + 1,
      profitable,
      gptHistoryOpts(req.model, o, profile),
    );
    foldGptHistory(info, req.model, plan);
    const allImages = [...plan.images, ...plan.imagesAfter];
    if (allImages.length > 0) {
      // [intro][before-images][pinned request as TEXT][after-images][outro] —
      // chronological, with the live ask legible (not OCR-only) in its real slot.
      const content: ResponsesContentPart[] = [
        { type: 'input_text', text: HISTORY_TRANSCRIPT_INTRO },
      ];
      for (const img of plan.images) content.push(responsesImagePart(img));
      if (plan.pinText !== undefined) {
        content.push({ type: 'input_text', text: pinnedRequestBlock(plan.pinText) });
        for (const img of plan.imagesAfter) content.push(responsesImagePart(img));
      }
      // Verbatim fact-sheet for the imaged transcript (exact ids survive OCR loss).
      const histFactSheet = factSheetText(plan.text);
      if (histFactSheet) content.push({ type: 'input_text', text: histFactSheet });
      content.push({ type: 'input_text', text: HISTORY_TRANSCRIPT_OUTRO });
      const synthetic: ResponsesInputItem = { role: 'user', content };
      const guard: ResponsesInputItem = {
        role: 'developer',
        content: buildLiveRequestGuard(plan.pinText),
      };
      req.input = [
        ...inputItems.slice(0, plan.start),
        synthetic,
        guard,
        ...inputItems.slice(plan.endExclusive),
      ];
      info.historyImageSha = await sha8(
        allImages.map((i) => bytesToBase64(i.png)).join(''),
      );
    }
  }

  if (rewrittenTools !== undefined) req.tools = rewrittenTools;

  // Regression denominator, same as the Chat path — Responses was the only
  // transform that never recorded it.
  info.outgoingTextChars = countResponsesOutgoingTextChars(req);
  info.compressed = true;
  return { body: new TextEncoder().encode(JSON.stringify(req)), info };
}
