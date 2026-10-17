// Google AI Studio / CloudCode PA eval client through the local Cloudflare AI Gateway,
// direct Google AI Studio, or Antigravity CloudCode PA.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function gatewayOrigin() {
  const base = (
    process.env.OPENAI_BASE_URL ??
    process.env.GEMINI_BASE_URL ??
    'https://generativelanguage.googleapis.com'
  ).replace(/\/$/, '');
  return base.replace(/\/(compat|openai-ai-studio|google-ai-studio)(\/.*)?$/, '');
}

function readEnvApiKey() {
  const envKey = process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY;
  if (envKey) return envKey;
  try {
    const envFile = join(homedir(), '.env');
    if (existsSync(envFile)) {
      const match = readFileSync(envFile, 'utf8').match(/^GEMINI_API_KEY=["']?([^"'\s]+)["']?/m);
      if (match) return match[1];
    }
  } catch {}
  return undefined;
}

function readCloudCodeToken() {
  if (process.env.CLOUDCODE_TOKEN) return process.env.CLOUDCODE_TOKEN;
  try {
    const tokenFile = join(homedir(), '.gemini/antigravity-cli/antigravity-oauth-token');
    if (existsSync(tokenFile)) {
      const parsed = JSON.parse(readFileSync(tokenFile, 'utf8'));
      const accessToken = parsed?.token?.access_token ?? parsed?.access_token;
      if (typeof accessToken === 'string' && accessToken.length > 0) return accessToken;
    }
  } catch {}
  return undefined;
}

