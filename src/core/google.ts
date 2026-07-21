/**
 * Google AI Studio / Gemini API request transformer and usage extractor.
 * Intercepts /google-ai-studio/v1beta/models/*:generateContent and :streamGenerateContent
 * requests, extracts static system instructions, renders them to PNG image parts, and
 * passes transformed payloads to Google AI Studio.
 */

import { renderTextToPngs, shrinkColsToContent } from './render.js';
import { geminiVisionTokens, resolveGeminiProfile } from './gemini-model-profiles.js';
import { bytesToBase64 } from './png.js';
import { compactSlabWhitespace, type TransformInfo } from './transform.js';
import { prepareImagedRenderText, CHAT_HEADER } from './openai.js';
import { factSheetText } from './factsheet.js';

export interface GooglePart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
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

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function transformGoogleGenerateContent(
  bodyBytes: Uint8Array,
  modelName: string,
  options: {
    compress?: boolean;
    cols?: number;
    reflow?: boolean;
  } = {},
): Promise<{ body: Uint8Array; info: TransformInfo }> {
  const text = new TextDecoder().decode(bodyBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { body: bodyBytes, info: createDefaultInfo(modelName) };
  }
  const reqRecord = record(parsed);
  if (!reqRecord) return { body: bodyBytes, info: createDefaultInfo(modelName) };
  const req = reqRecord as GoogleGenerateContentRequest;

  const info = createDefaultInfo(modelName);
  if (options.compress === false) {
    info.reason = 'compression_disabled';
    return { body: bodyBytes, info };
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

  const combinedRaw = systemTexts.join('\n\n');
  info.origChars = combinedRaw.length;
  if (!combinedRaw) {
    info.reason = 'no_static_context';
    return { body: bodyBytes, info };
  }

  const profile = resolveGeminiProfile();
  const combined = compactSlabWhitespace(combinedRaw).trimEnd();
  const reflowNote = options.reflow !== false
    ? ' The glyph ↵ (U+21B5) marks an original hard line break in content; treat it as a real newline.'
    : '';
  const header = CHAT_HEADER.replace('\n====', reflowNote + '\n====');
  const renderedText = prepareImagedRenderText(header + combined, options.reflow !== false);

  const maxCols = options.cols ?? profile.stripCols;
  const cols = Math.min(
    shrinkColsToContent(renderedText, maxCols, profile.style.markerScale, profile.style.font),
    profile.stripCols,
  );

  const images = await renderTextToPngs(renderedText, cols, profile.style, profile.maxHeightPx);
  const imageTokens = images.reduce(
    (total, image) => total + geminiVisionTokens(modelName, image.width, image.height),
    0,
  );
  const textTokens = Math.max(1, Math.ceil(combinedRaw.length / 3.5));
  const fsText = factSheetText(combinedRaw, profile.factSheetFormat);
  const nativeText = SYSTEM_POINTER + (fsText ?? '');
  const nativeInjectedTokens = Math.ceil(nativeText.length / 3.5);

  info.gateEval = {
    site: 'slab',
    imageTokens,
    textTokens,
    burnImageSide: nativeInjectedTokens,
    burnTextSide: 0,
    profitable: true,
  };

  // Build image parts
  const imageParts: GooglePart[] = images.map((img) => ({
    inlineData: {
      mimeType: 'image/png',
      data: bytesToBase64(img.png),
    },
  }));

  if (fsText) {
    imageParts.push({ text: fsText });
  }

  // Prepare transformed request
  if (req.contents !== undefined && !Array.isArray(req.contents)) {
    return { body: bodyBytes, info: createDefaultInfo(modelName) };
  }
  const contents = Array.isArray(req.contents) ? [...req.contents] : [];
  if (contents.length > 0 && contents[0] && contents[0].role === 'user') {
    const firstTurn = contents[0];
    if (firstTurn.parts !== undefined && !Array.isArray(firstTurn.parts)) {
      return { body: bodyBytes, info: createDefaultInfo(modelName) };
    }
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

  // Keep a native system-level pointer so the imaged instruction retains its
  // original authority instead of being demoted to ordinary user content.
  const transformedReq: GoogleGenerateContentRequest = {
    ...req,
    contents,
    systemInstruction: {
      ...req.systemInstruction,
      parts: [{ text: SYSTEM_POINTER }],
    },
  };

  info.compressed = true;
  info.imageCount = images.length;
  info.imageBytes = images.reduce((acc, img) => acc + img.png.byteLength, 0);
  info.imageTokens = imageTokens;
  info.baselineImagedTokens = textTokens;
  info.nativeInjectedTokens = nativeInjectedTokens;

  const transformedBytes = new TextEncoder().encode(JSON.stringify(transformedReq));
  return { body: transformedBytes, info };
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
