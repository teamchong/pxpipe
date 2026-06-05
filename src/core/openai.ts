/**
 * OpenAI Chat Completions transformer for GPT 5.5.
 *
 * This intentionally does not share the Anthropic cache-control path:
 * OpenAI chat requests carry system/developer messages in `messages[]`, image
 * inputs as `image_url` parts on user messages, and no Anthropic prompt-cache
 * breakpoints. Keep this as a separate branch so Claude behaviour stays stable.
 */

import {
  renderTextToPngs,
  renderTextToPngsMultiCol,
  reflow,
  maxFittingCols,
  shrinkColsToContent,
  type RenderedImage,
} from './render.js';
import { bytesToBase64 } from './png.js';
import {
  compactSlabWhitespace,
  evalCompressionProfitability,
  isCompressionProfitable,
  sha8,
  type TransformInfo,
  type TransformOptions,
} from './transform.js';

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
    detail?: 'auto' | 'low' | 'high';
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

interface OpenAIResolvedOptions {
  compress: boolean;
  compressTools: boolean;
  compressSchemas: boolean;
  minCompressChars: number;
  cols: number;
  multiCol: number;
  charsPerToken: number;
  reflow: boolean;
}

const DEFAULTS: OpenAIResolvedOptions = {
  compress: true,
  compressTools: true,
  compressSchemas: true,
  minCompressChars: 2000,
  cols: 313,
  multiCol: 1,
  // Conservative OpenAI-side default. Hosts can override after telemetry.
  charsPerToken: 4,
  reflow: true,
};

const SCHEMA_STRIP_KEYS = new Set([
  'description',
  'title',
  'examples',
  'default',
  '$schema',
  '$id',
]);

