import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CODEX_AUTH_MODE_CHATGPT = 'chatgpt';
const CODEX_AUTH_FILE_ENV = 'PXPIPE_CODEX_AUTH_FILE';
const DEFAULT_CODEX_AUTH_FILE = path.join(os.homedir(), '.codex', 'auth.json');

interface CodexAuthFile {
  auth_mode?: unknown;
  tokens?: unknown;
}

interface CodexAuthTokens {
  access_token?: unknown;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultCodexAuthFile(): string {
  return process.env[CODEX_AUTH_FILE_ENV] ?? DEFAULT_CODEX_AUTH_FILE;
}

export function readCodexChatGptAccessToken(
  authFile: string = defaultCodexAuthFile(),
): string | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(authFile, 'utf8');
  } catch {
    return undefined;
  }

  let parsed: CodexAuthFile;
  try {
    parsed = JSON.parse(raw) as CodexAuthFile;
  } catch {
    return undefined;
  }

  if (!isObjectRecord(parsed) || parsed.auth_mode !== CODEX_AUTH_MODE_CHATGPT) {
    return undefined;
  }

  if (!isObjectRecord(parsed.tokens)) {
    return undefined;
  }

  return nonEmptyString((parsed.tokens as CodexAuthTokens).access_token);
}

export function resolveOpenAIApiKey(
  explicitOpenAIKey: string | undefined = process.env.OPENAI_API_KEY,
  codexAuthFile?: string,
): string | undefined {
  const explicit = nonEmptyString(explicitOpenAIKey);
  return explicit ?? readCodexChatGptAccessToken(codexAuthFile);
}
