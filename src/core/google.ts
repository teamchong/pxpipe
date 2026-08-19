/**
 * Google AI Studio / Gemini API request transformer and usage extractor.
 * Intercepts /google-ai-studio/v1beta/models/*:generateContent and :streamGenerateContent
 * requests, extracts static system instructions, renders them to PNG image parts, and
 * passes transformed payloads to Google AI Studio.
 */

import { countTokens as o200kCountTokens } from 'gpt-tokenizer/encoding/o200k_base';
import {
  neutralizeSentinel,
  reflow,
  renderTextToPngs,
  shrinkColsToContent,
  type RenderedImage,
} from './render.js';
import { geminiVisionTokens, hasGeminiMeasuredProfile, resolveGeminiProfile } from './gemini-model-profiles.js';
import { bytesToBase64 } from './png.js';
import { classifyContent, compactSlabWhitespace, type TransformInfo } from './transform.js';
import {
  prepareImagedRenderText,
  droppedCodepointsTop,
  schemaAnnotationLines,
  CHAT_HEADER,
  HISTORY_TRANSCRIPT_INTRO,
  HISTORY_TRANSCRIPT_OUTRO,
  COMPACT_HISTORY_TRANSCRIPT_INTRO,
  COMPACT_HISTORY_TRANSCRIPT_OUTRO,
} from './openai.js';
import { factSheetText } from './factsheet.js';
import { stripSchemaDescriptions } from './schema-strip.js';