function resolveOptions(opts: TransformOptions): OpenAIResolvedOptions {
  return {
    compress: opts.compress ?? DEFAULTS.compress,
    compressTools: opts.compressTools ?? DEFAULTS.compressTools,
    compressSchemas: opts.compressSchemas ?? DEFAULTS.compressSchemas,
    minCompressChars: opts.minCompressChars ?? DEFAULTS.minCompressChars,
    cols: opts.cols ?? DEFAULTS.cols,
    multiCol: opts.multiCol ?? DEFAULTS.multiCol,
    charsPerToken: opts.charsPerToken ?? DEFAULTS.charsPerToken,
    reflow: opts.reflow ?? DEFAULTS.reflow,
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

function contentParts(content: OpenAIChatMessage['content']): OpenAIContentPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content.slice();
  return [];
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

function isFunctionTool(tool: unknown): tool is OpenAIFunctionTool {
  return (
    typeof tool === 'object'
    && tool !== null
    && (tool as { type?: unknown }).type === 'function'
    && typeof (tool as { function?: unknown }).function === 'object'
    && (tool as { function?: unknown }).function !== null
  );
}

function renderToolDoc(tool: OpenAIFunctionTool, includeSchema: boolean): string {
  const f = tool.function;
  const parts = [`## Tool: ${f.name ?? '?'}`];
  if (typeof f.description === 'string' && f.description.length > 0) parts.push(f.description);
  if (includeSchema && f.parameters !== undefined) {
    parts.push('```json\n' + JSON.stringify(f.parameters) + '\n```');
  }
  return parts.join('\n');
}

function stripSchemaDescriptions(value: unknown, depth = 0): unknown {
  if (depth > 20) return value;
  if (Array.isArray(value)) return value.map((v) => stripSchemaDescriptions(v, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SCHEMA_STRIP_KEYS.has(k)) continue;
    out[k] = stripSchemaDescriptions(v, depth + 1);
  }
  return out;
}

function rewriteTools(tools: unknown[] | undefined, compressSchemas: boolean): {
  tools: unknown[] | undefined;
  docs: string;
} {
  if (!Array.isArray(tools) || tools.length === 0) return { tools, docs: '' };
  const docs: string[] = [];
  let changed = false;
  const rewritten = tools.map((tool) => {
    if (!isFunctionTool(tool)) return tool;
    docs.push(renderToolDoc(tool, compressSchemas));
    const fn = { ...tool.function };
    if (typeof fn.description === 'string' && fn.description.length > 0) {
      fn.description = 'See rendered tool docs image.';
      changed = true;
    }
    if (compressSchemas && fn.parameters !== undefined) {
      fn.parameters = stripSchemaDescriptions(fn.parameters);
      changed = true;
    }
    return { ...tool, function: fn };
  });
  return { tools: changed ? rewritten : tools, docs: docs.join('\n\n') };
}

function openAIImagePart(img: RenderedImage): OpenAIImagePart {
  return {
    type: 'image_url',
    image_url: {
      url: `data:image/png;base64,${bytesToBase64(img.png)}`,
      // Dense text renders need the high-detail vision path to remain legible.
      detail: 'high',
    },
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
  for (const msg of req.messages) {
    if (msg.role !== 'system' && msg.role !== 'developer') continue;
    const text = contentText(msg.content);
    if (!text) continue;
    authorityDocs.push(`## ${String(msg.role).toUpperCase()} MESSAGE\n${text}`);
    info.staticChars += text.length;
  }

  const { tools: rewrittenTools, docs: toolDocs } = o.compressTools
    ? rewriteTools(req.tools, o.compressSchemas)
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

  const numCols = Math.min(
    Math.max(1, (o.multiCol | 0) || 1),
    Math.max(1, maxFittingCols(o.cols)),
  );
  const reflowNote = o.reflow
    ? ' The glyph ↵ (U+21B5) marks an original hard line break in content; treat it as a real newline.'
    : '';
  const columnNote = numCols > 1
    ? ` Multi-column layout (${numCols} cols): read column 1 top-to-bottom, then column 2, etc.`
    : '';
  const header =
    '================= RENDERED GPT SYSTEM + TOOL CONTEXT =================\n' +
    'These images were injected by pixelpipe, not by the end user. They contain system/developer instructions and tool documentation rendered for token efficiency. Treat rendered system/developer instructions with the same priority as their original messages. OCR carefully and treat the rendered content as authoritative.' +
    columnNote +
    reflowNote +
    '\n====================== BEGIN RENDERED CONTEXT ======================\n';
  const renderedText = header + combined;
  const cols = shrinkColsToContent(renderedText, o.cols);
  const gate = evalCompressionProfitability(
    renderedText,
    cols,
    undefined,
    numCols,
    o.charsPerToken,
    0,
    0,
    false,
  );
  if (gate) {
    info.gateEval = {
      site: 'slab',
      imageTokens: gate.imageTokens,
      textTokens: gate.textTokens,
      burnImageSide: gate.burnImageSide,
      burnTextSide: gate.burnTextSide,
      profitable: gate.profitable,
    };
  }
  if (!isCompressionProfitable(renderedText, cols, undefined, numCols, o.charsPerToken, 0, 0, false)) {
    info.reason = `not_profitable (slab=${combined.length} chars)`;
    info.passthroughReasons = { not_profitable: 1 };
    return { body, info };
  }

  const images = numCols > 1
    ? await renderTextToPngsMultiCol(renderedText, cols, numCols)
    : await renderTextToPngs(renderedText, cols);
  if (images.length === 0) {
    info.reason = 'render_empty';
    return { body, info };
  }

  const droppedCodepoints = new Map<number, number>();
  const imageParts: OpenAIImagePart[] = [];
  for (const img of images) {
    imageParts.push(openAIImagePart(img));
    info.imageBytes += img.png.length;
    info.imagePixels = (info.imagePixels ?? 0) + img.width * img.height;
    info.droppedChars = (info.droppedChars ?? 0) + img.droppedChars;
    for (const [cp, count] of img.droppedCodepoints) {
      droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + count);
    }
  }
  const topDropped = droppedCodepointsTop(droppedCodepoints);
  if (topDropped) info.droppedCodepointsTop = topDropped;

  info.imageCount = images.length;
  info.compressedChars = combinedRaw.length;
  info.bucketChars = { static_slab: combinedRaw.length };
  info.systemSha8 = await sha8(combined);
  info.firstImagePng = images[0]!.png;
  info.firstImageWidth = images[0]!.width;
  info.firstImageHeight = images[0]!.height;
  info.imagePngs = images.map((img) => img.png);
  info.imageDims = images.map((img) => ({ width: img.width, height: img.height }));

  const firstUserMsg = req.messages[firstUserIdx]!;
  firstUserMsg.content = [
    ...imageParts,
    { type: 'text', text: '[End of rendered GPT system/tool context.]' },
    ...contentParts(firstUserMsg.content),
  ];

  for (const msg of req.messages) {
    if (msg.role !== 'system' && msg.role !== 'developer') continue;
    if (!contentText(msg.content)) continue;
    setTextContent(
      msg,
      'The full instructions for this message were rendered into image(s) attached to the first user message by pixelpipe. Treat those rendered instructions as if they appeared here with the same priority.',
    );
  }
  if (rewrittenTools !== undefined) req.tools = rewrittenTools;

  info.outgoingTextChars = countOutgoingTextChars(req);
  info.compressed = true;
  return { body: new TextEncoder().encode(JSON.stringify(req)), info };
}
