/**
 * Google AI Studio / Gemini API request transformer and usage extractor.
 * Intercepts /google-ai-studio/v1beta/models/*:generateContent and :streamGenerateContent
 * requests, extracts static instructions & tools, renders them to PNG image parts, and
 * passes transformed payloads to Google AI Studio.
 */

import { renderTextToPngs, shrinkColsToContent } from './render.js';
import { resolveGeminiProfile, isGeminiModel } from './gemini-model-profiles.js';
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

export function parseGoogleModelFromPath(pathname: string): string | null {
  const match = /\/models\/([^:]+):/i.exec(pathname);
  return match && match[1] ? match[1] : null;
}

export function extractGoogleUsage(rawText: string): { input_tokens?: number; output_tokens?: number } | null {
  const trimmed = rawText.trim();
  let json: any = null;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      for (let i = parsed.length - 1; i >= 0; i--) {
        if (parsed[i]?.usageMetadata || parsed[i]?.usage) {
          json = parsed[i];
          break;
        }
      }
      if (!json) json = parsed[parsed.length - 1];
    } else {
      json = parsed;
    }
  } catch {
    const match = /"usageMetadata"\s*:\s*(\{[^}]+\})/.exec(trimmed);
    if (match && match[1]) {
      try {
        json = { usageMetadata: JSON.parse(match[1]) };
      } catch {}
    }
  }
  const u = json?.usageMetadata ?? json?.usage;
  if (u && typeof u.promptTokenCount === 'number') {
    return {
      input_tokens: u.promptTokenCount,
      output_tokens: typeof u.candidatesTokenCount === 'number' ? u.candidatesTokenCount : 0,
    };
  }
  return null;
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
  let req: GoogleGenerateContentRequest;
  try {
    req = JSON.parse(text);
  } catch {
    return { body: bodyBytes, info: createDefaultInfo(modelName) };
  }

  const info = createDefaultInfo(modelName);
  if (options.compress === false) {
    info.reason = 'compression_disabled';
    return { body: bodyBytes, info };
  }

  // Extract system instructions
  const systemTexts: string[] = [];
  if (req.systemInstruction?.parts) {
    for (const part of req.systemInstruction.parts) {
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

  const profile = resolveGeminiProfile(modelName);
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
  const imageTokens = images.length * 1089;
  const textTokens = Math.max(1, Math.ceil(combinedRaw.length / 3.5));

  const profitable = imageTokens < textTokens;
  info.gateEval = {
    site: 'slab',
    imageTokens,
    textTokens,
    burnImageSide: 0,
    burnTextSide: 0,
    profitable,
  };

  if (!profitable) {
    info.reason = `not_profitable (slab=${combined.length} chars)`;
    info.passthroughReasons = { not_profitable: 1 };
    return { body: bodyBytes, info };
  }

  // Build image parts
  const imageParts: GooglePart[] = images.map((img) => ({
    inlineData: {
      mimeType: 'image/png',
      data: bytesToBase64(img.png),
    },
  }));

  const fsText = factSheetText(combinedRaw, profile.factSheetFormat);
  if (fsText) {
    imageParts.push({ text: fsText });
  }

  // Prepare transformed request
  const contents = Array.isArray(req.contents) ? [...req.contents] : [];
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

  // Clear original systemInstruction since it is now imaged in contents[0]
  const transformedReq: GoogleGenerateContentRequest = {
    ...req,
    contents,
  };
  delete transformedReq.systemInstruction;

  info.compressed = true;
  info.imageCount = images.length;
  info.imageBytes = images.reduce((acc, img) => acc + img.png.byteLength, 0);
  info.imageTokens = imageTokens;
  info.baselineImagedTokens = textTokens;

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
