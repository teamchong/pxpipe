import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveOpenAIApiKey } from '../src/node-auth.js';
import { parseCli } from '../src/node.js';

const TMP_PREFIX = 'pxpipe-codex-auth-';
const AUTH_FILE_NAME = 'auth.json';
const CHATGPT_AUTH_MODE = 'chatgpt';
const API_KEY_AUTH_MODE = 'api-key';
const EXPLICIT_OPENAI_KEY = 'sk-explicit-test-key';
const CODEX_ACCESS_TOKEN = 'codex-chatgpt-access-token';
const IGNORED_CODEX_ACCESS_TOKEN = 'ignored-codex-token';
const MALFORMED_AUTH_JSON = '{';
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_CODEX_AUTH_FILE = process.env.PXPIPE_CODEX_AUTH_FILE;

const tmpDirs: string[] = [];

function writeAuthFile(contents: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  tmpDirs.push(dir);
  const file = path.join(dir, AUTH_FILE_NAME);
  fs.writeFileSync(file, JSON.stringify(contents), 'utf8');
  return file;
}

function writeRawAuthFile(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  tmpDirs.push(dir);
  const file = path.join(dir, AUTH_FILE_NAME);
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

afterEach(() => {
  setOptionalEnv('OPENAI_API_KEY', ORIGINAL_OPENAI_API_KEY);
  setOptionalEnv('PXPIPE_CODEX_AUTH_FILE', ORIGINAL_CODEX_AUTH_FILE);

  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function setOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('resolveOpenAIApiKey', () => {
  it('prefers an explicit OPENAI_API_KEY over Codex ChatGPT auth', () => {
    const authFile = writeAuthFile({
      auth_mode: CHATGPT_AUTH_MODE,
      tokens: { access_token: IGNORED_CODEX_ACCESS_TOKEN },
    });

    expect(resolveOpenAIApiKey(EXPLICIT_OPENAI_KEY, authFile)).toBe(EXPLICIT_OPENAI_KEY);
  });

  it('uses the Codex ChatGPT access token when OPENAI_API_KEY is absent', () => {
    const authFile = writeAuthFile({
      auth_mode: CHATGPT_AUTH_MODE,
      OPENAI_API_KEY: null,
      tokens: { access_token: CODEX_ACCESS_TOKEN },
    });

    expect(resolveOpenAIApiKey(undefined, authFile)).toBe(CODEX_ACCESS_TOKEN);
  });

  it('wires Codex ChatGPT auth into the Node runtime config', () => {
    const authFile = writeAuthFile({
      auth_mode: CHATGPT_AUTH_MODE,
      OPENAI_API_KEY: null,
      tokens: { access_token: CODEX_ACCESS_TOKEN },
    });
    delete process.env.OPENAI_API_KEY;
    process.env.PXPIPE_CODEX_AUTH_FILE = authFile;

    expect(parseCli([]).openAIApiKey).toBe(CODEX_ACCESS_TOKEN);
  });

  it('ignores non-ChatGPT Codex auth files', () => {
    const authFile = writeAuthFile({
      auth_mode: API_KEY_AUTH_MODE,
      tokens: { access_token: IGNORED_CODEX_ACCESS_TOKEN },
    });

    expect(resolveOpenAIApiKey(undefined, authFile)).toBeUndefined();
  });

  it('ignores missing or malformed Codex auth files', () => {
    const missingAuthFile = path.join(os.tmpdir(), TMP_PREFIX + AUTH_FILE_NAME);
    const malformedAuthFile = writeRawAuthFile(MALFORMED_AUTH_JSON);

    expect(resolveOpenAIApiKey(undefined, missingAuthFile)).toBeUndefined();
    expect(resolveOpenAIApiKey(undefined, malformedAuthFile)).toBeUndefined();
  });
});