function resolveCloudCodeModel(model) {
  if (process.env.CLOUDCODE_MODEL) return process.env.CLOUDCODE_MODEL;
  const clean = model.replace(/^google\//, '');
  if (/-(low|medium|high)$/.test(clean)) return clean;
  if (clean === 'gemini-4-argon') {
    return `${clean}-${process.env.CLOUDCODE_EFFORT || 'high'}`;
  }
  if (clean === 'gemini-3.8-flash') {
    return `${clean}-${process.env.CLOUDCODE_EFFORT || 'medium'}`;
  }
  return clean;
}

export function resultFilename(base, model) {
  const clean = model.replace(/^google\//, '');
  if (clean === 'gemini-3.6-flash') return `${base}-results.json`;
  return `${base}-${clean.replace(/[^a-zA-Z0-9._-]+/g, '_')}-results.json`;
}

async function callCloudCodeRequest({
  model,
  request,
  maxOutputTokens = 1000,
  timeoutMs = 120000,
  retries = 5,
  token,
}) {
  const ccModel = resolveCloudCodeModel(model);
  const url = 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse';
  const normalizedContents = (request.contents || []).map((c) => ({
    role: c.role || 'user',
    parts: c.parts || [],
  }));
  const effectiveMaxTokens = Math.max(maxOutputTokens, 8192);
  const effortMatch = /-(low|medium|high)$/i.exec(ccModel);
  const thinkingLevel = effortMatch ? effortMatch[1].toUpperCase() : undefined;
  const body = {
    project: process.env.CLOUDCODE_PROJECT || 'aicode-consumers',
    model: ccModel,
    userAgent: 'antigravity',
    requestType: 'agent',
    request: {
      ...request,
      contents: normalizedContents,
      generationConfig: {
        ...(thinkingLevel ? { thinkingConfig: { includeThoughts: true, thinkingLevel } } : {}),
        ...request.generationConfig,
        maxOutputTokens: effectiveMaxTokens,
      },
    },
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'user-agent':
            'antigravity/cli/1.4.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000494485; auth_method=consumer)',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < retries) {
          const waitMs = 5000 * Math.pow(1.6, attempt);
          console.warn(
            `  [retry] HTTP ${response.status} (${raw.slice(0, 80).replace(/\s+/g, ' ')}...), retrying in ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt + 1}/${retries})`,
          );
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${raw.slice(0, 200)}`);
      }
      const nonThoughtParts = [];
      const allParts = [];
      let usage = null;
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr) continue;
        try {
          const evt = JSON.parse(jsonStr);
          const resp = evt.response || evt;
          const parts = resp.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            if (part.text) {
              allParts.push(part.text);
              if (!part.thought) nonThoughtParts.push(part.text);
            }
          }
          if (resp.usageMetadata) usage = resp.usageMetadata;
        } catch {}
      }
      const text = nonThoughtParts.join('') || allParts.join('');
      return {
        text: text.trim(),
        usage,
        ms: Date.now() - started,
      };
    } catch (err) {
      if (attempt < retries && (err.name === 'AbortError' || /fetch failed|ECONNRESET|ETIMEDOUT/i.test(String(err)))) {
        const waitMs = 3000 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function callGeminiRequest({
  model = 'gemini-3.6-flash',
  request,
  maxOutputTokens = 1000,
  timeoutMs = 120000,
  retries = 5,
}) {
  const cloudCodeToken = readCloudCodeToken();
  if (
    process.env.CLOUDCODE === '1' ||
    (cloudCodeToken && !process.env.OPENAI_BASE_URL && !process.env.GEMINI_BASE_URL)
  ) {
    if (!cloudCodeToken) throw new Error('CLOUDCODE=1 set, but no CloudCode OAuth token found');
    return callCloudCodeRequest({ model, request, maxOutputTokens, timeoutMs, retries, token: cloudCodeToken });
  }

  const key = readEnvApiKey();
  if (!key) throw new Error('OPENAI_API_KEY or GEMINI_API_KEY is required');
  const cleanModel = model
    .replace(/^google\//, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '');
  const origin = gatewayOrigin();
  const hostname = new URL(origin).hostname.toLowerCase();
  const isDirect = hostname === 'googleapis.com' || hostname.endsWith('.googleapis.com');
  const url = isDirect
    ? `${origin}/v1beta/models/${cleanModel}:generateContent`
    : `${origin}/google-ai-studio/v1beta/models/${cleanModel}:generateContent`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': key,
        },
        body: JSON.stringify({
          ...request,
          generationConfig: {
            ...request.generationConfig,
            maxOutputTokens,
          },
        }),
        signal: controller.signal,
      });
      const raw = await response.text();
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`non-JSON HTTP ${response.status}: ${raw.slice(0, 160)}`);
      }
      if (!response.ok) {
        const msg = json?.error?.message || raw.slice(0, 160);
        if ((response.status === 429 || response.status >= 500) && attempt < retries) {
          let waitMs = 5000 * Math.pow(1.6, attempt);
          const match = /retry in ([\d.]+)s/i.exec(msg);
          if (match && match[1]) {
            waitMs = Math.ceil(parseFloat(match[1]) * 1000) + 2000;
          }
          console.warn(
            `  [retry] HTTP ${response.status} (${msg.slice(0, 80)}...), retrying in ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt + 1}/${retries})`,
          );
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${msg}`);
      }
      const candidateParts = json.candidates?.[0]?.content?.parts || [];
      const nonThoughtText = candidateParts
        .filter((p) => !p.thought)
        .map((p) => p.text)
        .filter(Boolean)
        .join('');
      const text =
        nonThoughtText ||
        candidateParts
          .map((p) => p.text)
          .filter(Boolean)
          .join('');
      return {
        text: text.trim(),
        usage: json.usageMetadata || null,
        ms: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function callGemini({
  model = 'gemini-3.6-flash',
  content,
  maxOutputTokens = 1000,
  timeoutMs = 120000,
  retries = 5,
}) {
  const parts = content.map((part) => {
    if (part.type === 'input_text') return { text: part.text };
    if (part.type === 'input_image' && typeof part.image_url === 'string') {
      const match = /^data:([^;]+);base64,(.+)$/.exec(part.image_url);
      if (!match) throw new Error('Gemini eval requires base64 data images');
      return {
        inlineData: { mimeType: match[1], data: match[2] },
      };
    }
    throw new Error(`unsupported Gemini content part: ${part.type}`);
  });
  return callGeminiRequest({
    model,
    request: { contents: [{ role: 'user', parts }] },
    maxOutputTokens,
    timeoutMs,
    retries,
  });
}