export interface GooglePart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  functionCall?: {
    name?: string;
    args?: unknown;
    [key: string]: unknown;
  };
  functionResponse?: {
    name?: string;
    response?: unknown;
    parts?: GooglePart[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface GoogleContent {
  role?: 'user' | 'model' | string;
  parts?: GooglePart[];
  [key: string]: unknown;
}

export interface GoogleGenerateContentRequest {
  contents?: GoogleContent[];
  systemInstruction?: {
    role?: string;
    parts?: GooglePart[];
    [key: string]: unknown;
  };
  tools?: unknown[];
  [key: string]: unknown;
}

const GOOGLE_ROUTE = /^\/google-ai-studio\/(?:v1|v1beta)\/models\/([^/:]+):(generateContent|streamGenerateContent)$/;

export function parseGoogleModelFromPath(pathname: string): string | null {
  const match = GOOGLE_ROUTE.exec(pathname);
  return match && match[1] ? match[1] : null;
}

const SYSTEM_POINTER =
  'The original system instruction is rendered in the image at the start of the first user turn. ' +
  'Treat that image as this system instruction, with the same authority and priority.';

const TOOL_POINTER_PREFIX = 'Full parameter docs: see "## Tool: ';

interface GoogleFunctionDeclaration extends Record<string, unknown> {
  name?: string;
  description?: string;
  parameters?: unknown;
}

interface GoogleToolRewrite {
  tools: unknown[] | undefined;
  docs: string;
  originalTokens: number;
  rewrittenTokens: number;
}

interface GoogleHistoryUnit {
  index: number;
  text: string;
  baselineTokens: number;
  source: GoogleContent;
  opens: string[];
  closes: string[];
  opaque: boolean;
}

interface GoogleHistoryPlan {
  start: number;
  endExclusive: number;
  images: RenderedImage[];
  imageSources: string[];
  text: string;
  factSheet: string;
  baselineTokens: number;
  nativeTokens: number;
  collapsedTurns: number;
  droppedChars: number;
  droppedCodepoints: Map<number, number>;
}

interface GoogleToolResultPlan {
  contents: GoogleContent[];
  images: RenderedImage[];
  imageSources: string[];
  baselineTokens: number;
  nativeTokens: number;
  compressedChars: number;
  bucketChars: Partial<Record<'tool_result_json' | 'tool_result_log' | 'tool_result_prose', number>>;
  droppedChars: number;
  droppedCodepoints: Map<number, number>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** Gemini 3+ replay token. Present on the part, thought block, or nested on functionCall. */
function readGeminiThoughtSignature(part: unknown): string | undefined {
  const rec = record(part);
  if (!rec) return undefined;
  const direct = readString(rec.thoughtSignature) ?? readString(rec.thought_signature) ?? readString(rec.signature);
  if (direct) return direct;
  const functionCall = record(rec.functionCall);
  if (functionCall) {
    const fcSig = readString(functionCall.thoughtSignature) ?? readString(functionCall.thought_signature) ?? readString(functionCall.signature);
    if (fcSig) return fcSig;
  }
  return undefined;
}

function isGeminiFunctionCallPart(part: unknown): boolean {
  return record(part)?.functionCall !== undefined;
}

function cleanGeminiFunctionCall(fc: unknown): { cleaned: Record<string, unknown> | undefined; changed: boolean } {
  const rec = record(fc);
  if (!rec) return { cleaned: undefined, changed: false };
  // FunctionCall in Gemini protobuf only permits `name`, `args`, and `id`.
  // Discard any thought_signature / thoughtSignature mistakenly attached to functionCall itself.
  if ('thoughtSignature' in rec || 'thought_signature' in rec || 'signature' in rec) {
    const { thoughtSignature, thought_signature, signature, ...rest } = rec;
    return { cleaned: rest, changed: true };
  }
  return { cleaned: rec, changed: false };
}

/** Copy a turn or session's existing signature onto unsigned sibling functionCall parts. Does not invent one. */
function stampGeminiThoughtSignatures(contents: GoogleContent[]): GoogleContent[] {
  let changed = false;
  let lastKnownDonor: string | undefined;

  const next = contents.map((content) => {
    if (!Array.isArray(content.parts) || content.parts.length === 0) return content;
    // Find donor from ANY part in this turn (thought part, text part, functionCall part)
    const turnDonor = content.parts
      .map(readGeminiThoughtSignature)
      .find((sig) => sig !== undefined);

    const donor = turnDonor ?? lastKnownDonor;
    if (turnDonor) {
      lastKnownDonor = turnDonor;
    }
    if (!donor) return content;

    let partsChanged = false;
    const parts = content.parts.map((part) => {
      if (!isGeminiFunctionCallPart(part)) return part;
      const rec = record(part) ?? {};
      const { cleaned: fc, changed: fcChanged } = cleanGeminiFunctionCall(rec.functionCall);
      const existing = readGeminiThoughtSignature(part);
      const sigToUse = existing ?? donor;
      if (!sigToUse) {
        if (fcChanged) {
          partsChanged = true;
          return { ...rec, functionCall: fc };
        }
        return part;
      }
      const directSig = readString(rec.thoughtSignature) ?? readString(rec.thought_signature);
      if (directSig === sigToUse && !fcChanged) {
        return part;
      }
      partsChanged = true;
      return {
        ...rec,
        thoughtSignature: sigToUse,
        ...(fc ? { functionCall: fc } : {}),
      };
    });
    if (!partsChanged) return content;
    changed = true;
    return { ...content, parts };
  });
  return changed ? next : contents;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value ?? '');
  }
}

function googleTextTokens(text: string): number {
  return text ? Math.ceil(text.length / 3.5) : 0;
}

function rewriteGoogleTools(tools: unknown[] | undefined): GoogleToolRewrite {
  if (!Array.isArray(tools) || tools.length === 0) {
    return { tools, docs: '', originalTokens: 0, rewrittenTokens: 0 };
  }
  const originalTokens = googleTextTokens(safeJson(tools));
  const docs: string[] = [];
  let changed = false;
  const rewritten = tools.map((rawTool) => {
    const tool = record(rawTool);
    if (!tool || !Array.isArray(tool.functionDeclarations)) return rawTool;
    let toolChanged = false;
    const declarations = tool.functionDeclarations.map((rawDeclaration) => {
      const declaration = record(rawDeclaration) as GoogleFunctionDeclaration | null;
      if (!declaration || typeof declaration.name !== 'string') return rawDeclaration;
      const annotations = schemaAnnotationLines(declaration.parameters);
      const description = typeof declaration.description === 'string'
        ? declaration.description
        : '';
      if (!description && annotations.length === 0) return rawDeclaration;
      docs.push([
        `## Tool: ${declaration.name}`,
        description,
        declaration.parameters === undefined
          ? ''
          : `\`\`\`json\n${safeJson(declaration.parameters)}\n\`\`\``,
      ].filter(Boolean).join('\n'));
      toolChanged = true;
      return {
        ...declaration,
        description: `${TOOL_POINTER_PREFIX}${declaration.name}" in the rendered context image.`,
        parameters: stripSchemaDescriptions(declaration.parameters),
      };
    });
    if (!toolChanged) return rawTool;
    changed = true;
    return { ...tool, functionDeclarations: declarations };
  });
  const toolsOut = changed ? rewritten : tools;
  return {
    tools: toolsOut,
    docs: docs.join('\n\n'),
    originalTokens,
    rewrittenTokens: googleTextTokens(safeJson(toolsOut)),
  };
}

function googlePartText(part: GooglePart): string {
  if (typeof part.text === 'string') return part.text;
  if (part.functionCall) {
    return `[tool_use ${part.functionCall.name ?? 'tool'}]\n${safeJson(part.functionCall.args ?? {})}`;
  }
  if (part.functionResponse) {
    return `[tool_result ${part.functionResponse.name ?? 'tool'}]\n${safeJson(part.functionResponse.response ?? {})}`;
  }
  return '';
}

function googleHistoryUnit(content: GoogleContent, index: number): GoogleHistoryUnit {
  if (!Array.isArray(content.parts)) {
    return { index, text: '', baselineTokens: 0, source: content, opens: [], closes: [], opaque: true };
  }
  const text: string[] = [];
  const opens: string[] = [];
  const closes: string[] = [];
  let opaque = false;
  for (const rawPart of content.parts) {
    const part = record(rawPart) as GooglePart | null;
    if (!part) { opaque = true; continue; }
    if (typeof part.text === 'string') {
      text.push(part.text);
      continue;
    }
    if (part.functionCall) {
      const name = typeof part.functionCall.name === 'string' ? part.functionCall.name : 'tool';
      opens.push(name);
      text.push(googlePartText(part));
      continue;
    }
    if (part.functionResponse) {
      const name = typeof part.functionResponse.name === 'string' ? part.functionResponse.name : 'tool';
      closes.push(name);
      text.push(googlePartText(part));
      continue;
    }
    // Thought signatures, images, server tool state, and unknown parts must stay native.
    opaque = true;
  }
  const role = content.role === 'model' ? 'assistant' : 'user';
  const body = text.filter(Boolean).join('\n\n');
  const transcript = body ? `<${role} t="${index}">\n${body}\n</${role}>` : '';
  return {
    index,
    text: transcript,
    baselineTokens: googleTextTokens(body),
    source: content,
    opens,
    closes,
    opaque,
  };
}

async function compressGoogleToolResults(
  contents: GoogleContent[],
  modelName: string,
  options: {
    compressToolResults?: boolean;
    minToolResultChars?: number;
    maxImagesPerToolResult?: number;
    reflow?: boolean;
  },
): Promise<GoogleToolResultPlan> {
  const empty = (): GoogleToolResultPlan => ({
    contents,
    images: [],
    imageSources: [],
    baselineTokens: 0,
    nativeTokens: 0,
    compressedChars: 0,
    bucketChars: {},
    droppedChars: 0,
    droppedCodepoints: new Map(),
  });
  if (options.compressToolResults === false) return empty();

  const profile = resolveGeminiProfile(modelName);
  const minChars = Math.max(0, options.minToolResultChars ?? 4500);
  const perResultCap = Math.max(1, options.maxImagesPerToolResult ?? 10);
  const allImages: RenderedImage[] = [];
  const imageSources: string[] = [];
  const bucketChars: GoogleToolResultPlan['bucketChars'] = {};
  const droppedCodepoints = new Map<number, number>();
  let baselineTokens = 0;
  let nativeTokens = 0;
  let compressedChars = 0;
  let droppedChars = 0;
  let changed = false;

  const rewrittenContents: GoogleContent[] = [];
  for (const content of contents) {
    if (!Array.isArray(content.parts)) {
      rewrittenContents.push(content);
      continue;
    }
    let contentChanged = false;
    const rewrittenParts: GooglePart[] = [];
    for (const rawPart of content.parts) {
      const part = record(rawPart) as GooglePart | null;
      const response = part?.functionResponse;
      const responseBody = record(response?.response);
      const raw = typeof responseBody?.content === 'string' ? responseBody.content : '';
      if (
        !part || !response || !responseBody || raw.length < minChars ||
        (Array.isArray(response.parts) && response.parts.length > 0)
      ) {
        rewrittenParts.push(rawPart);
        continue;
      }

      const name = typeof response.name === 'string' ? response.name : 'tool';
      const compact = compactSlabWhitespace(raw);
      const safe = neutralizeSentinel(compact);
      const packed = options.reflow !== false ? reflow(safe) ?? safe : safe;
      const rendered = prepareImagedRenderText(
        `================= RENDERED TOOL RESULT: ${name} =================\n` +
        'pxpipe rendered this completed tool result into image pages to reduce input tokens. Read it as the exact result returned by the tool.\n' +
        packed,
        false,
      );
      const images = await renderTextToPngs(
        rendered,
        profile.stripCols,
        profile.style,
        profile.maxHeightPx,
      );
      if (images.length === 0 || images.length > perResultCap) {
        rewrittenParts.push(rawPart);
        continue;
      }
      const imageTokens = images.reduce(
        (sum, image) => sum + geminiVisionTokens(modelName, image.width, image.height),
        0,
      );
      const sheet = factSheetText(raw, profile.factSheetFormat);
      const pointer = `The completed ${name} tool result is rendered in the attached image part(s).` +
        (sheet ? `\n${sheet}` : '');
      const textTokens = googleTextTokens(raw);
      const pointerTokens = googleTextTokens(pointer);
      if (imageTokens + pointerTokens >= textTokens) {
        rewrittenParts.push(rawPart);
        continue;
      }

      rewrittenParts.push({
        ...part,
        functionResponse: {
          ...response,
          response: { ...responseBody, content: pointer },
          parts: images.map(imagePart),
        },
      });
      contentChanged = true;
      changed = true;
      allImages.push(...images);
      imageSources.push(...images.map(() => raw));
      baselineTokens += textTokens;
      nativeTokens += pointerTokens;
      compressedChars += raw.length;
      const shape = classifyContent(compact);
      const bucket = shape === 'structured'
        ? 'tool_result_json'
        : shape === 'log' ? 'tool_result_log' : 'tool_result_prose';
      bucketChars[bucket] = (bucketChars[bucket] ?? 0) + raw.length;
      for (const image of images) {
        droppedChars += image.droppedChars;
        for (const [codepoint, count] of image.droppedCodepoints) {
          droppedCodepoints.set(codepoint, (droppedCodepoints.get(codepoint) ?? 0) + count);
        }
      }
    }
    rewrittenContents.push(contentChanged ? { ...content, parts: rewrittenParts } : content);
  }

  return {
    contents: changed ? rewrittenContents : contents,
    images: allImages,
    imageSources,
    baselineTokens,
    nativeTokens,
    compressedChars,
    bucketChars,
    droppedChars,
    droppedCodepoints,
  };
}

function googleClosedBoundary(
  units: GoogleHistoryUnit[],
  fromInclusive: number,
  cutoffExclusive: number,
): number {
  const open = new Map<string, number>();
  let lastClosed = fromInclusive - 1;
  for (let i = fromInclusive; i < Math.min(cutoffExclusive, units.length); i++) {
    const unit = units[i]!;
    if (unit.opaque) break;
    for (const name of unit.opens) open.set(name, (open.get(name) ?? 0) + 1);
    for (const name of unit.closes) {
      const count = open.get(name) ?? 0;
      // An output whose call sits before the selected range is a protocol barrier.
      if (count === 0) return lastClosed;
      if (count === 1) open.delete(name);
      else open.set(name, count - 1);
    }
    if (open.size === 0) lastClosed = i;
  }
  return lastClosed;
}

async function planGoogleHistory(
  contents: GoogleContent[],
  modelName: string,
  reflowEnabled: boolean,
): Promise<GoogleHistoryPlan | null> {
  const profile = resolveGeminiProfile(modelName);
  const units = contents.map(googleHistoryUnit);
  const cutoff = Math.max(0, units.length - profile.history.keepTail);
  // If there's only 1 user turn in the entire session (autonomous single-prompt agent),
  // keep turn 0 native so the prompt stays visible outside the image. In multi-turn
  // chat, the active user turn is already in the kept tail, so collapse from turn 0.
  const userTurns: number[] = [];
  for (let i = 0; i < contents.length; i++) {
    const c = contents[i];
    if (c?.role === 'user' && Array.isArray(c.parts) && c.parts.some((p) => typeof p.text === 'string' && p.text.trim())) {
      userTurns.push(i);
    }
  }
  const start = userTurns.length === 1 && userTurns[0] === 0 ? 1 : 0;
  const boundary = googleClosedBoundary(units, start, cutoff);
  if (boundary < start || boundary + 1 - start < 4) return null;
  const selected = units.slice(start, boundary + 1);
  const eligibleTokens = selected.reduce((sum, unit) => sum + unit.baselineTokens, 0);
  if (eligibleTokens < profile.history.minCollapseTokens) return null;

  // Admit only complete turns whose rendered pages fit. Rendering the entire history and
  // slicing its PNGs would remove an unrendered suffix from the native request.
  const admitted: GoogleHistoryUnit[] = [];
  const images: RenderedImage[] = [];
  const imageSources: string[] = [];
  const chunkSize = 8;
  let cursor = 0;
  while (cursor < selected.length && images.length < profile.history.maxImages) {
    const remaining = profile.history.maxImages - images.length;
    let candidateEnd = googleClosedBoundary(
      selected,
      cursor,
      Math.min(selected.length, cursor + chunkSize),
    ) + 1;
    let accepted = false;
    while (candidateEnd > cursor) {
      const chunk = selected.slice(cursor, candidateEnd);
      const chunkText = chunk.map((unit) => unit.text).filter(Boolean).join('\n\n');
      const safe = neutralizeSentinel(chunkText);
      const renderedText = reflowEnabled ? reflow(safe) ?? safe : safe;
      const chunkImages = await renderTextToPngs(
        renderedText,
        profile.stripCols,
        profile.style,
        profile.maxHeightPx,
      );
      if (chunkImages.length > 0 && chunkImages.length <= remaining) {
        admitted.push(...chunk);
        images.push(...chunkImages);
        imageSources.push(...chunkImages.map(() => chunkText));
        cursor = candidateEnd;
        accepted = true;
        break;
      }
      candidateEnd = googleClosedBoundary(selected, cursor, candidateEnd - 1) + 1;
    }
    if (!accepted) break;
  }

  if (admitted.length < 4 || images.length === 0) return null;
  const text = admitted.map((unit) => unit.text).filter(Boolean).join('\n\n');
  const baselineTokens = admitted.reduce((sum, unit) => sum + unit.baselineTokens, 0);
  if (!text || baselineTokens < profile.history.minCollapseTokens) return null;
  const imageTokens = images.reduce(
    (sum, image) => sum + geminiVisionTokens(modelName, image.width, image.height),
    0,
  );
  const factSheet = factSheetText(text, profile.factSheetFormat);
  const compactFraming = profile.history.framing === 'compact';
  const intro = compactFraming ? COMPACT_HISTORY_TRANSCRIPT_INTRO : HISTORY_TRANSCRIPT_INTRO;
  const outro = compactFraming ? COMPACT_HISTORY_TRANSCRIPT_OUTRO : HISTORY_TRANSCRIPT_OUTRO;
  const nativeTokens = googleTextTokens(
    intro + factSheet + outro,
  );
  if (imageTokens + nativeTokens >= baselineTokens) return null;
  const droppedCodepoints = new Map<number, number>();
  let droppedChars = 0;
  for (const image of images) {
    droppedChars += image.droppedChars;
    for (const [codepoint, count] of image.droppedCodepoints) {
      droppedCodepoints.set(codepoint, (droppedCodepoints.get(codepoint) ?? 0) + count);
    }
  }
  return {
    start,
    endExclusive: start + admitted.length,
    images,
    imageSources,
    text,
    factSheet,
    baselineTokens,
    nativeTokens,
    collapsedTurns: admitted.length,
    droppedChars,
    droppedCodepoints,
  };
}

function imagePart(image: RenderedImage): GooglePart {
  return {
    inlineData: {
      mimeType: 'image/png',
      data: bytesToBase64(image.png),
    },
  };
}

/**
 * Normalizes Google turn roles so that:
 * 1. Adjacent turns with the same role are merged.
 * 2. The conversation starts with a user turn.
 * 3. The conversation ends with a user turn (never a model turn), avoiding
 *    Google AI Studio's 400 "Requests ending with a model turn are not supported."
 */
export function normalizeGoogleTurnRoles(contents: GoogleContent[]): GoogleContent[] {
  if (contents.length === 0) return contents;
  const merged: GoogleContent[] = [];
  for (const turn of contents) {
    // Google AI Studio rejects empty-parts turns; skip turns with no content.
    if (!turn || !Array.isArray(turn.parts) || turn.parts.length === 0) continue;
    const role = turn.role === 'model' ? 'model' : 'user';
    const last = merged[merged.length - 1];
    if (last && last.role === role) {
      merged[merged.length - 1] = { ...last, parts: [...(last.parts ?? []), ...turn.parts] };
    } else {
      merged.push({ ...turn, role, parts: [...turn.parts] });
    }
  }
  if (merged.length === 0) return [];
  const first = merged[0];
  if (first && first.role === 'model') {
    merged.unshift({ role: 'user', parts: [{ text: ' ' }] });
  }
  const last = merged[merged.length - 1];
  if (last && last.role === 'model') {
    merged.push({ role: 'user', parts: [{ text: ' ' }] });
  }
  return merged;
}

export async function transformGoogleGenerateContent(
  bodyBytes: Uint8Array,
  modelName: string,
  options: {
    compress?: boolean;
    compressTools?: boolean;
    compressToolResults?: boolean;
    collapseHistory?: boolean;
    minToolResultChars?: number;
    maxImagesPerToolResult?: number;
    cols?: number;
    reflow?: boolean;
  } = {},
): Promise<{ body: Uint8Array; info: TransformInfo }> {
  if (!hasGeminiMeasuredProfile(modelName)) {
    const info = createDefaultInfo(modelName);
    info.reason = 'unsupported_model';
    return { body: bodyBytes, info };
  }

  const text = new TextDecoder().decode(bodyBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { body: bodyBytes, info: createDefaultInfo(modelName) };
  }
  const reqRecord = record(parsed);
  if (!reqRecord) {
    return { body: bodyBytes, info: createDefaultInfo(modelName) };
  }
  const req = reqRecord as GoogleGenerateContentRequest;

  const info = createDefaultInfo(modelName);
  if (options.compress === false) {
    info.reason = 'compression_disabled';
    return withStampedThoughtSignatures(req, bodyBytes, info);
  }

  // Extract system instructions
  const systemTexts: string[] = [];
  const systemInstruction = record(req.systemInstruction);
  const systemParts = systemInstruction?.parts;
  if (systemParts !== undefined && !Array.isArray(systemParts)) {
    return { body: bodyBytes, info };
  }
  if (Array.isArray(systemParts)) {
    for (const rawPart of systemParts) {
      const part = record(rawPart);
      if (!part) return { body: bodyBytes, info };
      if (typeof part.text === 'string' && part.text.trim()) {
        systemTexts.push(part.text);
        info.staticChars += part.text.length;
      }
    }
  }

  const toolRewrite = options.compressTools === false
    // Tools pass through untouched, so the saving is 0 by construction. Don't
    // pay two full safeJson walks of the tool array to compute `x - x`.
    ? { tools: req.tools, docs: '', originalTokens: 0, rewrittenTokens: 0 }
    : rewriteGoogleTools(req.tools);
  if (toolRewrite.docs) info.toolDocsChars = toolRewrite.docs.length;
  const authorityText = systemTexts.join('\n\n');
  const combinedRaw = [authorityText, toolRewrite.docs].filter(Boolean).join('\n\n');
  info.origChars = combinedRaw.length;

  const profile = resolveGeminiProfile(modelName);
  let staticImages: RenderedImage[] = [];
  let staticProfitable = false;
  let textTokens = 0;
  let imageTokens = 0;
  let nativeInjectedTokens = 0;
  let fsText: string | null = null;
  let renderedText = '';

  if (combinedRaw) {
    const combined = compactSlabWhitespace(combinedRaw).trimEnd();
    const reflowNote = options.reflow !== false
      ? ' The glyph ↵ (U+21B5) marks an original hard line break in content; treat it as a real newline.'
      : '';
    const header = CHAT_HEADER.replace('\n====', reflowNote + '\n====');
    renderedText = prepareImagedRenderText(header + combined, options.reflow !== false);

    const maxCols = options.cols ?? profile.stripCols;
    const cols = Math.min(
      shrinkColsToContent(renderedText, maxCols, profile.style.markerScale, profile.style.font),
      profile.stripCols,
    );

    staticImages = await renderTextToPngs(renderedText, cols, profile.style, profile.maxHeightPx);
    imageTokens = staticImages.reduce(
      (total, image) => total + geminiVisionTokens(modelName, image.width, image.height),
      0,
    );
    textTokens = Math.max(
      1,
      googleTextTokens(authorityText)
        + Math.max(0, toolRewrite.originalTokens - toolRewrite.rewrittenTokens),
    );
    fsText = factSheetText(combinedRaw, profile.factSheetFormat);
    const nativeText = SYSTEM_POINTER + (fsText ?? '');
    nativeInjectedTokens = Math.ceil(nativeText.length / 3.5);

    info.gateEval = {
      site: 'slab',
      imageTokens,
      textTokens,
      burnImageSide: nativeInjectedTokens,
      burnTextSide: 0,
      profitable: imageTokens + nativeInjectedTokens < textTokens,
    };
    staticProfitable = info.gateEval.profitable;
  }

  // Build static image parts if static slab is profitable
  const imageParts: GooglePart[] = staticProfitable ? staticImages.map(imagePart) : [];
  if (staticProfitable && fsText) {
    imageParts.push({ text: fsText });
  }

  // Prepare transformed request. Plan history against the ORIGINAL contents;
  // inserting the slab image first would make content[0] an opaque image barrier.
  if (req.contents !== undefined && !Array.isArray(req.contents)) {
    return { body: bodyBytes, info: createDefaultInfo(modelName) };
  }
  const originalContents = Array.isArray(req.contents) ? [...req.contents] : [];
  for (const content of originalContents) {
    if (!record(content) || (content.parts !== undefined && !Array.isArray(content.parts))) {
      return { body: bodyBytes, info: createDefaultInfo(modelName) };
    }
  }

  const historyPlan = options.collapseHistory === false
    ? null
    : await planGoogleHistory(originalContents, modelName, options.reflow !== false);
  let contents = originalContents;
  if (historyPlan) {
    const compactFraming = resolveGeminiProfile(modelName).history.framing === 'compact';
    const intro = compactFraming ? COMPACT_HISTORY_TRANSCRIPT_INTRO : HISTORY_TRANSCRIPT_INTRO;
    const outro = compactFraming ? COMPACT_HISTORY_TRANSCRIPT_OUTRO : HISTORY_TRANSCRIPT_OUTRO;
    const historyParts: GooglePart[] = [
      { text: intro },
      ...historyPlan.images.map(imagePart),
    ];
    if (historyPlan.factSheet) historyParts.push({ text: historyPlan.factSheet });
    historyParts.push({ text: outro });
    if (historyPlan.start > 0 && contents[historyPlan.start - 1]?.role === 'user') {
      // Keep Gemini's alternating role shape: append the synthetic prior-context
      // parts to the preceding live user turn rather than emitting user→user.
      const carrier = contents[historyPlan.start - 1]!;
      contents = [
        ...contents.slice(0, historyPlan.start - 1),
        { ...carrier, parts: [...(carrier.parts ?? []), ...historyParts] },
        ...contents.slice(historyPlan.endExclusive),
      ];
    } else {
      contents = [
        ...contents.slice(0, historyPlan.start),
        { role: 'user', parts: historyParts },
        ...contents.slice(historyPlan.endExclusive),
      ];
    }
  }

  const toolResultPlan = await compressGoogleToolResults(contents, modelName, options);
  contents = toolResultPlan.contents;

  const hasStaticCompression = staticProfitable && staticImages.length > 0;
  const hasHistoryCompression = !!historyPlan && historyPlan.images.length > 0;
  const hasToolCompression = toolResultPlan.images.length > 0;

  if (!hasStaticCompression && !hasHistoryCompression && !hasToolCompression) {
    if (!combinedRaw) {
      info.reason = 'no_static_context';
    } else if (!staticProfitable) {
      info.reason = 'not_profitable';
    }
    return withStampedThoughtSignatures(req, bodyBytes, info);
  }

  if (hasStaticCompression) {
    // Static context goes first in the first user turn, matching the Anthropic path.
    if (contents.length > 0 && contents[0] && contents[0].role === 'user') {
      const firstTurn = contents[0];
      contents[0] = {
        ...firstTurn,
        parts: [...imageParts, ...(firstTurn.parts || [])],
      };
    } else {
      contents.unshift({
        role: 'user',
        parts: imageParts,
      });
    }
  }

  const normalizedContents = stampGeminiThoughtSignatures(normalizeGoogleTurnRoles(contents));

  // Keep a native system-level pointer so the imaged instruction retains its
  // original authority instead of being demoted to ordinary user content.
  const transformedReq: GoogleGenerateContentRequest = {
    ...req,
    contents: normalizedContents,
    ...(hasStaticCompression && toolRewrite.tools !== undefined ? { tools: toolRewrite.tools } : {}),
    ...(hasStaticCompression
      ? {
          systemInstruction: {
            ...req.systemInstruction,
            parts: [{ text: SYSTEM_POINTER }],
          },
        }
      : {}),
  };

  const effectiveStaticImages = hasStaticCompression ? staticImages : [];
  info.compressed = true;
  info.imageCount = effectiveStaticImages.length;
  info.imageBytes = effectiveStaticImages.reduce((acc, img) => acc + img.png.byteLength, 0);
  info.imageTokens = hasStaticCompression ? imageTokens : 0;
  info.baselineImagedTokens = hasStaticCompression ? textTokens : 0;
  info.nativeInjectedTokens = hasStaticCompression ? nativeInjectedTokens : 0;
  info.compressedChars = hasStaticCompression ? combinedRaw.length : 0;
  info.bucketChars = hasStaticCompression ? { static_slab: combinedRaw.length } : {};
  info.firstImagePng = effectiveStaticImages[0]?.png;
  info.firstImageWidth = effectiveStaticImages[0]?.width;
  info.firstImageHeight = effectiveStaticImages[0]?.height;
  info.imagePngs = effectiveStaticImages.map((image) => image.png);
  info.imageDims = effectiveStaticImages.map((image) => ({ width: image.width, height: image.height }));
  info.imageSourceText = hasStaticCompression ? renderedText.slice(0, 65_536) : '';
  // Google renders a single combined text slab into page images; share source text across pages.
  info.imageSourceTexts = effectiveStaticImages.map(() => info.imageSourceText);

  if (historyPlan) {
      const historyImageTokens = historyPlan.images.reduce(
        (sum, image) => sum + geminiVisionTokens(modelName, image.width, image.height),
        0,
      );
      info.imageTokens += historyImageTokens;
      info.baselineImagedTokens += historyPlan.baselineTokens;
      info.nativeInjectedTokens += historyPlan.nativeTokens;
      info.imageCount += historyPlan.images.length;
      info.imageBytes += historyPlan.images.reduce((sum, image) => sum + image.png.byteLength, 0);
      info.imagePngs.push(...historyPlan.images.map((image) => image.png));
      info.imageDims.push(...historyPlan.images.map((image) => ({ width: image.width, height: image.height })));
      info.imageSourceTexts.push(...historyPlan.imageSources);
      info.compressedChars += historyPlan.text.length;
      info.bucketChars = { ...info.bucketChars, history: historyPlan.text.length };
      info.historyTextChars = historyPlan.text.length;
      info.collapsedTurns = historyPlan.collapsedTurns;
      info.collapsedChars = historyPlan.text.length;
      info.collapsedImages = historyPlan.images.length;
      info.historyReason = 'collapsed';
      info.droppedChars = (info.droppedChars ?? 0) + historyPlan.droppedChars;
      info.droppedCodepointsTop = droppedCodepointsTop(historyPlan.droppedCodepoints)
        ?? info.droppedCodepointsTop;
  } else if (options.collapseHistory !== false) {
    info.historyReason = originalContents.length > profile.history.keepTail
      ? 'not_profitable'
      : 'no_history';
  }

  if (toolResultPlan.images.length > 0) {
    const resultImageTokens = toolResultPlan.images.reduce(
      (sum, image) => sum + geminiVisionTokens(modelName, image.width, image.height),
      0,
    );
    info.imageTokens += resultImageTokens;
    info.baselineImagedTokens += toolResultPlan.baselineTokens;
    info.nativeInjectedTokens += toolResultPlan.nativeTokens;
    info.imageCount += toolResultPlan.images.length;
    info.imageBytes += toolResultPlan.images.reduce((sum, image) => sum + image.png.byteLength, 0);
    info.imagePngs.push(...toolResultPlan.images.map((image) => image.png));
    info.imageDims.push(...toolResultPlan.images.map((image) => ({ width: image.width, height: image.height })));
    info.imageSourceTexts.push(...toolResultPlan.imageSources);
    info.compressedChars += toolResultPlan.compressedChars;
    info.toolResultImgs = toolResultPlan.images.length;
    info.bucketChars = { ...info.bucketChars, ...toolResultPlan.bucketChars };
    info.droppedChars = (info.droppedChars ?? 0) + toolResultPlan.droppedChars;
  }

  const transformedBytes = new TextEncoder().encode(JSON.stringify(transformedReq));
  return { body: transformedBytes, info };
}

function isNormalizedGoogleTurnRoles(contents: GoogleContent[]): boolean {
  if (contents.length === 0) return true;
  for (let i = 0; i < contents.length; i++) {
    const turn = contents[i];
    if (!turn || !Array.isArray(turn.parts) || turn.parts.length === 0) return false;
    const expectedRole = i % 2 === 0 ? 'user' : 'model';
    const role = turn.role === 'model' ? 'model' : 'user';
    if (role !== expectedRole) return false;
  }
  return contents.length % 2 === 1;
}

function withStampedThoughtSignatures(
  req: GoogleGenerateContentRequest,
  bodyBytes: Uint8Array,
  info: TransformInfo,
): { body: Uint8Array; info: TransformInfo } {
  if (!Array.isArray(req.contents)) return { body: bodyBytes, info };
  const normalized = isNormalizedGoogleTurnRoles(req.contents)
    ? req.contents
    : normalizeGoogleTurnRoles(req.contents);
  const stamped = stampGeminiThoughtSignatures(normalized);
  if (stamped === req.contents && normalized === req.contents) return { body: bodyBytes, info };
  return {
    body: new TextEncoder().encode(JSON.stringify({ ...req, contents: stamped })),
    info,
  };
}

function createDefaultInfo(_model: string): TransformInfo {
  return {
    compressed: false,
    reason: undefined,
    origChars: 0,
    compressedChars: 0,
    staticChars: 0,
    dynamicChars: 0,
    dynamicBlockCount: 0,
    imageCount: 0,
    imageBytes: 0,
    droppedCodepointsTop: {},
  };
}
